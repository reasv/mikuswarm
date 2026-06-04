import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/builder.js";
import { buildAutoRetrievalBlock } from "../src/context/auto-retrieval.js";
import { resolveRetrievalConfig, type RetrievalResult, type SearchOutcome } from "../src/retrieval/index.js";
import type { MemorySearch } from "../src/retrieval/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

function result(over: Partial<RetrievalResult>): RetrievalResult {
  return {
    id: over.id ?? "id",
    path: over.path ?? "memory/2026-03-02.md",
    startLine: over.startLine ?? 5,
    endLine: over.endLine ?? 19,
    room: over.room ?? "Project Hammer",
    date: over.date ?? "2026-03-02",
    entryTs: over.entryTs ?? 1,
    score: over.score ?? 0.8,
    snippet: over.snippet ?? "We agreed the launch target is October.",
  };
}

/** A MemorySearch stub returning canned results. */
function fakeSearch(results: RetrievalResult[]): MemorySearch {
  return {
    search: async (): Promise<SearchOutcome> => ({
      results,
      mode: "hybrid",
      degraded: false,
      ignoredDateBounds: [],
      contradictoryDateBounds: false,
    }),
  } as unknown as MemorySearch;
}

const config = resolveRetrievalConfig({ enabled: true });

test("buildAutoRetrievalBlock renders a cited block", async () => {
  const block = await buildAutoRetrievalBlock(
    { search: fakeSearch([result({ path: "memory/2026-03-02.md", startLine: 5, endLine: 19 })]), config },
    { query: "launch target", recencyContent: null, now: 1000 },
  );
  assert.ok(block);
  assert.match(block!, /<retrieved_memory note=/);
  assert.match(block!, /\[memory\/2026-03-02\.md:5-19 · Project Hammer · 2026-03-02\]/);
  assert.match(block!, /launch target is October/);
  assert.match(block!, /<\/retrieved_memory>$/);
});

test("buildAutoRetrievalBlock returns null on empty query or no results", async () => {
  assert.equal(
    await buildAutoRetrievalBlock({ search: fakeSearch([result({})]), config }, { query: "  ", recencyContent: null, now: 1 }),
    null,
  );
  assert.equal(
    await buildAutoRetrievalBlock({ search: fakeSearch([]), config }, { query: "x", recencyContent: null, now: 1 }),
    null,
  );
});

test("buildAutoRetrievalBlock dedups entries already shown in the recency layer", async () => {
  const shared = "We agreed the launch target is October and assigned tasks.";
  const recency = `<recent_memory>\n## 2026-03-02 ...\n${shared}\n</recent_memory>`;
  const block = await buildAutoRetrievalBlock(
    {
      search: fakeSearch([
        result({ id: "dup", snippet: shared, path: "memory/2026-03-02.md" }),
        result({ id: "fresh", snippet: "Older note about the Helsinki trip.", path: "memory/2026-01-10.md", date: "2026-01-10" }),
      ]),
      config,
    },
    { query: "launch", recencyContent: recency, now: 1 },
  );
  assert.ok(block);
  assert.ok(!block!.includes("launch target is October"), "duplicate of recency content excluded");
  assert.match(block!, /Helsinki/);
});

test("buildAutoRetrievalBlock respects the token budget", async () => {
  const tight = resolveRetrievalConfig({ enabled: true, auto: { max_tokens: 25 } });
  const many = Array.from({ length: 5 }, (_, i) =>
    result({ id: `r${i}`, snippet: `Distinct memory number ${i} with enough words to cost tokens here.` }),
  );
  const block = await buildAutoRetrievalBlock({ search: fakeSearch(many), config: tight }, {
    query: "memory",
    recencyContent: null,
    now: 1,
  });
  // With a tiny budget, at most one line fits (or none).
  const lineCount = block ? block.split("\n").filter((l) => l.startsWith("- ")).length : 0;
  assert.ok(lineCount <= 1, `expected ≤1 line under tight budget, got ${lineCount}`);
});

// ── Integration: the block lands inside the final user turn ──

const emptyWorkspace: WorkspaceContent = {
  files: new Map(),
  tailContent: null,
  skills: { listed: [], inlined: [] },
};

function minimalConfig(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: { id: "m", provider: "t", endpoint: "http://x", api_key: "k", multimodal: false, max_tokens: 4096 },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}

function event(id: string, body: string, ts: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: "matrix:miku:room:!room",
    provider: "matrix",
    role: "user",
    sender: { id: "alice", displayName: "Alice" },
    body,
    timestamp: ts,
    receivedAt: ts,
  };
}

test("ContextBuilder injects the retrieved_memory block before the trigger, after the system block", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const search = fakeSearch([result({ snippet: "A relevant older decision about pricing." })]);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage, undefined, {
    search,
    config: resolveRetrievalConfig({ enabled: true }),
  });
  const TK = "matrix:miku:room:!room";
  try {
    const trigger = event("ev1", "what did we decide about pricing?", 1000);
    await timeline.append(trigger);
    const built = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace: emptyWorkspace });

    const finalTurn = built.messages[built.messages.length - 1]!;
    assert.equal(finalTurn.type, "triggerGroup");
    const content = finalTurn.content;
    assert.ok(content.includes("<retrieved_memory"), "block present in final turn");
    // Order: retrieved_memory → system block → trigger text.
    const idxMem = content.indexOf("<retrieved_memory");
    const idxSys = content.indexOf("<system>");
    const idxTrigger = content.indexOf("pricing?");
    assert.ok(idxMem < idxSys && idxSys < idxTrigger, "ordering: retrieved_memory < system < trigger");
  } finally {
    storage.close();
  }
});

test("ContextBuilder prefix is byte-identical with vs without auto-retrieval (cache-safety, issue #17)", async () => {
  // The feature's central cache-safety claim (§8c): enabling auto-retrieval changes ONLY
  // the final user turn — every message before it (system, diaryLayer, summaryLayer, all
  // prior chat messages) stays byte-identical, so the cached prefix is untouched. This
  // test builds the SAME timeline twice through the REAL builder — once with the
  // autoRetrieval dep and once without — and pins that invariant. It fails if a future
  // change threads retrieved content into any higher (cached-prefix) message.
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const TK = "matrix:miku:room:!room";
  // A prior turn from a DIFFERENT sender so it forms its own chatEvent message before the
  // trigger (same-sender messages coalesce into the trigger group, leaving no prefix turn).
  const otherSender = (id: string, body: string, ts: number): CanonicalChatEvent => ({
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "bob", displayName: "Bob" },
    body,
    timestamp: ts,
    receivedAt: ts,
  });
  try {
    // A real prefix: a prior chat turn (from Bob) before the trigger (from Alice).
    await timeline.append(otherSender("ev1", "hey, are we still on for the launch?", 1000));
    await timeline.append(otherSender("ev2", "what was the target month again?", 1100));
    const trigger = event("ev3", "what did we decide about pricing?", 1200);
    await timeline.append(trigger);

    const search = fakeSearch([result({ snippet: "A relevant older decision about pricing." })]);
    const retrievalCfg = resolveRetrievalConfig({ enabled: true });

    // WITHOUT auto-retrieval: no autoRetrieval dep passed (5th ctor arg undefined).
    const builderOff = new ContextBuilder(timeline, minimalConfig(), storage, undefined);
    // WITH auto-retrieval: same everything, plus the dep.
    const builderOn = new ContextBuilder(timeline, minimalConfig(), storage, undefined, {
      search,
      config: retrievalCfg,
    });

    const builtOff = await builderOff.build({ timelineKey: TK, trigger, activeSessions: [], workspace: emptyWorkspace });
    const builtOn = await builderOn.build({ timelineKey: TK, trigger, activeSessions: [], workspace: emptyWorkspace });

    // Same message count and shape.
    assert.equal(builtOn.messages.length, builtOff.messages.length, "same number of messages");
    assert.ok(builtOn.messages.length >= 3, "expect system + ≥1 chat + final turn");
    // Sanity: there is a genuine non-trivial prefix (a prior chat turn before the final).
    assert.ok(
      builtOff.messages.slice(0, -1).some((m) => m.type === "chatEvent"),
      "prefix must include at least one prior chat message (otherwise the test is trivial)",
    );

    // Everything BEFORE the final user turn must be byte-identical.
    const lastIdx = builtOff.messages.length - 1;
    for (let i = 0; i < lastIdx; i++) {
      const a = builtOff.messages[i]!;
      const b = builtOn.messages[i]!;
      assert.equal(b.type, a.type, `message ${i} type stable`);
      assert.equal(b.role, a.role, `message ${i} role stable`);
      assert.equal(
        b.content,
        a.content,
        `message ${i} (${a.type}) content must be byte-identical with/without auto-retrieval`,
      );
      assert.equal(b.tokenEstimate, a.tokenEstimate, `message ${i} tokenEstimate stable`);
    }

    // The final user turn is the ONLY message allowed to differ: the block is injected
    // there when on, and absent when off.
    const finalOff = builtOff.messages[lastIdx]!;
    const finalOn = builtOn.messages[lastIdx]!;
    assert.equal(finalOff.type, "triggerGroup");
    assert.equal(finalOn.type, "triggerGroup");
    assert.ok(!finalOff.content.includes("<retrieved_memory"), "no block when auto-retrieval off");
    assert.ok(finalOn.content.includes("<retrieved_memory"), "block present when auto-retrieval on");
    assert.notEqual(finalOn.content, finalOff.content, "final turn differs (the only difference)");
  } finally {
    storage.close();
  }
});

test("ContextBuilder omits auto-retrieval for summarization (cutoff) builds", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const search = fakeSearch([result({})]);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage, undefined, {
    search,
    config: resolveRetrievalConfig({ enabled: true }),
  });
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(event("ev1", "hello", 1000));
    const trigger = event("summarize:x", "Summarize", 2000);
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 2000 },
    });
    const finalTurn = built.messages[built.messages.length - 1]!;
    assert.equal(finalTurn.type, "satellite");
    assert.ok(!finalTurn.content.includes("<retrieved_memory"), "no auto-retrieval in generation builds");
  } finally {
    storage.close();
  }
});
