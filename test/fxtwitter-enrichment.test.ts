import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { EnrichmentWorker, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { Storage, LinkPreviewRow } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { FxTwitterClient } from "../src/fxtwitter/client.js";
import { resolveFxTwitterConfig, parseXTweetPayload, type FxApiTweet, type FxTwitterConfig } from "../src/fxtwitter/types.js";

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$msg`,
    externalId: "$msg",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function baseTweet(overrides: Partial<FxApiTweet> = {}): FxApiTweet {
  return {
    id: "111",
    url: "https://x.com/frieren/status/111",
    text: "Tweet text here",
    created_timestamp: 1_760_000_000,
    author: { name: "Frieren Daily", screen_name: "frieren" },
    replies: 12,
    retweets: 340,
    likes: 4521,
    views: 120034,
    ...overrides,
  };
}

interface Harness {
  worker: EnrichmentWorker;
  persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  synapseBodies: string[];
  fetchedUrls: string[];
  clientCalls: Array<{ statusId: string; screenName?: string }>;
  entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
  workspaceRoot: string;
}

async function makeHarness(opts: {
  tweets?: Record<string, FxApiTweet | Error>;
  config?: Partial<FxTwitterConfig>;
  synapseSources?: Array<{ url: string; sourceKind: string; title?: string; description?: string }>;
  failFetchUrls?: Set<string>;
  maxPreviewsPerMessage?: number;
}): Promise<Harness> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "fxtw-test-"));
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const synapseBodies: string[] = [];
  const fetchedUrls: string[] = [];
  const clientCalls: Array<{ statusId: string; screenName?: string }> = [];
  const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: EnrichmentLogger = {
    info: (msg, data) => entries.push({ level: "info", msg, data }),
    warn: (msg, data) => entries.push({ level: "warn", msg, data }),
    error: (msg, data) => entries.push({ level: "error", msg, data }),
  };
  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
  } as unknown as Storage;
  const capabilities = {
    messageSummary: async () => null,
    downloadMedia: async () => {
      throw new Error("not under test");
    },
    resolveLinkPreviews: async (params: { bodyText: string }) => {
      synapseBodies.push(params.bodyText);
      return { textBlocks: [], media: [], sources: opts.synapseSources ?? [] };
    },
    memberInfo: async () => ({}),
  } as unknown as EnrichmentCapabilities;
  const fetchClient = {
    fetch: async (url: string) => {
      fetchedUrls.push(url);
      if (opts.failFetchUrls?.has(url)) {
        throw new Error(`download refused for ${url}`);
      }
      const tmpPath = path.join(os.tmpdir(), `fxtw-fetch-${randomBytes(6).toString("hex")}`);
      await writeFile(tmpPath, Buffer.from(`content of ${url}`));
      const contentType = url.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
      return { path: tmpPath, sizeBytes: 16, contentType, finalUrl: url, statusCode: 200 };
    },
  } as unknown as FetchClient;
  const client = {
    fetchStatus: async (statusId: string, screenName?: string) => {
      clientCalls.push({ statusId, screenName });
      const entry = opts.tweets?.[statusId];
      if (!entry) throw new Error(`no tweet fixture for ${statusId}`);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  } as unknown as FxTwitterClient;
  const worker = new EnrichmentWorker({
    storage,
    capabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: opts.maxPreviewsPerMessage ?? 3,
    fxtwitter: { client, config: { ...resolveFxTwitterConfig(), ...opts.config } },
    logger,
  });
  return { worker, persisted, synapseBodies, fetchedUrls, clientCalls, entries, workspaceRoot };
}

function previews(h: Harness): LinkPreviewRow[] {
  return h.persisted[0]?.result.linkPreviews ?? [];
}

async function cleanup(h: Harness): Promise<void> {
  await rm(h.workspaceRoot, { recursive: true, force: true });
}

// ── Partitioning ─────────────────────────────────────────────────────────────

test("X status URLs are stripped from the Synapse body and enriched via FxTwitter", async () => {
  const h = await makeHarness({ tweets: { "111": baseTweet() } });
  try {
    await h.worker.process(chatEvent({
      body: "look https://x.com/frieren/status/111 and https://example.com/page",
    }));

    assert.equal(h.synapseBodies.length, 1);
    assert.ok(!h.synapseBodies[0].includes("x.com/frieren/status"), "X URL stripped from Synapse body");
    assert.ok(h.synapseBodies[0].includes("https://example.com/page"), "other URL kept");

    assert.equal(h.clientCalls.length, 1);
    assert.deepEqual(h.clientCalls[0], { statusId: "111", screenName: "frieren" });

    const lps = previews(h);
    assert.equal(lps.length, 1);
    assert.equal(lps[0].url, "https://x.com/frieren/status/111");
    assert.equal(lps[0].source_kind, "fx_twitter");
    assert.equal(lps[0].site_name, "X");
    assert.equal(lps[0].title, "Frieren Daily (@frieren)");
    assert.equal(lps[0].fetch_status, "complete");
    const payload = parseXTweetPayload(lps[0].payload_json);
    assert.ok(payload, "payload_json parses");
    assert.equal(payload.tweet.text, "Tweet text here");
    assert.equal(payload.tweet.stats?.likes, 4521);
    assert.ok(lps[0].description?.includes("Tweet text here"), "flat description carries the text");
  } finally {
    await cleanup(h);
  }
});

test("shared preview cap allocates by order of first appearance across both kinds", async () => {
  const h = await makeHarness({
    tweets: { "111": baseTweet(), "222": baseTweet({ id: "222" }) },
    synapseSources: [{ url: "https://example.com/page", sourceKind: "synapse", title: "Example" }],
    maxPreviewsPerMessage: 2,
  });
  try {
    await h.worker.process(chatEvent({
      body: "https://example.com/page then https://x.com/a/status/111 then https://x.com/b/status/222",
    }));
    const lps = previews(h).sort((a, b) => a.preview_index - b.preview_index);
    assert.equal(lps.length, 2, "cap shared across both kinds");
    assert.equal(lps[0].url, "https://example.com/page");
    assert.equal(lps[0].preview_index, 0);
    assert.equal(lps[1].url, "https://x.com/a/status/111");
    assert.equal(lps[1].preview_index, 1);
    assert.equal(h.clientCalls.length, 1, "the dropped X URL is never fetched");
  } finally {
    await cleanup(h);
  }
});

test("fxtwitter.enabled=false produces no X preview at all and still strips the Synapse body", async () => {
  const h = await makeHarness({ tweets: { "111": baseTweet() }, config: { enabled: false } });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111 plus https://example.com/x" }));
    assert.equal(h.clientCalls.length, 0);
    assert.equal(previews(h).length, 0, "no Synapse fallback for X URLs");
    assert.ok(!h.synapseBodies[0].includes("x.com/frieren"), "still stripped from the Synapse body");
  } finally {
    await cleanup(h);
  }
});

test("reply-context bodies get identical treatment (context=reply, reply_preview_media role)", async () => {
  const h = await makeHarness({
    tweets: { "111": baseTweet({ media: { photos: [{ url: "https://pbs.twimg.com/p1.jpg" }] } }) },
  });
  // Inject a reply context by giving the capability a summary.
  const capabilities = (h.worker as unknown as { options: { capabilities: EnrichmentCapabilities } }).options.capabilities;
  capabilities.messageSummary = async () => ({
    eventId: "$orig",
    sender: "@bob:example.org",
    body: "see https://x.com/frieren/status/111",
    msgtype: "m.text",
    timestamp: "2026-06-10T00:00:00Z",
  });
  try {
    await h.worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));
    const lps = previews(h);
    assert.equal(lps.length, 1);
    assert.equal(lps[0].context, "reply");
    const assets = h.persisted[0].result.mediaAssets;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].role, "reply_preview_media");
    assert.equal(assets[0].link_preview_id, lps[0].id);
  } finally {
    await cleanup(h);
  }
});

// ── Failure handling ─────────────────────────────────────────────────────────

test("an FxTwitter fetch failure records a failed preview row and a warning, never a retry", async () => {
  const h = await makeHarness({ tweets: { "111": new Error("FxTwitter error (HTTP 404): NOT_FOUND") } });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const lps = previews(h);
    assert.equal(lps.length, 1);
    assert.equal(lps[0].fetch_status, "failed");
    assert.match(String(lps[0].error), /NOT_FOUND/);
    assert.equal(lps[0].payload_json ?? null, null);
    const warned = h.entries.find((e) => e.msg === "enrichment_fxtwitter_failed");
    assert.ok(warned, "failure logged");
    assert.equal(h.persisted.length, 1, "event enrichment still completes");
  } finally {
    await cleanup(h);
  }
});

// ── Payload building ─────────────────────────────────────────────────────────

test("payload carries truncation flags, polls, community notes, and one-level quote nesting", async () => {
  const longText = "y".repeat(3000);
  const h = await makeHarness({
    config: { maxTextChars: 100 },
    tweets: {
      "111": baseTweet({
        text: longText,
        community_note: longText,
        poll: {
          choices: [{ label: "Yes", count: 60, percentage: 60 }, { label: "No", count: 40, percentage: 40 }],
          total_votes: 100,
        },
        quote: {
          id: "999",
          text: "quoted text",
          author: { name: "Other", screen_name: "other" },
          quote: { id: "888", text: "quote of quote — must not nest" },
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const payload = parseXTweetPayload(previews(h)[0].payload_json);
    assert.ok(payload);
    assert.equal(payload.tweet.textTruncated, true);
    assert.equal(payload.tweet.text?.length, 100);
    assert.ok(payload.tweet.text?.endsWith("…"));
    assert.equal(payload.tweet.communityNoteTruncated, true);
    assert.equal(payload.tweet.poll?.totalVotes, 100);
    assert.equal(payload.tweet.poll?.choices.length, 2);
    assert.equal(payload.tweet.quote?.id, "999");
    assert.equal(payload.tweet.quote?.text, "quoted text");
    assert.equal(payload.tweet.quote?.quote, undefined, "quote nesting is one level only");
  } finally {
    await cleanup(h);
  }
});

test("tolerant parsing: a minimal tweet with missing fields still produces a payload", async () => {
  const h = await makeHarness({ tweets: { "111": { id: "111" } } });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/i/status/111" }));
    const lp = previews(h)[0];
    assert.equal(lp.fetch_status, "complete");
    assert.equal(lp.title, null);
    const payload = parseXTweetPayload(lp.payload_json);
    assert.ok(payload);
    assert.equal(payload.tweet.id, "111");
  } finally {
    await cleanup(h);
  }
});

// ── Media rules ──────────────────────────────────────────────────────────────

test("exactly one photo downloads as a photo asset with alt text", async () => {
  const h = await makeHarness({
    tweets: {
      "111": baseTweet({
        media: { photos: [{ url: "https://pbs.twimg.com/one.jpg", altText: "a cat" }] },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const payload = parseXTweetPayload(previews(h)[0].payload_json);
    assert.equal(payload?.tweet.media?.length, 1);
    const slot = payload!.tweet.media![0];
    assert.equal(slot.kind, "photo");
    assert.equal(slot.index, 1);
    assert.equal(slot.altText, "a cat");
    const asset = h.persisted[0].result.mediaAssets.find((a) => a.id === slot.assetId);
    assert.ok(asset);
    assert.equal(asset.media_type, "image");
    assert.equal(asset.download_status, "complete");
    assert.equal(asset.caption_status, "pending", "post-pass marks it captionable");
    assert.equal(asset.role, "preview_media");
  } finally {
    await cleanup(h);
  }
});

test("two or more photos collapse into one mosaic asset with joined alt texts", async () => {
  const h = await makeHarness({
    tweets: {
      "111": baseTweet({
        media: {
          photos: [
            { url: "https://pbs.twimg.com/a.jpg", altText: "first" },
            { url: "https://pbs.twimg.com/b.jpg", altText: "second" },
            { url: "https://pbs.twimg.com/c.jpg" },
          ],
          mosaic: { formats: { jpeg: "https://mosaic.fxtwitter.com/m.jpg" } },
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const payload = parseXTweetPayload(previews(h)[0].payload_json);
    assert.equal(payload?.tweet.media?.length, 1);
    const slot = payload!.tweet.media![0];
    assert.equal(slot.kind, "mosaic");
    assert.equal(slot.photoCount, 3);
    assert.equal(slot.altText, "first / second");
    assert.deepEqual(h.fetchedUrls, ["https://mosaic.fxtwitter.com/m.jpg"], "only the mosaic is fetched");
  } finally {
    await cleanup(h);
  }
});

test("mosaic URL absent falls back to individual indexed photos", async () => {
  const h = await makeHarness({
    tweets: {
      "111": baseTweet({
        media: { photos: [{ url: "https://pbs.twimg.com/a.jpg" }, { url: "https://pbs.twimg.com/b.jpg" }] },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const slots = parseXTweetPayload(previews(h)[0].payload_json)?.tweet.media ?? [];
    assert.equal(slots.length, 2);
    assert.deepEqual(slots.map((s) => s.kind), ["photo", "photo"]);
    assert.deepEqual(slots.map((s) => s.index), [1, 2]);
  } finally {
    await cleanup(h);
  }
});

test("prefer_mosaic=false downloads individual photos even when the mosaic exists", async () => {
  const h = await makeHarness({
    config: { preferMosaic: false },
    tweets: {
      "111": baseTweet({
        media: {
          photos: [{ url: "https://pbs.twimg.com/a.jpg" }, { url: "https://pbs.twimg.com/b.jpg" }],
          mosaic: { formats: { jpeg: "https://mosaic.fxtwitter.com/m.jpg" } },
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const slots = parseXTweetPayload(previews(h)[0].payload_json)?.tweet.media ?? [];
    assert.equal(slots.length, 2);
    assert.ok(!h.fetchedUrls.includes("https://mosaic.fxtwitter.com/m.jpg"));
  } finally {
    await cleanup(h);
  }
});

test("videos and GIFs download the direct mp4 as video assets, capped per node", async () => {
  const h = await makeHarness({
    config: { maxVideosPerTweet: 2 },
    tweets: {
      "111": baseTweet({
        media: {
          videos: [
            { url: "https://video.twimg.com/v1.mp4", type: "video", duration: 18 },
            { url: "https://video.twimg.com/v2.mp4", type: "gif", duration: 3 },
            { url: "https://video.twimg.com/v3.mp4", type: "video" },
          ],
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const slots = parseXTweetPayload(previews(h)[0].payload_json)?.tweet.media ?? [];
    assert.equal(slots.length, 2, "max_videos_per_tweet caps the node");
    assert.equal(slots[0].kind, "video");
    assert.equal(slots[0].durationSeconds, 18);
    assert.equal(slots[1].kind, "gif");
    const assets = h.persisted[0].result.mediaAssets;
    for (const slot of slots) {
      const asset = assets.find((a) => a.id === slot.assetId);
      assert.equal(asset?.media_type, "video");
      assert.equal(asset?.caption_status, "pending", "videos route to the captioning pool");
    }
  } finally {
    await cleanup(h);
  }
});

test("a failed video download falls back to its thumbnail as a video_thumbnail image slot", async () => {
  const h = await makeHarness({
    failFetchUrls: new Set(["https://video.twimg.com/v1.mp4"]),
    tweets: {
      "111": baseTweet({
        media: {
          videos: [{ url: "https://video.twimg.com/v1.mp4", thumbnail_url: "https://pbs.twimg.com/t1.jpg", type: "video", duration: 18 }],
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const slots = parseXTweetPayload(previews(h)[0].payload_json)?.tweet.media ?? [];
    assert.equal(slots.length, 1);
    assert.equal(slots[0].kind, "video_thumbnail");
    const asset = h.persisted[0].result.mediaAssets.find((a) => a.id === slots[0].assetId);
    assert.equal(asset?.media_type, "image");
    assert.equal(asset?.download_status, "complete");
    assert.match(String(asset?.download_error), /download refused/, "fallback notes the original failure");
  } finally {
    await cleanup(h);
  }
});

test("a failed video with no thumbnail keeps the failed slot visible", async () => {
  const h = await makeHarness({
    failFetchUrls: new Set(["https://video.twimg.com/v1.mp4"]),
    tweets: {
      "111": baseTweet({ media: { videos: [{ url: "https://video.twimg.com/v1.mp4", type: "video" }] } }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const slots = parseXTweetPayload(previews(h)[0].payload_json)?.tweet.media ?? [];
    assert.equal(slots.length, 1);
    assert.equal(slots[0].kind, "video");
    const asset = h.persisted[0].result.mediaAssets.find((a) => a.id === slots[0].assetId);
    assert.equal(asset?.download_status, "failed");
    assert.equal(asset?.caption_status, "skipped", "failed downloads are never captioned");
  } finally {
    await cleanup(h);
  }
});

test("quote media stays attached to the quote node (provenance is structural)", async () => {
  const h = await makeHarness({
    tweets: {
      "111": baseTweet({
        media: { videos: [{ url: "https://video.twimg.com/main.mp4", type: "video" }] },
        quote: {
          id: "999",
          author: { name: "Other", screen_name: "other" },
          text: "quoted",
          media: { photos: [{ url: "https://pbs.twimg.com/q1.jpg" }] },
        },
      }),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://x.com/frieren/status/111" }));
    const payload = parseXTweetPayload(previews(h)[0].payload_json);
    assert.equal(payload?.tweet.media?.length, 1);
    assert.equal(payload?.tweet.media?.[0].kind, "video");
    assert.equal(payload?.tweet.quote?.media?.length, 1);
    assert.equal(payload?.tweet.quote?.media?.[0].kind, "photo");
  } finally {
    await cleanup(h);
  }
});
