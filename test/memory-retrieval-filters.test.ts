/**
 * Operator memory filters (ARCHITECTURE.md §9c "Memory filters"): config
 * resolution and validation, time scope, mechanical matching and pre-gates,
 * lazy judged evaluation with the verdict cache and its staleness, `pending`,
 * the audit trail, and enforcement on the recency layer, the diary writer's
 * window, `search_memory` and `recall_memory`. Synthetic fixtures only.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import {
  MemoryFilterService,
  filterBoundTs,
  filtersFor,
  filterMemoryFileText,
  resolveMemoryFilters,
  splitFileBlocks,
  validateMemoryFilters,
  warnFiltersWithoutDecisions,
  type FilterBlock,
} from "../src/retrieval/filters/index.js";
import { recentMemoryWindow } from "../src/diary/recent-window.js";
import { createSearchMemoryTool } from "../src/tools/memory.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";
import type { AppConfig } from "../src/config/index.js";

const TZ = "UTC";

function header(day: string, hh: string, room = "general"): string {
  const t = parseZonedWallClock(`${day} ${hh}`, TZ)!;
  return buildDiaryHeader({ earliestTimestamp: t, latestTimestamp: t + 600_000, room, timezone: TZ });
}

function blockOf(text: string, entryTs: number | null, hash = text): FilterBlock {
  return { contentHash: hash, text, path: "memory/2026-05-01.md", startLine: 1, endLine: 3, room: null, entryTs };
}

/** A fake engine: judges `filter__*` questions from the entry text, counts calls. */
function fakeEngine(opts: { enabled?: boolean; fail?: boolean } = {}) {
  const calls: any[] = [];
  return {
    calls,
    engine: {
      isEnabled: (point: string) => point === "memory" && opts.enabled !== false,
      evaluate: async (point: any, input: any) => {
        calls.push(input);
        if (opts.fail) return { verdict: point.fallback(input), source: "heuristic", reason: "timeout", costUsd: 0, decisionGroup: "g" };
        const answers: Record<string, any> = {};
        for (const id of Object.keys(point.questions(input, {}))) answers[id] = { type: "noul", noul: /BAD/.test(input.entry.text) ? 0.95 : 0.05 };
        return { verdict: point.resolve(answers, input, (_: string, v: number) => v, {}), source: "model", servedModel: "decider", costUsd: 0, decisionGroup: "g" };
      },
    } as any,
  };
}

async function withStore(run: (s: { storage: Storage; store: MemoryRetrievalStore; dir: string }) => Promise<void>) {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-filters-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    await run({ storage, store: new MemoryRetrievalStore(storage), dir });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

const cfg = (filters: Record<string, unknown>, agents?: Record<string, unknown>): AppConfig =>
  ({ retrieval: { filters }, ...(agents ? { agents } : {}) }) as unknown as AppConfig;

test("config: kinds, defaults, validation errors", () => {
  const r = resolveMemoryFilters({
    pending: "hide",
    model: "decider",
    a: { description: "d", examples: { hide: ["x"], keep: ["y"] } },
    b: { keywords: ["Old Nick"] },
    c: { patterns: ["(?i)\\bfoo\\b"], after: "2026-05-10", before: "2026-05-18T12:00" },
  });
  assert.equal(r.pending, "hide");
  assert.equal(r.model, "decider");
  assert.equal(r.filters.find((f) => f.key === "a")!.threshold, 0.8);
  assert.throws(() => resolveMemoryFilters({ x: { patterns: ["(unclosed"] } }), /not a valid regular expression/);
  assert.throws(() => resolveMemoryFilters({ x: {} }), /needs a description/);
  assert.throws(() => resolveMemoryFilters({ x: { keywords: ["k"], after: "May 10" } }), /expected a date/);
  assert.throws(() => resolveMemoryFilters({ x: { keywords: ["k"], after: "2026-05-10", before: "2026-05-01" } }), /range is empty/);
  assert.throws(() => resolveMemoryFilters({ pending: "maybe" }), /pending/);
  assert.throws(() => validateMemoryFilters(cfg({ bad: { patterns: ["("] } })), /regular expression/);
});

test("config: the per-agent merge is deep; an agent switch-off of an unknown filter is ignored with a warning", () => {
  const config = cfg(
    { habit: { description: "d", examples: { hide: ["x"], keep: ["y"] } }, old: { keywords: ["k"] } },
    {
      a: {
        workspace_root: "/w",
        retrieval: { filters: { habit: { examples: { keep: ["z"] } }, old: { enabled: false }, ghost: { enabled: false } } },
      },
    },
  );
  const merged = filtersFor(config, "a");
  const habit = merged.filters.find((f) => f.key === "habit")!;
  assert.deepEqual(habit.examplesHide, ["x"], "examples.keep alone keeps the global examples.hide");
  assert.deepEqual(habit.examplesKeep, ["z"]);
  assert.equal(merged.filters.find((f) => f.key === "old")!.enabled, false);
  assert.equal(merged.filters.find((f) => f.key === "ghost"), undefined);
  const warns: Array<[string, any]> = [];
  validateMemoryFilters(config, (e, f) => warns.push([e, f]));
  assert.deepEqual(warns.map(([e, f]) => [e, f.where]), [["memory_filter_disable_unknown", "agents.a.retrieval.filters.ghost"]]);
});

test("config: the filter hash changes when anything defining it changes", () => {
  const h = (f: Record<string, unknown>) => resolveMemoryFilters({ f }).filters[0]!.hash;
  const base = { description: "d", threshold: 0.8 };
  assert.equal(h(base), h({ ...base }));
  assert.notEqual(h(base), h({ ...base, threshold: 0.9 }));
  assert.notEqual(h(base), h({ ...base, examples: { hide: ["x"] } }));
  assert.notEqual(h(base), h({ ...base, after: "2026-01-01" }));
  assert.notEqual(h(base), h({ ...base, keywords: ["gate"] }));
});

test("config: per-agent overrides deep-merge; enabled=false turns a global filter off", async () => {
  await withStore(async ({ store }) => {
    const svc = new MemoryFilterService({
      config: cfg({ a: { keywords: ["x"] } }, { chen: { workspace_root: "/w", retrieval: { filters: { a: { enabled: false }, b: { keywords: ["y"] } } } } }),
      store,
    });
    assert.deepEqual(svc.active(null).map((f) => f.key), ["a"]);
    assert.deepEqual(svc.active("chen").map((f) => f.key), ["b"]);
  });
});

test("time scope: after inclusive, before exclusive, bare date = start of day; no entry time = out of range", async () => {
  configureAgentTimezone(TZ);
  try {
    assert.equal(filterBoundTs("2026-05-10"), Date.parse("2026-05-10T00:00:00Z"));
    assert.equal(filterBoundTs("2026-05-10T12:30+02:00"), Date.parse("2026-05-10T10:30:00Z"));
  } finally {
    resetAgentTimezone();
  }
  await withStore(async ({ store }) => {
    const svc = new MemoryFilterService({ config: cfg({ k: { keywords: ["nick"], after: "2026-05-10", before: "2026-05-18" } }), store });
    const at = (d: string) => Date.parse(`${d}Z`);
    const states = svc.classify(null, [
      blockOf("nick a", at("2026-05-10T00:00:00"), "in-start"),
      blockOf("nick b", at("2026-05-17T23:59:00"), "in-end"),
      blockOf("nick c", at("2026-05-18T00:00:00"), "out-end"),
      blockOf("nick d", at("2026-05-09T23:59:00"), "out-start"),
      blockOf("nick e", null, "no-time"),
    ]);
    assert.equal(states.get("in-start")!.hidden, true);
    assert.equal(states.get("in-end")!.hidden, true);
    assert.equal(states.get("out-end")!.hidden, false);
    assert.equal(states.get("out-start")!.hidden, false);
    assert.equal(states.get("no-time")!.hidden, false);
  });
});

test("mechanical: keywords are whole words/phrases, patterns are regexes; a pre-gate limits judgement", async () => {
  await withStore(async ({ store }) => {
    const { engine, calls } = fakeEngine();
    const svc = new MemoryFilterService({
      config: cfg({ kw: { keywords: ["old nick"] }, pat: { patterns: ["(?i)^secret"] }, gated: { description: "bad", keywords: ["gate"] } }),
      store,
      engine: () => engine,
    });
    const states = svc.classify(null, [
      blockOf("said Old  Nick yesterday", 1, "kw"),
      blockOf("oldnickname is different", 1, "no-kw"),
      blockOf("Secret plans", 1, "pat"),
      blockOf("BAD without the trigger word", 1, "ungated"),
      blockOf("BAD with the gate word", 1, "gated"),
    ]);
    assert.equal(states.get("kw")!.hiddenBy?.kind, "keyword");
    assert.equal(states.get("no-kw")!.hidden, false);
    assert.equal(states.get("pat")!.hiddenBy?.kind, "pattern");
    assert.equal(states.get("ungated")!.pendingJudged.length, 0, "the pre-gate did not match: never judged");
    assert.deepEqual(states.get("gated")!.pendingJudged.map((q) => q.key), ["gated"]);
    assert.equal(calls.length, 0, "classify never calls a model");
  });
});

test("judged: lazy, cached per block and filter hash; an edited filter is re-judged; no backfill", async () => {
  await withStore(async ({ store }) => {
    const { engine, calls } = fakeEngine();
    const svc = new MemoryFilterService({ config: cfg({ habit: { description: "bad habit" } }), store, engine: () => engine });
    const blocks = [blockOf("BAD entry", 1, "bad"), blockOf("fine entry", 1, "fine")];
    const ctx = { surface: "recall_memory" as const, attribution: { agentSessionId: "s" } };
    const first = await svc.enforce(null, blocks, ctx);
    assert.equal(first.get("bad")!.hidden, true);
    assert.equal(first.get("fine")!.hidden, false);
    assert.equal(calls.length, 2, "one request per block");
    const second = await svc.enforce(null, blocks, ctx);
    assert.equal(second.get("bad")!.hidden, true);
    assert.equal(calls.length, 2, "served from the cache");
    // Edit the filter → stale verdicts → judged again.
    const edited = new MemoryFilterService({ config: cfg({ habit: { description: "bad habit, edited" } }), store, engine: () => engine });
    await edited.enforce(null, blocks, ctx);
    assert.equal(calls.length, 4);
    await new Promise((r) => setTimeout(r, 20));
    const hits = store.filterHits({ limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "judged");
    assert.equal(hits[0]!.surface, "recall_memory");
  });
});

test("pending: an unavailable verdict shows by default, hides with pending = hide; mechanical always applies", async () => {
  await withStore(async ({ store }) => {
    const { engine } = fakeEngine({ fail: true });
    const ctx = { surface: "recency_layer" as const, attribution: {} };
    const show = new MemoryFilterService({ config: cfg({ j: { description: "d" }, k: { keywords: ["kw"] } }), store, engine: () => engine });
    const s1 = await show.enforce(null, [blockOf("BAD", 1, "a"), blockOf("kw here", 1, "b")], ctx);
    assert.equal(s1.get("a")!.hidden, false);
    assert.equal(s1.get("b")!.hidden, true);
    const hide = new MemoryFilterService({ config: cfg({ pending: "hide", j: { description: "d" } }), store, engine: () => engine });
    const s2 = await hide.enforce(null, [blockOf("BAD", 1, "a")], ctx);
    assert.equal(s2.get("a")!.hidden, true);
    assert.equal(s2.get("a")!.hiddenBy?.pending, true);
  });
});

test("judged filters without the memory decision point do not apply; startup warns", async () => {
  await withStore(async ({ store }) => {
    const { engine } = fakeEngine({ enabled: false });
    const svc = new MemoryFilterService({ config: cfg({ j: { description: "d" } }), store, engine: () => engine });
    const s = await svc.enforce(null, [blockOf("BAD", 1, "a")], { surface: "search_memory", attribution: {} });
    assert.equal(s.get("a")!.hidden, false);
    const warnings: string[] = [];
    warnFiltersWithoutDecisions(cfg({ j: { description: "d" } }), () => false, { warn: (e: string) => warnings.push(e) } as any);
    assert.deepEqual(warnings, ["memory_filters_without_decisions"]);
    const none: string[] = [];
    warnFiltersWithoutDecisions(cfg({ k: { keywords: ["x"] } }), () => false, { warn: (e: string) => none.push(e) } as any);
    assert.deepEqual(none, [], "mechanical-only filters need no decision model");
  });
});

test("surfaces: the recency window and the diary writer's window drop hidden blocks per file", async () => {
  await withStore(async ({ store, dir }) => {
    configureAgentTimezone(TZ);
    const root = path.join(dir, "ws");
    await mkdir(path.join(root, "memory"), { recursive: true });
    const text = `# 2026-05-01\n\n${header("2026-05-01", "10:00")}\nA good entry.\n\n${header("2026-05-01", "11:00")}\nAn entry with forbiddenword in it.\n`;
    await writeFile(path.join(root, "memory", "2026-05-01.md"), text);
    const svc = new MemoryFilterService({ config: cfg({ f: { keywords: ["forbiddenword"] } }), store });
    const window = await recentMemoryWindow({
      workspaceRoot: root,
      anchorDay: "2026-05-02",
      ceilingTokens: 10_000,
      fileCount: 2,
      filterFile: (rel, t) => filterMemoryFileText(svc, null, rel, t, { surface: "diary_writer", attribution: {} }),
    });
    assert.ok(window.includes("A good entry."));
    assert.ok(!window.includes("forbiddenword"));
    // Block identity matches the index's chunk boundaries.
    const blocks = splitFileBlocks("memory/2026-05-01.md", text);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]!.text.startsWith("## "));
  });
});

test("surfaces: search_memory drops lines inside hidden blocks; direct reads are not filtered", async () => {
  await withStore(async ({ store, dir }) => {
    configureAgentTimezone(TZ);
    const root = path.join(dir, "ws");
    await mkdir(path.join(root, "memory"), { recursive: true });
    const text = `${header("2026-05-01", "10:00")}\nkiwi is fine here.\n\n${header("2026-05-01", "11:00")}\nkiwi with forbiddenword.\n`;
    await writeFile(path.join(root, "memory", "2026-05-01.md"), text);
    const svc = new MemoryFilterService({ config: cfg({ f: { keywords: ["forbiddenword"] } }), store });
    const followUps: string[] = [];
    const tool = createSearchMemoryTool({
      workspaceRoot: root,
      hiddenBlocks: async (blocks) => {
        const st = await svc.enforce(null, blocks, { surface: "search_memory", attribution: {} });
        return new Set(blocks.filter((b) => st.get(b.contentHash)?.hidden).map((b) => b.contentHash));
      },
      onFollowUp: (k) => followUps.push(k),
    });
    const res: any = await tool.execute("c1", { pattern: "kiwi" });
    const out = res.content[0].text as string;
    assert.ok(out.includes("kiwi is fine"), JSON.stringify(res));
    assert.ok(!out.includes("forbiddenword"), out);
    assert.deepEqual(followUps, ["search_memory"]);
  });
});

test("search_memory checks only the blocks its output shows, in bounded batches, up to max_results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-memory-filters-"));
  try {
    configureAgentTimezone(TZ);
    await mkdir(path.join(dir, "memory"));
    for (let f = 0; f < 3; f++) {
      let text = "";
      for (let b = 0; b < 20; b++) {
        const ts = Date.UTC(2026, 4, 10 + f, b);
        text += `${buildDiaryHeader({ earliestTimestamp: ts, latestTimestamp: ts + 600_000, room: "lobby", timezone: "UTC" })}\n`;
        text += b === 7 || b === 12 ? `We talked about the zebra exhibit ${b}.\n\n` : `Ordinary block ${b} about nothing special.\n\n`;
      }
      await writeFile(path.join(dir, "memory", `2026-05-${10 + f}.md`), text);
    }
    const batches: number[] = [];
    const tool = createSearchMemoryTool({
      workspaceRoot: dir,
      hiddenBlocks: async (blocks) => {
        batches.push(blocks.length);
        // The first zebra block of each file is hidden.
        return new Set(blocks.filter((b) => b.text.includes("zebra exhibit 7")).map((b) => b.contentHash));
      },
    });
    const res: any = await tool.execute("t1", { pattern: "zebra" } as any, undefined as any, undefined as any);
    const out = res.content[0].text as string;
    assert.equal(out.split("\n").filter(Boolean).length, 3, out);
    assert.ok(!out.includes("exhibit 7"));
    // 6 blocks hold a match (2 per file): 60 blocks in the files, 6 checked.
    assert.equal(batches.reduce((a, b) => a + b, 0), 6);
    assert.ok(batches.every((n) => n <= 8));

    // max_results stops the checking early: one kept line needs only the first blocks.
    batches.length = 0;
    const one: any = await tool.execute("t2", { pattern: "zebra", max_results: 1 } as any, undefined as any, undefined as any);
    assert.equal(one.content[0].text.split("\n").filter(Boolean).length, 1);
    assert.equal(batches.length, 1);

    // A pattern hitting 54 blocks: max_results 2 checks one batch; the default checks at most 48 blocks.
    batches.length = 0;
    const two: any = await tool.execute("t3", { pattern: "Ordinary", max_results: 2 } as any, undefined as any, undefined as any);
    assert.equal(two.content[0].text.split("\n").filter(Boolean).length, 2);
    assert.deepEqual(batches, [8]);
    batches.length = 0;
    const many: any = await tool.execute("t4", { pattern: "Ordinary" } as any, undefined as any, undefined as any);
    assert.equal(batches.reduce((a, b) => a + b, 0), 48);
    assert.equal(many.content[0].text.split("\n").filter(Boolean).length, 48);
    assert.equal(many.details.truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
});
