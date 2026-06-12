import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createXFetchTool } from "../src/tools/x-fetch.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { FxTwitterClient } from "../src/fxtwitter/client.js";
import type { FxApiTweet } from "../src/fxtwitter/types.js";
import { resolveFxTwitterConfig } from "../src/fxtwitter/types.js";
import { buildInferenceImageOptions } from "../src/media/index.js";

const TOOL_CONFIG = resolveFxTwitterConfig().tool;

function baseTweet(overrides: Partial<FxApiTweet> = {}): FxApiTweet {
  return {
    id: "111",
    url: "https://x.com/frieren/status/111",
    text: "Full tweet text body",
    created_timestamp: 1_760_000_000,
    author: { name: "Frieren Daily", screen_name: "frieren" },
    replies: 12,
    retweets: 340,
    likes: 4521,
    views: 120034,
    media: {
      photos: [{ url: "https://pbs.twimg.com/p1.jpg", width: 800, height: 600, altText: "a cat" }],
      videos: [{ url: "https://video.twimg.com/v1.mp4", thumbnail_url: "https://pbs.twimg.com/t1.jpg", duration: 18, type: "video" }],
    },
    quote: {
      id: "999",
      url: "https://x.com/other/status/999",
      text: "Quoted tweet text",
      author: { name: "Other Person", screen_name: "other" },
      media: { photos: [{ url: "https://pbs.twimg.com/q1.jpg" }] },
    },
    ...overrides,
  };
}

interface Harness {
  workspaceRoot: string;
  fetchedUrls: string[];
  clientCalls: Array<{ statusId: string; screenName?: string }>;
  execute: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: Record<string, unknown>;
  }>;
}

async function makeHarness(opts: {
  tweet?: FxApiTweet | Error;
  config?: Partial<typeof TOOL_CONFIG>;
  imageBytes?: Buffer;
} = {}): Promise<Harness> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "xfetch-test-"));
  const fetchedUrls: string[] = [];
  const clientCalls: Array<{ statusId: string; screenName?: string }> = [];
  const imageBytes = opts.imageBytes ?? (await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer());
  const fetchClient = {
    fetch: async (url: string) => {
      fetchedUrls.push(url);
      const tmpPath = path.join(os.tmpdir(), `xfetch-fetch-${randomBytes(6).toString("hex")}`);
      const data = url.endsWith(".mp4") ? Buffer.from(`mp4 of ${url}`) : imageBytes;
      await writeFile(tmpPath, data);
      const contentType = url.endsWith(".mp4") ? "video/mp4" : "image/png";
      return { path: tmpPath, sizeBytes: data.byteLength, contentType, finalUrl: url, statusCode: 200 };
    },
  } as unknown as FetchClient;
  const client = {
    fetchStatus: async (statusId: string, screenName?: string) => {
      clientCalls.push({ statusId, screenName });
      const entry = opts.tweet ?? baseTweet();
      if (entry instanceof Error) throw entry;
      return entry;
    },
  } as unknown as FxTwitterClient;
  const tool = createXFetchTool({
    workspaceRoot,
    fetchClient,
    client,
    maxImageBytes: 5 * 1024 * 1024,
    inferenceImageOptions: buildInferenceImageOptions({}),
    config: { ...TOOL_CONFIG, ...opts.config },
  });
  return {
    workspaceRoot,
    fetchedUrls,
    clientCalls,
    execute: (params) => tool.execute("call-1", params) as ReturnType<Harness["execute"]>,
  };
}

function textOf(result: Awaited<ReturnType<Harness["execute"]>>): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// ── Document assembly & windowing ────────────────────────────────────────────

test("x_fetch assembles the document: header, stats, full text, numbered media, quote section", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: "https://x.com/frieren/status/111" });
    const text = textOf(result);
    assert.match(text, /Frieren Daily \(@frieren\)/);
    assert.match(text, /12 replies · 340 retweets · 4,521 likes · 120,034 views/);
    assert.match(text, /Full tweet text body/);
    assert.match(text, /\[1\] photo 800x600 alt="a cat" https:\/\/pbs\.twimg\.com\/p1\.jpg/);
    assert.match(text, /\[2\] video 18s https:\/\/video\.twimg\.com\/v1\.mp4/);
    assert.match(text, /── Quoted tweet ──/);
    assert.match(text, /Quoted tweet text/);
    assert.match(text, /\[3\] photo https:\/\/pbs\.twimg\.com\/q1\.jpg/, "indices continue across the quote");
    assert.equal(result.details?.mediaCount, 3);
    assert.equal(result.details?.truncated, false);
    assert.deepEqual(h.clientCalls, [{ statusId: "111", screenName: "frieren" }]);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("x_fetch windows long documents with offset continuation", async () => {
  const h = await makeHarness({ tweet: baseTweet({ text: "z".repeat(9000), media: undefined, quote: undefined }) });
  try {
    const first = await h.execute({ url: "111", max_chars: 100 });
    const firstText = textOf(first);
    assert.ok(firstText.includes("[truncated — continue with offset=100]"));
    assert.equal(first.details?.nextOffset, 100);
    assert.equal(first.details?.truncated, true);
    const total = first.details?.totalChars as number;
    assert.ok(total > 9000, "totalChars covers the assembled document");

    const second = await h.execute({ url: "111", max_chars: 100, offset: 100 });
    const secondText = textOf(second);
    assert.ok(!secondText.startsWith(firstText.slice(0, 40)), "second window continues, not repeats");
    assert.equal(second.details?.nextOffset, 200);

    const tail = await h.execute({ url: "111", offset: total - 10 });
    assert.equal(tail.details?.truncated, false);
    assert.equal(tail.details?.nextOffset, null);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("x_fetch caps the assembled document at max_total_chars", async () => {
  const h = await makeHarness({
    tweet: baseTweet({ text: "z".repeat(100_000), media: undefined, quote: undefined }),
    config: { maxTotalChars: 5000 },
  });
  try {
    const result = await h.execute({ url: "111" });
    assert.equal(result.details?.totalChars, 5000);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("x_fetch accepts a bare numeric status id and rejects unrecognizable input", async () => {
  const h = await makeHarness();
  try {
    await h.execute({ url: "111" });
    assert.deepEqual(h.clientCalls, [{ statusId: "111", screenName: undefined }]);
    await assert.rejects(
      () => h.execute({ url: "https://example.com/not-a-tweet" }),
      /Not a recognizable X status URL/,
    );
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("x_fetch surfaces FxTwitter API errors cleanly", async () => {
  const h = await makeHarness({ tweet: new Error("FxTwitter error (HTTP 404, code 404): NOT_FOUND") });
  try {
    await assert.rejects(() => h.execute({ url: "111" }), /NOT_FOUND/);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

// ── download_media ───────────────────────────────────────────────────────────

test("download_media saves selected items under downloads/x/{statusId}/", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: "111", download_media: [1, 2] });
    const downloaded = result.details?.downloaded as Array<{ index: number; kind: string; path: string }>;
    assert.equal(downloaded.length, 2);
    assert.ok(downloaded[0].path.startsWith("downloads/x/111/"), `path under downloads/x: ${downloaded[0].path}`);
    assert.equal(downloaded[1].kind, "video");
    for (const item of downloaded) {
      await access(path.join(h.workspaceRoot, item.path));
    }
    assert.ok(h.fetchedUrls.includes("https://video.twimg.com/v1.mp4"), "video downloads the mp4 itself");
    assert.match(textOf(result), /Downloaded media:/);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("download_media 'all' downloads everything; out-of-range indices error with the valid range", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: "111", download_media: "all", max_chars: 50 });
    assert.equal((result.details?.downloaded as unknown[]).length, 3);
    await assert.rejects(() => h.execute({ url: "111", download_media: [9] }), /valid: 1–3/);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

// ── view_media ───────────────────────────────────────────────────────────────

test("view_media returns photos as image blocks and substitutes thumbnails for videos", async () => {
  const h = await makeHarness();
  try {
    const result = await h.execute({ url: "111", view_media: [1, 2] });
    const images = result.content.filter((c) => c.type === "image");
    assert.equal(images.length, 2);
    assert.ok(images[0].data && images[0].mimeType?.startsWith("image/"));
    assert.ok(h.fetchedUrls.includes("https://pbs.twimg.com/t1.jpg"), "video viewed via its thumbnail");
    assert.ok(!h.fetchedUrls.includes("https://video.twimg.com/v1.mp4"), "the mp4 itself is not fetched for viewing");
    assert.match(textOf(result), /showing the video's thumbnail frame/);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test("view_media 'all' clamps to max_view_blocks with a note", async () => {
  const h = await makeHarness({ config: { maxViewBlocks: 2 } });
  try {
    const result = await h.execute({ url: "111", view_media: "all" });
    const images = result.content.filter((c) => c.type === "image");
    assert.equal(images.length, 2);
    assert.match(textOf(result), /clamped to the first 2 of 3/);
  } finally {
    await rm(h.workspaceRoot, { recursive: true, force: true });
  }
});
