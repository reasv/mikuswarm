import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

import {
  createImageGenTool,
  buildRequestBody,
  extractImage,
  type ImageGenToolContext,
} from "../src/tools/image-gen.js";
import { FetchClient } from "../src/enrichment/fetch-client.js";
import type { FetchOptions, FetchResult } from "../src/enrichment/fetch-client.js";
import type { LlmScheduler } from "../src/agent/scheduler.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";
import type { ImageProcessingOptions } from "../src/media/index.js";

// The image-gen endpoint POST now routes through `guardedFetch` (spec Design D), so
// the SSRF address guard — ON by default — would block the loopback Gemini stub
// these tests use. Disable it per-test; the one test that asserts reference-URL SSRF
// rejection re-enables it explicitly.
beforeEach(() => setEgressGuardEnabled(false));
afterEach(() => setEgressGuardEnabled(true));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-imagegen-"));
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

/** A FetchClient stub that serves a fixed buffer (used for URL reference inputs). */
function makeStubFetchClient(input: {
  buffer: Buffer;
  contentType?: string;
  statusCode?: number;
}): { client: FetchClient; calls: string[]; cleanup: () => Promise<void> } {
  const calls: string[] = [];
  const tmpFiles: string[] = [];
  const client = {
    async fetch(url: string, _options?: FetchOptions): Promise<FetchResult> {
      calls.push(url);
      const tmpPath = path.join(os.tmpdir(), `miku-imagegen-test-${randomBytes(6).toString("hex")}`);
      await writeFile(tmpPath, input.buffer);
      tmpFiles.push(tmpPath);
      return {
        path: tmpPath,
        sizeBytes: input.buffer.byteLength,
        contentType: input.contentType ?? "image/png",
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
      await Promise.all(tmpFiles.map((p) => rm(p, { force: true }).catch(() => {})));
    },
  };
}

/** A loopback server emulating the Gemini :generateContent endpoint. It records
 *  the last request body and replies with `responder(body)`. */
async function startGeminiServer(
  responder: (body: any) => { status?: number; json: unknown },
): Promise<{ url: string; lastBody: () => any; close: () => Promise<void> }> {
  let last: any;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      last = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const { status = 200, json } = responder(last);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    lastBody: () => last,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function smallPngBase64(): Promise<string> {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 240, g: 200, b: 40 } },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function baseContext(input: {
  workspaceRoot: string;
  serverUrl: string;
  fetchClient: FetchClient;
}): ImageGenToolContext {
  const inlineImageMaxBytes = 60_000;
  return {
    workspaceRoot: input.workspaceRoot,
    fetchClient: input.fetchClient,
    downloadSizeLimit: 10 * 1024 * 1024,
    inlineImageMaxBytes,
    inferenceImageOptions: defaultInferenceImageOptions(inlineImageMaxBytes),
    config: {
      base_url: input.serverUrl,
      api_key: "test-key",
      models: { pro: "gemini-3-pro-image", flash: "gemini-3.1-flash-image" },
      output_subdir: "generated-images",
    },
  };
}

function geminiImageResponse(b64: string, mime = "image/png") {
  return {
    candidates: [
      { content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: mime, data: b64 } }] }, finishReason: "STOP" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("buildRequestBody: generation has no inlineData, no imageConfig, mandatory maxOutputTokens", () => {
  const body = buildRequestBody({ prompt: "a cat", refs: [], maxOutputTokens: 32768 }) as any;
  assert.deepEqual(body.contents[0].parts, [{ text: "a cat" }]);
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.equal(body.generationConfig.maxOutputTokens, 32768);
  assert.equal(body.generationConfig.imageConfig, undefined);
});

test("buildRequestBody: edit prepends inlineData parts before the text and sets imageConfig", () => {
  const body = buildRequestBody({
    prompt: "make it night",
    refs: [{ mimeType: "image/png", data: "AAAA" }],
    aspectRatio: "16:9",
    imageSize: "2K",
    maxOutputTokens: 32768,
  }) as any;
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: "image/png", data: "AAAA" } });
  assert.deepEqual(body.contents[0].parts[1], { text: "make it night" });
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });
});

test("extractImage: reads camelCase, snake_case, and reports MAX_TOKENS with no image", () => {
  const camel = extractImage({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "X" } }] } }] });
  assert.deepEqual(camel.image, { mimeType: "image/jpeg", data: "X" });

  const snake = extractImage({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "Y" } }] } }] } as any);
  assert.deepEqual(snake.image, { mimeType: "image/png", data: "Y" });

  const truncated = extractImage({ candidates: [{ content: {}, finishReason: "MAX_TOKENS" }] });
  assert.equal(truncated.image, undefined);
  assert.equal(truncated.finishReason, "MAX_TOKENS");
});

// ---------------------------------------------------------------------------
// Construction-time validation
// ---------------------------------------------------------------------------

test("createImageGenTool throws when api_key or models are missing", () => {
  assert.throws(
    () => createImageGenTool({ workspaceRoot: "/tmp", fetchClient: {} as any, downloadSizeLimit: 1, inlineImageMaxBytes: 1, inferenceImageOptions: defaultInferenceImageOptions(1), config: { base_url: "https://x.test", models: { pro: "p", flash: "f" } } }),
    /api_key/,
  );
  assert.throws(
    () => createImageGenTool({ workspaceRoot: "/tmp", fetchClient: {} as any, downloadSizeLimit: 1, inlineImageMaxBytes: 1, inferenceImageOptions: defaultInferenceImageOptions(1), config: { base_url: "https://x.test", api_key: "k", models: { pro: "p", flash: "" } } }),
    /models\.pro and image_gen\.models\.flash/,
  );
});

// ---------------------------------------------------------------------------
// Execute — end to end against a loopback server
// ---------------------------------------------------------------------------

test("image_generate writes the image to the workspace and returns an inline preview + path", async () => {
  await withWorkspace(async (workspace) => {
    const b64 = await smallPngBase64();
    const server = await startGeminiServer(() => ({ json: geminiImageResponse(b64) }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("call-1", { prompt: "a yellow square", aspect_ratio: "16:9", image_size: "2K" });

      // Request shape reached the server correctly.
      const body = server.lastBody();
      assert.equal(body.generationConfig.maxOutputTokens, 32768);
      assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });

      // Result carries a text block (with the path) + an inline image block.
      const types = result.content.map((c: any) => c.type);
      assert.ok(types.includes("text"));
      assert.ok(types.includes("image"));
      assert.match(result.details.path, /^\.\/generated-images\/image-[0-9a-f]+\.png$/);
      assert.equal(result.details.isEdit, false);
      assert.equal(result.details.model, "gemini-3-pro-image");

      // File actually exists on disk and is a non-empty PNG.
      const saved = path.join(workspace, "generated-images", path.basename(result.details.path));
      const bytes = await readFile(saved);
      assert.ok(bytes.byteLength > 0);
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

test("image_generate edit mode loads a workspace reference image as an inlineData part", async () => {
  await withWorkspace(async (workspace) => {
    // Drop a reference image into the workspace.
    const refPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    await writeFile(path.join(workspace, "ref.png"), refPng);

    const out = await smallPngBase64();
    const server = await startGeminiServer(() => ({ json: geminiImageResponse(out) }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("call-2", { prompt: "make it red", images: ["ref.png"] });

      const body = server.lastBody();
      assert.equal(body.contents[0].parts.length, 2);
      assert.equal(body.contents[0].parts[0].inlineData.mimeType, "image/png");
      assert.equal(body.contents[0].parts[0].inlineData.data, refPng.toString("base64"));
      assert.deepEqual(body.contents[0].parts[1], { text: "make it red" });
      assert.equal(result.details.isEdit, true);
      assert.equal(result.details.referenceImages, 1);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

test("image_generate surfaces an error (no throw) when the model returns no image", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ json: { candidates: [{ content: {}, finishReason: "MAX_TOKENS" }] } }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("call-3", { prompt: "anything" });
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /no image/i);
      assert.match(result.content[0].text, /MAX_TOKENS/);
      assert.ok(result.details.error);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

test("image_generate rejects image_size '512' unless model is flash", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ json: { candidates: [] } }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const blocked: any = await tool.execute("call-4", { prompt: "x", image_size: "512" });
      assert.match(blocked.content[0].text, /512.*flash/i);
      // The request must never have been sent.
      assert.equal(server.lastBody(), undefined);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// SSRF & path-traversal rejection of reference inputs (#5.1, #5.4)
// ---------------------------------------------------------------------------

test("image_generate rejects a reference URL pointing at a private/loopback host", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ json: { candidates: [] } }));
    // Use the REAL guarding fetch client (the production path): private IP
    // literals are rejected by the egress guard inside the client — no DNS, no
    // network — before any download. IP literals keep the block deterministic.
    setEgressGuardEnabled(true);
    const fetchClient = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 1024 });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient }));
      for (const url of [
        "http://127.0.0.1:8080/x.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/secret.png",
      ]) {
        const result: any = await tool.execute("ssrf", { prompt: "edit", images: [url] });
        // Non-throwing error tool result mentioning the load failure.
        assert.equal(result.content[0].type, "text");
        assert.match(result.content[0].text, /error/i);
        assert.match(result.content[0].text, /Failed to load reference image/i);
        assert.ok(result.details.error);
      }
      // No Gemini generation request was sent.
      assert.equal(server.lastBody(), undefined);
    } finally {
      fetchClient.stop();
      await server.close();
    }
  });
});

test("image_generate rejects a workspace-relative reference that escapes the root", async () => {
  await withWorkspace(async (workspace) => {
    // Plant a file OUTSIDE the workspace that "../outside.png" would resolve to,
    // proving the rejection is from the path guard, not a missing-file error.
    const outside = path.join(workspace, "..", "outside.png");
    const outsidePng = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    await writeFile(outside, outsidePng);
    const server = await startGeminiServer(() => ({ json: { candidates: [] } }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("traversal", { prompt: "edit", images: ["../outside.png"] });
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /Failed to load reference image/i);
      assert.ok(result.details.error);
      // No generation request was sent.
      assert.equal(server.lastBody(), undefined);
    } finally {
      await rm(outside, { force: true });
      await server.close();
      await stub.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Construction-time output_subdir traversal rejection (#5.4)
// ---------------------------------------------------------------------------

test("createImageGenTool throws when output_subdir escapes the workspace", () => {
  for (const subdir of ["../evil", "/abs/evil", "a/../../etc", ".."]) {
    assert.throws(
      () =>
        createImageGenTool({
          workspaceRoot: "/tmp",
          fetchClient: {} as any,
          downloadSizeLimit: 1,
          inlineImageMaxBytes: 1,
          inferenceImageOptions: defaultInferenceImageOptions(1),
          config: { base_url: "https://x.test", api_key: "k", models: { pro: "p", flash: "f" }, output_subdir: subdir },
        }),
      /output_subdir/,
      `expected ${subdir} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// File-collision retry (#5.6)
// ---------------------------------------------------------------------------

test("image_generate skips existing filenames and picks the next free suffix", async () => {
  await withWorkspace(async (workspace) => {
    // Pre-create myname.png and myname-1.png so the writer must land on -2.
    const outDir = path.join(workspace, "generated-images");
    await mkdir(outDir, { recursive: true });
    const sentinel0 = Buffer.from("PRE-EXISTING-0");
    const sentinel1 = Buffer.from("PRE-EXISTING-1");
    await writeFile(path.join(outDir, "myname.png"), sentinel0);
    await writeFile(path.join(outDir, "myname-1.png"), sentinel1);

    const b64 = await smallPngBase64();
    const server = await startGeminiServer(() => ({ json: geminiImageResponse(b64) }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("collision", { prompt: "a square", filename: "myname" });
      assert.equal(result.details.path, "./generated-images/myname-2.png");
      // The new file exists and is a real PNG.
      const written = await readFile(path.join(outDir, "myname-2.png"));
      assert.deepEqual(written.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // Pre-existing files were left untouched.
      assert.deepEqual(await readFile(path.join(outDir, "myname.png")), sentinel0);
      assert.deepEqual(await readFile(path.join(outDir, "myname-1.png")), sentinel1);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Reference bounding (#5.7 / issue #3)
// ---------------------------------------------------------------------------

test("image_generate sends an under-budget URL reference with its original content-type and bytes", async () => {
  await withWorkspace(async (workspace) => {
    // A small JPEG well under the 6 MiB reference budget: must be sent untouched
    // (original MIME from content-type, original base64 bytes — no re-encode).
    const refJpeg = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 90, g: 120, b: 200 } } }).jpeg().toBuffer();
    const out = await smallPngBase64();
    const server = await startGeminiServer(() => ({ json: geminiImageResponse(out) }));
    const stub = makeStubFetchClient({ buffer: refJpeg, contentType: "image/jpeg" });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("ref-url", { prompt: "make it warmer", images: ["https://example.com/ref.jpg"] });

      // The URL was actually downloaded through the fetch client with the guard on.
      assert.deepEqual(stub.calls, ["https://example.com/ref.jpg"]);

      const body = server.lastBody();
      assert.equal(body.contents[0].parts.length, 2);
      // MIME comes from the content-type header; bytes are the ORIGINAL, unmodified.
      assert.equal(body.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
      assert.equal(body.contents[0].parts[0].inlineData.data, refJpeg.toString("base64"));
      assert.deepEqual(body.contents[0].parts[1], { text: "make it warmer" });
      assert.equal(result.details.isEdit, true);
      assert.equal(result.details.referenceImages, 1);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

// NOTE on the over-budget path: `boundReferenceImage` only re-encodes (resize +
// JPEG via conditionImageBufferForInference) when a reference exceeds the 6 MiB
// REFERENCE_IMAGE_MAX_BYTES budget. Producing a genuinely >6 MiB image in a unit
// test is impractical (multi-megapixel buffers, slow sharp encodes), so the
// over-budget branch is left to the conditionImageBufferForInference unit tests;
// the under-budget untouched path (the security/quality-relevant default) is
// covered above and by the existing workspace-reference edit-mode test.

// ---------------------------------------------------------------------------
// HTTP-error branch (#5.8)
// ---------------------------------------------------------------------------

test("image_generate surfaces an HTTP 429 from the endpoint as a non-throwing text error", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ status: 429, json: { error: "rate limited" } }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const tool = createImageGenTool(baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client }));
      const result: any = await tool.execute("rate-limited", { prompt: "anything" });
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /HTTP 429/);
      assert.ok(result.details.error);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded admission wait (#14)
// ---------------------------------------------------------------------------

test("image_generate bounds the scheduler-admission wait by maxWaitMs and degrades to a text error (#14)", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ json: geminiImageResponse("AAAA") }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      let acquireSignal: AbortSignal | undefined;
      // A scheduler stuck behind a half-open probe: acquire blocks until its
      // signal aborts (then rejects, as the real scheduler does), simulating an
      // image-model outage. Without the per-call timeout the tool would hang.
      const scheduler = {
        acquire: (opts: { signal?: AbortSignal }) =>
          new Promise<() => void>((_resolve, reject) => {
            acquireSignal = opts.signal;
            opts.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
        noteOutcome: () => {},
      } as unknown as LlmScheduler;

      const ctx = baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client });
      ctx.scheduler = scheduler;
      ctx.maxWaitMs = 50; // tiny wall-clock bound so the test doesn't wait 120s

      const tool = createImageGenTool(ctx);
      const start = Date.now();
      const result: any = await tool.execute("bounded", { prompt: "a yellow square" });
      const elapsed = Date.now() - start;

      assert.ok(acquireSignal !== undefined, "a signal was passed to acquire");
      assert.ok(elapsed < 5000, `bounded — gave up promptly, took ${elapsed}ms`);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /Image generation request failed/);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});

test("image_generate composes the agent abort signal into the admission wait (#14)", async () => {
  await withWorkspace(async (workspace) => {
    const server = await startGeminiServer(() => ({ json: geminiImageResponse("AAAA") }));
    const stub = makeStubFetchClient({ buffer: Buffer.from("unused") });
    try {
      const scheduler = {
        acquire: (opts: { signal?: AbortSignal }) =>
          new Promise<() => void>((_resolve, reject) => {
            opts.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
        noteOutcome: () => {},
      } as unknown as LlmScheduler;

      const ctx = baseContext({ workspaceRoot: workspace, serverUrl: server.url, fetchClient: stub.client });
      ctx.scheduler = scheduler;
      ctx.maxWaitMs = 60_000; // long, so the AGENT signal (not the timeout) ends the wait

      const tool = createImageGenTool(ctx);
      const agent = new AbortController();
      setTimeout(() => agent.abort(), 30);
      const start = Date.now();
      const result: any = await tool.execute("agent-abort", { prompt: "x" }, agent.signal);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `agent abort released the wait, took ${elapsed}ms`);
      assert.match(result.content[0].text, /Image generation request failed/);
    } finally {
      await server.close();
      await stub.cleanup();
    }
  });
});
