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
  userLaneTokens,
  userLanePrefixStem,
  resolveRetrievalConfig,
} from "../src/retrieval/index.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import {
  configureAgentTimezone,
  resetAgentTimezone,
  parseZonedWallClock,
  agentDateStamp,
} from "../src/time/index.js";

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

/**
 * #20: verify the day-inclusive `before` bound on a DST-transition day. Builds a
 * harness in the given DST zone (not the module's Tokyo), indexes a single entry late
 * on `day`, pushes its `entry_ts` to a near-midnight wall-clock in that zone (the part
 * of the day the old `23:59` cutoff dropped), and asserts `before=day` includes it
 * while `before=<dayBefore>` excludes it. Exercises `dateBoundTs`'s "end" branch
 * (parse noon → +24h → re-stamp next-day 00:00) across the transition.
 */
async function dstBeforeInclusiveCase(opts: {
  tz: string;
  day: string;
  lateEvening: string;
  nextDay: string;
}): Promise<void> {
  configureAgentTimezone(opts.tz);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-dst-"));
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const indexer = new MemoryIndexer({ storage, workspaceRoot, config });
  const search = new MemorySearch(storage, indexer, config);
  try {
    // Index a real file so the corpus signature is recorded and the lazy on-search
    // reconcile is a no-op (it won't overwrite the entry_ts we set below). The diary
    // header is minute-precision; we set the chunk's entry_ts directly to 23:30 in-zone.
    const header = buildDiaryHeader({
      earliestTimestamp: parseZonedWallClock(`${opts.day} 22:00`, opts.tz)!,
      latestTimestamp: parseZonedWallClock(`${opts.day} 23:00`, opts.tz)!,
      room: "#general",
    });
    const p = path.join(workspaceRoot, "memory", `${opts.day}.md`);
    await writeFile(p, `# ${opts.day} Daily Memory\n\n${header}\nWe shipped the release late.\n`, "utf8");
    await indexer.reconcileAll();

    const entryTs = parseZonedWallClock(opts.lateEvening, opts.tz)!;
    await storage.readAndWrite((db) =>
      db.prepare("update memory_chunks set entry_ts = ?").run(entryTs),
    );
    await storage.waitForIdle();

    const included = await search.search({
      query: "shipped release late",
      maxResults: 6,
      minScore: 0,
      before: opts.day,
      snippetMaxChars: 200,
    });
    assert.equal(
      included.results.length,
      1,
      `${opts.lateEvening} must be inside before=${opts.day} across the DST transition`,
    );

    // The prior day excludes it (exclusive start-of-next-day upper bound).
    const priorDay = agentDateStamp(parseZonedWallClock(`${opts.day} 12:00`, opts.tz)! - 86_400_000);
    const excluded = await search.search({
      query: "shipped release late",
      maxResults: 6,
      minScore: 0,
      before: priorDay,
      snippetMaxChars: 200,
    });
    assert.equal(excluded.results.length, 0, `before=${priorDay} must exclude an entry on ${opts.day}`);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
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

// --- #12 inverted after/before range is flagged (not silently empty) ---

test("an inverted after/before range sets contradictoryDateBounds (review #12)", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    await writeMemory(
      workspaceRoot,
      "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We discussed the roadmap."),
    );
    await indexer.reconcileAll();

    // Both bounds parse, but after (2026-06-10) is later than before (2026-06-01) → the
    // window is empty. Pre-fix this silently returned nothing; post-fix the flag is set
    // and ignoredDateBounds stays empty (both parsed fine).
    const outcome = await search.search({
      query: "roadmap discussed",
      maxResults: 6,
      minScore: 0,
      after: "2026-06-10",
      before: "2026-06-01",
      snippetMaxChars: 200,
    });
    assert.equal(outcome.contradictoryDateBounds, true);
    assert.deepEqual(outcome.ignoredDateBounds, [], "both bounds parsed, so neither is ignored");
    assert.equal(outcome.results.length, 0, "an empty window matches nothing");

    // A normal (non-inverted) range does not set the flag.
    const ok = await search.search({
      query: "roadmap discussed",
      maxResults: 6,
      minScore: 0,
      after: "2026-04-01",
      before: "2026-04-30",
      snippetMaxChars: 200,
    });
    assert.equal(ok.contradictoryDateBounds, false);
    assert.ok(ok.results.length >= 1);

    // Equal after == before is also empty (after >= before): the start-of-day lower
    // bound is on/after the exclusive next-day upper bound for the same earlier day.
    const same = await search.search({
      query: "roadmap discussed",
      maxResults: 6,
      minScore: 0,
      after: "2026-04-13",
      before: "2026-04-12",
      snippetMaxChars: 200,
    });
    assert.equal(same.contradictoryDateBounds, true);
  });
});

// --- #9 lexical FTS failure degrades to empty rather than throwing ---

test("a throwing lexical search degrades to empty results instead of rejecting (review #9)", async () => {
  await withHarness(async ({ workspaceRoot, storage, indexer, search }) => {
    await writeMemory(
      workspaceRoot,
      "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We discussed the roadmap."),
    );
    await indexer.reconcileAll();

    // Inject a lexical failure on the real Storage instance the search holds. The
    // semantic half is absent (no provider/vectorStore in this harness), so without the
    // try/catch this would reject out of search(). With it, search() resolves degraded
    // to empty lexical results.
    const original = storage.searchMemoryLexical.bind(storage);
    (storage as unknown as { searchMemoryLexical: () => never }).searchMemoryLexical = () => {
      throw new Error("simulated FTS5 MATCH failure");
    };
    try {
      const outcome = await search.search({
        query: "roadmap discussed",
        maxResults: 6,
        minScore: 0,
        snippetMaxChars: 200,
      });
      assert.equal(outcome.results.length, 0, "degraded to empty lexical results, did not throw");
      assert.equal(outcome.mode, "lexical");
    } finally {
      (storage as unknown as { searchMemoryLexical: typeof original }).searchMemoryLexical = original;
    }
  });
});

// --- #20 before filter is day-inclusive across DST transitions ---

test("before filter is fully day-inclusive on a spring-forward DST day (review #20)", async () => {
  await dstBeforeInclusiveCase({
    tz: "America/New_York",
    // US spring-forward 2026: 2026-03-08 (clocks jump 02:00 → 03:00). A late-evening
    // entry on that day must be inside before=2026-03-08.
    day: "2026-03-08",
    lateEvening: "2026-03-08 23:30",
    nextDay: "2026-03-09",
  });
});

test("before filter is fully day-inclusive on a fall-back DST day (review #20)", async () => {
  await dstBeforeInclusiveCase({
    tz: "America/New_York",
    // US fall-back 2026: 2026-11-01 (clocks repeat 01:00 → 01:00, the day is 25h long).
    day: "2026-11-01",
    lateEvening: "2026-11-01 23:30",
    nextDay: "2026-11-02",
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

// --- §9d user lane: name tokenization + prefix stem (pure, no DB) ---

test("userLaneTokens splits multi-word names, dedups, drops short/stopword fragments", () => {
  assert.deepEqual(userLaneTokens(["Atomic Tiger"]), ["atomic", "tiger"]);
  assert.deepEqual(userLaneTokens(["Plaguis", "Plaguis"]), ["plaguis"], "deduped across names");
  assert.deepEqual(userLaneTokens(["The Architect"]), ["architect"], "bare stopword dropped");
  assert.deepEqual(userLaneTokens(["A J"]), [], "1-char fragments dropped");
  assert.deepEqual(userLaneTokens(["Jo"]), ["jo"], "2-char content token kept");
});

test("userLanePrefixStem returns a stem only when it can catch a shortened form", () => {
  assert.equal(userLanePrefixStem("plaguis", 4), "plag");
  assert.equal(userLanePrefixStem("atomictiger", 4), "atom");
  assert.equal(userLanePrefixStem("alex", 4), null, "token at the floor → no prefix (would be whole token)");
  assert.equal(userLanePrefixStem("rey", 4), null, "short token → no prefix (false-positive risk)");
});

// --- §9d user lane: exact match by display name, ordered by recency ---

test("searchUserLane surfaces entries naming the person, most-recent first (decay)", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    const body = "Had a long chat with Plaguis about the build.";
    await writeMemory(workspaceRoot, "2026-04-10.md",
      `# 2026-04-10 Daily Memory\n\n` + block("2026-04-10 14:00", "2026-04-10 15:00", "#general", body));
    await writeMemory(workspaceRoot, "2026-05-20.md",
      `# 2026-05-20 Daily Memory\n\n` + block("2026-05-20 14:00", "2026-05-20 15:00", "#general", body));
    await indexer.reconcileAll();

    const now = parseZonedWallClock("2026-05-21 12:00", TZ)!;
    const hits = await search.searchUserLane({
      names: ["Plaguis"], maxResults: 5, minScore: 0,
      prefixEnabled: false, prefixMinChars: 4, snippetMaxChars: 200, now,
    });
    assert.equal(hits.length, 2, "both entries naming Plaguis surface");
    // Identical bodies → equal relevance → temporal decay orders the recent one first.
    assert.equal(hits[0]!.date, "2026-05-20", "most recent interaction ranks first");
    assert.equal(hits[1]!.date, "2026-04-10");

    // A different person finds nothing.
    const none = await search.searchUserLane({
      names: ["Bulchi"], maxResults: 5, minScore: 0,
      prefixEnabled: false, prefixMinChars: 4, snippetMaxChars: 200, now,
    });
    assert.equal(none.length, 0);
  });
});

// --- §9d user lane: prefix catches shortened names, but exact is always preferred ---

test("searchUserLane: exact beats prefix; a shortened form only fills leftover slots", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    // An OLD entry naming the person in full, a NEWER entry using a shortened prefix form.
    await writeMemory(workspaceRoot, "2026-03-01.md",
      `# 2026-03-01 Daily Memory\n\n` +
        block("2026-03-01 14:00", "2026-03-01 15:00", "#general", "Reviewed the PR with Plaguis today."));
    await writeMemory(workspaceRoot, "2026-05-25.md",
      `# 2026-05-25 Daily Memory\n\n` +
        block("2026-05-25 14:00", "2026-05-25 15:00", "#general", "Quick sync with Plagu about deploys."));
    await indexer.reconcileAll();

    const now = parseZonedWallClock("2026-05-26 12:00", TZ)!;
    const hits = await search.searchUserLane({
      names: ["Plaguis"], maxResults: 5, minScore: 0,
      prefixEnabled: true, prefixMinChars: 4, snippetMaxChars: 200, now,
    });
    assert.equal(hits.length, 2, "exact (Plaguis) + prefix (Plagu) both surface");
    // Despite being OLDER, the exact match ranks first — exact is favored over prefix,
    // so the newer prefix-only hit cannot leapfrog it on recency.
    assert.equal(hits[0]!.date, "2026-03-01", "exact hit first even though older");
    assert.match(hits[0]!.snippet, /Reviewed the PR with Plaguis/);
    assert.equal(hits[1]!.date, "2026-05-25", "prefix-only hit second");
    assert.match(hits[1]!.snippet, /Quick sync with Plagu/);

    // With prefix disabled, the shortened "Plagu" mention is not found at all.
    const exactOnly = await search.searchUserLane({
      names: ["Plaguis"], maxResults: 5, minScore: 0,
      prefixEnabled: false, prefixMinChars: 4, snippetMaxChars: 200, now,
    });
    assert.equal(exactOnly.length, 1, "only the exact Plaguis entry without prefix");
    assert.equal(exactOnly[0]!.date, "2026-03-01");
  });
});

// --- §9d user lane: short display names get no prefix lane (false-positive guard) ---

test("searchUserLane does not prefix-match a short display name", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    // "Rey" (3 chars) is below prefixMinChars, so "rey*" must NOT run and pull in
    // unrelated words like "really". Only an exact "Rey" mention should match.
    await writeMemory(workspaceRoot, "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We really reworked the renderer."));
    await indexer.reconcileAll();

    const now = parseZonedWallClock("2026-04-13 12:00", TZ)!;
    const hits = await search.searchUserLane({
      names: ["Rey"], maxResults: 5, minScore: 0,
      prefixEnabled: true, prefixMinChars: 4, snippetMaxChars: 200, now,
    });
    assert.equal(hits.length, 0, "short name must not prefix-match 'really'/'reworked'/'renderer'");
  });
});

// --- §9d README.md (and other non-content files) are never indexed ---

test("reconcileAll excludes README.md from the memory index", async () => {
  await withHarness(async ({ workspaceRoot, storage, indexer, search }) => {
    // README.md is the agent's scratchpad ABOUT the memory dir, not a diary entry; it
    // used to top auto-retrieval because its prose resembles a query. It must be skipped.
    await writeMemory(workspaceRoot, "README.md",
      "# memory/README.md\n\nUse memory/YYYY-MM-DD.md as your daily scratchpad. zorbflux marker.\n");
    await writeMemory(workspaceRoot, "2026-04-12.md",
      `# 2026-04-12 Daily Memory\n\n` +
        block("2026-04-12 14:00", "2026-04-12 15:00", "#general", "We shipped the zorbflux feature."));
    await indexer.reconcileAll();
    await storage.waitForIdle();

    const paths = storage.listMemoryChunkPaths();
    assert.ok(!paths.includes("memory/README.md"), "README.md is not indexed");
    assert.ok(paths.includes("memory/2026-04-12.md"), "real diary entries are still indexed");

    // The unique token lives in both files; only the diary hit should come back.
    const now = parseZonedWallClock("2026-04-13 12:00", TZ)!;
    const outcome = await search.search({ query: "zorbflux", maxResults: 6, minScore: 0, snippetMaxChars: 200, now });
    assert.ok(outcome.results.length >= 1, "the diary entry is found");
    assert.ok(
      outcome.results.every((r) => r.path !== "memory/README.md"),
      "no result comes from README.md",
    );
  });
});
