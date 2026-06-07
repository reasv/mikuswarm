import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type {
  ConcurrencyLimitedFetchClient,
  FetchOptions,
  FetchResult,
} from "../src/enrichment/fetch-client.js";
import type { ImageProcessingOptions } from "../src/media/index.js";

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
}): { client: ConcurrencyLimitedFetchClient; calls: string[]; cleanup: () => Promise<void> } {
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
  } as unknown as ConcurrencyLimitedFetchClient;
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
  fetchClient: ConcurrencyLimitedFetchClient;
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
