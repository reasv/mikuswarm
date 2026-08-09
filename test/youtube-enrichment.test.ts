/**
 * Tests for the YouTube T1 enrichment stage (src/enrichment/worker.ts §7e).
 * Phase 2 — spec/YOUTUBE-VIDEO-UNDERSTANDING.md §5.
 *
 * Strategy: configure a fake yt-dlp binary (same approach as youtube-ytdlp.test.ts)
 * and mock the storage/fetchClient to test the full enrichment flow without real
 * network or subprocess activity.
 *
 * Covered:
 *   - payload_json shape for a successful enrichment
 *   - transcript-failure non-fatal degrade (kind "none")
 *   - enrichment disabled / subsystem unavailable → YouTube URLs go to generic path
 *   - eligibility gate: trigger-group eligible; ineligible falls through; enrich_all;
 *     assistant messages with captionAssistant on/off
 *   - thumbnail asset row created vs skipped (thumbnail=false)
 *   - probe failure → fetch_status "failed" row
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { EnrichmentWorker, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { Storage, LinkPreviewRow, MediaAssetRow } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import {
  configureYtDlp,
  resetYtDlpConfig,
} from "../src/youtube/ytdlp.js";
import { parseYouTubePreviewPayload } from "../src/youtube/payload.js";
import { resolveYouTubeConfig } from "../src/youtube/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIDEO_ID = "dQw4w9WgXcY";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const THUMBNAIL_URL = `https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg`;

// Minimal yt-dlp --dump-json fixture.
const DUMP_JSON_FIXTURE = JSON.stringify({
  id: VIDEO_ID,
  title: "Never Gonna Give You Up",
  channel: "Rick Astley",
  duration: 213,
  upload_date: "20091024",
  view_count: 1_500_000_000,
  chapters: [
    { title: "Intro", start_time: 0, end_time: 18 },
    { title: "Verse 1", start_time: 18, end_time: 90 },
  ],
  subtitles: { en: [{ ext: "json3" }] },
  automatic_captions: {},
  is_live: false,
  thumbnail: THUMBNAIL_URL,
});

// Minimal json3 transcript fixture.
const JSON3_FIXTURE = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Never gonna give you up" }] },
    { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: " Never gonna let you down" }] },
  ],
});

// ---------------------------------------------------------------------------
// Fake yt-dlp binary helpers
// ---------------------------------------------------------------------------

async function makeFakeYtDlp(tmpDir: string, script: string): Promise<string> {
  const scriptPath = path.join(tmpDir, "yt-dlp");
  const src = `#!/usr/bin/env node\n${script}\n`;
  await writeFile(scriptPath, src, { mode: 0o755 });
  return scriptPath;
}

/** A combined binary: outputs DUMP_JSON on probe, writes json3 on transcript. */
function successScript(dumpJson: string, json3: string, videoId: string): string {
  return `
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else if (args.includes('--write-subs')) {
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const tmpl = args[oIdx + 1];
    const outDir = path.dirname(tmpl);
    fs.writeFileSync(path.join(outDir, ${JSON.stringify(videoId + '.en.json3')}), ${JSON.stringify(json3)});
  }
}
`;
}

/** A binary that succeeds on probe but fails (non-zero exit) on transcript. */
function transcriptFailScript(dumpJson: string): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else if (args.includes('--write-subs')) {
  process.stderr.write('ERROR: no subtitles available');
  process.exit(1);
}
`;
}

/** A binary that always fails with a non-zero exit code. */
function alwaysFailScript(): string {
  return `
process.stderr.write('ERROR: Video unavailable');
process.exit(1);
`;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  worker: EnrichmentWorker;
  persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  synapseBodies: string[];
  fetchedUrls: string[];
  entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
  workspaceRoot: string;
  eligibilityFields: Map<
    string,
    { triggerGroupId: string | null; isBackfetch: boolean; role: string } | null
  >;
}

async function makeHarness(opts: {
  /** yt-dlp binary path. Default: success binary (probe+transcript). */
  ytDlpPath?: string;
  /** Storage eligibility returns: keyed by eventId. Default: triggerGroupId set. */
  eligibilityMap?: Map<
    string,
    { triggerGroupId: string | null; isBackfetch: boolean; role: string } | null
  >;
  /**
   * YouTube enrichment config overrides. Pass undefined to disable YouTube
   * enrichment entirely (simulate subsystem unavailable or disabled).
   */
  youtubeConfig?: Partial<ReturnType<typeof resolveYouTubeConfig>["enrichment"]> | "disabled";
  /** captionAssistant flag on the youtube option. Default: false. */
  captionAssistant?: boolean;
  /** URLs for which fetchClient.fetch() should throw. */
  failFetchUrls?: Set<string>;
}): Promise<Harness> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-test-"));
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const synapseBodies: string[] = [];
  const fetchedUrls: string[] = [];
  const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];

  const eligibilityFields = opts.eligibilityMap ?? new Map();

  const logger: EnrichmentLogger = {
    info: (msg, data) => entries.push({ level: "info", msg, data }),
    warn: (msg, data) => entries.push({ level: "warn", msg, data }),
    error: (msg, data) => entries.push({ level: "error", msg, data }),
  };

  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    isBackfetchEvent: () => false,
    getEventCaptionEligibilityFields: (eventId: string) => {
      return eligibilityFields.get(eventId) ?? null;
    },
  } as unknown as Storage;

  const capabilities = {
    messageSummary: async () => null,
    downloadMedia: async () => {
      throw new Error("not under test");
    },
    resolveLinkPreviews: async (params: { bodyText: string }) => {
      synapseBodies.push(params.bodyText);
      return { textBlocks: [], media: [], sources: [] };
    },
    memberInfo: async () => ({}),
  } as unknown as EnrichmentCapabilities;

  const fetchClient = {
    fetch: async (url: string) => {
      fetchedUrls.push(url);
      if (opts.failFetchUrls?.has(url)) {
        throw new Error(`download refused for ${url}`);
      }
      const tmpPath = path.join(os.tmpdir(), `yt-fetch-${randomBytes(6).toString("hex")}`);
      await writeFile(tmpPath, Buffer.from("fake image data"));
      return { path: tmpPath, sizeBytes: 16, contentType: "image/jpeg", finalUrl: url, statusCode: 200 };
    },
  } as unknown as FetchClient;

  // Build the youtube option for the worker (or leave unset to simulate disabled/unavailable).
  let youtubeOpt: { config: ReturnType<typeof resolveYouTubeConfig>["enrichment"]; captionAssistant: boolean } | undefined;
  if (opts.youtubeConfig !== "disabled") {
    const base = resolveYouTubeConfig().enrichment;
    youtubeOpt = {
      config: { ...base, ...(opts.youtubeConfig ?? {}) },
      captionAssistant: opts.captionAssistant ?? false,
    };
  }

  // Configure yt-dlp to use the provided fake binary.
  if (opts.ytDlpPath) {
    configureYtDlp({ ytDlpPath: opts.ytDlpPath, timeoutMs: 10_000, concurrency: 2 });
  }

  const worker = new EnrichmentWorker({
    storage,
    capabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    youtube: youtubeOpt,
    logger,
  });

  return { worker, persisted, synapseBodies, fetchedUrls, entries, workspaceRoot, eligibilityFields };
}

function previews(h: Harness): LinkPreviewRow[] {
  return h.persisted[0]?.result.linkPreviews ?? [];
}

function mediaAssets(h: Harness): MediaAssetRow[] {
  return h.persisted[0]?.result.mediaAssets ?? [];
}

async function cleanup(h: Harness): Promise<void> {
  await rm(h.workspaceRoot, { recursive: true, force: true });
}

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$msg",
    externalId: "$msg",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: `check this video https://www.youtube.com/watch?v=${VIDEO_ID}`,
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Default event id — matches what chatEvent() produces. */
const EVENT_ID = "matrix:miku:$msg";

/** Eligibility map where the event is eligible (has a trigger group). */
function triggerGroupEligibility(): Map<string, { triggerGroupId: string | null; isBackfetch: boolean; role: string }> {
  return new Map([[EVENT_ID, { triggerGroupId: "matrix:miku:$trigger", isBackfetch: false, role: "user" }]]);
}

/** Eligibility map where the event is ineligible (no trigger group, not backfetch, not assistant). */
function ineligibleEligibility(): Map<string, { triggerGroupId: string | null; isBackfetch: boolean; role: string }> {
  return new Map([[EVENT_ID, { triggerGroupId: null, isBackfetch: false, role: "user" }]]);
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

test("payload_json shape: successful probe+transcript produces correct structured payload", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-payload-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
    });
    try {
      await h.worker.process(chatEvent());
      const lps = previews(h);
      assert.equal(lps.length, 1, "one link_previews row");
      const lp = lps[0];
      assert.equal(lp.source_kind, "youtube");
      assert.equal(lp.fetch_status, "complete");
      assert.equal(lp.site_name, "YouTube");
      assert.equal(lp.title, "Never Gonna Give You Up");
      assert.equal(lp.url, VIDEO_URL);

      // description is "ChannelName · M:SS"
      assert.equal(lp.description, "Rick Astley · 3:33");

      // payload_json carries the structured payload
      const payload = parseYouTubePreviewPayload(lp.payload_json);
      assert.ok(payload, "payload parses");
      assert.equal(payload.v, 1);
      assert.equal(payload.videoId, VIDEO_ID);
      assert.equal(payload.title, "Never Gonna Give You Up");
      assert.equal(payload.channel, "Rick Astley");
      assert.equal(payload.durationSeconds, 213);
      assert.equal(payload.uploadDate, "20091024");
      assert.equal(payload.viewCount, 1_500_000_000);

      // Chapters
      assert.equal(payload.chapters.length, 2);
      assert.equal(payload.chapters[0].title, "Intro");
      assert.equal(payload.chapters[0].startTime, 0);
      assert.equal(payload.chapters[1].title, "Verse 1");
      assert.equal(payload.chapters[1].startTime, 18);

      // Transcript
      assert.equal(payload.transcriptKind, "manual");
      assert.equal(payload.transcriptLang, "en");
      assert.ok(payload.transcriptHead, "transcriptHead present");
      assert.ok(
        payload.transcriptHead.includes("Never gonna give you up"),
        "transcript head content",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Transcript-failure non-fatal degrade
// ---------------------------------------------------------------------------

test("transcript failure is non-fatal: payload has transcriptKind 'none' when transcript fails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-txfail-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, transcriptFailScript(DUMP_JSON_FIXTURE));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
    });
    try {
      await h.worker.process(chatEvent());
      const lps = previews(h);
      assert.equal(lps.length, 1, "one link_previews row despite transcript failure");
      assert.equal(lps[0].fetch_status, "complete", "fetch_status still complete");
      const payload = parseYouTubePreviewPayload(lps[0].payload_json);
      assert.ok(payload, "payload parses");
      assert.equal(payload.transcriptKind, "none", "kind is none when transcript fails");
      assert.equal(payload.transcriptHead, undefined, "no transcriptHead");
      // Metadata fields still populated
      assert.equal(payload.title, "Never Gonna Give You Up");
      assert.equal(payload.channel, "Rick Astley");
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Enrichment disabled / subsystem unavailable
// ---------------------------------------------------------------------------

test("enrichment disabled: YouTube URL falls through to generic Synapse path", async () => {
  const h = await makeHarness({
    youtubeConfig: "disabled",
    eligibilityMap: triggerGroupEligibility(),
  });
  try {
    await h.worker.process(chatEvent());
    // Synapse was called with the YouTube URL still in the body
    assert.equal(h.synapseBodies.length, 1, "Synapse called");
    assert.ok(
      h.synapseBodies[0].includes("youtube.com"),
      "YouTube URL not stripped from Synapse body",
    );
    // No YouTube link preview rows
    const lps = previews(h);
    assert.equal(lps.length, 0, "no link_previews rows from YouTube enrichment");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Eligibility gate
// ---------------------------------------------------------------------------

test("eligibility: trigger-group event → URL partitioned + enriched, stripped from Synapse body", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-elig-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
    });
    try {
      // Include a non-YouTube URL so Synapse is still called after the YouTube strip.
      const event = chatEvent({
        body: `${VIDEO_URL} and also see https://example.com/article`,
      });
      await h.worker.process(event);
      const lps = previews(h);
      const ytLps = lps.filter((lp) => lp.source_kind === "youtube");
      assert.equal(ytLps.length, 1, "one YouTube enrichment row");
      // URL stripped from Synapse body (Synapse is called for example.com).
      assert.equal(h.synapseBodies.length, 1, "Synapse called for non-YouTube URL");
      assert.ok(
        !h.synapseBodies[0].includes("youtube.com"),
        "YouTube URL stripped from Synapse body when eligible",
      );
      assert.ok(
        h.synapseBodies[0].includes("example.com"),
        "non-YouTube URL kept in Synapse body",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("eligibility: ineligible event → YouTube URL falls through to generic path, not enriched", async () => {
  const h = await makeHarness({
    eligibilityMap: ineligibleEligibility(),
  });
  try {
    await h.worker.process(chatEvent());
    const lps = previews(h);
    // No YouTube enrichment rows (Synapse may produce generic og: rows, but
    // we have no synapse sources configured so there are none here either).
    assert.equal(lps.filter((lp) => lp.source_kind === "youtube").length, 0);
    // YouTube URL NOT stripped from Synapse body — it's an ineligible event.
    assert.equal(h.synapseBodies.length, 1, "Synapse called");
    assert.ok(
      h.synapseBodies[0].includes("youtube.com"),
      "YouTube URL kept in Synapse body when ineligible",
    );
  } finally {
    await cleanup(h);
  }
});

test("eligibility: enrich_all=true → even ineligible events are enriched", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-all-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: ineligibleEligibility(),
      youtubeConfig: { enrichAll: true },
    });
    try {
      await h.worker.process(chatEvent());
      const lps = previews(h);
      assert.equal(
        lps.filter((lp) => lp.source_kind === "youtube").length,
        1,
        "YouTube enriched despite ineligible event when enrich_all=true",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("eligibility: assistant message enriched when captionAssistant=true", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-asst-"));
  const assistantEventId = "matrix:miku:$asst";
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const eligibilityMap = new Map<string, { triggerGroupId: string | null; isBackfetch: boolean; role: string }>([
      [assistantEventId, { triggerGroupId: null, isBackfetch: false, role: "assistant" }],
    ]);
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap,
      captionAssistant: true,
    });
    try {
      await h.worker.process(chatEvent({ id: assistantEventId, role: "assistant" }));
      const lps = previews(h);
      assert.equal(
        lps.filter((lp) => lp.source_kind === "youtube").length,
        1,
        "assistant message enriched when captionAssistant=true",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("eligibility: assistant message NOT enriched when captionAssistant=false", async () => {
  const assistantEventId = "matrix:miku:$asst2";
  const eligibilityMap = new Map<string, { triggerGroupId: string | null; isBackfetch: boolean; role: string }>([
    [assistantEventId, { triggerGroupId: null, isBackfetch: false, role: "assistant" }],
  ]);
  const h = await makeHarness({
    eligibilityMap,
    captionAssistant: false,
  });
  try {
    await h.worker.process(chatEvent({ id: assistantEventId, role: "assistant" }));
    const lps = previews(h);
    assert.equal(
      lps.filter((lp) => lp.source_kind === "youtube").length,
      0,
      "assistant message NOT enriched when captionAssistant=false",
    );
    // URL still in Synapse body (ineligible → not stripped).
    assert.ok(h.synapseBodies[0]?.includes("youtube.com"), "URL kept in Synapse body");
  } finally {
    await cleanup(h);
  }
});

test("eligibility: backfetch event (is_backfetch=true) is eligible without trigger group", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-bkf-"));
  const backfetchEventId = "matrix:miku:$bkf";
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const eligibilityMap = new Map<string, { triggerGroupId: string | null; isBackfetch: boolean; role: string }>([
      [backfetchEventId, { triggerGroupId: null, isBackfetch: true, role: "user" }],
    ]);
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap,
    });
    try {
      await h.worker.process(chatEvent({ id: backfetchEventId }));
      const lps = previews(h);
      assert.equal(
        lps.filter((lp) => lp.source_kind === "youtube").length,
        1,
        "backfetch event is eligible for YouTube enrichment",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Thumbnail asset
// ---------------------------------------------------------------------------

test("thumbnail: media asset row created when thumbnail=true and probe yields thumbnailUrl", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-thumb-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
      // thumbnail=true is default
    });
    try {
      await h.worker.process(chatEvent());

      // Thumbnail was fetched
      assert.ok(h.fetchedUrls.includes(THUMBNAIL_URL), "thumbnail URL fetched");

      // Media asset row created
      const assets = mediaAssets(h);
      const thumbAsset = assets.find((a) => a.media_type === "image" && a.role === "preview_media");
      assert.ok(thumbAsset, "preview_media thumbnail asset created");
      assert.equal(thumbAsset.caption_status, "pending", "caption_status is pending");
      assert.equal(thumbAsset.download_status, "complete", "download_status is complete");

      // Asset is linked to the link preview via link_preview_id
      const lps = previews(h);
      assert.equal(lps.length, 1);
      assert.equal(thumbAsset.link_preview_id, lps[0].id, "thumbnail linked to preview");
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("thumbnail skipped when thumbnail=false", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-nothumb-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
      youtubeConfig: { thumbnail: false },
    });
    try {
      await h.worker.process(chatEvent());
      // Thumbnail URL should NOT have been fetched
      assert.ok(!h.fetchedUrls.includes(THUMBNAIL_URL), "thumbnail URL not fetched");
      // No preview_media asset
      const assets = mediaAssets(h);
      assert.equal(
        assets.filter((a) => a.role === "preview_media").length,
        0,
        "no preview_media asset when thumbnail=false",
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Probe failure → fetch_status "failed"
// ---------------------------------------------------------------------------

test("probe failure records fetch_status 'failed' row with error text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-probefail-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, alwaysFailScript());
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
    });
    try {
      await h.worker.process(chatEvent());
      const lps = previews(h);
      assert.equal(lps.length, 1, "one link_previews row even on failure");
      const lp = lps[0];
      assert.equal(lp.fetch_status, "failed");
      assert.equal(lp.source_kind, "youtube");
      assert.equal(lp.url, VIDEO_URL);
      assert.ok(lp.error, "error field populated");
      // A warning was logged
      const warnEntry = h.entries.find(
        (e) => e.level === "warn" && e.msg === "enrichment_youtube_probe_failed",
      );
      assert.ok(warnEntry, "warning logged on probe failure");
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Canonical URL normalization
// ---------------------------------------------------------------------------

test("canonical URL: stored URL is normalized watch URL regardless of input form", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-canon-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: new Map([[
        EVENT_ID,
        { triggerGroupId: "matrix:miku:$trigger", isBackfetch: false, role: "user" },
      ]]),
    });
    try {
      // Input is a short URL form
      const event = chatEvent({ body: `https://youtu.be/${VIDEO_ID}` });
      await h.worker.process(event);
      const lps = previews(h);
      assert.equal(lps.length, 1);
      // Stored URL is the canonical watch URL
      assert.equal(lps[0].url, VIDEO_URL, "canonical watch URL stored");
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// transcript_head_chars cap
// ---------------------------------------------------------------------------

test("transcriptHead is capped at transcript_head_chars from config", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-enrich-headcap-"));
  try {
    const bin = await makeFakeYtDlp(tmpDir, successScript(DUMP_JSON_FIXTURE, JSON3_FIXTURE, VIDEO_ID));
    const h = await makeHarness({
      ytDlpPath: bin,
      eligibilityMap: triggerGroupEligibility(),
      youtubeConfig: { transcriptHeadChars: 10 },
    });
    try {
      await h.worker.process(chatEvent());
      const lps = previews(h);
      const payload = parseYouTubePreviewPayload(lps[0].payload_json);
      assert.ok(payload?.transcriptHead, "transcriptHead present");
      assert.ok(
        payload.transcriptHead.length <= 10,
        `transcriptHead capped: got ${payload.transcriptHead.length}`,
      );
    } finally {
      await cleanup(h);
    }
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
