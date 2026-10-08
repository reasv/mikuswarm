/**
 * The context build's side of auto-retrieval (ARCHITECTURE.md §9d "Judged
 * retrieval"): a live build waits for its launch-time plan within the ticket's
 * budget, then takes the plan's best effort and abandons it only when nothing
 * is ready; a room preview never runs the pipeline and shows a placeholder.
 * Fake pipeline; synthetic fixtures only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/index.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";
import { resolveRetrievalConfig } from "../src/retrieval/config.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";
import type { MemoryPlanTicket, PlanInput, RetrievalPlan } from "../src/retrieval/auto/types.js";

const TK = "matrix:miku:room:!room";

function minimalConfig(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: { id: "test-model", provider: "test", endpoint: "http://localhost", api_key: "key", input_modalities: ["text"], max_tokens: 4096 },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}

function ev(id: string, body: string, ts: number): CanonicalChatEvent {
  return {
    id, timelineKey: TK, provider: "matrix", role: "user",
    sender: { id: "alice", displayName: "Alice", isSelf: false },
    body, timestamp: ts, receivedAt: ts,
  };
}

const emptyWorkspace: WorkspaceContent = { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };
const BLOCK = '<retrieved_memory note="n">\n- [memory/2026-01-01.md:1-3] a memory\n</retrieved_memory>';
const plan = (block: string | null): RetrievalPlan => ({
  block,
  report: { source: "model", candidates: 1, judged: 1, kept: 1, hidden: 0, tokens: 10, ms: 1, stages: { recallMs: 1 }, items: [] },
});

type Latest = { ts: number; source: string; kept: number; tokens: number } | null;

async function withBuilder(
  run: (b: ContextBuilder, inline: PlanInput[], setLatest: (l: Latest) => void) => Promise<void>,
): Promise<void> {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const inline: PlanInput[] = [];
  let latest: Latest = null;
  // Any recall or re-rank happens inside `plan`; counting its calls covers both.
  const pipeline = {
    plan: async (input: PlanInput) => {
      inline.push(input);
      return plan(BLOCK);
    },
    waitBudgetMs: () => 1000,
    latestForTimeline: (key: string) => (key === TK ? latest : null),
  } as any;
  const builder = new ContextBuilder(timeline, minimalConfig(), storage, undefined, {
    pipeline,
    config: resolveRetrievalConfig({ enabled: true } as any),
  });
  try {
    await timeline.append(ev("ev1", "hello there", 1000));
    await run(builder, inline, (l) => (latest = l));
  } finally {
    storage.close();
    resetAgentTimezone();
  }
}

const finalContent = (r: Awaited<ReturnType<ContextBuilder["build"]>>) => r.messages[r.messages.length - 1]!.content;

const ticketOf = (plan: Promise<RetrievalPlan | null>, waitMs: number, bestEffort: () => Promise<RetrievalPlan | null>, counts: { abandoned: number; bestEffort: number }): MemoryPlanTicket => ({
  plan,
  waitMs,
  bestEffort: () => {
    counts.bestEffort += 1;
    return bestEffort();
  },
  confirm: () => undefined,
  abandon: () => (counts.abandoned += 1),
});

test("a live build whose wait expires uses the plan's best effort now", async () => {
  await withBuilder(async (builder, inline) => {
    const counts = { abandoned: 0, bestEffort: 0 };
    const ticket = ticketOf(new Promise(() => {}), 30, async () => plan(BLOCK), counts);
    const result = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace,
      selfSessionId: "s1", memoryRetrieval: ticket,
    });
    assert.equal(counts.bestEffort, 1);
    assert.equal(counts.abandoned, 0, "the session confirms or abandons it later");
    assert.ok(finalContent(result).includes("a memory"), "the block is shown");
    assert.equal(inline.length, 0);
  });
});

test("a live build abandons a plan that outlasts the ticket's wait with nothing ready, and renders no block", async () => {
  await withBuilder(async (builder, inline) => {
    const counts = { abandoned: 0, bestEffort: 0 };
    const ticket = ticketOf(new Promise(() => {}), 30, async () => null, counts);
    const started = Date.now();
    const result = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace,
      selfSessionId: "s1", memoryRetrieval: ticket,
    });
    assert.ok(Date.now() - started < 2000);
    assert.equal(counts.bestEffort, 1);
    assert.equal(counts.abandoned, 1);
    assert.ok(!finalContent(result).includes("<retrieved_memory"));
    assert.equal(inline.length, 0);
  });
});

test("a live build renders its ticket's block and does not abandon it", async () => {
  await withBuilder(async (builder) => {
    const counts = { abandoned: 0, bestEffort: 0 };
    const ticket = ticketOf(Promise.resolve(plan(BLOCK)), 1000, async () => null, counts);
    const result = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace,
      selfSessionId: "s1", memoryRetrieval: ticket,
    });
    assert.equal(counts.abandoned, 0);
    assert.equal(counts.bestEffort, 0);
    assert.ok(finalContent(result).includes("a memory"));
  });
});

test("a room preview never runs the pipeline: it shows a placeholder, with the room's latest build when recorded", async () => {
  await withBuilder(async (builder, inline, setLatest) => {
    const preview = await builder.build({ timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace });
    assert.equal(inline.length, 0, "no recall, re-rank or decision call");
    const text = finalContent(preview);
    assert.ok(text.includes("<retrieved_memory>(chosen per trigger by the memory pipeline; not computed for previews)</retrieved_memory>"));
    assert.ok(!text.includes("a memory"));
    setLatest({ ts: Date.UTC(2026, 4, 8, 12, 30), source: "model", kept: 3, tokens: 412 });
    const pointed = finalContent(await builder.build({ timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace }));
    assert.ok(pointed.includes("latest build in this room: 2026-05-08T12:30:00Z, source model, 3 kept, 412 tokens"));
    assert.equal(inline.length, 0);
  });
});

test("a live build without a ticket shows no block and never takes the preview path", async () => {
  await withBuilder(async (builder, inline, setLatest) => {
    setLatest({ ts: 1, source: "model", kept: 1, tokens: 1 });
    const live = await builder.build({ timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace, selfSessionId: "s1" });
    assert.equal(inline.length, 0);
    assert.ok(!finalContent(live).includes("<retrieved_memory"));
    const proactive = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace, selfSessionId: "s2", proactive: true,
    });
    assert.ok(!finalContent(proactive).includes("<retrieved_memory"));
  });
});
