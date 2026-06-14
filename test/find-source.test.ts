import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

import {
  createFindSourceTool,
  normalizeResults,
  rankResults,
  buildOutputText,
  sauceStatusKind,
  isUrlInput,
  type FindSourceToolContext,
} from "../src/tools/find-source.js";
import { SauceNaoRateLimiter } from "../src/saucenao/rate-limiter.js";
import { buildInferenceImageOptions } from "../src/media/index.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";
import type { FetchClient, FetchResult, FetchOptions } from "../src/enrichment/fetch-client.js";

// The SauceNAO call routes through guardedFetch; the SSRF guard would block the
// loopback stub, so disable it per-test (the production guard has its own tests).
beforeEach(() => setEgressGuardEnabled(false));
afterEach(() => setEgressGuardEnabled(true));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("isUrlInput distinguishes http(s) URLs from workspace paths", () => {
  assert.equal(isUrlInput("https://x.com/a.jpg"), true);
  assert.equal(isUrlInput("HTTP://x.com/a.jpg"), true);
  assert.equal(isUrlInput("./attachments/foo.jpg"), false);
  assert.equal(isUrlInput("attachments/foo.jpg"), false);
  assert.equal(isUrlInput("ftp://x.com/a.jpg"), false);
});

test("sauceStatusKind maps SauceNAO header.status", () => {
  assert.equal(sauceStatusKind(0), "ok");
  assert.equal(sauceStatusKind(undefined), "ok");
  assert.equal(sauceStatusKind(-1), "fatal");
  assert.equal(sauceStatusKind(3), "partial");
});

test("normalizeResults extracts similarity, http ext_urls, artist, ids, thumbnail", () => {
  const out = normalizeResults([
    {
      header: { similarity: "92.41", thumbnail: "https://img.saucenao.com/a.jpg", index_id: 5, index_name: "Index #5: Pixiv - foo" },
      data: {
        ext_urls: ["https://www.pixiv.net/artworks/123", "not-a-url", "ftp://x/y"],
        title: "Sunrise",
        member_name: "artist-san",
        pixiv_id: 123,
        source: "  twitter.com/handle  ",
      },
    },
    {
      header: { similarity: 40 },
      data: { ext_urls: ["http://danbooru.donmai.us/posts/9"], author_name: "fallback-author", danbooru_id: 9 },
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.similarity, 92.41);
  assert.equal(out[0]!.indexId, 5);
  assert.equal(out[0]!.indexName, "Index #5: Pixiv - foo");
  assert.equal(out[0]!.thumbnail, "https://img.saucenao.com/a.jpg");
  assert.equal(out[0]!.title, "Sunrise");
  assert.equal(out[0]!.author, "artist-san");
  // Only http(s) ext_urls survive.
  assert.deepEqual(out[0]!.sourceUrls, ["https://www.pixiv.net/artworks/123"]);
  assert.equal(out[0]!.ids.pixiv_id, "123");
  assert.equal(out[0]!.ids.source, "twitter.com/handle");
  // member_name absent → author_name fallback.
  assert.equal(out[1]!.author, "fallback-author");
  assert.equal(out[1]!.ids.danbooru_id, "9");
});

test("normalizeResults is tolerant of missing/garbage", () => {
  assert.deepEqual(normalizeResults(undefined), []);
  const out = normalizeResults([{}, { header: {}, data: {} }]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.similarity, 0);
  assert.equal(out[0]!.author, null);
  assert.deepEqual(out[0]!.sourceUrls, []);
});

test("rankResults filters below floor, sorts desc, caps to limit", () => {
  const raw = [
    { header: { similarity: "55" }, data: {} },
    { header: { similarity: "90" }, data: {} },
    { header: { similarity: "30" }, data: {} },
    { header: { similarity: "70" }, data: {} },
  ];
  const ranked = rankResults(raw, 55, 2);
  assert.deepEqual(ranked.map((r) => r.similarity), [90, 70]);
  // Floor at exactly 55 is inclusive; 30 dropped.
  const all = rankResults(raw, 55, 10);
  assert.deepEqual(all.map((r) => r.similarity), [90, 70, 55]);
});

test("buildOutputText leads with similarity, labels confidence, surfaces quota", () => {
  const text = buildOutputText({
    results: rankResults([{ header: { similarity: "92.4", index_name: "Index #5: Pixiv - foo" }, data: { ext_urls: ["https://www.pixiv.net/artworks/1"], member_name: "a" } }], 55, 5),
    minSimilarity: 55,
    queriedBy: "url",
    partial: false,
    shortRemaining: 5,
    longRemaining: 199,
    viewActive: false,
    viewNotes: [],
  });
  assert.match(text, /92\.40%/);
  assert.match(text, /strong/);
  assert.match(text, /Pixiv/);
  assert.match(text, /short 5 left/);
  assert.match(text, /daily 199 left/);
  assert.match(text, /pixiv\.net\/artworks\/1/);
});

test("buildOutputText handles zero matches and partial note", () => {
  const text = buildOutputText({
    results: [],
    minSimilarity: 55,
    queriedBy: "upload",
    partial: true,
    shortRemaining: null,
    longRemaining: null,
    viewActive: false,
    viewNotes: [],
  });
  assert.match(text, /No matches/);
  assert.match(text, /Partial result/);
});

// ---------------------------------------------------------------------------
// SauceNaoRateLimiter
// ---------------------------------------------------------------------------

test("rate limiter admits up to the window max then blocks", () => {
  let now = 1000;
  const rl = new SauceNaoRateLimiter({ shortWindowMax: 3, shortWindowMs: 1000, now: () => now });
  assert.equal(rl.tryAcquire(), true);
  assert.equal(rl.tryAcquire(), true);
  assert.equal(rl.tryAcquire(), true);
  assert.equal(rl.tryAcquire(), false);
  assert.equal(rl.snapshot().remaining, 0);
  // msUntilSlot = oldest start + window - now.
  assert.equal(rl.msUntilSlot(), 1000);
});

test("rate limiter slides: old admissions age out of the window", () => {
  let now = 0;
  const rl = new SauceNaoRateLimiter({ shortWindowMax: 2, shortWindowMs: 1000, now: () => now });
  rl.tryAcquire(); // t=0
  now = 500;
  rl.tryAcquire(); // t=500
  assert.equal(rl.tryAcquire(), false); // full
  now = 1001; // first (t=0) has aged out
  assert.equal(rl.snapshot().used, 1);
  assert.equal(rl.tryAcquire(), true);
});

test("rate limiter reconcileShort syncs to the authoritative counter", () => {
  let now = 0;
  const rl = new SauceNaoRateLimiter({ shortWindowMax: 6, shortWindowMs: 30000, now: () => now });
  rl.tryAcquire(); // local used = 1
  // Server says only 2 remaining of 6 → used 4 > local 1 ⇒ pad up.
  rl.reconcileShort(2, 6);
  assert.equal(rl.snapshot().used, 4);
  assert.equal(rl.snapshot().remaining, 2);
  // Server now says 5 remaining → used 1 < 4 ⇒ trim down.
  rl.reconcileShort(5, 6);
  assert.equal(rl.snapshot().used, 1);
  // Garbage ignored.
  rl.reconcileShort(Number.NaN, 6);
  assert.equal(rl.snapshot().used, 1);
});

test("rate limiter acquire returns not-admitted when wait exceeds maxWaitMs", async () => {
  let now = 0;
  const rl = new SauceNaoRateLimiter({ shortWindowMax: 1, shortWindowMs: 10000, now: () => now });
  assert.equal(rl.tryAcquire(), true);
  const res = await rl.acquire({ maxWaitMs: 0 });
  assert.equal(res.admitted, false);
  if (!res.admitted) assert.ok(res.waitMs > 0);
});

// ---------------------------------------------------------------------------
// Tool integration (loopback SauceNAO stub; egress guard disabled above)
// ---------------------------------------------------------------------------

function makeNoopFetchClient(): FetchClient {
  return {
    async fetch(_url: string, _options?: FetchOptions): Promise<FetchResult> {
      throw new Error("fetchClient should not be called in this test");
    },
    stop() {},
  } as unknown as FetchClient;
}

async function buildContext(input: {
  serverUrl: string;
  workspaceRoot?: string;
  modelHasVision?: boolean;
  rateLimiter?: SauceNaoRateLimiter;
  fetchClient?: FetchClient;
}): Promise<FindSourceToolContext> {
  return {
    workspaceRoot: input.workspaceRoot ?? (await mkdtemp(path.join(os.tmpdir(), "miku-fs-ws-"))),
    fetchClient: input.fetchClient ?? makeNoopFetchClient(),
    inlineImageMaxBytes: 5_000_000,
    inferenceImageOptions: buildInferenceImageOptions(undefined),
    modelHasVision: input.modelHasVision ?? false,
    rateLimiter: input.rateLimiter ?? new SauceNaoRateLimiter({ shortWindowMax: 6, shortWindowMs: 30000 }),
    maxWaitMs: 0,
    config: { api_key: "test-key", base_url: input.serverUrl },
  };
}

/** Start an http server returning `body` (JSON) with `status`. */
function startSauceServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void>; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("find_source throws at construction when api_key is missing", () => {
  assert.throws(
    () =>
      createFindSourceTool({
        workspaceRoot: "/tmp",
        fetchClient: makeNoopFetchClient(),
        inlineImageMaxBytes: 1,
        inferenceImageOptions: buildInferenceImageOptions(undefined),
        modelHasVision: false,
        rateLimiter: new SauceNaoRateLimiter({ shortWindowMax: 6, shortWindowMs: 30000 }),
        config: { api_key: "  " },
      }),
    /api_key must be configured/,
  );
});

test("find_source url mode: status 0 returns ranked candidates", async () => {
  const server = await startSauceServer((req, res) => {
    const u = new URL(req.url ?? "", "http://x");
    assert.equal(u.searchParams.get("output_type"), "2");
    assert.equal(u.searchParams.get("db"), "999");
    assert.ok(u.searchParams.get("url")?.includes("example.com"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      header: { status: 0, short_remaining: 5, short_limit: "6", long_remaining: 199 },
      results: [
        { header: { similarity: "30" }, data: { ext_urls: ["https://low/1"] } },
        { header: { similarity: "95.5", index_name: "Index #5: Pixiv - foo", thumbnail: "https://t/1.jpg" }, data: { ext_urls: ["https://www.pixiv.net/artworks/7"], member_name: "drawer" } },
      ],
    }));
  });
  try {
    const ctx = await buildContext({ serverUrl: server.url });
    const tool = createFindSourceTool(ctx);
    const result = await tool.execute("c1", { image: "https://example.com/pic.jpg" }, undefined) as any;
    const text = result.content[0].text as string;
    assert.match(text, /SauceNAO Source Lookup/);
    assert.match(text, /95\.50%/);
    // 30% is below the default 55 floor → dropped.
    assert.equal(result.details.count, 1);
    assert.equal(result.details.queriedBy, "url");
    assert.equal(result.details.results[0].author, "drawer");
    assert.equal(result.details.shortRemaining, 5);
  } finally {
    await server.close();
  }
});

test("find_source surfaces a fatal status (<0) as a tool error", async () => {
  const server = await startSauceServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ header: { status: -1, message: "Invalid API key" } }));
  });
  try {
    const tool = createFindSourceTool(await buildContext({ serverUrl: server.url }));
    const result = await tool.execute("c1", { image: "https://example.com/pic.jpg" }, undefined) as any;
    assert.match(result.content[0].text, /error:.*Invalid API key/);
  } finally {
    await server.close();
  }
});

test("find_source notes a partial status (>0) but still returns results", async () => {
  const server = await startSauceServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      header: { status: 2 },
      results: [{ header: { similarity: "88" }, data: { ext_urls: ["https://src/1"] } }],
    }));
  });
  try {
    const tool = createFindSourceTool(await buildContext({ serverUrl: server.url }));
    const result = await tool.execute("c1", { image: "https://example.com/pic.jpg" }, undefined) as any;
    assert.equal(result.details.partial, true);
    assert.match(result.content[0].text, /Partial result/);
    assert.equal(result.details.count, 1);
  } finally {
    await server.close();
  }
});

test("find_source maps HTTP 429 to a soft rate-limited result, not an error", async () => {
  const server = await startSauceServer((_req, res) => {
    res.writeHead(429, { "content-type": "text/plain" });
    res.end("Too many requests");
  });
  try {
    const tool = createFindSourceTool(await buildContext({ serverUrl: server.url }));
    const result = await tool.execute("c1", { image: "https://example.com/pic.jpg" }, undefined) as any;
    assert.equal(result.details.rateLimited, true);
    assert.equal(result.details.status, 429);
    assert.doesNotMatch(result.content[0].text, /^error:/);
  } finally {
    await server.close();
  }
});

test("find_source returns a soft result when the short window is exhausted", async () => {
  // Pre-fill the limiter so acquire fails before any network call.
  const rl = new SauceNaoRateLimiter({ shortWindowMax: 1, shortWindowMs: 30000 });
  assert.equal(rl.tryAcquire(), true);
  const ctx = await buildContext({ serverUrl: "http://127.0.0.1:1", rateLimiter: rl });
  const tool = createFindSourceTool(ctx);
  const result = await tool.execute("c1", { image: "https://example.com/pic.jpg" }, undefined) as any;
  assert.equal(result.details.rateLimited, true);
  assert.match(result.content[0].text, /quota is exhausted/);
});

test("find_source rejects a traversal path before any network call", async () => {
  const ctx = await buildContext({ serverUrl: "http://127.0.0.1:1" });
  const tool = createFindSourceTool(ctx);
  const result = await tool.execute("c1", { image: "../../etc/passwd" }, undefined) as any;
  assert.match(result.content[0].text, /Could not read image/);
});

test("find_source rejects a non-http(s) URL scheme", async () => {
  const ctx = await buildContext({ serverUrl: "http://127.0.0.1:1" });
  const tool = createFindSourceTool(ctx);
  const result = await tool.execute("c1", { image: "file:///etc/passwd" }, undefined) as any;
  // file:// is not matched as a URL input → treated as a path → read failure.
  assert.match(result.content[0].text, /Could not read image|Only http/);
});

test("find_source uploads a conditioned image in path mode and views thumbnails on vision models", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "miku-fs-ws-"));
  const imgPath = path.join(workspaceRoot, "pic.png");
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
  await writeFile(imgPath, png);

  let gotMultipart = false;
  const server = await startSauceServer((req, res) => {
    gotMultipart = (req.headers["content-type"] ?? "").includes("multipart/form-data");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      header: { status: 0, short_remaining: 4, long_remaining: 100 },
      results: [{ header: { similarity: "97", index_name: "Index #9: Danbooru", thumbnail: "https://t/x.jpg" }, data: { ext_urls: ["https://danbooru.donmai.us/posts/5"] } }],
    }));
  });

  // Stub thumbnail fetch (returns a small png written to a temp file).
  const tmpFiles: string[] = [];
  const fetchClient = {
    async fetch(url: string): Promise<FetchResult> {
      const p = path.join(os.tmpdir(), `miku-fs-thumb-${randomBytes(6).toString("hex")}.png`);
      await writeFile(p, png);
      tmpFiles.push(p);
      return { path: p, sizeBytes: png.byteLength, contentType: "image/png", finalUrl: url, statusCode: 200 } as FetchResult;
    },
    stop() {},
  } as unknown as FetchClient;

  try {
    const ctx = await buildContext({ serverUrl: server.url, workspaceRoot, modelHasVision: true, fetchClient });
    const tool = createFindSourceTool(ctx);
    const result = await tool.execute("c1", { image: "pic.png", view: true }, undefined) as any;
    assert.equal(gotMultipart, true);
    assert.equal(result.details.queriedBy, "upload");
    assert.equal(result.details.count, 1);
    // The vision view path inlined the matched thumbnail as an image block.
    const imageBlocks = result.content.filter((c: any) => c.type === "image");
    assert.equal(imageBlocks.length, 1);
    assert.deepEqual(result.details.viewed, [0]);
  } finally {
    await server.close();
    await Promise.all(tmpFiles.map((p) => rm(p, { force: true }).catch(() => {})));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("find_source ignores view on a non-vision model with a note", async () => {
  const server = await startSauceServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ header: { status: 0 }, results: [{ header: { similarity: "90", thumbnail: "https://t/x.jpg" }, data: { ext_urls: ["https://s/1"] } }] }));
  });
  try {
    const ctx = await buildContext({ serverUrl: server.url, modelHasVision: false });
    const tool = createFindSourceTool(ctx);
    const result = await tool.execute("c1", { image: "https://example.com/pic.jpg", view: true }, undefined) as any;
    assert.equal(result.content.filter((c: any) => c.type === "image").length, 0);
    assert.match(result.content[0].text, /no vision/);
  } finally {
    await server.close();
  }
});
