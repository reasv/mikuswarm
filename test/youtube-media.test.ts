/**
 * Tests for YouTube routing in src/tools/media.ts (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §7 T3).
 *
 * Strategy: fake yt-dlp binary (same pattern as youtube-fetch.test.ts), mock
 * InferenceClient, mock FetchClient. No real subprocess network or ffmpeg.
 *
 * Covers:
 *  - Recognized YouTube URL takes the YouTube download path (not FetchClient)
 *  - Unrecognized / plain URLs use FetchClient unchanged
 *  - start_time ?? urlT ?? 0 precedence
 *  - Synthesized truncation warning exact-form (segment mid-video)
 *  - No warning when whole video fits in one segment
 *  - Double-seek prevention: startTime NOT passed to caption client for YouTube sources
 *  - Cache hit on second call with same (videoId, start, duration, resolution) key
 *  - Different start_time → different cache key → new download
 *  - Subsystem unavailable (youtube context absent) → FetchClient fallthrough
 *  - Live / upcoming refusal with clear error
 *  - Billing: recordToolUsage called with usage from caption result
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMediaTool, type MediaToolContext, type YoutubeMediaContext } from "../src/tools/media.js";
import { configureYtDlp, resetYtDlpConfig } from "../src/youtube/ytdlp.js";
import type { InferenceClient } from "../src/captioning/inference-client.js";
import type { CaptionRequest, CaptionResponse } from "../src/captioning/inference-client.js";
import type { ToolUsageRecord } from "../src/tools/image-gen.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal format-timestamp helper — mirrors formatTimestamp in inference-client.ts */
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Build a mock InferenceClient for "video" modality that:
 *  - Records every CaptionRequest into the provided array
 *  - Replicates formatTruncationWarning (context:"tool") when youtubeSegment.truncated
 *    is true, so the end-to-end warning text can be verified
 *  - Returns mock usage so recordToolUsage fires
 */
function makeMockVideoClient(captionRequests: CaptionRequest[]): InferenceClient {
  return {
    caption: async (request: CaptionRequest): Promise<CaptionResponse> => {
      captionRequests.push(request);
      const body = "[mock video caption]";
      let caption = body;
      if (request.youtubeSegment?.truncated && request.youtubeSegment.processedRange) {
        const [start, end] = request.youtubeSegment.processedRange;
        const total = request.youtubeSegment.totalDuration;
        // Exact form from inference-client.ts formatTruncationWarning, context:"tool"
        caption =
          `Warning: media duration is ${fmt(total)}. ` +
          `Only ${fmt(start)}-${fmt(end)} was processed (duration limit). ` +
          `Use start_time to analyze a different segment.\n\n${body}`;
      }
      return {
        caption,
        model: "mock-model",
        logicalModelId: "mock-model",
        provider: null,
        usage: { input: 36000, output: 150, cacheRead: 0, cacheWrite: 0 },
        cost: 0.05,
      };
    },
  } as unknown as InferenceClient;
}

/** A minimal FetchClient mock that records fetched URLs and throws (YouTube should never reach it). */
function makeMockFetchClient(fetchedUrls: string[]): MediaToolContext["fetchClient"] {
  return {
    fetch: async (url: string) => {
      fetchedUrls.push(url);
      throw new Error(`FetchClient.fetch called unexpectedly for: ${url}`);
    },
  } as unknown as MediaToolContext["fetchClient"];
}

/** FetchClient that succeeds, returning a video/mp4 temp file — for the fallthrough tests. */
async function makeFetchClientReturningVideo(tmpDir: string, fetchedUrls: string[]): Promise<MediaToolContext["fetchClient"]> {
  const fakeVideoPath = path.join(tmpDir, "fetched-video.mp4");
  await writeFile(fakeVideoPath, Buffer.from("fake-video-bytes"));
  return {
    fetch: async (url: string) => {
      fetchedUrls.push(url);
      return {
        path: fakeVideoPath,
        statusCode: 200,
        contentType: "video/mp4",
      };
    },
  } as unknown as MediaToolContext["fetchClient"];
}

// ---------------------------------------------------------------------------
// Fake yt-dlp script builders
// ---------------------------------------------------------------------------

const VIDEO_ID = "dQw4w9WgXcY";
const VIDEO_DURATION_LONG = 2832; // 47:12 — longer than max_duration_seconds
const VIDEO_DURATION_SHORT = 90;  // 1:30 — fits within max_duration_seconds (120s)

function makeDumpJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: VIDEO_ID,
    title: "Never Gonna Give You Up",
    channel: "Rick Astley",
    duration: VIDEO_DURATION_LONG,
    is_live: false,
    live_status: "not_live",
    ...overrides,
  });
}

/**
 * Fake yt-dlp Node.js script.
 *  - --dump-json: writes `dumpJson` to stdout
 *  - download mode: creates a file at the -o argument path (with an optional call counter file)
 */
function makeFakeYtDlpScript(dumpJson: string, counterFile?: string): string {
  return `
const args = process.argv.slice(2);
const fs = require('fs');
const path = require('path');
if (args.includes('--dump-json')) {
  process.stdout.write(${JSON.stringify(dumpJson)});
} else {
  // Download mode: create a file at -o path
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const outPath = args[oIdx + 1];
    fs.writeFileSync(outPath, Buffer.alloc(64, 0x00));  // fake mp4 bytes
  }
  ${counterFile ? `try { fs.writeFileSync(${JSON.stringify(counterFile)}, String((Number(fs.existsSync(${JSON.stringify(counterFile)}) ? fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8') : '0') || 0) + 1)); } catch {}` : ""}
}
`;
}

async function makeFakeYtDlp(tmpDir: string, script: string): Promise<string> {
  const p = path.join(tmpDir, "yt-dlp");
  await writeFile(p, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return p;
}

// ---------------------------------------------------------------------------
// Build a minimal MediaToolContext for tests
// ---------------------------------------------------------------------------

function makeContext(
  tmpDir: string,
  overrides: Partial<MediaToolContext> = {},
): MediaToolContext {
  const captionRequests: CaptionRequest[] = [];
  const mockClient = makeMockVideoClient(captionRequests);

  const baseYoutube: YoutubeMediaContext = {
    maxDownloadBytes: 209_715_200,
    maxResolution: 480,
    maxDurationSeconds: 120,
    cachePath: path.join(tmpDir, "media-cache"),
    cacheMaxBytes: 21_474_836_480,
    cacheTargetBytes: 16_106_127_360,
  };

  return {
    workspaceRoot: tmpDir,
    clients: new Map([["video", mockClient]]),
    defaultPrompts: new Map([["video", "Describe the video."]]),
    modelHasVision: false,
    maxFetchBytes: 1_073_741_824,
    fetchClient: makeMockFetchClient([]),
    youtube: baseYoutube,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("media: recognized YouTube URL uses YouTube download path, not FetchClient", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const counterFile = path.join(tmpDir, "download-count.txt");
    const script = makeFakeYtDlpScript(makeDumpJson(), counterFile);
    const binaryPath = await makeFakeYtDlp(tmpDir, script);

    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const fetchedUrls: string[] = [];
      const fetchClient = makeMockFetchClient(fetchedUrls);

      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        fetchClient,
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });

      const tool = createMediaTool(ctx);
      const result = await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      // FetchClient must NOT have been called
      assert.equal(fetchedUrls.length, 0, "FetchClient should not be called for YouTube URL");
      // yt-dlp download should have been called (counter file written)
      const { readFile } = await import("node:fs/promises");
      const count = Number(await readFile(counterFile, "utf8").catch(() => "0"));
      assert.ok(count >= 1, "yt-dlp download was called");
      // Result must be non-empty
      const text = (result.content[0] as { text: string }).text;
      assert.ok(text.includes("mock video caption"), "caption appears in output");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: unrecognized URL uses FetchClient unchanged", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const fetchedUrls: string[] = [];
    const fetchClient = await makeFetchClientReturningVideo(tmpDir, fetchedUrls);
    const captionRequests: CaptionRequest[] = [];
    const ctx = makeContext(tmpDir, {
      fetchClient,
      clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
    });

    const tool = createMediaTool(ctx);
    const plainUrl = "https://example.com/video.mp4";
    await tool.execute("call-1", { media: plainUrl }).catch(() => {});
    assert.ok(fetchedUrls.includes(plainUrl), "FetchClient called for plain URL");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: start_time ?? urlT ?? 0 precedence — tool param wins over url t=", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const downloadArgs: string[][] = [];

      // Intercept the args passed to download by inspecting the cache key.
      // We do this by using a different start_time and checking youtubeSegment.processedRange.
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      // URL has t=60, tool start_time=90 → tool param wins
      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=60`,
        start_time: 90,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      // processedRange should start at 90 (tool param), not 60 (url t=)
      assert.equal(seg.processedRange[0], 90, "tool start_time takes precedence over url t=");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: start_time=0 wins over url t= (guards ?? vs || regression)", async () => {
  // Explicit start_time=0 is falsy; using || instead of ?? would silently ignore it
  // and fall through to the url t= value.  This test pins the nullish-coalescing
  // semantics: 0 must be treated as a valid provided value, not as "unset".
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      // URL carries t=120; explicit start_time=0 must win (0 is "provided", not "absent").
      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=120`,
        start_time: 0,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      assert.equal(seg.processedRange[0], 0, "explicit start_time=0 takes precedence over url t=120");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: start_time ?? urlT ?? 0 — url t= used when no tool param", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=300`,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      assert.equal(seg.processedRange[0], 300, "url t= used when no tool start_time");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: start_time ?? urlT ?? 0 — defaults to 0 when neither is set", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      assert.equal(seg.processedRange[0], 0, "defaults to startSec=0");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: truncation warning exact-form when segment is mid-video", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    // 47:12 video — much longer than max_duration_seconds=120
    const binaryPath = await makeFakeYtDlp(
      tmpDir,
      makeFakeYtDlpScript(makeDumpJson({ duration: VIDEO_DURATION_LONG })),
    );
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      // start at 5:00 (300s) of a 47:12 video with max_duration=120s
      const result = await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        start_time: 300,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      assert.equal(seg.truncated, true, "truncated=true for segment mid-video");
      assert.deepEqual(seg.processedRange, [300, 420], "processedRange=[300,420]");
      assert.equal(seg.totalDuration, VIDEO_DURATION_LONG, "totalDuration matches full video");

      // Verify the warning appears in the tool output (the mock emits it when truncated)
      const text = (result.content[0] as { text: string }).text;
      // 47:12 = 2832s: fmt(2832) = "47:12"; fmt(300) = "5:00"; fmt(420) = "7:00"
      assert.ok(
        text.includes("Warning: media duration is 47:12."),
        `expected truncation warning in output, got: ${text}`,
      );
      assert.ok(text.includes("Only 5:00-7:00 was processed"), `expected range in warning: ${text}`);
      assert.ok(text.includes("Use start_time to analyze a different segment."), `expected hint in warning: ${text}`);
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: no truncation warning when whole video fits in one segment", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    // 1:30 video — shorter than max_duration_seconds=120
    const binaryPath = await makeFakeYtDlp(
      tmpDir,
      makeFakeYtDlpScript(makeDumpJson({ duration: VIDEO_DURATION_SHORT })),
    );
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      const result = await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      assert.equal(captionRequests.length, 1);
      const seg = captionRequests[0]!.youtubeSegment!;
      assert.equal(seg.truncated, false, "truncated=false when video fits");

      const text = (result.content[0] as { text: string }).text;
      assert.ok(!text.includes("Warning: media duration"), "no truncation warning when whole video fits");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: double-seek prevention — startTime NOT passed to caption for YouTube source", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      // Tool called with start_time=300; the segment is already cut, so startTime
      // must NOT be forwarded to the caption client.
      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        start_time: 300,
      });

      assert.equal(captionRequests.length, 1);
      assert.equal(
        captionRequests[0]!.startTime,
        undefined,
        "startTime must be undefined for YouTube segments (double-seek prevention)",
      );
      // But youtubeSegment must still carry the correct range
      assert.equal(captionRequests[0]!.youtubeSegment!.processedRange[0], 300);
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: cache hit — yt-dlp download called only once for same key", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const counterFile = path.join(tmpDir, "download-count.txt");
    const binaryPath = await makeFakeYtDlp(
      tmpDir,
      makeFakeYtDlpScript(makeDumpJson(), counterFile),
    );
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      const url = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
      // First call — cache miss → download
      await tool.execute("call-1", { media: url, start_time: 0 });
      // Second call — cache hit → no second download
      await tool.execute("call-2", { media: url, start_time: 0 });

      const { readFile } = await import("node:fs/promises");
      const count = Number(await readFile(counterFile, "utf8").catch(() => "0"));
      assert.equal(count, 1, "yt-dlp download called exactly once (second call is cache hit)");
      assert.equal(captionRequests.length, 2, "caption was called twice (one per tool call)");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: different start_time → different cache key → new download", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const counterFile = path.join(tmpDir, "download-count.txt");
    const binaryPath = await makeFakeYtDlp(
      tmpDir,
      makeFakeYtDlpScript(makeDumpJson(), counterFile),
    );
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      const url = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
      await tool.execute("call-1", { media: url, start_time: 0 });
      await tool.execute("call-2", { media: url, start_time: 300 });

      const { readFile } = await import("node:fs/promises");
      const count = Number(await readFile(counterFile, "utf8").catch(() => "0"));
      assert.equal(count, 2, "yt-dlp download called twice for different start_time values");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: subsystem unavailable (youtube context absent) → FetchClient fallthrough", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const fetchedUrls: string[] = [];
    const fetchClient = await makeFetchClientReturningVideo(tmpDir, fetchedUrls);
    const captionRequests: CaptionRequest[] = [];

    // No youtube context → subsystem unavailable path
    const ctx = makeContext(tmpDir, {
      fetchClient,
      clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      youtube: undefined,
    });
    const tool = createMediaTool(ctx);

    const ytUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    await tool.execute("call-1", { media: ytUrl });

    assert.ok(fetchedUrls.includes(ytUrl), "FetchClient should be called when youtube context is absent");
    // youtubeSegment must NOT be set
    if (captionRequests.length > 0) {
      assert.equal(
        captionRequests[0]!.youtubeSegment,
        undefined,
        "youtubeSegment must be absent when subsystem is unavailable",
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: live stream YouTube URL → clear error, not a download", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const liveJson = makeDumpJson({ is_live: true, live_status: "is_live", duration: undefined });
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(liveJson));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      const result = await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      const text = (result.content[0] as { text: string }).text;
      assert.ok(
        text.toLowerCase().includes("live"),
        `expected live-stream error message, got: ${text}`,
      );
      assert.equal(captionRequests.length, 0, "caption should not be called for live streams");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: upcoming YouTube URL → clear error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const upcomingJson = makeDumpJson({ is_live: false, live_status: "upcoming", duration: undefined });
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(upcomingJson));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const captionRequests: CaptionRequest[] = [];
      const ctx = makeContext(tmpDir, {
        clients: new Map([["video", makeMockVideoClient(captionRequests)]]),
      });
      const tool = createMediaTool(ctx);

      const result = await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      const text = (result.content[0] as { text: string }).text;
      assert.ok(
        text.toLowerCase().includes("premiere") || text.toLowerCase().includes("upcoming"),
        `expected upcoming error message, got: ${text}`,
      );
      assert.equal(captionRequests.length, 0, "caption should not be called for upcoming videos");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: recordToolUsage called with usage from caption result (billing)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const binaryPath = await makeFakeYtDlp(tmpDir, makeFakeYtDlpScript(makeDumpJson()));
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const usageRecords: ToolUsageRecord[] = [];
      const ctx = makeContext(tmpDir, {
        agentSessionId: "session-123",
        recordToolUsage: (record) => { usageRecords.push(record); },
      });
      const tool = createMediaTool(ctx);

      await tool.execute("call-1", {
        media: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      });

      assert.equal(usageRecords.length, 1, "recordToolUsage should be called once");
      const rec = usageRecords[0]!;
      assert.equal(rec.toolName, "media", "toolName is 'media'");
      assert.equal(rec.agentSessionId, "session-123");
      assert.ok(rec.usage !== null, "usage should be present");
      assert.ok(
        typeof rec.usage?.input === "number" && rec.usage.input > 0,
        "usage.input should be positive",
      );
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("media: youtu.be short URL recognized as YouTube and routed via download", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-yt-media-"));
  try {
    const counterFile = path.join(tmpDir, "download-count.txt");
    const binaryPath = await makeFakeYtDlp(
      tmpDir,
      makeFakeYtDlpScript(makeDumpJson(), counterFile),
    );
    configureYtDlp({ ytDlpPath: binaryPath });
    try {
      const fetchedUrls: string[] = [];
      const ctx = makeContext(tmpDir, {
        fetchClient: makeMockFetchClient(fetchedUrls),
      });
      const tool = createMediaTool(ctx);

      await tool.execute("call-1", { media: `https://youtu.be/${VIDEO_ID}` });

      assert.equal(fetchedUrls.length, 0, "FetchClient not called for youtu.be URL");
      const { readFile } = await import("node:fs/promises");
      const count = Number(await readFile(counterFile, "utf8").catch(() => "0"));
      assert.ok(count >= 1, "yt-dlp download called for youtu.be URL");
    } finally {
      resetYtDlpConfig();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
