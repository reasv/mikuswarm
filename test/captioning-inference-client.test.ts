import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InferenceClient } from "../src/captioning/inference-client.js";
import { LlmScheduler, type LlmScheduler as LlmSchedulerType } from "../src/agent/scheduler.js";
import type { ModelChainEntry } from "../src/agent/model-fallback.js";

async function withImageFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-caption-"));
  const filePath = path.join(dir, "test.png");
  // A tiny non-image payload is fine: the test never reaches describeMedia
  // (the scheduler acquire is what we exercise), and no image processing is set.
  await writeFile(filePath, "not-a-real-image");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// #6: the caption client must thread a shutdown abort signal into the scheduler
// acquire so a queued caption waiter is rejected promptly at stop() — otherwise
// captionPool.stop() can stall for probe-window multiples during an outage.
test("InferenceClient: stop() aborts a queued scheduler acquire (#6)", async () => {
  await withImageFile(async (filePath) => {
    let acquireSignal: AbortSignal | undefined;
    const scheduler = {
      // Block until the acquire's signal aborts, then reject like the real
      // scheduler does (an AbortError), simulating a waiter parked behind a
      // half-open probe during a caption-model outage.
      acquire: (opts: { signal?: AbortSignal }) =>
        new Promise<() => void>((_resolve, reject) => {
          acquireSignal = opts.signal;
          if (opts.signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          opts.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
      noteOutcome: () => {},
    } as unknown as LlmSchedulerType;

    const client = new InferenceClient({
      modality: "image",
      // Single-member chain (spec MODEL-FALLBACK §2.3): caption() reads the file
      // then goes straight to the per-member scheduler acquire.
      chain: [
        {
          logicalId: "caption-model",
          config: { id: "caption-model", endpoint: "http://127.0.0.1:9", api_key: "k", input_modalities: ["text", "image"], max_tokens: 256, context_window: 128000 } as never,
        },
      ],
      prompt: "describe",
      maxChars: 100,
      maxTokens: 256,
      scheduler,
      // No imageProcessing → caption() reads the file then goes straight to acquire.
    });

    const pending = client.caption({ filePath, mimeType: "image/png", filename: "test.png" });
    // Give caption() a tick to reach the (blocking) acquire, then stop the client.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(acquireSignal !== undefined, "a signal was passed to acquire");
    assert.equal(acquireSignal!.aborted, false, "not yet aborted before stop()");

    client.stop();
    await assert.rejects(() => pending, /aborted/, "queued acquire rejects on stop()");
    assert.equal(acquireSignal!.aborted, true, "stop() aborted the acquire signal");
  });
});

/** An OpenAI-style /chat/completions loopback server returning a fixed caption. */
async function startCaptionServer(
  caption: string,
): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "caption-model", choices: [{ message: { content: caption } }], usage: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// spec MODEL-FALLBACK §6 (caption row): a 2-member chain whose HEAD is unhealthy
// (per §8a health) falls over to the fallback member, which serves the caption.
test("InferenceClient: 2-member chain — head unhealthy → fallback member serves the caption", async () => {
  await withImageFile(async (filePath) => {
    const head = await startCaptionServer("from-head");
    const fb = await startCaptionServer("from-fallback");
    try {
      // Mark the head's model UNHEALTHY (probe window far out) so chooseChainMember
      // skips it (not probe-due) and selects the in-budget healthy fallback.
      const scheduler = new LlmScheduler({
        health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
      });
      const headKey = `${head.url}::caption-head`;
      scheduler.noteOutcome("default", headKey, "environmental"); // → unhealthy

      const chain: ModelChainEntry[] = [
        { logicalId: "caption-head", config: { id: "caption-head", endpoint: head.url, api_key: "k", input_modalities: ["text", "image"], max_tokens: 256, context_window: 128000 } as never },
        { logicalId: "caption-fallback", config: { id: "caption-fallback", endpoint: fb.url, api_key: "k", input_modalities: ["text", "image"], max_tokens: 256, context_window: 128000 } as never },
      ];

      const client = new InferenceClient({
        modality: "image",
        chain,
        prompt: "describe",
        maxChars: 100,
        maxTokens: 256,
        scheduler,
      });

      const result = await client.caption({ filePath, mimeType: "image/png", filename: "test.png" });
      assert.equal(result.caption, "from-fallback", "the fallback member served the caption");
      assert.equal(result.logicalModelId, "caption-fallback");
      assert.equal(head.hits(), 0, "the unhealthy head member is never hit");
      assert.equal(fb.hits(), 1, "the fallback member served exactly once");
    } finally {
      await head.close();
      await fb.close();
    }
  });
});

// spec MODEL-FALLBACK §3/§6 (per-lane capability pre-filter, issue #3): on a video
// lane, an image-only FALLBACK member is dropped by the capability predicate so the
// video is never shipped to a model that can't see it (worst case: a silent 200
// with a hallucinated caption). Here the head is unhealthy, the first fallback is
// image-only (must be dropped despite being healthy + in-budget), and the second
// fallback is video-capable and serves. Without the predicate, the image-only
// fallback would have been selected and mis-captioned the video.
test("InferenceClient: video lane drops an image-only fallback, serves from a video-capable one", async () => {
  await withImageFile(async (filePath) => {
    const head = await startCaptionServer("from-head");
    const imageOnlyFb = await startCaptionServer("from-image-fallback");
    const videoFb = await startCaptionServer("from-video-fallback");
    try {
      const scheduler = new LlmScheduler({
        health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
      });
      // Mark the head unhealthy (probe far out) so selection falls past it.
      scheduler.noteOutcome("default", `${head.url}::caption-head`, "environmental");

      const chain: ModelChainEntry[] = [
        {
          logicalId: "caption-head",
          config: { id: "caption-head", endpoint: head.url, api_key: "k", input_modalities: ["text", "image", "video"], max_tokens: 256, context_window: 128000 } as never,
        },
        {
          logicalId: "caption-image-fallback",
          config: { id: "caption-image-fallback", endpoint: imageOnlyFb.url, api_key: "k", input_modalities: ["text", "image"], max_tokens: 256, context_window: 128000 } as never,
        },
        {
          logicalId: "caption-video-fallback",
          config: { id: "caption-video-fallback", endpoint: videoFb.url, api_key: "k", input_modalities: ["text", "image", "video"], max_tokens: 256, context_window: 128000 } as never,
        },
      ];

      const client = new InferenceClient({
        modality: "video",
        chain,
        prompt: "describe",
        maxChars: 100,
        maxTokens: 256,
        scheduler,
        // No videoProcessing → caption() reads the file then goes straight to the fetch.
      });

      const result = await client.caption({ filePath, mimeType: "video/mp4", filename: "test.mp4" });
      assert.equal(result.caption, "from-video-fallback", "the video-capable fallback served the caption");
      assert.equal(result.logicalModelId, "caption-video-fallback");
      assert.equal(head.hits(), 0, "the unhealthy head is never hit");
      assert.equal(imageOnlyFb.hits(), 0, "the image-only fallback is filtered out for the video lane");
      assert.equal(videoFb.hits(), 1, "the video-capable fallback served exactly once");
    } finally {
      await head.close();
      await imageOnlyFb.close();
      await videoFb.close();
    }
  });
});
