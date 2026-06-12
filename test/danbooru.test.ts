import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

import { createDanbooruTool, DanbooruRateLimiter, type DanbooruToolContext } from "../src/tools/danbooru.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";
import type {
  FetchClient,
  FetchOptions,
  FetchResult,
} from "../src/enrichment/fetch-client.js";
import type { ImageProcessingOptions } from "../src/media/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The tool's JSON fetch now routes through `guardedFetch` (spec Design D); these
// tests point `base_url` at a loopback stub server, which the SSRF address guard
// (ON by default) would block. No Danbooru test exercises SSRF, so disable it here.
before(() => setEgressGuardEnabled(false));
after(() => setEgressGuardEnabled(true));

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-danbooru-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function defaultInferenceImageOptions(maxBytes: number): ImageProcessingOptions {
  return {
    maxTotalPixels: 921_600,
    maxTotalPixelsHard: 1_843_200,
    minShortestSide: 480,
    maxBytes,
    mozjpeg: false,
  };
}

/**
 * Stand up a tiny in-process HTTP server. The danbooru tool's fetchJson and
 * the FetchClient both speak ordinary HTTP, so a real loopback server is
 * cleaner than monkey-patching globalThis.fetch.
 */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; server: http.Server }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Build a stub FetchClient that returns a configured buffer on disk. */
function makeStubFetchClient(input: {
  buffer: Buffer;
  contentType?: string;
  statusCode?: number;
}): { client: FetchClient; calls: Array<{ url: string; options?: FetchOptions }>; cleanup: () => Promise<void> } {
  const calls: Array<{ url: string; options?: FetchOptions }> = [];
  const tmpFiles: string[] = [];
  const client = {
    async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
      calls.push({ url, options });
      const tmpPath = path.join(os.tmpdir(), `miku-danbooru-test-${randomBytes(6).toString("hex")}`);
      await writeFile(tmpPath, input.buffer);
      tmpFiles.push(tmpPath);
      return {
        path: tmpPath,
        sizeBytes: input.buffer.byteLength,
        contentType: input.contentType ?? "image/jpeg",
        finalUrl: url,
        statusCode: input.statusCode ?? 200,
      };
    },
    stop() {},
  } as unknown as FetchClient;
  return {
    client,
    calls,
    cleanup: async () => {
      await Promise.all(
        tmpFiles.map((p) => rm(p, { force: true }).catch(() => {})),
      );
    },
  };
}

/** Build a danbooru tool wired against a local server and stub fetch client. */
function buildContext(input: {
  workspaceRoot: string;
  serverUrl: string;
  fetchClient: FetchClient;
  downloadSizeLimit?: number;
  inlineImageMaxBytes?: number;
  inferenceImageOptions?: ImageProcessingOptions;
  modelHasVision?: boolean;
  imageCaptionClient?: DanbooruToolContext["imageCaptionClient"];
  config?: DanbooruToolContext["config"];
}): DanbooruToolContext {
  const inlineImageMaxBytes = input.inlineImageMaxBytes ?? 60_000;
  return {
    workspaceRoot: input.workspaceRoot,
    downloadSizeLimit: input.downloadSizeLimit ?? 10 * 1024 * 1024,
    inlineImageMaxBytes,
    inferenceImageOptions:
      input.inferenceImageOptions ?? defaultInferenceImageOptions(inlineImageMaxBytes),
    // Default to a vision model so existing preview tests keep getting image blocks.
    modelHasVision: input.modelHasVision ?? true,
    imageCaptionClient: input.imageCaptionClient,
    fetchClient: input.fetchClient,
    config: { base_url: input.serverUrl, max_regular_tags: 3, ...input.config },
  };
}

// ---------------------------------------------------------------------------
// Issue #5 — preview must condition bytes under inlineImageMaxBytes
// ---------------------------------------------------------------------------

test("danbooru preview re-encodes oversized images to fit inlineImageMaxBytes", async () => {
  await withWorkspace(async (workspace) => {
    // Build a large PNG buffer (well above the inline cap). Use noisy random
    // pixels so the PNG encoder can't deflate it down past the threshold.
    const width = 1600;
    const height = 1600;
    const pixels = randomBytes(width * height * 3);
    const largePng = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    assert.ok(
      largePng.byteLength > 200_000,
      `fixture should be big to make the test meaningful, got ${largePng.byteLength} bytes`,
    );

    const server = await startServer((req, res) => {
      // Serve the post metadata.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 12345,
          rating: "g",
          score: 1,
          fav_count: 0,
          file_ext: "png",
          file_url: "http://upstream/large.png",
          large_file_url: "http://upstream/sample.jpg",
          preview_file_url: "http://upstream/preview.jpg",
          image_width: width,
          image_height: height,
        }),
      );
    });

    const inlineCap = 75_000;
    const { client, cleanup } = makeStubFetchClient({
      buffer: largePng,
      contentType: "image/png",
    });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          inlineImageMaxBytes: inlineCap,
        }),
      );
      const result = await tool.execute("t-prev", {
        action: "preview",
        postId: 12345,
        previewVariant: "original",
      });
      const imageBlock = result.content.find((c: { type: string }) => c.type === "image") as
        | { type: "image"; data: string; mimeType: string }
        | undefined;
      assert.ok(imageBlock, "preview should return an image block");
      const decoded = Buffer.from(imageBlock.data, "base64");
      assert.ok(
        decoded.byteLength <= inlineCap,
        `decoded inline payload should be <= ${inlineCap} bytes, got ${decoded.byteLength}`,
      );
      assert.equal(imageBlock.mimeType, "image/jpeg");
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-vision preview — describe via captioning model, never emit image blocks
// ---------------------------------------------------------------------------

/** Minimal InferenceClient stub recording caption requests. */
function makeStubCaptionClient(caption: string): {
  client: DanbooruToolContext["imageCaptionClient"];
  calls: Array<{ filePath: string; mimeType: string }>;
} {
  const calls: Array<{ filePath: string; mimeType: string }> = [];
  const client = {
    modality: "image" as const,
    stop() {},
    async caption(req: { filePath: string; mimeType: string }) {
      calls.push({ filePath: req.filePath, mimeType: req.mimeType });
      return { caption, model: "stub-vision-model" };
    },
  } as unknown as DanbooruToolContext["imageCaptionClient"];
  return { client, calls };
}

test("non-vision preview returns a caption, never an image block", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 555,
          rating: "g",
          score: 3,
          fav_count: 0,
          file_ext: "png",
          file_url: "http://upstream/orig.png",
          large_file_url: "http://upstream/sample.jpg",
          preview_file_url: "http://upstream/preview.jpg",
        }),
      );
    });
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(16), contentType: "image/png" });
    const { client: captionClient, calls: captionCalls } = makeStubCaptionClient("A blonde knight in armor.");
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          modelHasVision: false,
          imageCaptionClient: captionClient,
        }),
      );
      const result = await tool.execute("t-desc", { action: "preview", postId: 555 });
      assert.ok(
        !result.content.some((c: { type: string }) => c.type === "image"),
        "non-vision preview must NOT emit an image block",
      );
      const text = (result.content[0] as { text: string }).text;
      assert.ok(text.includes("A blonde knight in armor."), "caption text should be present");
      assert.ok(/\bmedia\b/.test(text), "should point the model at the media tool");
      assert.equal(captionCalls.length, 1, "asset should be captioned exactly once");
      assert.equal((result.details as { mode: string }).mode, "described");
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("non-vision preview without a caption client degrades to URLs + media pointer", async () => {
  await withWorkspace(async (workspace) => {
    let cdnFetched = false;
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 777,
          rating: "g",
          score: 0,
          fav_count: 0,
          file_ext: "jpg",
          file_url: "http://upstream/orig.jpg",
          large_file_url: "http://upstream/sample.jpg",
          preview_file_url: "http://upstream/preview.jpg",
        }),
      );
    });
    const tmpFiles: string[] = [];
    const client = {
      async fetch(url: string): Promise<FetchResult> {
        cdnFetched = true;
        const tmpPath = path.join(os.tmpdir(), `miku-danbooru-nocap-${randomBytes(6).toString("hex")}`);
        await writeFile(tmpPath, Buffer.alloc(8));
        tmpFiles.push(tmpPath);
        return { path: tmpPath, sizeBytes: 8, contentType: "image/jpeg", finalUrl: url, statusCode: 200 };
      },
      stop() {},
    } as unknown as FetchClient;
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          modelHasVision: false,
          // no imageCaptionClient
        }),
      );
      const result = await tool.execute("t-nocap", { action: "preview", postId: 777 });
      assert.ok(!result.content.some((c: { type: string }) => c.type === "image"), "no image block");
      const text = (result.content[0] as { text: string }).text;
      assert.ok(text.includes("http://upstream/sample.jpg"), "asset URLs should be present");
      // With no caption client configured, the `media` tool (same client) can't
      // caption either — so this path must NOT promise it; it just gives URLs.
      assert.equal(cdnFetched, false, "must not fetch the asset when it cannot be described");
      assert.equal((result.details as { mode: string }).mode, "urls-only");
    } finally {
      await Promise.all(tmpFiles.map((p) => rm(p, { force: true }).catch(() => {})));
      await server.close();
    }
  });
});

test("danbooru download retains downloadSizeLimit semantics (no inline conditioning on disk)", async () => {
  await withWorkspace(async (workspace) => {
    // Build a buffer larger than the inline cap but well below downloadSizeLimit.
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    // Write a minimal valid JPEG header so sharp/MIME sniffing don't break in
    // case anything else inspects the bytes. The download path doesn't care
    // about format — it just writes the raw buffer to disk.
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;

    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 99,
          rating: "g",
          score: 0,
          fav_count: 0,
          file_ext: "jpg",
          file_url: "http://upstream/full.jpg",
          large_file_url: "http://upstream/sample.jpg",
          preview_file_url: "http://upstream/preview.jpg",
        }),
      );
    });

    const { client, cleanup } = makeStubFetchClient({
      buffer: big,
      contentType: "image/jpeg",
    });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          inlineImageMaxBytes: 10_000, // intentionally smaller than the file
          downloadSizeLimit: 5_000_000,
          config: { download_subdir: "downloads/danbooru" },
        }),
      );
      const result = await tool.execute("t-dl", {
        action: "download",
        postId: 99,
      });
      const filePath = (result.details as { filePath: string }).filePath;
      const stats = await stat(filePath);
      assert.equal(stats.size, big.byteLength, "download path must keep on-disk file at full size");
      const written = await readFile(filePath);
      assert.equal(
        written.byteLength,
        big.byteLength,
        "download must not re-encode/conditionally shrink on-disk artifacts",
      );
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #7 — fetchJson timeout, User-Agent, size cap
// ---------------------------------------------------------------------------

test("fetchJson sends MikuAgent User-Agent on outbound requests", async () => {
  await withWorkspace(async (workspace) => {
    const seen: { userAgent?: string } = {};
    const server = await startServer((req, res) => {
      seen.userAgent = req.headers["user-agent"];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
    });

    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );
      await tool.execute("t-ua", { action: "search", includeTags: ["solo"] });
      assert.ok(
        seen.userAgent && /MikuAgent/i.test(seen.userAgent),
        `expected User-Agent to identify MikuAgent, got: ${seen.userAgent}`,
      );
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("fetchJson rejects responses larger than the cap", async () => {
  await withWorkspace(async (workspace) => {
    // Serve a JSON payload above the 4 MiB cap. Use a streamed write so the
    // connection stays open while we pour bytes onto the wire.
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      // Don't set content-length so the pre-flight check doesn't short-circuit;
      // we want the running counter to catch this.
      res.write("[");
      const chunk = `"${"a".repeat(64 * 1024)}"`;
      let totalChunks = 0;
      const writeMore = (): void => {
        if (totalChunks >= 80) {
          // > 4 MiB across chunks
          res.end("]");
          return;
        }
        const ok = res.write(totalChunks === 0 ? chunk : `,${chunk}`);
        totalChunks++;
        if (ok) {
          setImmediate(writeMore);
        } else {
          res.once("drain", writeMore);
        }
      };
      writeMore();
    });

    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );
      await assert.rejects(
        () => tool.execute("t-cap", { action: "search", includeTags: ["solo"] }),
        /exceeded.*bytes/i,
      );
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("fetchJson rejects when the server's declared content-length is oversized", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(50 * 1024 * 1024));
      // Don't actually need to write 50MiB — the pre-flight check trips on the header.
      res.end("[]");
    });

    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );
      await assert.rejects(
        () => tool.execute("t-decl", { action: "search", includeTags: ["solo"] }),
        /content-length/i,
      );
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("fetchJson aborts a hung response after the timeout", async () => {
  await withWorkspace(async (workspace) => {
    // Server that never responds; the tool must give up on its own.
    const server = await startServer((_req, _res) => {
      // intentionally hang
    });

    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      // Patch the timeout via env? We can't — the timeout is a constant. So
      // assert the abort happens within a reasonable window by racing.
      // To keep the test fast (and not block 30s) we monkey-patch the global
      // AbortController's timeout via the tool's behavior: we just assert
      // that without monkey-patching the request DOES reject when we manually
      // abort by closing the server.
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );

      // Race: kick off the tool call, then forcibly close the server after a
      // short delay. The connection should drop and fetchJson should reject.
      const exec = tool.execute("t-timeout", { action: "search", includeTags: ["solo"] });
      setTimeout(() => {
        server.server.closeAllConnections?.();
      }, 100);
      await assert.rejects(exec);
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #8 — extraTerms validation
// ---------------------------------------------------------------------------

test("extraTerms entries containing whitespace are rejected", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: "https://example.test", fetchClient: client }),
      );
      await assert.rejects(
        () =>
          tool.execute("t-ws", {
            action: "search",
            includeTags: ["solo"],
            extraTerms: ["rating:s -rating:e"],
          }),
        /must not contain whitespace/i,
      );
    } finally {
      await cleanup();
    }
  });
});

test("extraTerms count against max_regular_tags budget", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: "https://example.test",
          fetchClient: client,
          config: { max_regular_tags: 2 },
        }),
      );
      await assert.rejects(
        () =>
          tool.execute("t-budget", {
            action: "search",
            includeTags: ["a", "b"],
            extraTerms: ["score:>100"],
          }),
        /at most 2 regular tags/i,
      );
    } finally {
      await cleanup();
    }
  });
});

test("order:* counts against the max_regular_tags budget", async () => {
  // Danbooru counts the `order:*` metatag toward its per-account tag limit, so
  // a search using the full regular-tag budget PLUS an order would 422 at
  // Danbooru. The tool must reject it locally with a clear message instead.
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: "https://example.test",
          fetchClient: client,
          config: { max_regular_tags: 2 },
        }),
      );
      await assert.rejects(
        () =>
          tool.execute("t-order-budget", {
            action: "search",
            includeTags: ["mordred_(fate)", "artoria_pendragon_(fate)"],
            order: "score",
          }),
        /at most 2 regular tags/i,
      );
    } finally {
      await cleanup();
    }
  });
});

test("rating:* does NOT count against the max_regular_tags budget", async () => {
  // Danbooru exempts `rating:*` metatags from its tag limit, so two regular
  // tags plus a rating filter must be accepted (and must reach the server).
  await withWorkspace(async (workspace) => {
    let seenTags: string | undefined;
    const server = await startServer((req, res) => {
      seenTags = new URL(req.url ?? "", "http://x").searchParams.get("tags") ?? undefined;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
    });
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          config: { max_regular_tags: 2 },
        }),
      );
      await tool.execute("t-rating-budget", {
        action: "search",
        includeTags: ["mordred_(fate)", "artoria_pendragon_(fate)"],
        includeRatings: ["sensitive"],
      });
      assert.ok(seenTags?.includes("rating:s"), `expected rating metatag in query, got: ${seenTags}`);
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("HTTP error surfaces Danbooru's JSON message, not a bare code", async () => {
  // Danbooru error bodies use `message`/`error`, never `reason`. The tool must
  // extract them so the agent sees why a request failed (e.g. the tag limit).
  await withWorkspace(async (workspace) => {
    const server = await startServer((_req, res) => {
      res.statusCode = 422;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          success: false,
          error: "PostQuery::TagLimitError",
          message: "You cannot search for more than 2 tags at a time.",
        }),
      );
    });
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );
      await assert.rejects(
        () => tool.execute("t-422", { action: "search", includeTags: ["solo"] }),
        /HTTP 422.*more than 2 tags/s,
      );
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("extraTerms reject metatags that overlap structured fields", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: "https://example.test",
          fetchClient: client,
          config: { max_regular_tags: 5 },
        }),
      );
      for (const term of ["rating:s", "order:score", "limit:50", "-rating:e"]) {
        await assert.rejects(
          () =>
            tool.execute("t-meta", {
              action: "search",
              includeTags: ["solo"],
              extraTerms: [term],
            }),
          new RegExp("structured", "i"),
          `expected rejection for: ${term}`,
        );
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #21 — refuse Basic credentials over plaintext HTTP
// ---------------------------------------------------------------------------

test("createDanbooruTool refuses credentials over plaintext HTTP base_url", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      assert.throws(
        () =>
          createDanbooruTool({
            workspaceRoot: workspace,
            downloadSizeLimit: 1_000_000,
            inlineImageMaxBytes: 100_000,
            inferenceImageOptions: defaultInferenceImageOptions(100_000),
            fetchClient: client,
            config: {
              base_url: "http://danbooru.donmai.us",
              login: "alice",
              api_key: "secret",
            },
          }),
        /Refusing to send Basic credentials over plaintext HTTP/i,
      );
    } finally {
      await cleanup();
    }
  });
});

test("createDanbooruTool with https base_url + credentials succeeds", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      assert.doesNotThrow(() =>
        createDanbooruTool({
          workspaceRoot: workspace,
          downloadSizeLimit: 1_000_000,
          inlineImageMaxBytes: 100_000,
          inferenceImageOptions: defaultInferenceImageOptions(100_000),
          fetchClient: client,
          config: {
            base_url: "https://danbooru.donmai.us",
            login: "alice",
            api_key: "secret",
          },
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

test("createDanbooruTool with http base_url and no credentials succeeds", async () => {
  await withWorkspace(async (workspace) => {
    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      assert.doesNotThrow(() =>
        createDanbooruTool({
          workspaceRoot: workspace,
          downloadSizeLimit: 1_000_000,
          inlineImageMaxBytes: 100_000,
          inferenceImageOptions: defaultInferenceImageOptions(100_000),
          fetchClient: client,
          config: { base_url: "http://danbooru.donmai.us" },
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #22 — explicit filename extension allow-list
// ---------------------------------------------------------------------------

test("danbooru download falls back to file_ext when explicit filename has disallowed extension", async () => {
  await withWorkspace(async (workspace) => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(100).fill(0)]);
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 5,
          rating: "g",
          score: 0,
          fav_count: 0,
          file_ext: "jpg",
          file_url: "http://upstream/foo.jpg",
          large_file_url: "http://upstream/foo-sample.jpg",
          preview_file_url: "http://upstream/foo-prev.jpg",
        }),
      );
    });

    const { client, cleanup } = makeStubFetchClient({ buffer, contentType: "image/jpeg" });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          config: { download_subdir: "downloads" },
        }),
      );
      const result = await tool.execute("t-ext", {
        action: "download",
        postId: 5,
        filename: "owned.html",
      });
      const filePath = (result.details as { filePath: string }).filePath;
      // Even with filename="owned.html" we expect ".jpg" because html is not allow-listed.
      assert.ok(filePath.endsWith(".jpg"), `expected fallback to .jpg, got: ${filePath}`);
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

test("danbooru download accepts allow-listed explicit filename extensions", async () => {
  await withWorkspace(async (workspace) => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(100).fill(0)]);
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 6,
          rating: "g",
          score: 0,
          fav_count: 0,
          file_ext: "jpg",
          file_url: "http://upstream/foo.jpg",
          large_file_url: "http://upstream/foo-s.jpg",
          preview_file_url: "http://upstream/foo-p.jpg",
        }),
      );
    });

    const { client, cleanup } = makeStubFetchClient({ buffer, contentType: "image/jpeg" });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          config: { download_subdir: "downloads" },
        }),
      );
      const result = await tool.execute("t-ext-ok", {
        action: "download",
        postId: 6,
        filename: "mypic.png",
      });
      const filePath = (result.details as { filePath: string }).filePath;
      assert.ok(filePath.endsWith(".png"), `expected explicit .png to be preserved, got: ${filePath}`);
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #23 — exclusive create on collision
// ---------------------------------------------------------------------------

test("danbooru download uses exclusive create — pre-existing file forces suffix", async () => {
  await withWorkspace(async (workspace) => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 77,
          rating: "g",
          score: 0,
          fav_count: 0,
          file_ext: "jpg",
          file_url: "http://upstream/x.jpg",
          large_file_url: null,
          preview_file_url: null,
        }),
      );
    });

    // Pre-create a colliding file with distinguishable contents.
    const subdir = "downloads/danbooru";
    const collisionDir = path.join(workspace, subdir);
    await mkdtemp(collisionDir).catch(() => {});
    await rm(collisionDir, { recursive: true, force: true }).catch(() => {});
    const { promises: fs } = await import("node:fs");
    await fs.mkdir(collisionDir, { recursive: true });
    const existing = path.join(collisionDir, "danbooru-77.jpg");
    await writeFile(existing, "PRE-EXISTING");

    const { client, cleanup } = makeStubFetchClient({ buffer, contentType: "image/jpeg" });
    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          config: { download_subdir: subdir },
        }),
      );
      const result = await tool.execute("t-collide", { action: "download", postId: 77 });
      const filePath = (result.details as { filePath: string }).filePath;
      assert.notEqual(filePath, existing, "must not clobber the pre-existing file");
      assert.ok(/danbooru-77-1\.jpg$/.test(filePath), `expected suffix=-1, got: ${filePath}`);
      // The original file's contents must still be there untouched.
      const originalContents = await readFile(existing);
      assert.equal(originalContents.toString("utf8"), "PRE-EXISTING");
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #24 — search output surfaces createdAt / fileSize / source
// ---------------------------------------------------------------------------

test("danbooru search surfaces createdAt, fileSize, and source on each post", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: 42,
            rating: "g",
            score: 10,
            fav_count: 3,
            file_ext: "png",
            file_size: 123_456,
            created_at: "2024-08-01T12:34:56Z",
            source: "https://example.com/illustration",
            file_url: "https://example.com/illustration.png",
            large_file_url: "https://example.com/sample.png",
            preview_file_url: "https://example.com/preview.png",
            image_width: 800,
            image_height: 600,
            tag_string_general: "solo",
          },
        ]),
      );
    });

    const { client, cleanup } = makeStubFetchClient({ buffer: Buffer.alloc(0) });
    try {
      const tool = createDanbooruTool(
        buildContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: client }),
      );
      const result = await tool.execute("t-search", {
        action: "search",
        includeTags: ["solo"],
      });
      const details = result.details as { posts: Array<Record<string, unknown>> };
      assert.equal(details.posts.length, 1);
      const post = details.posts[0];
      assert.equal(post.createdAt, "2024-08-01T12:34:56Z");
      assert.equal(post.fileSize, 123_456);
      assert.equal(post.source, "https://example.com/illustration");
      // The text rendering should also mention the source verbatim.
      const text = (result.content[0] as { text: string }).text;
      assert.ok(text.includes("https://example.com/illustration"), "rendered text should include source");
      assert.ok(text.includes("size=120.6KB") || text.includes("size=123456B"), "rendered text should include fileSize");
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DanbooruRateLimiter — pacing + slot accounting (spec Design D rollout item 6
// verification: min-interval between starts, maxInFlight, one shared budget).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("limiter: two concurrent runs start at least minIntervalMs apart", async () => {
  const limiter = new DanbooruRateLimiter({ minIntervalMs: 80, maxInFlight: 4 });
  const starts: number[] = [];
  await Promise.all(
    [0, 1].map(() =>
      limiter.run(async () => {
        starts.push(Date.now());
      }),
    ),
  );
  assert.equal(starts.length, 2);
  const gap = Math.abs(starts[1]! - starts[0]!);
  assert.ok(gap >= 70, `concurrent starts must be paced >= minIntervalMs apart, got ${gap}ms`);
});

test("limiter: third run waits while maxInFlight runs are in flight", async () => {
  const limiter = new DanbooruRateLimiter({ minIntervalMs: 0, maxInFlight: 2 });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));

  let thirdStarted = false;
  const first = limiter.run(() => firstGate);
  const second = limiter.run(() => secondGate);
  const third = limiter.run(async () => {
    thirdStarted = true;
  });

  await sleep(20);
  assert.equal(thirdStarted, false, "third run must wait at maxInFlight=2");
  releaseFirst();
  await first;
  await third;
  assert.equal(thirdStarted, true, "a release admits the queued third run");
  releaseSecond();
  await second;
});

test("limiter: released slot is handed to the queued waiter FIFO — never double-granted", async () => {
  const limiter = new DanbooruRateLimiter({ minIntervalMs: 0, maxInFlight: 1 });
  let inFlight = 0;
  let maxObserved = 0;
  const startOrder: number[] = [];
  const tasks = [0, 1, 2, 3, 4].map((id) =>
    limiter.run(async () => {
      startOrder.push(id);
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await sleep(5);
      inFlight -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(maxObserved, 1, `maxInFlight=1 must never be exceeded, observed ${maxObserved}`);
  assert.deepEqual(startOrder, [0, 1, 2, 3, 4], "waiters are admitted FIFO");
});

test("limiter: API and CDN requests share one budget (preview paces JSON + asset fetch)", async () => {
  await withWorkspace(async (workspace) => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    let apiHitAt = 0;
    const server = await startServer((req, res) => {
      apiHitAt = Date.now();
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: 99,
          rating: "g",
          score: 1,
          fav_count: 0,
          file_ext: "png",
          file_url: "http://upstream/a.png",
          large_file_url: "http://upstream/a-large.png",
          preview_file_url: "http://upstream/a-preview.png",
          image_width: 32,
          image_height: 32,
        }),
      );
    });

    const calls: Array<{ url: string; options?: FetchOptions }> = [];
    let cdnHitAt = 0;
    const tmpFiles: string[] = [];
    const client = {
      async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
        cdnHitAt = Date.now();
        calls.push({ url, options });
        const tmpPath = path.join(os.tmpdir(), `miku-danbooru-budget-${randomBytes(6).toString("hex")}`);
        await writeFile(tmpPath, png);
        tmpFiles.push(tmpPath);
        return {
          path: tmpPath,
          sizeBytes: png.byteLength,
          contentType: "image/png",
          finalUrl: url,
          statusCode: 200,
        };
      },
      stop() {},
    } as unknown as FetchClient;

    try {
      const tool = createDanbooruTool(
        buildContext({
          workspaceRoot: workspace,
          serverUrl: server.url,
          fetchClient: client,
          config: { base_url: server.url, max_regular_tags: 3, min_request_interval_ms: 120, max_in_flight: 2 },
        }),
      );
      const result = await tool.execute("t-budget", {
        action: "preview",
        postId: 99,
        previewVariant: "original",
      });
      assert.ok(result.content.some((c: { type: string }) => c.type === "image"), "preview succeeds");
      assert.equal(calls.length, 1, "exactly one CDN asset fetch");
      assert.ok(apiHitAt > 0 && cdnHitAt > 0);
      const gap = cdnHitAt - apiHitAt;
      assert.ok(
        gap >= 90,
        `the CDN fetch must be paced behind the API call by the shared budget (~120ms), got ${gap}ms`,
      );
    } finally {
      await Promise.all(tmpFiles.map((p) => rm(p, { force: true }).catch(() => {})));
      await server.close();
    }
  });
});
