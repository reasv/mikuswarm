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

test("a high-relevance old chunk survives the min_score floor but ranks below a fresh one (review #13)", async () => {
  await withStack(async ({ storage, indexer, search, worker, workspaceRoot }) => {
    // Two chunks with identical strong-match bodies: one fresh, one ~2 half-lives old.
    // Decay (default ON, 30-day half-life) multiplies the old one's score to ~1/4 — pre-
    // fix that decayed value was tested against `min_score`, dropping the old exact
    // match. Post-fix the floor tests PRE-DECAY relevance (identical for both), so both
    // survive; decay only reorders them (review issue #13).
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-06-01.md"),
      `# 2026-06-01 Daily Memory\n\n` +
        block("2026-06-01 12:00", "2026-06-01 12:30", "#general", "We argued and decided to use SQLite as our database."),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-02.md"),
      `# 2026-04-02 Daily Memory\n\n` +
        block("2026-04-02 12:00", "2026-04-02 12:30", "#general", "We argued and decided to use SQLite as our database."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker);

    // "now" ~60 days after the old entry (2 half-lives) → its decayed score is ~1/4 of
    // the fresh one's. Pick a floor between the old chunk's decayed score and its (equal-
    // to-fresh) pre-decay relevance, so the test only passes when the floor uses
    // pre-decay relevance.
    const now = parseZonedWallClock("2026-06-01 13:00", TZ)!;
    const query = "what database did we decide on";
    // First, read both pre-decay relevances/decayed scores with the floor wide open.
    const open = await search.search({ query, maxResults: 6, minScore: 0, snippetMaxChars: 200, now });
    assert.equal(open.results.length, 2);
    const fresh = open.results.find((r) => r.date === "2026-06-01")!;
    const old = open.results.find((r) => r.date === "2026-04-02")!;
    assert.ok(old.score < fresh.score, "decay ranks the old chunk below the fresh one");
    // A floor strictly above the old chunk's DECAYED score: pre-fix (decay-then-drop)
    // this would drop the old chunk; post-fix (floor on pre-decay relevance) it survives.
    const floor = (old.score + fresh.score) / 2;
    const outcome = await search.search({ query, maxResults: 6, minScore: floor, snippetMaxChars: 200, now });
    assert.equal(outcome.results.length, 2, "both equal-relevance chunks survive a floor above the old decayed score");
    assert.equal(outcome.results[0]!.date, "2026-06-01", "fresh chunk ranks first");
    assert.equal(outcome.results[1]!.date, "2026-04-02", "old chunk ranked below but still returned");
    assert.ok(outcome.results[1]!.score < floor, "the old chunk's decayed score is below the floor it survived");
  });
});

test("a narrow date filter still surfaces in-range vector hits; mode reflects reality (review #2)", async () => {
  await withStack(async ({ storage, indexer, search, worker, workspaceRoot }) => {
    // The nearest neighbours to the query are out of the date window; the only in-range
    // chunk is a weaker (but still relevant) semantic match. Pre-fix, the KNN's top-k
    // (ignoring the filter) was filled by the out-of-range chunks and the in-range one
    // could be crowded out — and `mode` was computed from the pre-filter KNN size, so it
    // reported `hybrid` even when every vector neighbour was filtered away. Post-fix the
    // KNN over-fetches under a filter (in-range chunk survives) and `mode` is honest.
    //
    // Build several near-duplicate strong matches dated in May (out of range) and one
    // in-range (April) chunk that matches on a single keyword the query also carries.
    const mayBlocks = Array.from({ length: 8 }, (_, i) =>
      block(
        `2026-05-0${(i % 9) + 1} 12:00`,
        `2026-05-0${(i % 9) + 1} 12:30`,
        "#general",
        "We argued and decided to use SQLite as our database database.",
      ),
    ).join("\n");
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-05-10.md"),
      `# 2026-05-10 Daily Memory\n\n${mayBlocks}`,
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-12.md"),
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We picked a database for the project."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker);

    // Restrict to April only — every strong May neighbour is excluded; the lone in-range
    // April chunk (a weaker but real semantic match) must still come back.
    const outcome = await search.search({
      query: "what database did we decide on",
      maxResults: 3,
      minScore: 0,
      after: "2026-04-01",
      before: "2026-04-30",
      snippetMaxChars: 200,
    });
    assert.equal(outcome.results.length, 1, "the in-range chunk survives the over-fetched KNN");
    assert.equal(outcome.results[0]!.date, "2026-04-12");
    // A vector neighbour passed the filter, so the semantic half genuinely contributed.
    assert.equal(outcome.mode, "hybrid");
    assert.equal(outcome.degraded, false);
  });
});

test("mode honestly reports lexical when no surviving candidate carries a vector (review #2)", async () => {
  await withStack(async ({ storage, indexer, search, worker, workspaceRoot }) => {
    // A #tech chunk is embedded; a #random chunk matches LEXICALLY (shares "database")
    // but is left UNEMBEDDED (no vector → never a KNN hit). Filtering to #random means
    // the only vector neighbour (the #tech chunk) is excluded post-filter, and the
    // surviving candidate (#random) carries no vector score. Pre-fix `mode` was computed
    // from the pre-filter KNN size and would report `hybrid`; post-fix it is `lexical`.
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-12.md"),
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#tech", "We decided to use SQLite as our database."),
      "utf8",
    );
    await indexer.reconcileAll();
    await drainEmbeddings(storage, worker); // embeds the #tech chunk only

    // Add the #random lexical-only chunk and reconcile, but do NOT drain — it stays
    // `pending`, so it has no vector and never appears as a KNN neighbour.
    await writeFile(
      path.join(workspaceRoot, "memory", "2026-04-13.md"),
      `# 2026-04-13 Daily Memory\n\n` +
        block("2026-04-13 18:00", "2026-04-13 19:00", "#random", "Notes about the database from yesterday."),
      "utf8",
    );
    await indexer.reconcileAll();
    await storage.waitForIdle();

    const outcome = await search.search({
      query: "what database did we decide on",
      maxResults: 5,
      minScore: 0,
      room: "#random",
      snippetMaxChars: 200,
    });
    assert.ok(outcome.results.length >= 1, "the lexical match in #random is still found");
    assert.equal(outcome.results[0]!.room, "#random");
    // The only embedded chunk (#tech) was filtered out by room and the surviving
    // candidate carries no vector → honest `lexical`, not a falsely-reported `hybrid`.
    assert.equal(outcome.mode, "lexical", "no surviving candidate carries a vector score");
    assert.equal(outcome.degraded, false, "not degraded — embeddings were available, just filtered");
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
