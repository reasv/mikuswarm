/**
 * The context build's side of auto-retrieval (ARCHITECTURE.md §9d "Judged
 * retrieval"): a live build waits for its launch-time plan within the ticket's
 * budget and abandons it on timeout; only a room preview runs the pipeline
 * inline. Fake pipeline; synthetic fixtures only.
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

async function withBuilder(run: (b: ContextBuilder, inline: PlanInput[]) => Promise<void>): Promise<void> {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const inline: PlanInput[] = [];
  const pipeline = {
    plan: async (input: PlanInput) => {
      inline.push(input);
      return plan(BLOCK);
    },
    waitBudgetMs: () => 1000,
  } as any;
  const builder = new ContextBuilder(timeline, minimalConfig(), storage, undefined, {
    pipeline,
    config: resolveRetrievalConfig({ enabled: true } as any),
  });
  try {
    await timeline.append(ev("ev1", "hello there", 1000));
    await run(builder, inline);
  } finally {
    storage.close();
    resetAgentTimezone();
  }
}

const finalContent = (r: Awaited<ReturnType<ContextBuilder["build"]>>) => r.messages[r.messages.length - 1]!.content;

test("a live build abandons a plan that outlasts the ticket's wait, and renders no block", async () => {
  await withBuilder(async (builder, inline) => {
    let abandoned = 0;
    const ticket: MemoryPlanTicket = { plan: new Promise(() => {}), waitMs: 30, abandon: () => (abandoned += 1) };
    const started = Date.now();
    const result = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace,
      selfSessionId: "s1", memoryRetrieval: ticket,
    });
    assert.ok(Date.now() - started < 2000);
    assert.equal(abandoned, 1);
    assert.ok(!finalContent(result).includes("<retrieved_memory"));
    assert.equal(inline.length, 0);
  });
});

test("a live build renders its ticket's block and does not abandon it", async () => {
  await withBuilder(async (builder) => {
    let abandoned = 0;
    const ticket: MemoryPlanTicket = { plan: Promise.resolve(plan(BLOCK)), waitMs: 1000, abandon: () => (abandoned += 1) };
    const result = await builder.build({
      timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace,
      selfSessionId: "s1", memoryRetrieval: ticket,
    });
    assert.equal(abandoned, 0);
    assert.ok(finalContent(result).includes("a memory"));
  });
});

test("only a room preview runs the pipeline inline (unjudged, attributed to the preview)", async () => {
  await withBuilder(async (builder, inline) => {
    await builder.build({ timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace, selfSessionId: "s1" });
    assert.equal(inline.length, 0, "a live build without a ticket never runs the pipeline inline");
    const preview = await builder.build({ timelineKey: TK, trigger: ev("ev1", "hello there", 1000), activeSessions: [], workspace: emptyWorkspace });
    assert.equal(inline.length, 1);
    assert.equal(inline[0]!.judge, false);
    assert.equal(inline[0]!.attribution.sessionType, "preview");
    assert.ok(finalContent(preview).includes("a memory"));
  });
});
