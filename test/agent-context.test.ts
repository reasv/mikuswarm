import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../src/agent/convert.js";
import { AgentSessionFactory, buildAgentContextMessages, splitBuiltContext, withSdkRetriesDisabled } from "../src/agent/factory.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { BuiltContext } from "../src/context/index.js";
import { ContextBuilder, type BuildContextOptions } from "../src/context/builder.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

test("agent context keeps timeline base and preserves live runtime messages", () => {
  const built: BuiltContext = {
    messages: [
      {
        type: "system",
        role: "system",
        content: "system prompt",
        tier: "system",
        tokenEstimate: 1,
      },
      {
        type: "chatEvent",
        role: "user",
        content: "<message>hello</message>",
        tier: "rich",
        tokenEstimate: 1,
      },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  };

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "tool output" }],
    details: {},
    isError: false,
    timestamp: 1,
  };
  const interjection: AgentMessage = { type: "interjection", content: "new user reply" };
  const forcedPrompt: AgentMessage = { role: "user", content: "finish visibly", timestamp: 2 };
  const duplicateTrigger: AgentMessage = {
    type: "chatEvent",
    role: "user",
    content: "hello",
  };

  const messages = buildAgentContextMessages(built, [
    duplicateTrigger,
    toolResult,
    interjection,
    forcedPrompt,
  ]);

  assert.deepEqual(
    messages.map((message) => (message as any).type ?? (message as any).role),
    ["chatEvent", "toolResult", "interjection", "user"],
  );

  const llmMessages = convertToLlm(messages);
  assert.equal(llmMessages.some((message) => (message as any).content === "system prompt"), false);
  assert.equal(llmMessages.some((message) => message.role === "toolResult"), true);
  assert.equal(llmMessages.some((message) => message.role === "user" && message.content === "finish visibly"), true);
  assert.equal(
    llmMessages.some(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("<interjection>"),
    ),
    true,
  );
});

test("summary layer renders as a user turn ahead of chat and trigger", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      {
        type: "summaryLayer",
        role: "user",
        content: "<summary level=\"1\">old history</summary>",
        tier: "summary",
        tokenEstimate: 1,
        timestamp: 10,
      },
      { type: "chatEvent", role: "user", content: "<message>recent</message>", tier: "compact", tokenEstimate: 1, timestamp: 20 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 4,
    compactTokens: 1,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;

  const messages = buildAgentContextMessages(built, []);

  assert.deepEqual(
    messages.map((m) => (m as any).type),
    ["chatEvent", "chatEvent", "triggerGroup"],
  );
  // The summary layer is the first chatEvent, role user, carrying the summary body.
  assert.equal((messages[0] as any).role, "user");
  assert.match((messages[0] as any).content, /<summary/);

  const llm = convertToLlm(messages);
  assert.equal(
    llm.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<summary")),
    true,
  );
});

// ── Phase 0: frozen sessions — split & append-only filter (§2b) ──────

test("splitBuiltContext pops the triggerGroup final turn off the frozen prefix", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "rich", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>\n\n<message>hi miku</message>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 3,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  } as BuiltContext;

  const { frozenBase, finalTurn } = splitBuiltContext(built);

  // Prefix keeps history only; the trigger turn is popped out (system is dropped).
  assert.deepEqual(frozenBase.map((m) => (m as any).type), ["chatEvent"]);
  assert.equal((finalTurn as any)?.type, "triggerGroup");
  assert.match((finalTurn as any).content, /hi miku/);
});

// #9: the persisted transcript head (the popped final turn) must carry the
// builder's real per-message tier + tokenEstimate, so the verbatim renderer shows
// the true token count instead of 0/`trigger`.
test("splitBuiltContext: final turn carries the builder's real tier and tokenEstimate (#9)", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>\n\n<message>hi miku</message>", tier: "trigger", tokenEstimate: 137, timestamp: 30 },
    ],
    tokenEstimate: 138,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;

  const { finalTurn } = splitBuiltContext(built);
  // The head turn must carry the real estimate, not the default 0 (#9).
  assert.equal((finalTurn as any)?.type, "triggerGroup");
  assert.equal((finalTurn as any)?.tokenEstimate, 137);
  assert.equal((finalTurn as any)?.tier, "trigger");
});

test("splitBuiltContext pops the satellite final turn for a cutoff build", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "compact", tokenEstimate: 1 },
      { type: "satellite", role: "user", content: "<system>summarize state</system>", tier: "trigger", tokenEstimate: 1 },
    ],
    tokenEstimate: 3,
    compactTokens: 1,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;

  const { frozenBase, finalTurn } = splitBuiltContext(built);
  assert.deepEqual(frozenBase.map((m) => (m as any).type), ["chatEvent"]);
  assert.equal((finalTurn as any)?.type, "satellite");
});

// #3: the snapshot prefix and the mapped frozenBase are derived from one boundary,
// so they always cover the same source messages (same terminal-trimming).
test("splitBuiltContext: snapshot prefix and frozenBase share one boundary (trigger present)", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "rich", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>\n\n<message>hi miku</message>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 3,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  } as BuiltContext;

  const { frozenBase, finalTurn, snapshot } = splitBuiltContext(built);

  // The trailing live turn was trimmed from BOTH views.
  assert.equal((finalTurn as any)?.type, "triggerGroup");
  // snapshot keeps the system message (verbatim renderer needs it); frozenBase drops it.
  assert.deepEqual(snapshot.map((m) => m.type), ["system", "chatEvent"]);
  assert.deepEqual(frozenBase.map((m) => (m as any).type), ["chatEvent"]);
  // Same source coverage: snapshot is the raw prefix, frozenBase is that prefix minus
  // the dropped `system` message — exactly one terminal turn trimmed from each.
  assert.equal(snapshot.length, built.messages.length - 1);
  assert.equal(
    snapshot.filter((m) => m.type !== "system").length,
    frozenBase.length,
    "snapshot (minus system) and frozenBase must cover the same source messages",
  );
  // Neither view aliases the builder's array.
  assert.notEqual(snapshot, built.messages);
});

test("splitBuiltContext: snapshot prefix and frozenBase share one boundary (trigger absent)", () => {
  // A build that does NOT end in a triggerGroup/satellite (defensive: should not
  // happen for real builds, but the boundary logic must keep both views in lockstep).
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "rich", tokenEstimate: 1 },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  } as BuiltContext;

  const { frozenBase, finalTurn, snapshot } = splitBuiltContext(built);

  assert.equal(finalTurn, undefined, "no final turn when the build doesn't end in trigger/satellite");
  // Nothing is trimmed from either view.
  assert.deepEqual(snapshot.map((m) => m.type), ["system", "chatEvent"]);
  assert.deepEqual(frozenBase.map((m) => (m as any).type), ["chatEvent"]);
  assert.equal(snapshot.length, built.messages.length);
  assert.equal(snapshot.filter((m) => m.type !== "system").length, frozenBase.length);
  // Snapshot is a fresh copy, not the builder's array.
  assert.notEqual(snapshot, built.messages);
});

// ── #13: pin the REAL factory transformContext closure (production path) ──────

/** A ContextBuilder stub that returns a fixed BuiltContext, so create() exercises
 *  the real freeze/split/transformContext path without touching the timeline DB. */
function stubContextBuilder(built: BuiltContext): ContextBuilder {
  return {
    build: async () => built,
  } as unknown as ContextBuilder;
}

function chatSession(): AgentSessionRecord {
  return {
    id: "s-test",
    timelineKey: "matrix:miku:room:!room",
    sessionType: "default",
    status: "running",
    trigger: {
      provider: "matrix",
      timelineKey: "matrix:miku:room:!room",
      event: testEvent({ id: "trig", body: "hi miku", timestamp: 30 }),
    } as any,
    createdAt: 0,
  };
}

function triggerBuilt(): BuiltContext {
  return {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "rich", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>\n\n<message>hi miku</message>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 3,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  } as BuiltContext;
}

test("factory transformContext: prefix is byte-stable across turns and keeps the trigger exactly once", async () => {
  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });

  const { agent, finalTurn } = await factory.create(chatSession(), []);
  assert.equal((finalTurn as any)?.type, "triggerGroup", "final turn popped off the prefix");

  // Invoke the REAL closure the factory installed on the Agent. pi-agent-core exposes
  // `transformContext` as a public property on the instance, so this is the actual
  // production closure — no test-only seam in production code.
  const transform = agent.transformContext!;

  const assistantTurn: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "web_fetch", input: {} }],
    timestamp: 40,
  } as any;
  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "tool output" }],
    details: {},
    isError: false,
    timestamp: 41,
  } as any;

  // Turn 1: only the kickoff final turn is live.
  const ctx1 = await transform([finalTurn as AgentMessage]);
  // Turn 2: the live array has grown by an assistant tool-call turn + its result.
  const ctx2 = await transform([finalTurn as AgentMessage, assistantTurn, toolResult]);

  // (a) The leading prefix slice is byte-identical across both calls (the #1 regression
  // Phase 0 exists to prevent: prefix-cache invalidation on tool round-trips).
  const prefixLen = ctx1.length - 1; // ctx1 = prefix + finalTurn
  assert.deepEqual(
    ctx2.slice(0, prefixLen),
    ctx1.slice(0, prefixLen),
    "frozen prefix must be byte-identical across successive transformContext calls",
  );
  // Same element identities, not just structural equality (true byte-stable cache prefix).
  for (let i = 0; i < prefixLen; i++) {
    assert.equal(ctx2[i], ctx1[i], `prefix element ${i} must be the same object reference`);
  }

  // (b) finalTurn appears exactly once.
  assert.equal(
    ctx2.filter((m) => (m as any).type === "triggerGroup").length,
    1,
    "triggerGroup (final turn) must appear exactly once",
  );

  // (c) The filter keeps the trigger + a satellite, and drops a stray historical chatEvent.
  const satellite: AgentMessage = { type: "satellite", content: "<system>x</system>", timestamp: 42 } as any;
  const strayHistory: AgentMessage = { type: "chatEvent", role: "user", content: "stray", timestamp: 5 } as any;
  const ctx3 = await transform([strayHistory, finalTurn as AgentMessage, satellite]);
  assert.equal(ctx3.filter((m) => (m as any).content === "stray").length, 0, "stray chatEvent must be dropped");
  assert.equal(ctx3.filter((m) => (m as any).type === "triggerGroup").length, 1, "trigger kept");
  assert.equal(ctx3.filter((m) => (m as any).type === "satellite").length, 1, "satellite kept");
});

// #4: the append-only prefix is frozen at its single point of construction, so any
// future reassignment of an element/the array throws in strict mode.
test("splitBuiltContext freezes the runtime prefix (append-only invariant)", () => {
  const built = triggerBuilt();
  const { frozenBase } = splitBuiltContext(built);
  assert.ok(Object.isFrozen(frozenBase), "frozenBase must be frozen");
  assert.throws(() => {
    (frozenBase as AgentMessage[]).push({ type: "chatEvent", role: "user", content: "x" } as AgentMessage);
  }, "pushing onto the frozen prefix must throw in strict mode");

  // Trigger-absent branch is frozen too.
  const noTrigger: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "rich", tokenEstimate: 1 },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  } as BuiltContext;
  assert.ok(Object.isFrozen(splitBuiltContext(noTrigger).frozenBase));
});

// #4 (resume path): the factory freezes the prefix it seeds from a stored snapshot,
// and the runtime prefix never aliases the caller's persisted snapshot array (#2).
test("factory freezes the resume prefix and does not alias the caller's snapshot", async () => {
  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });

  const resumeSnapshot: AgentMessage[] = [
    { type: "chatEvent", role: "user", content: "<message>prior</message>", timestamp: 1 } as any,
  ];
  const { agent } = await factory.create(chatSession(), [], { resume: { snapshot: resumeSnapshot } });
  const transform = agent.transformContext!;

  // The closure's prefix is frozen: a second call yields the same prior-message bytes.
  const ctx = await transform([]);
  assert.equal(ctx.length, 1);
  assert.equal((ctx[0] as any).content, "<message>prior</message>");

  // Mutating the caller's snapshot afterwards must NOT change the agent's prefix
  // (the factory copied it, so it is not aliased).
  resumeSnapshot.push({ type: "chatEvent", role: "user", content: "injected" } as any);
  const ctx2 = await transform([]);
  assert.equal(ctx2.length, 1, "caller's snapshot mutation must not leak into the runtime prefix");
  assert.equal((ctx2[0] as any).content, "<message>prior</message>");
});

// #2: resume transcript array is defensively copied — the agent loop mutating
// agent.state.messages must not corrupt the caller's persisted transcript array.
test("factory does not alias the caller's resume transcript array", async () => {
  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });

  const transcript: AgentMessage[] = [
    { role: "user", content: "resumed question", timestamp: 1 } as any,
  ];
  const { agent } = await factory.create(chatSession(), [], {
    resume: { snapshot: [], transcript },
  });

  // The agent loop appends to agent.state.messages in place. Simulate one append.
  assert.notEqual(agent.state.messages, transcript, "state.messages must be a copy, not the same array");
  agent.state.messages.push({ role: "assistant", content: [], timestamp: 2 } as any);

  assert.equal(transcript.length, 1, "caller's transcript array must not be mutated");
  assert.equal((transcript[0] as any).content, "resumed question");
});

test("convertToLlm filters accidental system transcript messages", () => {
  const messages = convertToLlm([{ role: "system", content: "duplicate system", timestamp: 1 } as any]);
  assert.deepEqual(messages, []);
});

test("convertToLlm renders historical assistant chat events as assistant messages", () => {
  const messages = convertToLlm([
    {
      type: "chatEvent",
      role: "assistant",
      content: "<message sender=\"Miku\">hello</message>",
      timestamp: 1,
    } as any,
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
});

// ── summarizationCutoff path in ContextBuilder.build() (#5) ──────────

/** Minimal AppConfig sufficient for ContextBuilder.build() without touching real
 *  files, network, or the full schema. Uses cast-to-AppConfig to avoid filling
 *  every optional field. */
function minimalConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
    },
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        multimodal: false,
        max_tokens: 4096,
      },
    },
    context: {
      tiers: {
        rich_target_tokens: 2000,
        rich_max_tokens: 4000,
        compact_target_tokens: 4000,
        compact_max_tokens: 8000,
      },
    },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...overrides,
  } as AppConfig;
}

function testEvent(overrides: {
  id: string;
  body: string;
  timestamp: number;
  role?: "user" | "assistant";
}): CanonicalChatEvent {
  return {
    id: overrides.id,
    timelineKey: "matrix:miku:room:!room",
    provider: "matrix",
    role: overrides.role ?? "user",
    sender: { id: "alice", displayName: "Alice" },
    body: overrides.body,
    timestamp: overrides.timestamp,
    receivedAt: overrides.timestamp,
  };
}

const emptyWorkspace: WorkspaceContent = {
  files: new Map(),
  tailContent: null,
  skills: { listed: [], inlined: [] },
};

test("summarizationCutoff: only events with timestamp <= endTimestamp are included", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "first", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "second", timestamp: 2000 }));
    await timeline.append(testEvent({ id: "ev3", body: "third", timestamp: 3000 }));
    await timeline.append(testEvent({ id: "ev4", body: "fourth", timestamp: 4000 }));

    const trigger = testEvent({ id: "summarize:test", body: "Summarize", timestamp: 2000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 2000 },
    });

    // Only ev1 and ev2 (timestamp <= 2000) should appear as chatEvent messages.
    const chatEvents = result.messages.filter((m) => m.type === "chatEvent");
    const bodies = chatEvents.map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("first")), "ev1 should be included");
    assert.ok(bodies.some((b) => b.includes("second")), "ev2 should be included");
    assert.ok(!bodies.some((b) => b.includes("third")), "ev3 should be excluded (timestamp > cutoff)");
    assert.ok(!bodies.some((b) => b.includes("fourth")), "ev4 should be excluded (timestamp > cutoff)");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: summary layer excludes summaries overlapping the events being summarized", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Insert events spanning 1000–4000.
    for (let i = 1; i <= 4; i++) {
      await timeline.append(testEvent({ id: `ev${i}`, body: `event ${i}`, timestamp: i * 1000 }));
    }

    // Insert a summary covering events up to timestamp 1500 (before the events being summarized).
    await storage.write((db) => {
      db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
         latest_timestamp, latest_event_id, event_count, token_count, model_id,
         status, generated_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sum_old", TK, 1, "old summary", 500, 1500, "ev1", 2, 50, "model", "complete", 0, 0);
    });

    // Insert a summary that overlaps the events being summarized (latestTimestamp = 3500).
    await storage.write((db) => {
      db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
         latest_timestamp, latest_event_id, event_count, token_count, model_id,
         status, generated_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sum_overlap", TK, 1, "overlapping summary", 2000, 3500, "ev3", 2, 50, "model", "complete", 0, 0);
    });

    // Build with cutoff at 4000. The earliest event timestamp is 2000 (first event
    // after the old summary's coverage). The beforeTimestamp filter should exclude
    // sum_overlap (latestTimestamp 3500 > earliest event being summarized).
    const trigger = testEvent({ id: "summarize:test2", body: "Summarize", timestamp: 4000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 4000 },
    });

    const summaryMsg = result.messages.find((m) => m.type === "summaryLayer");
    if (summaryMsg) {
      assert.ok(summaryMsg.content.includes("old summary"), "old summary should be in layer");
      assert.ok(!summaryMsg.content.includes("overlapping summary"), "overlapping summary should be excluded");
    }
    // sum_old is included. The events being summarized (after sum_old's coverage) should render.
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: runtime state is suppressed", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test3", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    // The final user turn (satellite) should NOT contain <runtime_state>.
    const satellite = result.messages.find((m) => m.type === "satellite");
    assert.ok(satellite, "satellite message should exist");
    assert.ok(!satellite!.content.includes("<runtime_state>"), "runtime_state should be suppressed in summarization build");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: image blocks are skipped", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig({
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        multimodal: true,
        max_tokens: 4096,
      },
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test4", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    assert.deepEqual(result.imageBlocks, [], "image blocks should be empty for summarization build");
  } finally {
    storage.close();
  }
});

test("builds never create summarization jobs (job creation moved to SummarizationIndexer)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  // A very low generation threshold: under the OLD lazy design this build would
  // have enqueued a level-1 job; the build path is now read-only w.r.t. jobs.
  const config = minimalConfig({
    summarization: {
      enabled: true,
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 0; i < 20; i++) {
      await timeline.append(testEvent({
        id: `ev${i}`,
        body: `message content that has some words ${i}`,
        timestamp: 1000 + i,
      }));
    }

    // Both a live build and a summarization-cutoff build leave the queue alone.
    const liveTrigger = testEvent({ id: "trigger-ro", body: "hi", timestamp: 2000 });
    await builder.build({
      timelineKey: TK,
      trigger: liveTrigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    const cutoffTrigger = testEvent({ id: "summarize:test5", body: "Summarize", timestamp: 1019 });
    await builder.build({
      timelineKey: TK,
      trigger: cutoffTrigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1019 },
    });

    const jobs = storage.getActiveSummarizationJobs(TK, 1);
    assert.equal(jobs.length, 0, "the build path must not create summarization jobs");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: final message type is 'satellite' not 'triggerGroup'", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test6", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    const lastMsg = result.messages[result.messages.length - 1];
    assert.equal(lastMsg?.type, "satellite", "final message type should be 'satellite' in a summarization build");
    assert.ok(!result.messages.some((m) => m.type === "triggerGroup"), "no triggerGroup message should exist");
  } finally {
    storage.close();
  }
});

// The generation-threshold enqueue tests moved to test/summarization-indexer.test.ts
// (spec C: job creation now lives in SummarizationIndexer, off the build path).

// #8 (concurrency review): Layer-1 is the sole retry authority — the factory pins
// `maxRetries: 0` onto every base stream call so the provider SDK's silent default
// of 2 internal retries (backoff inside the held scheduler slot, 429s invisible to
// the group backoff) is disabled.
test("withSdkRetriesDisabled pins maxRetries: 0 while preserving other stream options (#8)", () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const base = ((_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
    seen.push(options);
    return undefined as never;
  }) as unknown as Parameters<typeof withSdkRetriesDisabled>[0];

  const wrapped = withSdkRetriesDisabled(base);
  const signal = new AbortController().signal;
  wrapped({} as never, {} as never, { signal, temperature: 0.5, maxRetries: 7 } as never);
  // Caller options survive; maxRetries is force-overridden (the SDK default of 2
  // applies whenever the option is left undefined, so it must be pinned, not merged).
  assert.equal(seen[0]?.maxRetries, 0);
  assert.equal(seen[0]?.temperature, 0.5);
  assert.equal(seen[0]?.signal, signal);

  // No options at all still yields the pin.
  wrapped({} as never, {} as never, undefined);
  assert.equal(seen[1]?.maxRetries, 0);
});
