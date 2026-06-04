import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  MemoryIndexer,
  MemorySearch,
  EmbedWorkerPool,
  VectorStore,
  resolveRetrievalConfig,
  l2normalize,
  type EmbeddingProvider,
} from "../src/retrieval/index.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";

const TZ = "Asia/Tokyo";

// Deterministic toy embedder: a keyword-count vector, so semantic similarity is
// meaningful and testable without the native model.
const KEYWORDS = ["sqlite", "database", "decide", "launch", "may", "pancake", "recipe", "carol"];

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "fake:keywords";
  readonly dim = KEYWORDS.length;
  fail = false;
  private vec(text: string): Float32Array {
    const lower = text.toLowerCase();
    const raw = KEYWORDS.map((k) => (lower.match(new RegExp(k, "g")) ?? []).length + 0.01);
    return l2normalize(raw);
  }
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vec(t));
  }
  async embedQuery(text: string): Promise<Float32Array> {
    if (this.fail) throw new Error("simulated embed failure");
    return this.vec(text);
  }
  async close(): Promise<void> {}
}

interface Stack {
  storage: Storage;
  indexer: MemoryIndexer;
  search: MemorySearch;
  worker: EmbedWorkerPool;
  provider: FakeEmbeddingProvider;
  workspaceRoot: string;
}

async function withStack(run: (s: Stack) => Promise<void>): Promise<void> {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-hybrid-"));
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const provider = new FakeEmbeddingProvider();
  const vectorStore = new VectorStore(storage);
  await vectorStore.ensureSchema(provider.dim, provider.modelId);
  const indexer = new MemoryIndexer({
    storage,
    workspaceRoot,
    config,
    pruneVectors: (rowids) => rowids.forEach((r) => void vectorStore.remove(r)),
  });
  const worker = new EmbedWorkerPool({ storage, vectorStore, provider, config });
  const search = new MemorySearch(storage, indexer, config, { provider, vectorStore });
  try {
    await run({ storage, indexer, search, worker, provider, workspaceRoot });
  } finally {
    await worker.stop();
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

function block(start: string, end: string, room: string, body: string): string {
  const header = buildDiaryHeader({
    earliestTimestamp: parseZonedWallClock(start, TZ)!,
    latestTimestamp: parseZonedWallClock(end, TZ)!,
    room,
  });
  return `${header}\n${body}\n`;
}

function inFlightEmbeds(storage: Storage): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare(
            `select count(*) as n from memory_chunks where embed_status in ('pending','processing')`,
          )
          .get() as { n: number }
      ).n,
  );
}

async function drainEmbeddings(storage: Storage, worker: EmbedWorkerPool): Promise<void> {
  await worker.start();
  const deadline = Date.now() + 5000;
  // Wait until nothing is pending OR processing — countPendingEmbedding alone hits 0
  // at claim time, before the in-flight batch has finished embedding.
  while (inFlightEmbeds(storage) > 0) {
    if (Date.now() > deadline) throw new Error("embedding did not drain in time");
    await new Promise((r) => setTimeout(r, 25));
  }
  await storage.waitForIdle();
}

test("embed worker populates the vector index and hybrid search runs", async () => {
  await withStack(async ({ storage, indexer, search, worker, workspaceRoot }) => {
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-12.md"),
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We argued and decided to use SQLite as our database.") +
        "\n" +
        block("2026-04-12 18:00", "2026-04-12 19:00", "#random", "Carol shared a pancake recipe."),
      "utf8",
    );
    await indexer.reconcileAll();
    assert.equal(storage.countPendingEmbedding(), 2);

    await drainEmbeddings(storage, worker);
    assert.equal(storage.countPendingEmbedding(), 0);
    // Both chunks are embedded (status done).
    const done = storage.read(
      (db) =>
        (db.prepare("select count(*) as n from memory_chunks where embed_status='done'").get() as {
          n: number;
        }).n,
    );
    assert.equal(done, 2);

    const outcome = await search.search({
      query: "what database did we decide on",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
    });
    assert.equal(outcome.mode, "hybrid");
    assert.equal(outcome.degraded, false);
    assert.ok(outcome.results[0]!.snippet.toLowerCase().includes("sqlite"));
  });
});

test("query-embed failure degrades to lexical-only without erroring", async () => {
  await withStack(async ({ storage, indexer, search, worker, provider, workspaceRoot }) => {
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-12.md"),
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We decided to use SQLite database."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker);

    provider.fail = true;
    const outcome = await search.search({
      query: "sqlite database decision",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
    });
    assert.equal(outcome.mode, "lexical");
    assert.equal(outcome.degraded, true);
    assert.ok(outcome.results.length >= 1);
  });
});

test("temporal decay favors the more recent of two equally-relevant entries", async () => {
  await withStack(async ({ storage, indexer, search, worker, workspaceRoot }) => {
    // Two entries with identical text but different dates.
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-01-01.md"),
      `# 2026-01-01 Daily Memory\n\n` +
        block("2026-01-01 12:00", "2026-01-01 12:30", "#general", "Discussed the launch in May."),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-05-01.md"),
      `# 2026-05-01 Daily Memory\n\n` +
        block("2026-05-01 12:00", "2026-05-01 12:30", "#general", "Discussed the launch in May."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker);

    const now = parseZonedWallClock("2026-05-02 12:00", TZ)!;
    const outcome = await search.search({
      query: "launch May discussed",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
      now,
    });
    assert.equal(outcome.results[0]!.date, "2026-05-01", "newer entry should rank first under decay");
  });
});

test("embed worker ignores a stale wrong-width cached vector and re-embeds", async () => {
  await withStack(async ({ storage, indexer, worker, provider, workspaceRoot }) => {
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-12.md"),
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "Carol shared a pancake recipe."),
      "utf8",
    );
    await indexer.reconcileAll();

    // Find the chunk's real content hash, then poison the cache with a wrong-width
    // BLOB under the active model id (simulating a remote dim change without an id
    // change). Pre-fix, the cache-hit path would upsert this wrong-width vector
    // (vec0 rejects it → the batch fails); post-fix it is ignored and re-embedded.
    const contentHash = storage.read(
      (db) =>
        (db.prepare("select content_hash as h from memory_chunks limit 1").get() as { h: string }).h,
    );
    const badVec = l2normalize([1, 2, 3]); // dim 3, provider.dim is KEYWORDS.length (8)
    await storage.putCachedEmbedding(
      contentHash,
      provider.modelId,
      Buffer.from(badVec.buffer, badVec.byteOffset, badVec.byteLength),
    );

    await drainEmbeddings(storage, worker);

    // The chunk embedded successfully (status done, not failed) and the vector index
    // holds exactly one full-width row.
    assert.equal(storage.countPendingEmbedding(), 0);
    const done = storage.read(
      (db) =>
        (db.prepare("select count(*) as n from memory_chunks where embed_status='done'").get() as {
          n: number;
        }).n,
    );
    assert.equal(done, 1, "chunk should embed despite the poisoned cache entry");
    const vecRows = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(vecRows, 1, "a correct-width vector should be inserted");
    // The stale cache entry was repaired to the correct width.
    const repaired = storage.getCachedEmbedding(contentHash, provider.modelId)!;
    assert.equal(repaired.byteLength, provider.dim * 4, "cache entry repaired to active dim");
  });
});

test("deleting a chunk prunes its vector", async () => {
  await withStack(async ({ storage, indexer, worker, workspaceRoot }) => {
    const file = path.join(workspaceRoot, "memory", "2026-04-12.md");
    await writeFile(
      file,
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "Carol shared a pancake recipe."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker);
    const vecBefore = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(vecBefore, 1);

    await writeFile(file, "# 2026-04-12 Daily Memory\n", "utf8"); // remove the block
    await indexer.reconcileAll();
    await storage.waitForIdle();
    const vecAfter = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(vecAfter, 0, "vector should be pruned when its chunk is removed");
  });
});
