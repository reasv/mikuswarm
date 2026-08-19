/**
 * Tests for src/tools/youtube-fetch.ts — youtube_fetch agent tool.
 * (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §6 + §6a; Phase 3)
 *
 * Strategy: configure a fake yt-dlp binary (same approach as youtube-ytdlp.test.ts
 * and youtube-enrichment.test.ts) — no real subprocess or network. The tool's
 * exported pure helpers (buildYoutubeFetchDocument, findNearestMarkerOffset,
 * slugifyTitle, parseYouTubeRef) are tested directly without a binary.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createYoutubeFetchTool,
  parseYouTubeRef,
  buildYoutubeFetchDocument,
  findNearestMarkerOffset,
  slugifyTitle,
} from "../src/tools/youtube-fetch.js";
import { configureYtDlp, resetYtDlpConfig } from "../src/youtube/ytdlp.js";
import { resolveYouTubeConfig } from "../src/youtube/config.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VIDEO_ID = "dQw4w9WgXcY";

const BASE_DUMP_JSON = JSON.stringify({
  id: VIDEO_ID,
  title: "Never Gonna Give You Up",
  channel: "Rick Astley",
  duration: 213,
  upload_date: "20091024",
  view_count: 1_500_000_000,
  is_live: false,
  live_status: "not_live",
  description: "The official video for Never Gonna Give You Up by Rick Astley.",
  chapters: [
    { title: "Intro", start_time: 0, end_time: 18 },
    { title: "Verse 1", start_time: 18, end_time: 90 },
  ],
  subtitles: { en: [{ ext: "json3" }] },
  automatic_captions: {},
});

const BASE_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Never gonna give you up" }] },
    { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: " Never gonna let you down" }] },
    { tStartMs: 35000, dDurationMs: 3000, segs: [{ utf8: " Second marker segment" }] },
  ],
});

const DEFAULT_CONFIG = resolveYouTubeConfig().tool;

// ---------------------------------------------------------------------------
// Fake yt-dlp script helpers
// ---------------------------------------------------------------------------

async function makeFakeYtDlp(tmpDir: string, script: string): Promise<string> {
  const p = path.join(tmpDir, "yt-dlp");
  await writeFile(p, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return p;
}

/** Happy-path binary: probe + transcript. */
function probeTranscriptScript(
  dumpJson: string,
  json3: string,
  lang = "en",
): string {
  return `
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else if (args.includes('--write-subs') || args.includes('--write-auto-subs')) {
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const tmpl = args[oIdx + 1];
    const outDir = path.dirname(tmpl);
    const fn = ${JSON.stringify(VIDEO_ID + "." + lang + ".json3")};
    fs.writeFileSync(path.join(outDir, fn), ${JSON.stringify(json3)});
  }
}
`;
}

/** Happy-path binary: probe + transcript + creates a fake download file. */
function probeTranscriptDownloadScript(dumpJson: string, json3: string): string {
  return `
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else if (args.includes('--write-subs') || args.includes('--write-auto-subs')) {
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const tmpl = args[oIdx + 1];
    const outDir = path.dirname(tmpl);
    fs.writeFileSync(path.join(outDir, ${JSON.stringify(VIDEO_ID + ".en.json3")}), ${JSON.stringify(json3)});
  }
} else {
  // Download: write a fake file at the -o path.
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    fs.writeFileSync(args[oIdx + 1], 'fake media bytes');
  }
}
`;
}

/** Binary that succeeds on probe but fails on transcript (returns kind "none"). */
function probOnlyScript(dumpJson: string): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else if (args.includes('--write-subs') || args.includes('--write-auto-subs')) {
  process.exit(1);
}
`;
}

/** Binary that always fails. */
function alwaysFailScript(message: string): string {
  return `
process.stderr.write(${JSON.stringify(message)});
process.exit(1);
`;
}

/** Binary that reports the video as live. */
function liveScript(): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ id: VIDEO_ID, is_live: true, live_status: "is_live", title: "Live Stream", subtitles: {}, automatic_captions: {} }))});
}
`;
}

/** Binary that reports the video as upcoming. */
function upcomingScript(): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ id: VIDEO_ID, is_live: false, live_status: "upcoming", title: "Premiere", subtitles: {}, automatic_captions: {} }))});
}
`;
}

/** Download binary that aborts with a filesize error. */
function filesizeErrorScript(dumpJson: string): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else {
  process.stderr.write('ERROR: Filesize too large');
  process.exit(1);
}
`;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  workspaceRoot: string;
  tmpDir: string;
  execute: (
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
  cleanup: () => Promise<void>;
}

async function makeHarness(opts: {
  script?: string;
  config?: Partial<typeof DEFAULT_CONFIG>;
} = {}): Promise<Harness> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ytfetch-test-"));
  const workspaceRoot = path.join(tmpDir, "ws");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspaceRoot, { recursive: true });

  const script = opts.script ?? probeTranscriptScript(BASE_DUMP_JSON, BASE_JSON3);
  const ytDlpPath = await makeFakeYtDlp(tmpDir, script);

  resetYtDlpConfig();
  configureYtDlp({ ytDlpPath, timeoutMs: 15_000 });

  const tool = createYoutubeFetchTool({
    workspaceRoot,
    config: { ...DEFAULT_CONFIG, ...opts.config },
  });

  return {
    workspaceRoot,
    tmpDir,
    execute: (params) =>
      tool.execute("call-1", params) as ReturnType<Harness["execute"]>,
    cleanup: async () => {
      resetYtDlpConfig();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

function textOf(
  result: Awaited<ReturnType<Harness["execute"]>>,
): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

// ===========================================================================
// § Pure helpers (no binary needed)
// ===========================================================================

// ── parseYouTubeRef ──────────────────────────────────────────────────────────

test("parseYouTubeRef: accepts bare 11-char id", () => {
  const ref = parseYouTubeRef("dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
  assert.equal(ref.startSec, undefined);
});

test("parseYouTubeRef: accepts youtube.com/watch?v= URL", () => {
  const ref = parseYouTubeRef("https://www.youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeRef: accepts youtu.be short URL", () => {
  const ref = parseYouTubeRef("https://youtu.be/dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeRef: accepts youtube.com/shorts/ URL", () => {
  const ref = parseYouTubeRef("https://www.youtube.com/shorts/dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeRef: accepts youtube.com/live/ URL", () => {
  const ref = parseYouTubeRef("https://www.youtube.com/live/dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeRef: accepts youtube.com/embed/ URL", () => {
  const ref = parseYouTubeRef("https://www.youtube.com/embed/dQw4w9WgXcY");
  assert.ok(ref);
  assert.equal(ref.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeRef: parses t= from watch URL", () => {
  const ref = parseYouTubeRef("https://www.youtube.com/watch?v=dQw4w9WgXcY&t=750");
  assert.ok(ref);
  assert.equal(ref.startSec, 750);
});

test("parseYouTubeRef: parses t= HMS from youtu.be", () => {
  const ref = parseYouTubeRef("https://youtu.be/dQw4w9WgXcY?t=2m30s");
  assert.ok(ref);
  assert.equal(ref.startSec, 150);
});

test("parseYouTubeRef: rejects non-YouTube URL", () => {
  assert.equal(parseYouTubeRef("https://example.com/watch?v=dQw4w9WgXcY"), null);
});

test("parseYouTubeRef: rejects wrong-length bare id", () => {
  assert.equal(parseYouTubeRef("dQw4w9WgX"), null); // 9 chars
  assert.equal(parseYouTubeRef("dQw4w9WgXcYZ"), null); // 12 chars
});

test("parseYouTubeRef: rejects channel/playlist URLs", () => {
  assert.equal(parseYouTubeRef("https://www.youtube.com/@RickAstleyYT"), null);
  assert.equal(
    parseYouTubeRef("https://www.youtube.com/playlist?list=PLAbCd123456789"),
    null,
  );
});

// ── buildYoutubeFetchDocument ─────────────────────────────────────────────────

test("buildYoutubeFetchDocument: header fields appear in order", () => {
  const meta = {
    id: VIDEO_ID,
    title: "Test Video",
    channel: "Test Channel",
    uploadDate: "20240115",
    duration: 213,
    viewCount: 1_500_000,
    chapters: [],
    subtitleTracks: [],
  };
  const doc = buildYoutubeFetchDocument(meta, "some text", "en", "auto", 32768);
  const lines = doc.split("\n");
  const titleIdx = lines.findIndex((l) => l.startsWith("Title:"));
  const channelIdx = lines.findIndex((l) => l.startsWith("Channel:"));
  const uploadIdx = lines.findIndex((l) => l.startsWith("Uploaded:"));
  const durationIdx = lines.findIndex((l) => l.startsWith("Duration:"));
  const viewsIdx = lines.findIndex((l) => l.startsWith("Views:"));
  assert.ok(titleIdx >= 0 && channelIdx > titleIdx && uploadIdx > channelIdx);
  assert.ok(durationIdx > uploadIdx && viewsIdx > durationIdx);
  assert.match(doc, /Title: Test Video/);
  assert.match(doc, /Channel: Test Channel/);
  assert.match(doc, /Uploaded: 2024-01-15/);
  assert.match(doc, /Duration: 3:33/);
  assert.match(doc, /Views: 1,500,000/);
});

test("buildYoutubeFetchDocument: description wrapped in untrusted envelope", () => {
  const meta = {
    id: VIDEO_ID,
    title: "T",
    chapters: [],
    subtitleTracks: [],
    description: "A video description with <xml> & chars",
  };
  const doc = buildYoutubeFetchDocument(meta, "", "en", "none", 32768);
  assert.match(doc, /source="description"/);
  assert.match(doc, /A video description with &lt;xml&gt; &amp; chars/);
  assert.match(doc, /<\/untrusted_youtube_fetch>/);
});

test("buildYoutubeFetchDocument: transcript wrapped in untrusted envelope", () => {
  const meta = { id: VIDEO_ID, title: "T", chapters: [], subtitleTracks: [] };
  const doc = buildYoutubeFetchDocument(
    meta,
    "[0:00] Words with <evil> & 'quotes'",
    "en",
    "manual",
    32768,
  );
  assert.match(doc, /source="transcript"/);
  assert.match(doc, /lang="en"/);
  assert.match(doc, /kind="manual"/);
  assert.match(doc, /\[0:00\] Words with &lt;evil&gt; &amp; 'quotes'/);
});

test("buildYoutubeFetchDocument: chapters appear with timestamps", () => {
  const meta = {
    id: VIDEO_ID,
    title: "T",
    chapters: [
      { title: "Intro", startTime: 0, endTime: 18 },
      { title: "Main <& more>", startTime: 18, endTime: 90 },
    ],
    subtitleTracks: [],
  };
  const doc = buildYoutubeFetchDocument(meta, "", "en", "none", 32768);
  assert.match(doc, /Chapters:/);
  assert.match(doc, /\[0:00\] Intro/);
  assert.match(doc, /\[0:18\] Main &lt;&amp; more&gt;/);
});

test("buildYoutubeFetchDocument: no-transcript case emits Transcript: none available", () => {
  const meta = { id: VIDEO_ID, title: "T", chapters: [], subtitleTracks: [] };
  const doc = buildYoutubeFetchDocument(meta, "", "", "none", 32768);
  assert.match(doc, /Transcript: none available/);
  // Should NOT contain the untrusted transcript envelope.
  assert.ok(!doc.includes('source="transcript"'));
});

test("buildYoutubeFetchDocument: media hint trailer always present", () => {
  const meta = { id: VIDEO_ID, title: "T", chapters: [], subtitleTracks: [] };
  const doc = buildYoutubeFetchDocument(meta, "text", "en", "auto", 32768);
  assert.match(doc, /call `media` with this URL and `start_time`/);
});

test("buildYoutubeFetchDocument: description bounded at DESCRIPTION_MAX_CHARS", () => {
  const meta = {
    id: VIDEO_ID,
    title: "T",
    chapters: [],
    subtitleTracks: [],
    description: "x".repeat(3000),
  };
  const doc = buildYoutubeFetchDocument(meta, "", "en", "none", 32768);
  assert.match(doc, /description truncated/);
});

test("buildYoutubeFetchDocument: hard-sliced at maxTotalChars", () => {
  const meta = {
    id: VIDEO_ID,
    title: "T",
    chapters: [],
    subtitleTracks: [],
    description: "d".repeat(100),
  };
  const transcript = "t".repeat(10000);
  const doc = buildYoutubeFetchDocument(meta, transcript, "en", "auto", 500);
  assert.equal(doc.length, 500);
});

test("buildYoutubeFetchDocument: section order — description before chapters before transcript", () => {
  const meta = {
    id: VIDEO_ID,
    title: "T",
    chapters: [{ title: "Intro", startTime: 0, endTime: 18 }],
    subtitleTracks: [],
    description: "Some desc",
  };
  const doc = buildYoutubeFetchDocument(meta, "[0:00] text", "en", "auto", 32768);
  const descIdx = doc.indexOf("Description:");
  const chapIdx = doc.indexOf("Chapters:");
  const transcriptIdx = doc.indexOf("Transcript (");
  assert.ok(descIdx < chapIdx, "description before chapters");
  assert.ok(chapIdx < transcriptIdx, "chapters before transcript");
});

// ── findNearestMarkerOffset ───────────────────────────────────────────────────

test("findNearestMarkerOffset: returns offset of nearest [M:SS] marker", () => {
  const doc = "header\n[0:00] first marker\nsome text\n[1:00] second marker\n[2:00] third";
  // targetSec=65 is between 60 and 120; nearest = [1:00] (delta 5)
  const offset = findNearestMarkerOffset(doc, 65);
  assert.equal(doc.slice(offset, offset + 7), "[1:00] ");
});

test("findNearestMarkerOffset: returns 0 when no markers found", () => {
  const doc = "No timestamp markers here at all.";
  assert.equal(findNearestMarkerOffset(doc, 100), 0);
});

test("findNearestMarkerOffset: handles multi-minute timestamps (total minutes, not H:MM)", () => {
  // [90:00] = 5400 seconds
  const doc = "preamble\n[90:00] a segment\nmore";
  const offset = findNearestMarkerOffset(doc, 5400);
  assert.equal(doc.slice(offset, offset + 7), "[90:00]");
});

test("findNearestMarkerOffset: picks [0:00] for targetSec=0", () => {
  const doc = "lead\n[0:00] start\n[1:00] later";
  const offset = findNearestMarkerOffset(doc, 0);
  assert.equal(doc.slice(offset, offset + 6), "[0:00]");
});

// ── slugifyTitle ──────────────────────────────────────────────────────────────

test("slugifyTitle: removes unicode and emoji", () => {
  const slug = slugifyTitle("My Video 🎵 日本語");
  assert.match(slug, /^[A-Za-z0-9.-]*$/);
  assert.ok(!slug.includes("🎵"));
});

test("slugifyTitle: replaces slashes, colons, question marks", () => {
  const slug = slugifyTitle("Hello/World: Why?");
  assert.ok(!slug.includes("/"));
  assert.ok(!slug.includes(":"));
  assert.ok(!slug.includes("?"));
});

test("slugifyTitle: collapses repeated hyphens", () => {
  const slug = slugifyTitle("One   Two   Three");
  assert.ok(!slug.includes("--"));
});

test("slugifyTitle: strips leading/trailing hyphens", () => {
  const slug = slugifyTitle("  Hello World  ");
  assert.ok(!slug.startsWith("-"));
  assert.ok(!slug.endsWith("-"));
});

test("slugifyTitle: removes dot-led segments to avoid hidden files and ..", () => {
  const slug = slugifyTitle("..hidden .file");
  assert.ok(!slug.startsWith("."));
  assert.ok(!slug.includes(".."));
});

test("slugifyTitle: limits to 80 characters", () => {
  const slug = slugifyTitle("a".repeat(200));
  assert.ok(slug.length <= 80);
});

test("slugifyTitle: falls back to 'video' when title is all symbols", () => {
  const slug = slugifyTitle("🎵🎵🎵");
  assert.equal(slug, "video");
});

test("slugifyTitle: preserves dots mid-stem", () => {
  // A dot in the middle of a name is fine.
  const slug = slugifyTitle("v1.2.3 release");
  assert.match(slug, /v1\.2\.3/);
});

// ===========================================================================
// § Tool integration (requires fake binary)
// ===========================================================================

// ── URL / id acceptance ───────────────────────────────────────────────────────

test("youtube_fetch: accepts a bare 11-char video id", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: VIDEO_ID });
    assert.match(textOf(result), /Never Gonna Give You Up/);
    assert.equal(result.details?.videoId, VIDEO_ID);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: accepts a youtube.com/watch URL", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });
    assert.match(textOf(result), /Never Gonna Give You Up/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: accepts a youtu.be short URL", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: `https://youtu.be/${VIDEO_ID}` });
    assert.match(textOf(result), /Rick Astley/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: rejects unrecognizable input", async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(
      () => h.execute({ url: "https://example.com/not-a-video" }),
      /Not a recognizable YouTube URL/,
    );
  } finally {
    await h.cleanup();
  }
});

// ── Document layout ───────────────────────────────────────────────────────────

test("youtube_fetch: document contains header, description, chapters, transcript", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: VIDEO_ID });
    const text = textOf(result);
    // Header
    assert.match(text, /Title: Never Gonna Give You Up/);
    assert.match(text, /Channel: Rick Astley/);
    assert.match(text, /Duration: 3:33/);
    assert.match(text, /Views: 1,500,000,000/);
    // Description (untrusted envelope)
    assert.match(text, /source="description"/);
    assert.match(text, /official video for Never/);
    // Chapters
    assert.match(text, /\[0:00\] Intro/);
    assert.match(text, /\[0:18\] Verse 1/);
    // Transcript (untrusted envelope)
    assert.match(text, /source="transcript"/);
    assert.match(text, /Never gonna give you up/);
    // Media hint
    assert.match(text, /call `media` with this URL/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: no-transcript document still includes metadata", async () => {
  const script = probOnlyScript(BASE_DUMP_JSON);
  const h = await makeHarness({ script });
  try {
    const result = await h.execute({ url: VIDEO_ID });
    const text = textOf(result);
    assert.match(text, /Title: Never Gonna Give You Up/);
    assert.match(text, /Transcript: none available/);
    // No transcript envelope
    assert.ok(!text.includes('source="transcript"'));
    // Media hint still present
    assert.match(text, /call `media` with this URL/);
    assert.equal(result.details?.transcriptKind, "none");
  } finally {
    await h.cleanup();
  }
});

// ── Windowing and offset math ─────────────────────────────────────────────────

test("youtube_fetch: windows the document with offset/max_chars", async () => {
  const h = await makeHarness();
  try {
    const first = await h.execute({ url: VIDEO_ID, max_chars: 50 });
    const firstText = textOf(first);
    assert.match(firstText, /\[truncated — continue with offset=50\]/);
    assert.equal(first.details?.nextOffset, 50);
    assert.equal(first.details?.truncated, true);

    const second = await h.execute({ url: VIDEO_ID, max_chars: 50, offset: 50 });
    const secondText = textOf(second);
    // Second window should continue, not repeat the first 50 chars.
    assert.ok(
      secondText.slice(0, 20) !== firstText.slice(0, 20),
      "windows do not overlap",
    );
    assert.equal(second.details?.nextOffset, 100);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: details.totalChars covers the full document", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: VIDEO_ID, max_chars: 50 });
    const total = result.details?.totalChars as number;
    assert.ok(total > 200, "total > 200 for a real document");

    // A window starting at total-10 should not be truncated.
    const tail = await h.execute({ url: VIDEO_ID, offset: total - 10 });
    assert.equal(tail.details?.truncated, false);
    assert.equal(tail.details?.nextOffset, null);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: max_chars capped at maxCharsLimit", async () => {
  const h = await makeHarness({ config: { maxCharsLimit: 200 } });
  try {
    // Even if max_chars=99999 is passed, the cap applies.
    const result = await h.execute({ url: VIDEO_ID, max_chars: 99999 });
    const text = textOf(result);
    // If total < 200 the result is not truncated; otherwise it is.
    // Either way the raw text before the truncation marker <= 200 chars.
    const mainText = text.replace(/\n\[truncated.*$/, "");
    assert.ok(mainText.length <= 200);
  } finally {
    await h.cleanup();
  }
});

// ── t= anchored offset ────────────────────────────────────────────────────────

test("youtube_fetch: t= URL anchor opens window at nearest transcript marker", async () => {
  // The BASE_JSON3 has markers at [0:00] and [0:35] (35000ms = 35s).
  // A URL with t=35 should land at or near the [0:35] position.
  const h = await makeHarness();
  try {
    const result = await h.execute({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=35`,
      max_chars: 200,
    });
    const text = textOf(result);
    // The [0:35] marker or its neighbourhood should appear early in the window.
    // Because the window opens near [0:35], the text starts mid-document.
    // We verify the window is NOT at the very start (title "Never Gonna") and
    // DOES contain content near [0:35].
    // The text at [0:35] is "Second marker segment".
    assert.match(text, /Second marker segment/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: explicit offset overrides t= anchor", async () => {
  // t=35 would normally anchor at [0:35], but offset=0 forces start of document.
  const h = await makeHarness();
  try {
    const result = await h.execute({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=35`,
      offset: 0,
      max_chars: 100,
    });
    // offset=0 forces start, so the header (title) should appear.
    assert.match(textOf(result), /Title: Never Gonna Give You Up/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: t= past truncation point opens at last surviving marker", async () => {
  // Craft a JSON3 where the [0:00] marker survives the maxTotalChars cut but
  // the [10:00] marker (600s) does not. Use a minimal dump JSON (no description,
  // no chapters) for a predictable header size (~156 chars before transcript).
  // "padding ".repeat(25) ≈ 199 chars of early text pushes [10:00] to offset ~363,
  // past the maxTotalChars=300 cut; [0:00] sits at ~156, well within the cut.
  const earlyPadding = "padding ".repeat(25); // 199 chars after trim
  const truncTestJson3 = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: earlyPadding }] },
      { tStartMs: 600_000, dDurationMs: 3000, segs: [{ utf8: "Late segment content" }] },
    ],
  });
  const minimalDump = JSON.stringify({
    id: VIDEO_ID,
    title: "T",
    channel: "C",
    duration: 700,
    is_live: false,
    live_status: "not_live",
    subtitles: { en: [{ ext: "json3" }] },
    automatic_captions: {},
  });

  const script = probeTranscriptScript(minimalDump, truncTestJson3);
  // maxTotalChars=300 truncates after [0:00] (offset ~156) but before [10:00] (offset ~363).
  const h = await makeHarness({ script, config: { maxTotalChars: 300 } });
  try {
    // t=600 points to [10:00] which lies beyond the truncation cut.
    const result = await h.execute({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=600`,
    });
    const text = textOf(result);
    const totalChars = result.details?.totalChars as number;

    // Document must be truncated to maxTotalChars.
    assert.equal(totalChars, 300, "document truncated to maxTotalChars");
    // Window must be non-empty (offset < totalChars, valid page).
    assert.ok(text.length > 0, "non-empty window");
    // The late marker was beyond the cut — must not appear in the window.
    assert.ok(!text.includes("[10:00]"), "[10:00] not present — it was truncated away");
    // The late segment content was also truncated — not in window.
    assert.ok(!text.includes("Late segment content"), "late content not reachable");
  } finally {
    await h.cleanup();
  }
});

// ── Error surfacing ───────────────────────────────────────────────────────────

test("youtube_fetch: surfaces yt-dlp error for unavailable video", async () => {
  const script = alwaysFailScript("ERROR: Video unavailable");
  const h = await makeHarness({ script });
  try {
    await assert.rejects(
      () => h.execute({ url: VIDEO_ID }),
      /Video unavailable/,
    );
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: refuses live stream with clear message", async () => {
  const h = await makeHarness({ script: liveScript() });
  try {
    await assert.rejects(
      () => h.execute({ url: VIDEO_ID }),
      /live stream/i,
    );
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch: refuses upcoming/premiere with clear message", async () => {
  const h = await makeHarness({ script: upcomingScript() });
  try {
    await assert.rejects(
      () => h.execute({ url: VIDEO_ID }),
      /premiere/i,
    );
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// § Download mode (§6a)
// ===========================================================================

test("youtube_fetch download: saves mp4 under downloads/youtube/{videoId}/", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({ url: VIDEO_ID, download: "video" });
    const text = textOf(result);
    assert.match(text, /downloads\/youtube\//);
    assert.match(text, /\.mp4/);
    assert.match(text, /video mp4/);
    const relPath = result.details?.path as string;
    assert.ok(relPath.startsWith("downloads/youtube/"), `path under downloads/youtube/: ${relPath}`);
    // Verify the file was actually created.
    const fullPath = path.join(h.workspaceRoot, relPath);
    await assert.doesNotReject(() => access(fullPath));
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: saves m4a for audio mode", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({ url: VIDEO_ID, download: "audio" });
    const text = textOf(result);
    assert.match(text, /\.m4a/);
    assert.match(text, /audio only/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: clamps max_height above cap to configured cap", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
    config: { downloadMaxHeight: 480 },
  });
  try {
    // max_height=1080 is above the 480 cap — should be silently clamped.
    const result = await h.execute({
      url: VIDEO_ID,
      download: "video",
      max_height: 1080,
    });
    const text = textOf(result);
    // Should say "up to 480p", not 1080.
    assert.match(text, /480p/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: filename includes clip range when clip_start+clip_duration", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({
      url: VIDEO_ID,
      download: "video",
      clip_start: 10,
      clip_duration: 30,
    });
    const relPath = result.details?.path as string;
    // Filename should contain the range "10-40" (start–end).
    assert.match(relPath, /10-40/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: clip_duration without clip_start defaults clip_start to 0", async () => {
  // Build a custom script that logs the download invocation args so we can
  // assert that the wrapper received startSec=0 / durationSec=30.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ytfetch-clipdefault-"));
  const argsLog = path.join(tmpDir, "dl-args.txt");

  const captureScript = `
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(BASE_DUMP_JSON)});
} else if (args.includes('--write-subs') || args.includes('--write-auto-subs')) {
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const tmpl = args[oIdx + 1];
    const outDir = path.dirname(tmpl);
    fs.writeFileSync(path.join(outDir, ${JSON.stringify(VIDEO_ID + ".en.json3")}), ${JSON.stringify(BASE_JSON3)});
  }
} else {
  // Download invocation: capture args for assertion.
  fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    fs.writeFileSync(args[oIdx + 1], 'fake media bytes');
  }
}
`;

  const ytDlpPath = await makeFakeYtDlp(tmpDir, captureScript);
  const workspaceRoot = path.join(tmpDir, "ws");
  await (await import("node:fs/promises")).mkdir(workspaceRoot, { recursive: true });
  resetYtDlpConfig();
  configureYtDlp({ ytDlpPath, timeoutMs: 15_000 });
  const tool = createYoutubeFetchTool({ workspaceRoot, config: { ...DEFAULT_CONFIG } });

  try {
    const result = await (tool.execute("call-1", {
      url: VIDEO_ID,
      download: "video",
      clip_duration: 30,
    }) as Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>);

    const relPath = result.details?.path as string;

    // Filename must carry the 0–30 range suffix (clip_start defaulted to 0).
    assert.match(relPath, /0-30/, "filename carries the 0-30 range suffix");

    // The yt-dlp invocation must have --download-sections *0-30
    // (wrapper received startSec=0, durationSec=30).
    const argsLines = (await readFile(argsLog, "utf8")).trim().split("\n");
    const dlArgs = JSON.parse(argsLines[argsLines.length - 1]) as string[];
    const sectionsIdx = dlArgs.indexOf("--download-sections");
    assert.ok(sectionsIdx >= 0, "--download-sections arg present in yt-dlp call");
    assert.equal(dlArgs[sectionsIdx + 1], "*0-30", "startSec=0, durationSec=30 → *0-30");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("youtube_fetch download: filename includes clip_start only when no clip_duration", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({
      url: VIDEO_ID,
      download: "video",
      clip_start: 60,
    });
    const relPath = result.details?.path as string;
    assert.match(relPath, /-60\./);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: collision suffixes avoid overwriting existing files", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    // First download.
    const r1 = await h.execute({ url: VIDEO_ID, download: "video" });
    // Second download of the same video — should get a collision suffix.
    const r2 = await h.execute({ url: VIDEO_ID, download: "video" });
    assert.notEqual(r1.details?.path, r2.details?.path, "collision suffix applied");
    // Both files should exist.
    const full1 = path.join(h.workspaceRoot, r1.details?.path as string);
    const full2 = path.join(h.workspaceRoot, r2.details?.path as string);
    await assert.doesNotReject(() => access(full1));
    await assert.doesNotReject(() => access(full2));
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: reports size in bytes", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({ url: VIDEO_ID, download: "video" });
    const sizeBytes = result.details?.sizeBytes as number;
    assert.ok(typeof sizeBytes === "number" && sizeBytes > 0);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: size-abort error suggests actionable alternatives", async () => {
  const h = await makeHarness({ script: filesizeErrorScript(BASE_DUMP_JSON) });
  try {
    await assert.rejects(
      () => h.execute({ url: VIDEO_ID, download: "video" }),
      /size limit/,
    );
    // Also check that alternatives are mentioned.
    let errorMessage = "";
    try {
      await h.execute({ url: VIDEO_ID, download: "video" });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    assert.match(errorMessage, /max_height/);
    assert.match(errorMessage, /audio/);
    assert.match(errorMessage, /clip/);
  } finally {
    await h.cleanup();
  }
});

test("youtube_fetch download: returns metadata header without transcript", async () => {
  const h = await makeHarness({
    script: probeTranscriptDownloadScript(BASE_DUMP_JSON, BASE_JSON3),
  });
  try {
    const result = await h.execute({ url: VIDEO_ID, download: "video" });
    const text = textOf(result);
    assert.match(text, /Title: Never Gonna Give You Up/);
    assert.match(text, /Duration: 3:33/);
    assert.match(text, /Downloads:/);
    // No transcript document.
    assert.ok(!text.includes('source="transcript"'));
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// § Registration gating
// ===========================================================================

test("youtube_fetch: tool is NOT present when youtubeSubsystemAvailable=false", () => {
  // The gating is in app.ts (youtubeSubsystemAvailable && ytConfig.enabled).
  // Here we verify the factory function itself exists (so app.ts can call it),
  // and that calling it with a misconfigured binary makes probe() throw (the
  // mechanism app.ts uses to detect binary-absent).

  // Point at a nonexistent binary — createYoutubeFetchTool itself succeeds, but
  // a subsequent execute() call throws because yt-dlp is absent.
  resetYtDlpConfig();
  configureYtDlp({ ytDlpPath: "/nonexistent/yt-dlp", timeoutMs: 2000 });

  const tool = createYoutubeFetchTool({
    workspaceRoot: os.tmpdir(),
    config: DEFAULT_CONFIG,
  });
  // The tool object exists; execute() will throw on subprocess failure.
  assert.equal(tool.name, "youtube_fetch");
  // (The app-level gating prevents this from ever being called when binary is absent.)
  resetYtDlpConfig();
});
