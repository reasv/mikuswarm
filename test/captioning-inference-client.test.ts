import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InferenceClient } from "../src/captioning/inference-client.js";
import type { LlmScheduler } from "../src/agent/scheduler.js";

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
    } as unknown as LlmScheduler;

    const client = new InferenceClient({
      modality: "image",
      model: { id: "caption-model", endpoint: "http://127.0.0.1:9", api_key: "k" },
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
