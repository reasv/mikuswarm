import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { VectorStore, l2normalize } from "../src/retrieval/index.js";
import type { Logger } from "../src/observability/logger.js";

/**
 * Direct VectorStore tests (no indexer/embed-worker), covering:
 *  - #19: vec0 KNN `k`+`source` partition semantics — `knn(q, k, "memory")` returns up
 *    to `k` nearest WITHIN the memory partition, even when vectors in another partition
 *    are nearer (i.e. it is N-nearest-within-partition, not N-overall-then-filtered).
 *  - #17: a read failure is swallowed into a graceful empty result AND warns once.
 *
 * sqlite-vec is loaded by `VectorStore.load()` (called by `ensureSchema`). The other
 * memory-retrieval tests in this repo construct a VectorStore the same way and run, so
 * the extension loads in this environment; we do not need a skip guard. If a future
 * environment cannot load sqlite-vec, `ensureSchema` throws and the test fails loudly
 * (rather than silently passing) — which is the correct signal.
 */

const DIM = 3;

function vec(a: number, b: number, c: number): Float32Array {
  return l2normalize([a, b, c]);
}

async function withStore(run: (vs: VectorStore, storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vecstore-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const vs = new VectorStore(storage);
    await vs.ensureSchema(DIM, "fake:test");
    await run(vs, storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("knn k+source returns k nearest WITHIN the partition even when the other partition is nearer (review #19)", async () => {
  await withStore(async (vs) => {
    // Query points along +x. The three nearest-overall vectors all live in the OTHER
    // ("diary") partition; the "memory" partition's vectors are deliberately farther
    // (rotated toward +y). A naive N-overall-then-filter KNN with k=3 would fetch the 3
    // diary rows, filter them all out, and return 0 memory rows. A correct partitioned
    // KNN (`k=3 and source='memory'`) returns the 3 nearest MEMORY rows.
    const query = vec(1, 0, 0);

    // OTHER partition: very close to the query (small +y component) — nearest overall.
    await vs.upsert(101, "diary", vec(1, 0.01, 0));
    await vs.upsert(102, "diary", vec(1, 0.02, 0));
    await vs.upsert(103, "diary", vec(1, 0.03, 0));

    // MEMORY partition: farther from the query (larger +y component), with a clear
    // internal ordering (chunk 1 nearest, then 2, then 3, then 4).
    await vs.upsert(1, "memory", vec(1, 0.5, 0));
    await vs.upsert(2, "memory", vec(1, 0.7, 0));
    await vs.upsert(3, "memory", vec(1, 0.9, 0));
    await vs.upsert(4, "memory", vec(1, 1.2, 0));

    const k = 3;
    const hits = vs.knn(query, k, "memory");

    // Returns exactly k rows (not fewer) — i.e. it did NOT under-fetch by taking the
    // k-overall (which are all diary) and then filtering.
    assert.equal(hits.length, k, "knn(q, k, 'memory') returns k rows from the memory partition");
    // Every returned row is from the memory partition (chunk ids 1..4, never 101..103).
    for (const h of hits) {
      assert.ok(h.chunkId >= 1 && h.chunkId <= 4, `row ${h.chunkId} is a memory-partition row`);
    }
    // The 3 nearest memory rows are 1, 2, 3 (4 is farthest), in distance order.
    assert.deepEqual(
      hits.map((h) => h.chunkId),
      [1, 2, 3],
      "the k nearest WITHIN the memory partition, in distance order",
    );
    // Distances are non-decreasing.
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i]!.distance >= hits[i - 1]!.distance, "distances are ordered");
    }
  });
});

test("knn k+source under-fetch check: k larger than the partition returns all partition rows (review #19)", async () => {
  await withStore(async (vs) => {
    const query = vec(1, 0, 0);
    // 2 memory rows, 5 nearer diary rows. k=2 must return both memory rows.
    await vs.upsert(201, "diary", vec(1, 0.01, 0));
    await vs.upsert(202, "diary", vec(1, 0.02, 0));
    await vs.upsert(203, "diary", vec(1, 0.03, 0));
    await vs.upsert(204, "diary", vec(1, 0.04, 0));
    await vs.upsert(205, "diary", vec(1, 0.05, 0));
    await vs.upsert(1, "memory", vec(1, 0.5, 0));
    await vs.upsert(2, "memory", vec(1, 0.7, 0));

    const hits = vs.knn(query, 2, "memory");
    assert.equal(hits.length, 2, "both memory rows returned despite 5 nearer diary rows");
    assert.deepEqual(hits.map((h) => h.chunkId).sort((a, b) => a - b), [1, 2]);
  });
});

test("getVectors swallows a read error into an empty map and warns once (review #17)", async () => {
  await withStore(async (vs) => {
    await vs.upsert(1, "memory", vec(1, 0, 0));

    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(message, fields) {
        warnings.push({ message, fields });
      },
      error() {},
      child() {
        return logger;
      },
    };
    // Inject a logger and force the read to throw to exercise the catch path. We rebuild
    // a VectorStore over the same loaded extension state but with a poisoned `storage`
    // whose `read` throws, simulating a vec0 binding/corruption failure.
    const throwingStorage = {
      read() {
        throw new Error("simulated vec0 read failure");
      },
    } as unknown as Storage;
    const poisoned = new VectorStore(throwingStorage, logger);
    // Mark it loaded so getVectors/knn proceed to the read (which throws).
    (poisoned as unknown as { loaded: boolean }).loaded = true;

    const out1 = poisoned.getVectors([1, 2, 3]);
    assert.equal(out1.size, 0, "getVectors returns an empty map on read failure");
    assert.equal(warnings.length, 1, "warns exactly once");
    assert.equal(warnings[0]!.message, "vector_store_read_failed");

    // A second failing call (getVectors or knn) does NOT warn again — once per process.
    const out2 = poisoned.getVectors([4, 5]);
    assert.equal(out2.size, 0);
    const knnHits = poisoned.knn(vec(1, 0, 0), 3, "memory");
    assert.deepEqual(knnHits, [], "knn also degrades to empty on read failure");
    assert.equal(warnings.length, 1, "still warned only once across getVectors + knn");
  });
});
