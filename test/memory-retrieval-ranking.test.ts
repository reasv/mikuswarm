import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  MemoryIndexer,
  MemorySearch,
  buildFtsMatch,
  resolveRetrievalConfig,
} from "../src/retrieval/index.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";

const TZ = "Asia/Tokyo";

interface Harness {
  workspaceRoot: string;
  storage: Storage;
  indexer: MemoryIndexer;
  search: MemorySearch;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ranking-"));
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const indexer = new MemoryIndexer({ storage, workspaceRoot, config });
  const search = new MemorySearch(storage, indexer, config);
  try {
    await run({ workspaceRoot, storage, indexer, search });
  } finally {
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

async function writeMemory(workspaceRoot: string, name: string, content: string): Promise<string> {
  const p = path.join(workspaceRoot, "memory", name);
  await writeFile(p, content, "utf8");
  return p;
}

// --- #5a stopwords + #9 column scoping (pure, no DB) ---

test("buildFtsMatch drops stopwords and scopes to the text column (review #5a/#9)", () => {
  const m = buildFtsMatch("what did we decide about the database");
  assert.ok(m != null);
  // Column-filter form scopes the OR group to `text` so room-label tokens can't match
  // the indexed `room` column (#9).
  assert.ok(m!.startsWith("{text} : ("), `expected text-column scope, got: ${m}`);
  // Stopwords are gone; content words remain (#5a).
  assert.ok(m!.includes('"decide"'));
  assert.ok(m!.includes('"database"'));
  assert.ok(!m!.includes('"what"'));
  assert.ok(!m!.includes('"did"'));
  assert.ok(!m!.includes('"the"'));
  assert.ok(!m!.includes('"we"'));
});

test("buildFtsMatch returns null when only stopwords remain (review #5a)", () => {
  // A stopword-only query yields nothing — lexical-only correctly returns no results.
  assert.equal(buildFtsMatch("what did we have"), null);
  assert.equal(buildFtsMatch("the and of to"), null);
});

// --- #9 FTS MATCH must not span the room column ---

test("a query token equal to a room label does not match via the room column (review #9)", async () => {
  await withHarness(async ({ storage }) => {
    // Insert a chunk whose `room` column is "kubernetes" but whose `text` (header+body)
    // never contains that token, isolating the room-column path (the normal chunker's
    // rendered header always echoes the room). Exercise the lexical layer directly so
    // the search-path lazy reconcile can't prune this out-of-band chunk. Pre-fix, the
    // bare `"tok" OR ...` MATCH spanned all FTS columns and matched `room`; the
    // `{text} : (...)` column scope must now exclude it.
    await storage.reconcileMemoryChunks("memory/2026-04-12.md", [
      {
        id: "k8s-room",
        path: "memory/2026-04-12.md",
        ordinal: 0,
        source: "memory",
        startLine: 1,
        endLine: 2,
        room: "kubernetes",
        entryTs: parseZonedWallClock("2026-04-12 15:00", TZ)!,
        text: "We talked about lunch and the weather.",
        tokenCount: 7,
        contentHash: "k8s-hash",
      },
    ]);
    await storage.waitForIdle();

    const match = buildFtsMatch("kubernetes")!;
    const hits = storage.searchMemoryLexical({ match, limit: 10 });
    assert.equal(hits.length, 0, "a room-label token must not match via the indexed room column");

    // Sanity: a token that IS in the text column matches.
    const textHits = storage.searchMemoryLexical({ match: buildFtsMatch("weather")!, limit: 10 });
    assert.equal(textHits.length, 1);
  });
});

// --- #5b saturating absolute min_score floor ---

test("min_score is an absolute floor: a weak lone match is dropped (review #5b)", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    // A long entry mentioning the query term exactly once among many other words →
    // low BM25 relevance. Decay is off so the floor alone decides.
    const filler = Array.from({ length: 120 }, (_, i) => `note ${i}`).join(" ");
    await writeMemory(
      workspaceRoot,
      "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", `${filler} pangolin ${filler}`),
    );
    await indexer.reconcileAll();

    const now = parseZonedWallClock("2026-04-12 16:00", TZ)!;
    const weak = await search.search({
      query: "pangolin",
      maxResults: 6,
      minScore: 0.45,
      snippetMaxChars: 200,
      now,
    });
    // Pre-fix (min-max normalize) the lone match would be forced to 1.0 and clear any
    // floor < 1; post-fix the saturating transform scores it low and it is dropped.
    assert.equal(weak.results.length, 0, "weak lone match should fall below an absolute floor");

    // With the floor at 0 it is still found (sanity: the term is indexed).
    const found = await search.search({
      query: "pangolin",
      maxResults: 6,
      minScore: 0,
      snippetMaxChars: 200,
      now,
    });
    assert.ok(found.results.length >= 1);
    assert.ok(found.results[0]!.score < 0.45, "its absolute score is below the floor");
  });
});

// --- #12 before bound is fully day-inclusive ---

test("before filter includes an entry at 23:59:30 on the before day (review #12)", async () => {
  await withHarness(async ({ workspaceRoot, storage, indexer, search }) => {
    // The diary header is minute-precision, so the gap [23:59:00.001, 23:59:59.999]
    // can't be expressed through the header path. Index a real file (so the corpus
    // signature is recorded and the lazy reconcile is a no-op below), then push the
    // chunk's `entry_ts` to 23:59:30 — exactly the window the old `<= 23:59:00` bound
    // dropped. The file is unchanged, so `ensureFreshForQuery` won't re-reconcile and
    // overwrite our timestamp.
    await writeMemory(
      workspaceRoot,
      "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 23:00", "2026-04-12 23:59", "#general", "We finalized the budget spreadsheet late."),
    );
    await indexer.reconcileAll();
    const entryTs = parseZonedWallClock("2026-04-12 23:59", TZ)! + 30_000; // 23:59:30
    await storage.readAndWrite((db) =>
      db.prepare("update memory_chunks set entry_ts = ?").run(entryTs),
    );
    await storage.waitForIdle();

    const included = await search.search({
      query: "budget spreadsheet finalized",
      maxResults: 6,
      minScore: 0,
      before: "2026-04-12",
      snippetMaxChars: 200,
    });
    assert.equal(included.results.length, 1, "23:59:30 must be inside before=2026-04-12");

    // The day before excludes it (exclusive start-of-next-day bound).
    const excluded = await search.search({
      query: "budget spreadsheet finalized",
      maxResults: 6,
      minScore: 0,
      before: "2026-04-11",
      snippetMaxChars: 200,
    });
    assert.equal(excluded.results.length, 0);
  });
});

// --- #4b unparseable date bounds are surfaced, not silently dropped ---

test("an unparseable date filter is reported in ignoredDateBounds (review #4b)", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    await writeMemory(
      workspaceRoot,
      "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We discussed the roadmap."),
    );
    await indexer.reconcileAll();

    const outcome = await search.search({
      query: "roadmap discussed",
      maxResults: 6,
      minScore: 0,
      after: "2026-13-40", // overflow → rejected by parseZonedWallClock
      before: "not-a-date",
      snippetMaxChars: 200,
    });
    assert.deepEqual(outcome.ignoredDateBounds.sort(), ["after", "before"]);
    // The filter was ignored (not applied as a silent empty range), so the entry still surfaces.
    assert.ok(outcome.results.length >= 1);

    // A valid bound is not reported.
    const ok = await search.search({
      query: "roadmap discussed",
      maxResults: 6,
      minScore: 0,
      after: "2026-04-01",
      snippetMaxChars: 200,
    });
    assert.deepEqual(ok.ignoredDateBounds, []);
  });
});

// --- #6 zero-sum hybrid weights fail fast at config resolution ---

test("config resolution rejects a zero-sum vector+text weight pair (review #6)", () => {
  assert.throws(
    () => resolveRetrievalConfig({ enabled: true, query: { vector_weight: 0, text_weight: 0 } }),
    /vector_weight \+ text_weight must be > 0/,
  );
  // A non-zero sum (e.g. lexical-only by weight) is accepted.
  assert.doesNotThrow(() =>
    resolveRetrievalConfig({ enabled: true, query: { vector_weight: 0, text_weight: 1 } }),
  );
});

// --- #14 fallback_chunk_tokens > max_chunk_tokens fails fast at config resolution ---

test("config resolution rejects fallback_chunk_tokens > max_chunk_tokens (review #14)", () => {
  assert.throws(
    () =>
      resolveRetrievalConfig({
        enabled: true,
        index: { fallback_chunk_tokens: 600, max_chunk_tokens: 512 },
      }),
    /fallback_chunk_tokens \(600\) must be <= max_chunk_tokens \(512\)/,
  );
  // fallback == max is allowed (the boundary is inclusive).
  assert.doesNotThrow(() =>
    resolveRetrievalConfig({
      enabled: true,
      index: { fallback_chunk_tokens: 512, max_chunk_tokens: 512 },
    }),
  );
  // The shipped defaults (fallback 400 <= max 512) resolve cleanly.
  assert.doesNotThrow(() => resolveRetrievalConfig({ enabled: true }));
});
