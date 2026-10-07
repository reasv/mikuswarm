/**
 * Fork core (spec REFUSAL-HANDLING §8.4, §9): fork point computation (delivered
 * messages, irreversible effects, read-only tails, the run floor, sibling
 * edits) and `forkSession`'s effects (truncation, branch row, live event,
 * transcript flush, re-derivation hook, interjection redelivery), plus the
 * factory-side re-derivation (running context counter, dynamic tools).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { findForkPoint, forkFloor, forkSession, type ForkChange, type ForkContext } from "../src/agent/fork.js";
import { DynamicToolRegistry } from "../src/agent/dynamic-tools.js";
import { AgentSessionFactory, rewindRunningContext } from "../src/agent/factory.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/index.js";
import { SessionLiveEventBus, type SessionLiveEvent } from "../src/observability/live-events.js";
import { Storage } from "../src/storage/index.js";

// --- builders ---------------------------------------------------------------

const kick = () => ({ type: "triggerGroup", content: "hi", timestamp: 1 }) as unknown as AgentMessage;
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const asst = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  ({ role: "assistant", content: blocks, stopReason: "toolUse", timestamp: 2, ...extra }) as unknown as AgentMessage;
const res = (id: string, name: string, isError = false, extra: Record<string, unknown> = {}) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "r" }], isError, timestamp: 3, ...extra }) as unknown as AgentMessage;
const text = (t: string) => asst([{ type: "text", text: t }], { stopReason: "stop" });
const aborted = () => asst([{ type: "text", text: "" }], { stopReason: "aborted" });
const inj = (id: string) => [
  asst([call(id, "load_skill", { name: "x" })], { harness: { kind: "injection" } }),
  res(id, "load_skill", false, { harness: { kind: "injection" } }),
];

// --- findForkPoint ----------------------------------------------------------

test("findForkPoint: fork point table", () => {
  const cases: { name: string; messages: AgentMessage[]; gated?: string; expect: ReturnType<typeof findForkPoint> }[] = [
    {
      name: "nothing delivered, read-only tail → the run floor",
      messages: [kick(), asst([call("r1", "read_messages")]), res("r1", "read_messages"), text("t")],
      expect: { index: 1 },
    },
    {
      name: "the floor skips the kickoff's synthetic injections",
      messages: [kick(), ...inj("i1"), ...inj("i2"), text("t")],
      expect: { index: 5 },
    },
    {
      name: "delivered message → after its result",
      messages: [kick(), asst([call("s1", "send_message", { final: false })]), res("s1", "send_message"), asst([call("r1", "web_search")]), res("r1", "web_search"), text("t")],
      expect: { index: 3 },
    },
    {
      name: "a failed send delivered nothing",
      messages: [kick(), asst([call("s1", "send_message")]), res("s1", "send_message", true), text("t")],
      expect: { index: 1 },
    },
    {
      name: "a later irreversible effect wins over the last delivered message",
      messages: [
        kick(),
        asst([call("s1", "send_message")]), res("s1", "send_message"),
        asst([call("b1", "bash")]), res("b1", "bash", true),
        asst([call("w1", "web_search")]), res("w1", "web_search"),
        text("t"),
      ],
      expect: { index: 5 },
    },
    {
      name: "parallel calls: after the whole result group",
      messages: [kick(), asst([call("b1", "bash"), call("r1", "read_messages")]), res("b1", "bash"), res("r1", "read_messages"), text("t")],
      expect: { index: 4 },
    },
    {
      name: "pins list is a read, a pin is an effect; MCP tools are effects",
      messages: [
        kick(),
        asst([call("p1", "pins", { action: "list" })]), res("p1", "pins"),
        asst([call("m1", "mcp_srv_do")]), res("m1", "mcp_srv_do"),
        asst([call("p2", "pins", { action: "list" })]), res("p2", "pins"),
        text("t"),
      ],
      expect: { index: 5 },
    },
    {
      name: "repeatable and undoable effects count; args-refined reads do not",
      messages: [
        kick(),
        asst([call("g1", "image_generate", { prompt: "x" })]), res("g1", "image_generate"),
        asst([call("v1", "str_replace_based_edit_tool", { command: "view", path: "a" })]), res("v1", "str_replace_based_edit_tool"),
        asst([call("x1", "react", { message_id: "m", emoji: "👍" })]), res("x1", "react"),
        asst([call("n1", "browser", { action: "snapshot" })]), res("n1", "browser"),
        text("t"),
      ],
      expect: { index: 7 },
    },
    {
      name: "a repeatable call alone moves the fork point past it",
      messages: [kick(), asst([call("e1", "exa_research", { query: "q" })]), res("e1", "exa_research"), asst([call("w1", "web_search")]), res("w1", "web_search"), text("t")],
      expect: { index: 3 },
    },
    {
      name: "gated send with a repeatable sibling → sibling edit",
      messages: [kick(), asst([call("g1", "send_message"), call("i1", "image_generate", { prompt: "x" })]), res("g1", "send_message", true), res("i1", "image_generate"), aborted()],
      gated: "g1",
      expect: { index: 1, siblingEdit: { messageIndex: 1, removeToolCallIds: ["g1"] } },
    },
    {
      name: "a resumed transcript forks no earlier than the current run",
      messages: [
        kick(), text("t"),
        { role: "user", content: "record", harness: { kind: "record_turn" } } as unknown as AgentMessage,
        text("record"),
        kick(), text("again"),
      ],
      expect: { index: 5 },
    },
    {
      name: "gated send with an irreversible sibling → sibling edit",
      messages: [
        kick(),
        asst([{ type: "text", text: "I'd rather not" }, call("g1", "send_message"), call("x1", "react")]),
        res("g1", "send_message", true), res("x1", "react"),
        aborted(),
      ],
      gated: "g1",
      expect: { index: 1, siblingEdit: { messageIndex: 1, removeToolCallIds: ["g1"] } },
    },
    {
      name: "gated send with a delivered sibling send → sibling edit",
      messages: [kick(), asst([call("s1", "send_message"), call("g1", "send_message")]), res("s1", "send_message"), res("g1", "send_message", true), aborted()],
      gated: "g1",
      expect: { index: 1, siblingEdit: { messageIndex: 1, removeToolCallIds: ["g1"] } },
    },
    {
      name: "gated send whose siblings are all redo-safe → the whole message is discarded",
      messages: [kick(), asst([call("g1", "send_message"), call("w1", "web_search")]), res("g1", "send_message", true), res("w1", "web_search"), aborted()],
      gated: "g1",
      expect: { index: 1 },
    },
    {
      name: "gated send after a delivered message, redo-safe siblings → after the delivered one",
      messages: [
        kick(),
        asst([call("s1", "send_message", { final: false })]), res("s1", "send_message"),
        asst([call("g1", "send_message"), call("r1", "read_messages")]), res("g1", "send_message", true), res("r1", "read_messages"),
        aborted(),
      ],
      gated: "g1",
      expect: { index: 3 },
    },
    {
      name: "with a gated call, effects after its message are ignored",
      messages: [kick(), asst([call("g1", "send_message")]), res("g1", "send_message", true), asst([call("b1", "bash")]), res("b1", "bash")],
      gated: "g1",
      expect: { index: 1 },
    },
  ];
  for (const c of cases) {
    assert.deepEqual(findForkPoint(c.messages, c.gated ? { gatedToolCallId: c.gated } : {}), c.expect, c.name);
  }
  assert.equal(forkFloor([]), 0);
});

// --- forkSession ------------------------------------------------------------

function fakeAgent(messages: AgentMessage[]) {
  return {
    state: { messages, tools: [] as AgentTool[], errorMessage: "aborted" as string | undefined },
    waitForIdle: async () => {},
  };
}

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.insertAgentSession({
    id: "s1", timelineKey: "matrix:a:room:!r:x", sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
  });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

function forkCtx(storage: Storage, agent: ReturnType<typeof fakeAgent>) {
  const events: SessionLiveEvent[] = [];
  const bus = new SessionLiveEventBus();
  bus.subscribe("s1", (e) => events.push(e));
  const flushed: number[] = [];
  const changes: ForkChange[] = [];
  const ctx: ForkContext = {
    sessionId: "s1",
    agent: agent as never,
    storage,
    flushTranscript: async () => {
      flushed.push(agent.state.messages.length);
    },
    onForked: (c) => changes.push(c),
    liveEvents: bus,
  };
  return { ctx, events, flushed, changes };
}

test("forkSession: truncates, stores the branch, resets, flushes, emits branch_forked", async () => {
  await withStorage(async (storage) => {
    const interjection = { type: "interjection", content: "wait, also this" } as unknown as AgentMessage;
    const messages = [
      kick(),
      asst([call("s1", "send_message", { final: false })], { usage: { cost: { total: 0.5 } } }),
      res("s1", "send_message"),
      text("failed attempt"),
      interjection,
      asst([{ type: "image", data: "QUJDRA==", mimeType: "image/png" }], { usage: { cost: { total: 0.25 } } }),
    ];
    const agent = fakeAgent(messages.slice());
    const { ctx, events, flushed, changes } = forkCtx(storage, agent);
    const { branchNo } = await forkSession(ctx, { index: 3 }, { reason: "contract_redo", fromModel: "model_a", toModel: "model_a" });
    assert.equal(branchNo, 1);
    assert.deepEqual(agent.state.messages, [messages[0], messages[1], messages[2], interjection]);
    assert.strictEqual(agent.state.messages[3], interjection, "the same interjection object is redelivered");
    assert.equal(agent.state.errorMessage, undefined);
    assert.deepEqual(flushed, [4], "flushed after the truncation");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.forkIndex, 3);
    assert.equal(changes[0]!.discarded.length, 3);
    assert.deepEqual(events, [
      { type: "branch_forked", branchNo: 1, forkIndex: 3, reason: "contract_redo", fromModel: "model_a", toModel: "model_a" },
    ]);
    const [row] = storage.listSessionBranches("s1");
    assert.equal(row!.fork_index, 3);
    assert.equal(row!.reason, "contract_redo");
    assert.equal(row!.parent_branch_no, 0);
    assert.equal(row!.cost_usd, 0.25);
    const stored = JSON.parse(row!.messages_json) as { content?: unknown }[];
    assert.equal(stored.length, 3);
    assert.ok(!row!.messages_json.includes("QUJDRA=="), "image base64 is externalized like transcripts");
  });
});

test("forkSession: sibling edit keeps the edited message and sibling results; the branch keeps the original", async () => {
  await withStorage(async (storage) => {
    const original = asst(
      [
        { type: "thinking", thinking: "should I?" },
        { type: "text", text: "I won't send that" },
        call("g1", "send_message"),
        call("x1", "react"),
        call("w1", "web_search"),
      ],
      { usage: { cost: { total: 1 } } },
    );
    const rx = res("x1", "react");
    const rw = res("w1", "web_search");
    const messages = [kick(), original, res("g1", "send_message", true), rx, rw, aborted()];
    const agent = fakeAgent(messages.slice());
    const { ctx } = forkCtx(storage, agent);
    const point = findForkPoint(messages, { gatedToolCallId: "g1" });
    assert.deepEqual(point, { index: 1, siblingEdit: { messageIndex: 1, removeToolCallIds: ["g1"] } });
    await forkSession(ctx, point, { reason: "refusal_redo", checkCode: "refusal_x", fromModel: "model_a", toModel: "model_b" });
    const live = agent.state.messages as unknown as { content?: { type: string; id?: string }[] }[];
    assert.equal(live.length, 4);
    assert.deepEqual(live[1]!.content!.map((b) => [b.type, b.id]), [["toolCall", "x1"], ["toolCall", "w1"]]);
    assert.strictEqual(agent.state.messages[2], rx);
    assert.strictEqual(agent.state.messages[3], rw);
    const [row] = storage.listSessionBranches("s1");
    assert.equal(row!.check_code, "refusal_x");
    assert.equal(row!.to_model, "model_b");
    assert.equal(row!.cost_usd, 0, "the original request's spend stays with the live message");
    const stored = JSON.parse(row!.messages_json) as { content: { type: string }[] }[];
    assert.equal(stored[0]!.content.length, 5, "the branch starts with the original message");
  });
});

test("forkSession: nothing to discard throws and changes nothing", async () => {
  await withStorage(async (storage) => {
    const messages = [kick(), text("t")];
    const agent = fakeAgent(messages.slice());
    const { ctx, flushed } = forkCtx(storage, agent);
    await assert.rejects(forkSession(ctx, { index: 2 }, { reason: "contract_redo" }), /nothing to discard/);
    assert.equal(agent.state.messages.length, 2);
    assert.deepEqual(flushed, []);
    assert.equal(storage.listSessionBranches("s1").length, 0);
  });
});

// --- factory-side re-derivation ---------------------------------------------

test("rewindRunningContext takes the counted discarded share and unloaded tools back out", () => {
  const discarded = [text("a"), text("b"), asst([call("r1", "read_messages")]), res("r1", "read_messages")];
  const counter = { running: 1000, seenMsgs: 6, cachedAtLast: 900 };
  // seenMsgs 6, fork 3 → the first three discarded messages were counted; text-only
  // assistant turns are not live runtime messages (never on the wire), so only the
  // tool-call message counts here.
  const seen: AgentMessage[][] = [];
  rewindRunningContext(counter, { forkIndex: 3, discarded }, 50, (slice) => {
    seen.push(slice);
    return 100 * slice.length;
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 1);
  assert.deepEqual(counter, { running: 850, seenMsgs: 3, cachedAtLast: 850 });
  const unseeded = { running: 0, seenMsgs: -1, cachedAtLast: 0 };
  rewindRunningContext(unseeded, { forkIndex: 0, discarded }, 50, () => 1);
  assert.deepEqual(unseeded, { running: 0, seenMsgs: -1, cachedAtLast: 0 });
});

test("DynamicToolRegistry.unloadDiscarded defers tools loaded only by discarded messages", () => {
  const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [] }) }) as unknown as AgentTool;
  const registry = new DynamicToolRegistry([tool("a"), tool("b"), tool("c"), tool("d")], ["a"]);
  registry.load(["b", "c", "d"]);
  const loads = (names: string[]) => ({ role: "toolResult", toolCallId: "x", toolName: "load_skill", content: [], addedToolNames: names }) as unknown as AgentMessage;
  const kept = [loads(["c"])];
  const discarded = [loads(["b", "c", "a"])];
  const removed = registry.unloadDiscarded(discarded, kept);
  assert.deepEqual(removed.map((t) => t.name), ["b"]);
  assert.deepEqual(registry.current.map((t) => t.name), ["a", "c", "d"], "immediate, kept-loaded and non-transcript loads stay");
});

test("factory forkContext: a fork unloads the discarded span's dynamic tools from the agent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-fork-factory-"));
  try {
    const config = {
      app: { name: "t", data_dir: dir, log_level: "error", context_dump_dir: dir },
      agent: {
        sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
        system: {},
        tools: { dynamic: { enabled: true, immediate: ["immediate_tool"], index: "none" } },
      },
      models: {
        default: {
          id: "m", provider: "p", api: "openai-completions", endpoint: "http://127.0.0.1:9/v1",
          api_key: "k", input_modalities: ["text"], max_tokens: 100, context_window: 128_000,
        },
      },
      context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
      storage: { database_path: ":memory:" },
      workspace: { root_dir: dir },
      matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    } as unknown as AppConfig;
    const built = {
      messages: [
        { type: "system", role: "system", content: "s", tier: "system", tokenEstimate: 1 },
        { type: "triggerGroup", role: "user", content: "hi", tier: "trigger", tokenEstimate: 1, timestamp: 1 },
      ],
      tokenEstimate: 2,
      compactTokens: 0,
      richTokens: 0,
      imageBlocks: [],
    } as unknown as BuiltContext;
    const factory = new AgentSessionFactory({
      config,
      contextBuilder: { build: async () => built } as unknown as ContextBuilder,
      getActiveSessions: () => [],
    });
    const session = {
      id: "s1", timelineKey: "matrix:a:room:!r", sessionType: "default", status: "running", createdAt: 0,
      trigger: { provider: "matrix", timelineKey: "matrix:a:room:!r", event: { id: "t", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "u" }, body: "hi", timestamp: 1, receivedAt: 1 } },
    } as unknown as AgentSessionRecord;
    const mk = (name: string) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }) as unknown as AgentTool;
    const created = await factory.create(session, [mk("immediate_tool"), mk("deferred_tool")]);
    assert.ok(created.registry, "dynamic loading is on");
    assert.ok(!created.agent.state.tools.some((t) => t.name === "deferred_tool"));
    created.registry!.load(["deferred_tool"]);
    assert.ok(created.agent.state.tools.some((t) => t.name === "deferred_tool"), "onChange loaded it");
    created.agent.state.messages = [
      created.kickoff![0]!,
      asst([call("l1", "tool_search", { query: "select:deferred_tool" })]),
      res("l1", "tool_search", false, { addedToolNames: ["deferred_tool"] }),
      text("failed"),
    ];
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      await storage.insertAgentSession({ id: "s1", timelineKey: "matrix:a:room:!r", sessionType: "default", status: "running", createdAt: 1, updatedAt: 1 });
      const ctx = created.forkContext({ storage, flushTranscript: async () => {} });
      await forkSession(ctx, { index: 1 }, { reason: "contract_redo" });
      assert.equal(created.agent.state.messages.length, 1);
      assert.ok(!created.agent.state.tools.some((t) => t.name === "deferred_tool"), "the fork unloaded it");
      assert.ok(!created.registry!.isLoaded("deferred_tool"));
      assert.ok(created.redoControl, "a redo control per session");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
