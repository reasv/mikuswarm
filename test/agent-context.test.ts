import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../src/agent/convert.js";
import { AgentSessionFactory, buildAgentContextMessages, splitBuiltContext, withSdkRetriesDisabled } from "../src/agent/factory.js";
import { SessionUsageTracker, type SessionUsageTotals } from "../src/agent/usage.js";
import { estimateObjectTokens } from "../src/context/tokens.js";
import type { UserLimitContext, UserLimitResolution } from "../src/budget/index.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { BuiltContext } from "../src/context/index.js";
import { ContextBuilder, type BuildContextOptions } from "../src/context/builder.js";
import { SessionClaims } from "../src/agent/session-claims.js";
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

// === spec PER-USER-LIMITS §5.3 / review #1 ===================================
// On RESUME the factory builds no context, so the running-input estimate must be
// SEEDED from the resumed baseline (`usage.snapshot().contextTokens`) — otherwise
// the first affordability estimate sees a 0-token context (input_cost ≈ $0), the
// §5.3 output cap is removed, and §5.4 degradation never fires (uncapped overshoot
// on every reply-resume / follow-up-resume / continue-mode recovery).
test("resume seeds the per-user running estimate from the resumed context (#1)", async () => {
  // A fake per-user engine that records every affordability estimate it is asked,
  // and answers UNAFFORDABLE so the first request terminates content-class without
  // ever touching a real provider stream.
  const seenEstimates: Array<{ cachedTokens?: number; newTokens?: number }> = [];
  const resolution = {
    matched: true,
    active: true,
    banned: false,
    models: ["default"],
    constraints: [],
    ledgerPartitionKey: undefined,
  } as unknown as UserLimitResolution;
  const ctx = { userId: "@alice:hs", roomId: "!room:hs" } as UserLimitContext;
  const engine = {
    affordable(_r: unknown, _m: string, estimate: { cachedTokens?: number; newTokens?: number }) {
      seenEstimates.push(estimate);
      return { ok: false, maxOutput: 0, remainingUsd: 0 };
    },
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  } as never;

  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });

  // Continue-mode resume seed: the persisted row's context size (the LAST committed
  // request's totalTokens) — what `usageSeedFromRow` loads. 12_345 ≠ 0 is the signal.
  const seed: SessionUsageTotals = {
    llmRequests: 3,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 12_345,
  };
  const usage = new SessionUsageTracker(seed);

  const resumeSnapshot: AgentMessage[] = [
    { type: "chatEvent", role: "user", content: "<message>prior</message>", timestamp: 1 } as any,
  ];
  const { agent } = await factory.create(chatSession(), [], {
    resume: { snapshot: resumeSnapshot },
    usage,
    userLimit: { engine, resolution, ctx },
  });

  // Drive ONE request: the per-user pre-flight (`checkCostBudget` →
  // `resolveUserSelection`) calls `affordable` with the running-counter estimate, then
  // (unaffordable) terminates the run content-class — no provider stream is reached.
  await agent.prompt({ role: "user", content: "resumed turn", timestamp: 2 } as any);

  // The pre-flight estimate (from `resolveUserSelection`, distinct from the #13
  // defensive `{}` cap computed at create) reflects the RESUMED context, not 0.
  const preflight = seenEstimates.find((e) => (e.newTokens ?? 0) > 0);
  assert.ok(preflight, "the resume pre-flight affordability estimate must carry non-zero new tokens");
  assert.equal(
    (preflight!.cachedTokens ?? 0) + (preflight!.newTokens ?? 0),
    12_345,
    "the seeded running estimate must equal the resumed context size",
  );
});

// === spec PER-USER-LIMITS §4.2 / review #3 ===================================
// An image-bearing session whose entire per-user model set is text-only is a
// TERMINAL per-user content-class deny (the capability filter emptied the set) —
// never a fall-through to the ungated session-type default. Pixel delivery keys off
// the SESSION'S reply model (the session-type `default` block here), so for the deny
// to trigger the reply model must be image-capable (pixels are built ⇒ multimodal
// required) while the per-user preference set has no image-capable member. (A
// text-only reply model would ship no pixels and just caption — no deny.)
test("image session + text-only user model set is a terminal per-user deny, not ungated (#3)", async () => {
  let affordableCalls = 0;
  const resolution = {
    matched: true,
    active: true,
    banned: false,
    models: ["textonly"], // per-user set is text-only, but the reply model (default) is multimodal
    constraints: [],
    ledgerPartitionKey: undefined,
  } as unknown as UserLimitResolution;
  const ctx = { userId: "@alice:hs", roomId: "!room:hs" } as UserLimitContext;
  const engine = {
    affordable() {
      affordableCalls++;
      return { ok: true, maxOutput: 4096, remainingUsd: Infinity };
    },
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  } as never;

  const factory = new AgentSessionFactory({
    config: minimalConfig({
      app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
      // The reply model (session-type `default`) is image-capable → pixels are built →
      // multimodal required; the per-user set points at a separate TEXT-ONLY model.
      models: {
        default: {
          id: "vision-model", provider: "test", endpoint: "http://localhost", api_key: "key",
          input_modalities: ["text", "image"], max_tokens: 4096, context_window: 128_000,
        },
        textonly: {
          id: "text-model", provider: "test", endpoint: "http://localhost", api_key: "key",
          input_modalities: ["text"], max_tokens: 4096, context_window: 128_000,
        },
      },
    } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });

  // A session whose trigger carries an image attachment → requiresMultimodal.
  const session = chatSession();
  (session.trigger as any).event = {
    ...(session.trigger as any).event,
    attachments: [{ mediaType: "image", localPath: "/m/pic.png" }],
  };

  const { agent } = await factory.create(session, [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "<message>p</message>", timestamp: 1 } as any] },
    usage: new SessionUsageTracker(),
    userLimit: { engine, resolution, ctx },
  });

  await agent.prompt({ role: "user", content: "look at this", timestamp: 2 } as any);

  // The run terminated with the capability-deny terminal — never an ungated request.
  assert.match(
    agent.state.errorMessage ?? "",
    /capability mismatch/,
    "an image trigger against a text-only model set must terminate as a per-user capability deny",
  );
  // The deny is structural — it never reaches the affordability selector.
  assert.equal(affordableCalls, 0, "no per-user affordability selection happens on the capability-deny path");
});

// === spec PER-USER-LIMITS §5.3 / review #10 ==================================
// The running input counter must tokenize only the slice the wire context carries
// (`isLiveRuntimeMessage`-filtered, mirroring `transformContext`) — a stray
// historical `chatEvent` is dropped on the wire, so it must not inflate the
// estimate (a conservative over-count, but an exactness drift).
test("running counter ignores wire-dropped chatEvents (#10)", async () => {
  const seenEstimates: Array<{ cachedTokens?: number; newTokens?: number }> = [];
  const resolution = {
    matched: true,
    active: true,
    banned: false,
    models: ["default"],
    constraints: [],
    ledgerPartitionKey: undefined,
  } as unknown as UserLimitResolution;
  const ctx = { userId: "@alice:hs", roomId: "!room:hs" } as UserLimitContext;
  const engine = {
    affordable(_r: unknown, _m: string, estimate: { cachedTokens?: number; newTokens?: number }) {
      seenEstimates.push(estimate);
      return { ok: false, maxOutput: 0, remainingUsd: 0 };
    },
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  } as never;

  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });
  // Seed a known resumed baseline so the first observation fixes `running` and
  // `seenMsgs`; subsequent refreshes tokenize only the FILTERED delta.
  const seed: SessionUsageTotals = {
    llmRequests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 1_000,
  };
  const { agent } = await factory.create(chatSession(), [], {
    resume: { snapshot: [] },
    usage: new SessionUsageTracker(seed),
    userLimit: { engine, resolution, ctx },
  });

  // Request 1: first observation seeds running=1000, seenMsgs=state.length. Terminates
  // unaffordable (no provider stream reached).
  await agent.prompt({ role: "user", content: "first", timestamp: 2 } as any);
  const afterFirst = seenEstimates.length;

  // Append a HUGE wire-DROPPED stray chatEvent. `transformContext` filters it out of the
  // wire context, so the running counter must too — its tokens must NOT enter the
  // estimate. A large body makes the contrast unambiguous: counted ⇒ the estimate
  // balloons by ~10k+ tokens; filtered ⇒ it stays near the 1000 baseline.
  const hugeBody = "lorem ipsum ".repeat(5_000); // ~10k words → ~10k+ tokens
  const hugeChatEventTokens = estimateObjectTokens(
    convertToLlm([{ type: "chatEvent", role: "user", content: `<message>${hugeBody}</message>`, timestamp: 3 } as any]),
  );
  assert.ok(hugeChatEventTokens > 5_000, "the stray chatEvent is large enough to dominate if counted");
  agent.state.messages.push({
    type: "chatEvent",
    role: "user",
    content: `<message>${hugeBody}</message>`,
    timestamp: 3,
  } as any);

  await agent.prompt({ role: "user", content: "second", timestamp: 5 } as any);
  assert.ok(seenEstimates.length > afterFirst, "the second request re-ran the pre-flight");
  const preflight2 = seenEstimates[seenEstimates.length - 1];
  const observed2 = (preflight2!.cachedTokens ?? 0) + (preflight2!.newTokens ?? 0);

  // The wire-dropped chatEvent contributed nothing: the running estimate is far below
  // `baseline + hugeChatEventTokens` (it would be ≥ that if the filter were missing).
  assert.ok(
    observed2 < 1_000 + hugeChatEventTokens,
    `running counter must exclude wire-dropped chatEvents (observed ${observed2}, ` +
      `would be ≥ ${1_000 + hugeChatEventTokens} if counted)`,
  );
});

// === spec PER-USER-LIMITS §6.2 / review #13 ==================================
// The initial per-user `activeSelection` must carry a DEFENSIVE `maxTokens` cap,
// computed at create from the first selectable's affordable output at a ≈0 prior-
// context estimate (mirroring Gate A). If the per-request pre-flight ever throws
// (and `withRequestRetry` swallows it), request 1 still ships with this cap rather
// than uncapped — the most-expensive request must never be ungated.
test("per-user initial selection is seeded with a defensive output cap (#13)", async () => {
  const estimatesAtCreate: Array<{ cachedTokens?: number; newTokens?: number } | undefined> = [];
  let calls = 0;
  const resolution = {
    matched: true,
    active: true,
    banned: false,
    models: ["default"],
    constraints: [],
    ledgerPartitionKey: undefined,
  } as unknown as UserLimitResolution;
  const ctx = { userId: "@alice:hs", roomId: "!room:hs" } as UserLimitContext;
  const engine = {
    affordable(_r: unknown, _m: string, estimate: { cachedTokens?: number; newTokens?: number }) {
      calls++;
      // The FIRST call is the create-time defensive cap (estimate is the empty `{}`).
      if (calls === 1) estimatesAtCreate.push(estimate);
      return { ok: true, maxOutput: 1234, remainingUsd: Infinity };
    },
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  } as never;

  const factory = new AgentSessionFactory({
    config: minimalConfig({ app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" } } as any),
    contextBuilder: stubContextBuilder(triggerBuilt()),
    getActiveSessions: () => [],
  });
  // `create` alone must compute the defensive cap (an `affordable` call with the empty
  // estimate) — no request issued. This is the seam #13 fixes: previously the initial
  // `activeSelection` carried no `maxTokens`.
  await factory.create(chatSession(), [], {
    resume: { snapshot: [] },
    usage: new SessionUsageTracker(),
    userLimit: { engine, resolution, ctx },
  });

  assert.ok(calls >= 1, "create computed the defensive initial cap via affordable()");
  const createEstimate = estimatesAtCreate[0]!;
  // The defensive cap is computed at ≈0 prior context (mirroring Gate A's `{}`).
  assert.ok(
    (createEstimate.newTokens ?? 0) === 0 && (createEstimate.cachedTokens ?? 0) === 0,
    "the defensive initial cap uses a zero-context estimate",
  );
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
        input_modalities: ["text"],
        max_tokens: 4096,
        // context_window is the always-on enforcement base and is required for
        // any model a session type resolves to (spec CONTEXT-LIMIT-UNIFICATION
        // §2.5); factory.create() resolves the session ceiling from it.
        context_window: 128_000,
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

test("live builds wrap the summary layer in the expand_summary envelope; generation builds stay bare", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 1; i <= 4; i++) {
      await timeline.append(testEvent({ id: `ev${i}`, body: `event ${i}`, timestamp: i * 1000 }));
    }
    // A summary covering the oldest history (up to ev1 / ts 1500).
    await storage.write((db) => {
      db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
         latest_timestamp, latest_event_id, event_count, token_count, model_id,
         status, generated_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sum_old", TK, 1, "old history", 500, 1500, "ev1", 2, 50, "model", "complete", 0, 0);
    });

    // Live build (no cutoff / diaryRange / condenseInputs): envelope present.
    const trigger = testEvent({ id: "ev5", body: "live trigger", timestamp: 5000 });
    await timeline.append(trigger);
    const live = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    const liveLayer = live.messages.find((m) => m.type === "summaryLayer");
    assert.ok(liveLayer, "live build renders a summary layer");
    assert.ok(liveLayer!.content.includes("<conversation_summary"), "live summary layer is wrapped in the envelope");
    assert.ok(liveLayer!.content.includes("expand_summary"), "envelope note names expand_summary");
    assert.ok(liveLayer!.content.includes("<summary"), "inner summary blocks are still present");
    assert.ok(liveLayer!.content.includes("old history"), "summary content is rendered");

    // Generation build (cutoff): bare — the worker consumes summaries as input.
    const sTrigger = testEvent({ id: "summarize:env", body: "Summarize", timestamp: 4000 });
    const gen = await builder.build({
      timelineKey: TK,
      trigger: sTrigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 4000 },
    });
    const genLayer = gen.messages.find((m) => m.type === "summaryLayer");
    assert.ok(genLayer, "generation build renders a summary layer");
    assert.ok(!genLayer!.content.includes("<conversation_summary"), "generation build leaves the summary layer bare");
    assert.ok(genLayer!.content.includes("<summary"), "bare summary blocks still present");
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
        input_modalities: ["text", "image"],
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

// ── diaryRange path in ContextBuilder.build() (spec DIARY-CONTEXT-PARITY) ──────

/** Insert a complete level-1 summary row directly (the tests above use the same SQL). */
async function insertSummaryRow(
  storage: Storage,
  opts: { id: string; earliest: number; latest: number; latestEventId: string; content?: string },
): Promise<void> {
  await storage.write((db) => {
    db.prepare(
      `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
       latest_timestamp, latest_event_id, event_count, token_count, model_id,
       status, generated_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      "matrix:miku:room:!room",
      1,
      opts.content ?? `content of ${opts.id}`,
      opts.earliest,
      opts.latest,
      opts.latestEventId,
      2,
      50,
      "model",
      "complete",
      0,
      0,
    );
  });
}

// The spec's §1 made executable: a diary-range build over a state where the
// range's own summary EXISTS must be message-for-message identical to the
// summarize-cutoff build that produced that summary (built before it existed) —
// same system prompt, same summary layer (prior chunks only), same raw range
// turns, same satellite final turn.
test("diaryRange parity: identical to the summarize-cutoff build over the same range", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Prior chunk e1–e2 (summarized), work range e3–e4.
    for (let i = 1; i <= 4; i++) {
      await timeline.append(testEvent({ id: `ev${i}`, body: `event ${i}`, timestamp: i * 1000 }));
    }
    await insertSummaryRow(storage, { id: "sum_prev", earliest: 1000, latest: 2000, latestEventId: "ev2" });

    // The summarize build for the range, in the state the summarize session saw
    // it (the range's own summary does not exist yet).
    const cutoffBuild = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "summarize:range", body: "Summarize", timestamp: 4000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 4000 },
    });

    // The range's summary lands (the diary trigger state); later events arrive too.
    await insertSummaryRow(storage, { id: "sum_range", earliest: 3000, latest: 4000, latestEventId: "ev4" });
    await timeline.append(testEvent({ id: "ev5", body: "event 5 after the range", timestamp: 5000 }));

    const diaryBuild = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:sum_range", body: "Write your diary entry.", timestamp: 4000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      diaryRange: { earliestTimestamp: 3000, latestTimestamp: 4000, summaryId: "sum_range" },
    });

    // Full parity: same trigger timestamp + same workspace/sessionType → the
    // message arrays are identical (the satellite content only differs when the
    // session types differ).
    assert.deepEqual(diaryBuild.messages, cutoffBuild.messages);

    // Shape sanity: prior summary in the layer, range raw, own summary excluded,
    // post-range event cut, satellite last.
    const layer = diaryBuild.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "prior chunk's summary forms the layer");
    assert.match(layer!.content, /content of sum_prev/);
    assert.ok(!layer!.content.includes("content of sum_range"), "the range's own summary is excluded");
    const bodies = diaryBuild.messages.filter((m) => m.type === "chatEvent").map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("event 3")) && bodies.some((b) => b.includes("event 4")));
    assert.ok(!bodies.some((b) => b.includes("event 1")), "covered events stay in the layer");
    assert.ok(!bodies.some((b) => b.includes("event 5")), "events past the range end are cut");
    assert.equal(diaryBuild.messages[diaryBuild.messages.length - 1]?.type, "satellite");
    assert.ok(!diaryBuild.messages.some((m) => m.type === "diaryLayer"), "no recent-diary layer in the prefix");
  } finally {
    storage.close();
  }
});

test("diaryRange: satellite omits the session_instruction template; cutoff keeps it", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));
    await insertSummaryRow(storage, { id: "sum_range", earliest: 1000, latest: 1000, latestEventId: "ev1" });
    const sessionType = { session_instruction: "TEMPLATE {{header}}" } as any;

    const diaryBuild = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:x", body: "Write your diary entry.", timestamp: 1000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      sessionType,
      diaryRange: { earliestTimestamp: 1000, latestTimestamp: 1000, summaryId: "sum_range" },
    });
    const diarySatellite = diaryBuild.messages[diaryBuild.messages.length - 1]!;
    assert.equal(diarySatellite.type, "satellite");
    assert.ok(
      !diarySatellite.content.includes("TEMPLATE"),
      "the per-job instruction template is delivered substituted in the kickoff, not raw in the satellite",
    );

    const cutoffBuild = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "summarize:x", body: "Summarize", timestamp: 1000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      sessionType,
      summarizationCutoff: { endTimestamp: 1000 },
    });
    const cutoffSatellite = cutoffBuild.messages[cutoffBuild.messages.length - 1]!;
    assert.match(cutoffSatellite.content, /TEMPLATE/, "the cutoff satellite renders the session instruction as before");
  } finally {
    storage.close();
  }
});

test("diaryRange: single-event range whose own summary sits exactly on the bound is still excluded", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "earlier message", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "the single range event", timestamp: 2000 }));
    await insertSummaryRow(storage, { id: "sum_prev", earliest: 1000, latest: 1000, latestEventId: "ev1" });
    // Single-event range: earliest == latest == 2000 — the inclusive
    // beforeTimestamp bound alone would admit the range's own summary.
    await insertSummaryRow(storage, { id: "sum_range", earliest: 2000, latest: 2000, latestEventId: "ev2" });

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:1", body: "Write your diary entry.", timestamp: 2000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      diaryRange: { earliestTimestamp: 2000, latestTimestamp: 2000, summaryId: "sum_range" },
    });

    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "prior summary still renders");
    assert.match(layer!.content, /content of sum_prev/);
    assert.ok(!layer!.content.includes("content of sum_range"), "own summary excluded despite the inclusive bound");
    const bodies = built.messages.filter((m) => m.type === "chatEvent").map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("the single range event")), "range event renders raw");
  } finally {
    storage.close();
  }
});

test("diaryRange: a prior chunk's summary sharing a millisecond boundary with the range start is kept", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Matrix batch send: the prior chunk's last event and the range's first
    // event share timestamp 2000.
    await timeline.append(testEvent({ id: "ev1", body: "prior chunk start", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "prior chunk end", timestamp: 2000 }));
    await timeline.append(testEvent({ id: "ev3", body: "range start collision", timestamp: 2000 }));
    await timeline.append(testEvent({ id: "ev4", body: "range end", timestamp: 3000 }));
    await insertSummaryRow(storage, { id: "sum_prev", earliest: 1000, latest: 2000, latestEventId: "ev2" });
    await insertSummaryRow(storage, { id: "sum_range", earliest: 2000, latest: 3000, latestEventId: "ev4" });

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:1", body: "Write your diary entry.", timestamp: 3000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      diaryRange: { earliestTimestamp: 2000, latestTimestamp: 3000, summaryId: "sum_range" },
    });

    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "millisecond-boundary prior summary still forms the layer");
    assert.match(layer!.content, /content of sum_prev/);
    assert.ok(!layer!.content.includes("content of sum_range"));
    const bodies = built.messages.filter((m) => m.type === "chatEvent").map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("range start collision")), "the range's collision event renders raw");
    assert.ok(bodies.some((b) => b.includes("range end")));
    assert.ok(!bodies.some((b) => b.includes("prior chunk start")), "covered events stay in the layer");
  } finally {
    storage.close();
  }
});

test("diaryRange: range at the very start of a timeline renders a raw-only prefix (no summary layer)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "first ever", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "second ever", timestamp: 2000 }));
    await insertSummaryRow(storage, { id: "sum_range", earliest: 1000, latest: 2000, latestEventId: "ev2" });

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:1", body: "Write your diary entry.", timestamp: 2000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      diaryRange: { earliestTimestamp: 1000, latestTimestamp: 2000, summaryId: "sum_range" },
    });

    assert.ok(!built.messages.some((m) => m.type === "summaryLayer"), "no prior summaries → no layer");
    const bodies = built.messages.filter((m) => m.type === "chatEvent").map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("first ever")) && bodies.some((b) => b.includes("second ever")));
    assert.equal(built.messages[built.messages.length - 1]?.type, "satellite");
  } finally {
    storage.close();
  }
});

test("diaryRange: uncovered pre-range events ride along as raw turns", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // ev0 was never summarized (no coverage); the range is ev1–ev2.
    await timeline.append(testEvent({ id: "ev0", body: "uncovered straggler", timestamp: 500 }));
    await timeline.append(testEvent({ id: "ev1", body: "range first", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "range last", timestamp: 2000 }));
    await insertSummaryRow(storage, { id: "sum_range", earliest: 1000, latest: 2000, latestEventId: "ev2" });

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "diary:1", body: "Write your diary entry.", timestamp: 2000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      diaryRange: { earliestTimestamp: 1000, latestTimestamp: 2000, summaryId: "sum_range" },
    });

    const bodies = built.messages.filter((m) => m.type === "chatEvent").map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("uncovered straggler")), "pre-range raw events render (benign continuity)");
    assert.ok(bodies.some((b) => b.includes("range first")) && bodies.some((b) => b.includes("range last")));
  } finally {
    storage.close();
  }
});

test("diaryRange and summarizationCutoff are mutually exclusive", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  try {
    await assert.rejects(
      builder.build({
        timelineKey: "matrix:miku:room:!room",
        trigger: testEvent({ id: "x", body: "x", timestamp: 1000 }),
        activeSessions: [],
        workspace: emptyWorkspace,
        summarizationCutoff: { endTimestamp: 1000 },
        diaryRange: { earliestTimestamp: 0, latestTimestamp: 1000, summaryId: "s" },
      }),
      /mutually exclusive/,
    );
  } finally {
    storage.close();
  }
});

// ── condenseInputs path in ContextBuilder.build() (spec SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1) ──

/** Insert a summary row directly (test helper for the condense input-addressed path). */
function insertLeveledSummaryRow(
  storage: Storage,
  s: {
    id: string;
    level: number;
    earliest: number;
    latest: number;
    content?: string;
    status?: string;
    latestEventId?: string;
  },
): Promise<void> {
  return storage.write((db) => {
    db.prepare(
      `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
        latest_timestamp, latest_event_id, event_count, token_count, model_id,
        status, generated_at, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      "matrix:miku:room:!room",
      s.level,
      s.content ?? `content of ${s.id}`,
      s.earliest,
      s.latest,
      s.latestEventId ?? `ev_${s.id}`,
      2,
      50,
      "model",
      s.status ?? "complete",
      0,
      0,
    );
  });
}

test("condenseInputs: renders exactly the declared child summaries, no raw events, no coverage selection", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Five level-1 summaries — the declared condense inputs.
    for (let i = 0; i < 5; i++) {
      await insertLeveledSummaryRow(storage, { id: `l1_${i}`, level: 1, earliest: i * 100, latest: i * 100 + 50 });
    }
    // A DUPLICATE covering level-2 summary over the same span (the field-case
    // hazard): greedy coverage selection would prefer it. condenseInputs must
    // ignore it entirely.
    await insertLeveledSummaryRow(storage, { id: "l2_dup", level: 2, earliest: 0, latest: 450 });
    // Raw timeline events in the same span — condense must not read them.
    await timeline.append(testEvent({ id: "ev_a", body: "raw a", timestamp: 100 }));
    await timeline.append(testEvent({ id: "ev_b", body: "raw b", timestamp: 200 }));

    const children = storage.getSummariesByLevel(TK, 1);
    assert.equal(children.length, 5);

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "condense:test", body: "condense", timestamp: 450 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      condenseInputs: { summaries: children },
    });

    const summaryLayer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(summaryLayer, "a summary layer is rendered");
    for (const id of ["l1_0", "l1_1", "l1_2", "l1_3", "l1_4"]) {
      assert.ok(summaryLayer!.content.includes(id), `summary layer includes declared child ${id}`);
    }
    assert.ok(!summaryLayer!.content.includes("l2_dup"), "the duplicate covering L2 is NOT selected");
    // No raw events rendered.
    assert.equal(built.messages.filter((m) => m.type === "chatEvent").length, 0, "condense renders no raw events");
    assert.ok(!JSON.stringify(built.messages).includes("raw a"), "raw timeline events are not read");
    // Final turn is the satellite, not a trigger group.
    assert.equal(built.messages[built.messages.length - 1]!.type, "satellite");
    storage.close();
  } catch (e) {
    storage.close();
    throw e;
  }
});

test("condenseInputs: renderedInputIds equals the declared parent IDs in order", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 0; i < 3; i++) {
      await insertLeveledSummaryRow(storage, { id: `l1_${i}`, level: 1, earliest: i * 100, latest: i * 100 + 50 });
    }
    const children = storage.getSummariesByLevel(TK, 1);
    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "condense:test", body: "condense", timestamp: 250 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      condenseInputs: { summaries: children },
    });
    assert.deepEqual(built.renderedInputIds, ["l1_0", "l1_1", "l1_2"]);
    storage.close();
  } catch (e) {
    storage.close();
    throw e;
  }
});

test("summarizationCutoff: renderedInputIds equals the rendered raw-event IDs (level-1 integrity surface)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "first", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "second", timestamp: 2000 }));
    await timeline.append(testEvent({ id: "ev3", body: "third", timestamp: 3000 }));

    const built = await builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "summarize:test", body: "summarize", timestamp: 2000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 2000 },
    });
    // Only ev1, ev2 are <= cutoff and rendered as to-summarize material.
    assert.deepEqual(built.renderedInputIds, ["ev1", "ev2"]);
    storage.close();
  } catch (e) {
    storage.close();
    throw e;
  }
});

test("condenseInputs and summarizationCutoff are mutually exclusive", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  try {
    await assert.rejects(
      builder.build({
        timelineKey: "matrix:miku:room:!room",
        trigger: testEvent({ id: "x", body: "x", timestamp: 1000 }),
        activeSessions: [],
        workspace: emptyWorkspace,
        summarizationCutoff: { endTimestamp: 1000 },
        condenseInputs: { summaries: [] },
      }),
      /mutually exclusive/,
    );
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
test("live build marks a claimed in-context message and emits the coordination line (DUPLICATE-REPLY-MITIGATION §4)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const claims = new SessionClaims();
  const TK = "matrix:miku:room:!room";
  try {
    // A recent in-context message ($claimed) and the building session's own trigger.
    await timeline.append({
      ...testEvent({ id: "ev-claimed", body: "> plagueis", timestamp: 1000 }),
      externalId: "$claimed",
    });
    const trigger = { ...testEvent({ id: "ev-trigger", body: "hey miku", timestamp: 2000 }), externalId: "$trigger" };
    await timeline.append(trigger);

    // Another running session ($claimed's owner) and self both active.
    claims.claim(TK, { triggerId: "ev-claimed", externalId: "$claimed", triggerTimestamp: 1000, createdAt: 1000 });
    claims.attachSession(TK, "$claimed", "s-other");

    const builder = new ContextBuilder(timeline, config, storage, undefined, undefined, claims);
    const activeSessions = [
      { id: "s-self", createdAt: 2000, timelineKey: TK, sessionType: "default", status: "running", trigger: { timelineKey: TK, provider: "matrix", event: trigger } },
      { id: "s-other", createdAt: 1000, timelineKey: TK, sessionType: "default", status: "running", trigger: { timelineKey: TK, provider: "matrix", event: { ...testEvent({ id: "ev-claimed", body: "> plagueis", timestamp: 1000 }), externalId: "$claimed" } } },
    ] as unknown as BuildContextOptions["activeSessions"];

    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions,
      selfSessionId: "s-self",
      workspace: emptyWorkspace,
    });

    // The claimed (non-trigger) message renders rich with the marker.
    const chatEvents = built.messages.filter((m) => m.type === "chatEvent");
    const marked = chatEvents.some((m) => m.content.includes('<handled_by_session id="s-other"/>'));
    assert.ok(marked, "claimed in-context message should carry the <handled_by_session> marker");

    // The final user turn carries the code-owned coordination line (≥1 other session).
    const finalTurn = built.messages[built.messages.length - 1];
    assert.ok(finalTurn.content.includes("<coordination>"), "coordination line should be emitted");

    // The session never marks its OWN trigger as handled-by-another.
    assert.ok(
      !built.messages.some((m) => m.content.includes('<handled_by_session id="s-self"')),
      "self-claims must never be marked",
    );
  } finally {
    storage.close();
  }
});

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
