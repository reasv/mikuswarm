import assert from "node:assert/strict";
import test from "node:test";
import { createRecallMemoryTool } from "../src/tools/memory.js";
import type { MemorySearch, RetrievalResult, SearchOutcome, SearchOptions } from "../src/retrieval/index.js";

function result(over: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    id: over.id ?? "id",
    path: over.path ?? "memory/2026-03-02.md",
    startLine: over.startLine ?? 5,
    endLine: over.endLine ?? 19,
    room: "room" in over ? (over.room ?? null) : "Project Hammer",
    date: over.date ?? "2026-03-02",
    entryTs: over.entryTs ?? 1,
    score: over.score ?? 0.81,
    snippet: over.snippet ?? "We agreed the launch target is October.",
    contentHash: over.contentHash ?? over.id ?? "id",
  };
}

/**
 * A stub `MemorySearch` that records the options it was called with and returns a
 * canned outcome. The tool depends only on `.search(opts)`, so we inject this.
 */
function stubSearch(
  outcome: Partial<SearchOutcome> & { results: RetrievalResult[] },
): { search: MemorySearch; calls: SearchOptions[] } {
  const calls: SearchOptions[] = [];
  const search = {
    search: async (opts: SearchOptions): Promise<SearchOutcome> => {
      calls.push(opts);
      return {
        results: outcome.results,
        mode: outcome.mode ?? "hybrid",
        degraded: outcome.degraded ?? false,
        ignoredDateBounds: outcome.ignoredDateBounds ?? [],
        contradictoryDateBounds: outcome.contradictoryDateBounds ?? false,
      };
    },
  } as unknown as MemorySearch;
  return { search, calls };
}

const DEFAULTS = { maxResults: 3, minScore: 0.35 };

function text(out: Awaited<ReturnType<ReturnType<typeof createRecallMemoryTool>["execute"]>>): string {
  const first = out.content[0]!;
  assert.equal(first.type, "text");
  return (first as { type: "text"; text: string }).text;
}

test("recall_memory applies max_results/min_score defaults when args omit them", async () => {
  const { search, calls } = stubSearch({ results: [result()] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  await tool.execute("call-1", { query: "pricing" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.maxResults, DEFAULTS.maxResults, "default max_results applied");
  assert.equal(calls[0]!.minScore, DEFAULTS.minScore, "default min_score applied");
  assert.equal(calls[0]!.query, "pricing");
});

test("recall_memory forwards explicit max_results/min_score over the defaults", async () => {
  const { search, calls } = stubSearch({ results: [result()] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  await tool.execute("call-2", { query: "pricing", max_results: 7, min_score: 0.6 });
  assert.equal(calls[0]!.maxResults, 7);
  assert.equal(calls[0]!.minScore, 0.6);
});

test("recall_memory renders the compact citation `[path:start-end · room] (score)`", async () => {
  const { search } = stubSearch({
    results: [result({ path: "memory/2026-03-02.md", startLine: 5, endLine: 19, room: "Project Hammer", date: "2026-03-02", score: 0.81 })],
  });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const out = await tool.execute("call-3", { query: "launch" });
  const body = text(out);
  // Compact citation (§9d "Excerpts"): the date is in the file name, so it is not repeated.
  assert.match(body, /1\. \[memory\/2026-03-02\.md:5-19 · Project Hammer\] \(0\.81\)/);
  assert.match(body, /Recalled 1 memory \(hybrid\)/);
  // Snippet rendered on the indented continuation line.
  assert.match(body, /\n {3}We agreed the launch target is October\./);
});

test("recall_memory omits the room segment when room is null", async () => {
  const { search } = stubSearch({ results: [result({ room: null })] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-4", { query: "x" }));
  assert.match(body, /1\. \[memory\/2026-03-02\.md:5-19\] \(0\.81\)/);
  assert.ok(!body.includes("· Project Hammer"), "no room segment when room null");
});

test("recall_memory surfaces the degradation note when degraded / lexical mode", async () => {
  const { search } = stubSearch({ results: [result()], mode: "lexical", degraded: true });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-5", { query: "x" }));
  assert.match(body, /\(lexical \(semantic search unavailable — lexical only\)\)/);
});

test("recall_memory degradation note also shows on the empty-results path", async () => {
  const { search } = stubSearch({ results: [], mode: "lexical", degraded: true });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-6", { query: "x" }));
  assert.match(body, /No matching memories found \(lexical \(semantic search unavailable — lexical only\)\)/);
});

test("recall_memory surfaces ignoredDateBounds in the header (issue #4b)", async () => {
  const { search } = stubSearch({ results: [result()], ignoredDateBounds: ["after", "before"] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-7", { query: "x", after: "garbage", before: "nope" }));
  assert.match(body, /ignored unparseable after and before date filters — use YYYY-MM-DD/);
});

test("recall_memory surfaces a single ignored bound without pluralizing (issue #4b)", async () => {
  const { search } = stubSearch({ results: [result()], ignoredDateBounds: ["after"] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-8", { query: "x", after: "garbage" }));
  assert.match(body, /ignored unparseable after date filter — use YYYY-MM-DD/);
  assert.ok(!body.includes("filters"), "singular note for one bound");
});

test("recall_memory surfaces contradictoryDateBounds (issue #12, field exists in outcome)", async () => {
  const { search } = stubSearch({ results: [], contradictoryDateBounds: true });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const out = await tool.execute("call-9", { query: "x", after: "2026-06-10", before: "2026-06-01" });
  const body = text(out);
  assert.match(body, /the after\/before range is empty — `after` is later than `before`/);
  // The field is also surfaced in structured details for the observability layer.
  assert.equal((out.details as { contradictoryDateBounds: boolean }).contradictoryDateBounds, true);
});

test("recall_memory pluralizes the recalled-count header and forwards room/date filters", async () => {
  const { search, calls } = stubSearch({ results: [result({ id: "a" }), result({ id: "b" })] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-10", { query: "x", room: "Project Hammer", after: "2026-01-01", before: "2026-12-31" }));
  assert.match(body, /Recalled 2 memories \(hybrid\)/);
  assert.equal(calls[0]!.room, "Project Hammer");
  assert.equal(calls[0]!.after, "2026-01-01");
  assert.equal(calls[0]!.before, "2026-12-31");
});

test("recall_memory: `user` scopes the search to the person's chunks; an unknown person is an actionable miss", async () => {
  const { search, calls } = stubSearch({ results: [result()] });
  const tool = createRecallMemoryTool({
    search,
    defaults: DEFAULTS,
    userScope: (user) => (user === "@alice:x" ? { rowids: [4, 9], names: ["Alice"], senderIds: ["@alice:x"] } : { rowids: [], names: [], senderIds: [] }),
  });
  await tool.execute("c1", { query: "launch", user: "@alice:x" });
  assert.deepEqual(calls[0]!.rowidScope, [4, 9]);
  const miss = text(await tool.execute("c2", { query: "launch", user: "nobody" }));
  assert.match(miss, /No memories found with "nobody"/);
  assert.match(miss, /without user/);
  assert.equal(calls.length, 1, "no search for an unresolved person");
});

test("recall_memory: filter-hidden results are dropped (over-fetching to keep the count); the call is a follow-up", async () => {
  const { search, calls } = stubSearch({ results: [result({ id: "a", contentHash: "a" }), result({ id: "b", contentHash: "b", snippet: "hidden one" })] });
  const followUps: string[] = [];
  const tool = createRecallMemoryTool({
    search,
    defaults: DEFAULTS,
    chunksByHash: (hashes) => hashes.map((h) => ({ rowid: 1, id: h, path: "memory/2026-03-02.md", startLine: 1, endLine: 2, room: null, entryTs: 1, text: h, contentHash: h, tokenCount: 1, agent: null, bm25: 0 })),
    hooks: { hiddenBlocks: async () => new Set(["b"]), onFollowUp: (k) => followUps.push(k) },
  });
  const body = text(await tool.execute("c1", { query: "launch" }));
  assert.equal(calls[0]!.maxResults, DEFAULTS.maxResults + 5);
  assert.ok(!body.includes("hidden one"));
  assert.match(body, /Recalled 1 memory/);
  assert.deepEqual(followUps, ["recall_memory"]);
});
