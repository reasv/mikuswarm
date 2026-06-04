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

test("recall_memory renders the citation header format `path:start-end · room · date (score)`", async () => {
  const { search } = stubSearch({
    results: [result({ path: "memory/2026-03-02.md", startLine: 5, endLine: 19, room: "Project Hammer", date: "2026-03-02", score: 0.81 })],
  });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const out = await tool.execute("call-3", { query: "launch" });
  const body = text(out);
  assert.match(body, /1\. memory\/2026-03-02\.md:5-19 · Project Hammer · 2026-03-02 \(0\.81\)/);
  assert.match(body, /Recalled 1 memory \(hybrid\)/);
  // Snippet rendered on the indented continuation line.
  assert.match(body, /\n {3}We agreed the launch target is October\./);
});

test("recall_memory omits the room segment when room is null", async () => {
  const { search } = stubSearch({ results: [result({ room: null })] });
  const tool = createRecallMemoryTool({ search, defaults: DEFAULTS });
  const body = text(await tool.execute("call-4", { query: "x" }));
  assert.match(body, /1\. memory\/2026-03-02\.md:5-19 · 2026-03-02 \(0\.81\)/);
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
