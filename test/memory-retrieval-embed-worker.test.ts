import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  EmbedWorkerPool,
  VectorStore,
  resolveRetrievalConfig,
  l2normalize,
  type EmbeddingProvider,
} from "../src/retrieval/index.js";

const DIM = 4;

function vec(seed: number): Float32Array {
  return l2normalize([seed + 0.1, 0.2, 0.3, 0.4]);
}

async function withStorage(run: (s: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-embed-worker-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Insert N pending chunks (one file, distinct ids/hashes) and return the file path. */
async function seedChunks(storage: Storage, n: number): Promise<void> {
  const chunks = Array.from({ length: n }, (_v, i) => ({
    id: `c-${i}`,
    path: "memory/x.md",
    ordinal: i,
    source: "memory" as const,
    startLine: i * 2 + 1,
    endLine: i * 2 + 2,
    room: null,
    entryTs: 1000 + i,
    text: `chunk body number ${i}`,
    tokenCount: 4,
    contentHash: `h-${i}`,
  }));
  await storage.reconcileMemoryChunks("memory/x.md", chunks);
}

function countByStatus(storage: Storage, status: string): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare("select count(*) as n from memory_chunks where embed_status = ?")
          .get(status) as { n: number }
      ).n,
  );
}

function inFlight(storage: Storage): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare(
            "select count(*) as n from memory_chunks where embed_status in ('pending','processing')",
          )
          .get() as { n: number }
      ).n,
  );
}

async function drain(storage: Storage, worker: EmbedWorkerPool, deadlineMs = 5000): Promise<void> {
  await worker.start();
  const deadline = Date.now() + deadlineMs;
  while (inFlight(storage) > 0) {
    if (Date.now() > deadline) throw new Error("embedding did not drain in time");
    await new Promise((r) => setTimeout(r, 10));
  }
  await storage.waitForIdle();
}

// #3: with worker_count > 1, two concurrent loops claim from the same queue but must
// never double-process a chunk. A provider that records every text it is asked to
// embed lets us assert each unique chunk text was embedded exactly once.
test("multiple worker loops never double-process a chunk (#3)", async () => {
  await withStorage(async (storage) => {
    const embedded: string[] = [];
    let concurrentPeak = 0;
    let inProvider = 0;
    const provider: EmbeddingProvider = {
      modelId: "fake:multi",
      dim: DIM,
      async embedDocuments(texts) {
        inProvider++;
        concurrentPeak = Math.max(concurrentPeak, inProvider);
        // Yield so both loops can be in-flight together (proving real concurrency).
        await new Promise((r) => setTimeout(r, 15));
        for (const t of texts) embedded.push(t);
        inProvider--;
        return texts.map((_t, i) => vec(i));
      },
      async embedQuery() {
        return vec(0);
      },
      async close() {},
    };

    const vectorStore = new VectorStore(storage);
    await vectorStore.ensureSchema(DIM, provider.modelId);
    // Small batch size so 20 chunks require many claims spread across both loops.
    const config = resolveRetrievalConfig({
      enabled: true,
      index: { worker_count: 3, embed_batch_size: 2 },
    });
    assert.equal(config.index.workerCount, 3, "worker_count is honored from config");

    await seedChunks(storage, 20);
    const worker = new EmbedWorkerPool({ storage, vectorStore, provider, config });
    try {
      await drain(storage, worker);
    } finally {
      await worker.stop();
    }

    assert.equal(countByStatus(storage, "done"), 20, "every chunk embedded");
    assert.equal(embedded.length, 20, "each chunk embedded exactly once (no double-claim)");
    assert.equal(new Set(embedded).size, 20, "no duplicate texts embedded");
    assert.ok(concurrentPeak >= 2, "loops actually ran concurrently");
  });
});

// #4: a batch mixing cache hits and provider misses where the provider throws. The
// cache-served chunks must end 'done' (they never touched the provider); only the
// misses burn an attempt and go back to pending/failed.
test("provider error fails only the misses, not cache-served chunks (#4)", async () => {
  await withStorage(async (storage) => {
    const provider: EmbeddingProvider = {
      modelId: "fake:poison",
      dim: DIM,
      async embedDocuments() {
        throw new Error("simulated provider outage");
      },
      async embedQuery() {
        return vec(0);
      },
      async close() {},
    };

    const vectorStore = new VectorStore(storage);
    await vectorStore.ensureSchema(DIM, provider.modelId);
    const config = resolveRetrievalConfig({
      enabled: true,
      index: { worker_count: 1, embed_batch_size: 10, max_retries: 3 },
    });

    // Two chunks: c-0 is a cache hit, c-1 is a miss (provider will throw).
    await seedChunks(storage, 2);
    const cachedVec = vec(0);
    await storage.putCachedEmbedding(
      "h-0",
      provider.modelId,
      Buffer.from(cachedVec.buffer, cachedVec.byteOffset, cachedVec.byteLength),
    );

    const worker = new EmbedWorkerPool({ storage, vectorStore, provider, config });
    // Run a single batch directly (not the full loop) to observe the one-pass outcome.
    const processed = await (worker as unknown as { processBatch(): Promise<number> }).processBatch();
    assert.equal(processed, 2, "both chunks were claimed");

    // c-0 (cache hit) succeeded despite the provider throwing on the batch.
    const c0 = storage.read(
      (db) =>
        db.prepare("select embed_status, embed_attempts from memory_chunks where id='c-0'").get() as {
          embed_status: string;
          embed_attempts: number;
        },
    );
    assert.equal(c0.embed_status, "done", "cache-served chunk ends done");

    // c-1 (miss) went back to pending (attempts 1 <= max_retries) — it burned an
    // attempt, the cache hit did not push it toward terminal failure.
    const c1 = storage.read(
      (db) =>
        db.prepare("select embed_status, embed_attempts from memory_chunks where id='c-1'").get() as {
          embed_status: string;
          embed_attempts: number;
        },
    );
    assert.equal(c1.embed_status, "pending", "miss retries");
    assert.equal(c1.embed_attempts, 1, "miss burned exactly one attempt");

    // The cache-served vector landed in memory_vec; the miss did not.
    const vecRows = storage.read(
      (db) =>
        db.prepare("select chunk_id from memory_vec").all() as Array<{ chunk_id: number }>,
    );
    assert.equal(vecRows.length, 1, "only the cache-served chunk has a vector");

    await worker.stop();
  });
});

// #8: a notify that lands while a batch is processing must not be lost — the loop
// re-polls immediately rather than waiting the full idle interval. We block the
// provider until a notify fires mid-batch, then assert the next batch is picked up
// well within the 5s idle window.
test("notifyNewWork during processing is not dropped (#8)", async () => {
  await withStorage(async (storage) => {
    let firstBatchGate!: () => void;
    const firstBatch = new Promise<void>((r) => (firstBatchGate = r));
    let calls = 0;
    const provider: EmbeddingProvider = {
      modelId: "fake:sticky",
      dim: DIM,
      async embedDocuments(texts) {
        calls++;
        if (calls === 1) await firstBatch; // hold the first batch open
        return texts.map((_t, i) => vec(i));
      },
      async embedQuery() {
        return vec(0);
      },
      async close() {},
    };

    const vectorStore = new VectorStore(storage);
    await vectorStore.ensureSchema(DIM, provider.modelId);
    const config = resolveRetrievalConfig({
      enabled: true,
      index: { worker_count: 1, embed_batch_size: 1 },
    });

    await seedChunks(storage, 1); // first batch (1 chunk)
    const worker = new EmbedWorkerPool({ storage, vectorStore, provider, config });
    await worker.start();

    // Wait until the loop is in the held first batch, then queue more work AND notify
    // while processing is in flight (the dropped-wake window).
    while (calls < 1) await new Promise((r) => setTimeout(r, 5));
    await seedChunks2(storage); // add c-extra
    worker.notifyNewWork(); // lands mid-processBatch → must stick
    firstBatchGate(); // release the first batch

    // The second chunk should be embedded promptly (sticky flag → immediate re-poll),
    // far inside the 5s idle window. Allow a generous-but-sub-idle budget.
    const deadline = Date.now() + 1500;
    while (inFlight(storage) > 0) {
      if (Date.now() > deadline) throw new Error("sticky wake was dropped (idle timeout hit)");
      await new Promise((r) => setTimeout(r, 10));
    }
    await storage.waitForIdle();
    assert.equal(countByStatus(storage, "done"), 2, "both chunks embedded promptly");
    await worker.stop();
  });
});

// Add a second distinct chunk to the existing file without disturbing c-0..c-(n-1).
async function seedChunks2(storage: Storage): Promise<void> {
  await storage.reconcileMemoryChunks("memory/y.md", [
    {
      id: "c-extra",
      path: "memory/y.md",
      ordinal: 0,
      source: "memory",
      startLine: 1,
      endLine: 2,
      room: null,
      entryTs: 9999,
      text: "extra chunk body",
      tokenCount: 3,
      contentHash: "h-extra",
    },
  ]);
}

// #11: stop() aborts an in-flight provider request so shutdown doesn't block up to the
// remote timeout. We assert the wiring: the signal passed to embedDocuments is aborted
// by stop(), and stop() resolves promptly (not after the provider's own long wait).
test("stop() aborts the in-flight provider request (#11)", async () => {
  await withStorage(async (storage) => {
    let receivedSignal: AbortSignal | undefined;
    let aborted = false;
    const provider: EmbeddingProvider = {
      modelId: "fake:abort",
      dim: DIM,
      async embedDocuments(texts, signal) {
        receivedSignal = signal;
        // Simulate a slow remote call that only resolves on abort (or a long timeout).
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 30_000); // the "30s" remote timeout analogue
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        return texts.map((_t, i) => vec(i));
      },
      async embedQuery() {
        return vec(0);
      },
      async close() {},
    };

    const vectorStore = new VectorStore(storage);
    await vectorStore.ensureSchema(DIM, provider.modelId);
    const config = resolveRetrievalConfig({
      enabled: true,
      index: { worker_count: 1, embed_batch_size: 1 },
    });
    await seedChunks(storage, 1);

    const worker = new EmbedWorkerPool({ storage, vectorStore, provider, config });
    await worker.start();
    // Wait until the loop is parked inside the slow embedDocuments call.
    while (!receivedSignal) await new Promise((r) => setTimeout(r, 5));
    assert.ok(receivedSignal, "a stop signal was threaded into embedDocuments");
    assert.equal(receivedSignal!.aborted, false, "not aborted during normal operation");

    const start = Date.now();
    await worker.stop();
    const elapsed = Date.now() - start;
    assert.ok(aborted, "stop() aborted the in-flight provider request");
    assert.ok(elapsed < 2000, `stop() returned promptly (${elapsed}ms), not after the 30s timeout`);
  });
});
