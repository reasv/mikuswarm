import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/index.js";
import { loadCompletedSessionMaterial } from "../src/agent/index.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";
import { MatrixProvider, type MatrixProviderOptions } from "../src/matrix/provider.js";
import { normalizeMatrixInboundEvent } from "../src/matrix/inbound.js";
import type { MatrixInboundEvent } from "../src/matrix/native-types.js";
import type { AppConfig } from "../src/config/index.js";
import type { AgentSessionRow } from "../src/storage/index.js";
import type { CanonicalChatEvent, InboundChatEvent, TriggerInfo } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

const TK = "matrix:miku:room:!room";

function minimalConfig(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: { id: "test-model", provider: "test", endpoint: "http://localhost", api_key: "key", multimodal: false, max_tokens: 4096 },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}

function ev(id: string, body: string, ts: number, role: "user" | "assistant" = "user"): CanonicalChatEvent {
  return {
    id,
    externalId: id,
    timelineKey: TK,
    provider: "matrix",
    role,
    sender: {
      id: role === "assistant" ? "@miku:server" : "alice",
      displayName: role === "assistant" ? "Miku" : "Alice",
      isSelf: role === "assistant",
    },
    body,
    timestamp: ts,
    receivedAt: ts,
  };
}

const tailWorkspace: WorkspaceContent = {
  files: new Map(),
  tailContent: "STAY-IN-CHARACTER-TAIL",
  skills: { listed: [], inlined: [] },
};

// ── §6 single-consumption: acceptResumeGeneration CAS ────────────────────────

test("acceptResumeGeneration flips completed→resuming and bumps the generation once", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = 1000;
    await storage.insertAgentSession({
      id: "s1", timelineKey: TK, sessionType: "default", status: "created", createdAt: now, updatedAt: now,
    });
    await storage.updateAgentSessionStatus("s1", "completed", { completedAt: now });
    assert.equal(storage.getAgentSession("s1")?.resume_generation, 0, "starts at generation 0");

    const gen = await storage.acceptResumeGeneration("s1");
    assert.equal(gen, 1, "first accept returns the bumped generation");
    assert.equal(storage.getAgentSession("s1")?.status, "resuming");
    assert.equal(storage.getAgentSession("s1")?.resume_generation, 1);

    // A racing second accept (now `resuming`, not `completed`) → undefined (no double-consume).
    const again = await storage.acceptResumeGeneration("s1");
    assert.equal(again, undefined, "second accept of a non-completed row consumes nothing");
    assert.equal(storage.getAgentSession("s1")?.resume_generation, 1, "generation unchanged by the failed CAS");
  } finally {
    storage.close();
  }
});

test("acceptResumeGeneration on an unknown row returns undefined", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    assert.equal(await storage.acceptResumeGeneration("nope"), undefined);
  } finally {
    storage.close();
  }
});

// ── §6 generation tagging round-trips and survives the echo-enrich UPDATE ─────

test("agent_session_generation tags an outbound event and survives echo reconciliation", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  try {
    // The send tool's append: a synthetic assistant event tagged with the session's generation.
    const sent: CanonicalChatEvent = {
      ...ev("$matrixId", "hello from the bot", 5000, "assistant"),
      id: "assistant:s1:$matrixId:0",
      externalId: "$matrixId",
      agentSessionId: "s1",
      agentSessionGeneration: 2,
    };
    await timeline.append(sent);

    const got = timeline.getByExternalId("matrix", "$matrixId", TK);
    assert.equal(got?.agentSessionGeneration, 2, "generation round-trips in event_json");
    assert.equal(got?.agentSessionId, "s1");

    // The Matrix echo of the same message carries no session attribution; ingesting
    // it must NOT wipe the generation (it enriches the existing row in place).
    const echo = ev("matrix:miku:$matrixId", "hello from the bot", 5001, "assistant");
    echo.externalId = "$matrixId";
    await timeline.ingestAssistantEcho(echo);

    const afterEcho = timeline.getByExternalId("matrix", "$matrixId", TK);
    assert.equal(afterEcho?.agentSessionGeneration, 2, "generation survives the echo-enrich UPDATE");
    assert.equal(afterEcho?.agentSessionId, "s1", "session attribution also survives");
  } finally {
    storage.close();
  }
});

// ── §9.2 gap lower bound: chat_upper_bound_ts round-trips and advances ────────

test("chat_upper_bound_ts round-trips through insert and advances on resume (gap lower bound)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = 1000;
    // Set at creation = the original trigger group's latest member (its trigger ts).
    await storage.insertAgentSession({
      id: "s1", timelineKey: TK, sessionType: "default", status: "created",
      chatUpperBoundTs: 4000, createdAt: now, updatedAt: now,
    });
    assert.equal(
      storage.getAgentSession("s1")?.chat_upper_bound_ts, 4000,
      "creation persists the trigger group's latest-member timestamp as the bound",
    );

    // Each accepted resume advances the bound to its own trigger's timestamp, so the
    // NEXT resume's gap window starts where this one ended.
    await storage.setSessionChatUpperBound("s1", 9000);
    assert.equal(storage.getAgentSession("s1")?.chat_upper_bound_ts, 9000, "resume advances the bound");

    // A row created without the field (e.g. a path that omits it) reads NULL — the
    // legacy pre-v27 shape the read site falls back from.
    await storage.insertAgentSession({
      id: "s2", timelineKey: TK, sessionType: "default", status: "created", createdAt: now, updatedAt: now,
    });
    assert.equal(storage.getAgentSession("s2")?.chat_upper_bound_ts, null, "omitted bound stores NULL");
  } finally {
    storage.close();
  }
});

// ── §7 loadCompletedSessionMaterial: full transcript, no failed-tail strip ────

test("loadCompletedSessionMaterial keeps the full transcript and drops the system block", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const snapshot = [
      { type: "system", role: "system", content: "sys", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "earlier history", tokenEstimate: 2 },
    ];
    const transcript = [
      { type: "triggerGroup", content: "the original request" },
      { role: "assistant", content: [{ type: "text", text: "the answer" }], stopReason: "stop" },
    ];
    const row = {
      id: "s1",
      context_snapshot_json: JSON.stringify(snapshot),
      transcript_json: JSON.stringify(transcript),
    } as AgentSessionRow;

    const material = await loadCompletedSessionMaterial(row, {
      media: { getMediaAssetById: () => undefined },
      workspaceRoot: "/tmp",
    });
    assert.ok(material, "completed material loads");
    // System block dropped by mapBuiltMessages; the clean trailing assistant turn
    // is KEPT (unlike failure-recovery, which strips/ requires an un-answered tail).
    assert.equal(material!.snapshot.length, 1, "system block dropped from the projected prefix");
    assert.equal(material!.transcript.length, 2, "full transcript retained (assistant turn not stripped)");
    assert.equal((material!.transcript[1] as { role?: string }).role, "assistant");
  } finally {
    storage.close();
  }
});

test("loadCompletedSessionMaterial returns null when snapshot or transcript is missing", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const deps = { media: { getMediaAssetById: () => undefined }, workspaceRoot: "/tmp" };
    assert.equal(
      await loadCompletedSessionMaterial({ id: "s", transcript_json: "[]", context_snapshot_json: null } as AgentSessionRow, deps),
      null,
    );
    assert.equal(
      await loadCompletedSessionMaterial({ id: "s", transcript_json: null, context_snapshot_json: "[]" } as AgentSessionRow, deps),
      null,
    );
  } finally {
    storage.close();
  }
});

// ── §9/§11 buildResumeTurn: satellite re-render + gap backfill ────────────────

interface ResumeTurnShape {
  type: string;
  content: string;
  imageBlocks?: unknown[];
}

test("buildResumeTurn: fresh satellite with runtime_state + tail + browser note, no retrieved_memory", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    const trigger = ev("reply1", "where is that image you made?", 4000);
    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      browserNote: "BROWSER-TAB-CLOSED-NOTE",
    })) as unknown as ResumeTurnShape;

    assert.equal(turn.type, "triggerGroup", "appended turn is a triggerGroup (a real-user-turn boundary)");
    assert.ok(turn.content.includes("<runtime_state>"), "runtime_state always re-rendered on resume");
    assert.ok(turn.content.includes("Current time:"), "runtime_state carries the current time");
    assert.ok(turn.content.includes("STAY-IN-CHARACTER-TAIL"), "tail kept when the toggle is on");
    assert.ok(turn.content.includes("BROWSER-TAB-CLOSED-NOTE"), "browser note rides in runtime_state");
    assert.ok(turn.content.includes("where is that image you made?"), "the trigger (request) is included");
    assert.ok(!turn.content.includes("<retrieved_memory"), "retrieved_memory never rendered on resume");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("buildResumeTurn: tail toggle off omits the tail instructions", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger: ev("reply1", "follow up", 4000),
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: false,
    })) as unknown as ResumeTurnShape;
    assert.ok(turn.content.includes("<runtime_state>"), "runtime_state still present");
    assert.ok(!turn.content.includes("STAY-IN-CHARACTER-TAIL"), "tail omitted when the toggle is off");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("buildResumeTurn: gap surfaces missed messages newest-first with a truncation marker, excluding trigger members", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    // The session's last send is at t=1000 (lower bound). Three human messages
    // arrived while away (2000, 3000, 3500), then the reply triggers at 4000.
    await timeline.append(ev("bot-last", "here you go", 1000, "assistant"));
    await timeline.append(ev("gap1", "missed one", 2000));
    await timeline.append(ev("gap2", "missed two", 3000));
    await timeline.append(ev("gap3", "missed three", 3500));
    const trigger = ev("reply1", "thanks, follow-up", 4000);

    // Budget of 2 messages → newest two kept (gap3, gap2), oldest (gap1) truncated.
    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      gap: { maxMessages: 2, maxTokens: 100000, lowerBoundTimestamp: 1000 },
    })) as unknown as ResumeTurnShape;

    assert.ok(turn.content.includes("messages_while_you_were_away"), "gap block present");
    assert.ok(turn.content.includes("missed three") && turn.content.includes("missed two"), "newest two kept");
    assert.ok(!turn.content.includes("missed one"), "oldest truncated by the message budget");
    assert.ok(turn.content.includes("here you go") === false, "the session's own prior send (lower bound) is excluded");
    assert.ok(/earlier_messages_omitted count="1"/.test(turn.content), "truncation marker reports the omitted count");
    // Contiguity: kept run is chronological (older kept before newer).
    assert.ok(
      turn.content.indexOf("missed two") < turn.content.indexOf("missed three"),
      "kept gap is rendered oldest→newest",
    );
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("buildResumeTurn: gap omitted entirely when budget is off (default)", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    await timeline.append(ev("gap1", "while away", 2000));
    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger: ev("reply1", "hi again", 4000),
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      gap: { maxMessages: 0, maxTokens: 0, lowerBoundTimestamp: 1000 },
    })) as unknown as ResumeTurnShape;
    assert.ok(!turn.content.includes("messages_while_you_were_away"), "no gap block when the budget is 0/0");
    assert.ok(!turn.content.includes("while away"), "missed message not surfaced when the gap is off");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

// Issue #3 lower-bound correctness lock. The gap lower bound is the previous
// trigger group's latest member (its trigger timestamp), NOT the bot's last send.
// Timeline: original trigger at t=1000; a human message at t=1500; the bot's reply
// send at t=2000 (LATER than its trigger — a slow rollout). The OLD bound (= the
// bot's max send timestamp = 2000) made the gap window (2000, new-trigger] and
// silently DROPPED the t=1500 message; the corrected bound (= 1000) surfaces it,
// and §9.2 also wants the bot's own send (t=2000) rendered as an in-room message.
test("buildResumeTurn: gap lower bound is the prior trigger ts, not the bot's send (issue #3)", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    await timeline.append(ev("orig-trigger", "make me an image", 1000)); // prior trigger (the bound)
    await timeline.append(ev("mid", "any update?", 1500)); // arrived BETWEEN trigger and the bot's send
    await timeline.append({
      ...ev("bot-send", "here is your image", 2000, "assistant"),
      id: "bot-send",
      agentSessionId: "s1",
      agentSessionGeneration: 0,
    }); // the bot's reply — LATER than its trigger
    const trigger = ev("reply1", "where did it go?", 3000);

    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      // The corrected bound = the prior trigger group's latest member (t=1000).
      gap: { maxMessages: 100, maxTokens: 1000000, lowerBoundTimestamp: 1000 },
    })) as unknown as ResumeTurnShape;

    assert.ok(turn.content.includes("messages_while_you_were_away"), "gap block present");
    assert.ok(
      turn.content.includes("any update?"),
      "the mid-rollout message (between trigger and bot-send) is surfaced — the OLD bot's-last-send bound dropped it",
    );
    assert.ok(
      turn.content.includes("here is your image"),
      "the bot's own send in the window is rendered as an in-room message (§9.2)",
    );
    assert.ok(
      !turn.content.includes("make me an image"),
      "the prior trigger itself (== the lower bound) is excluded — never re-rendered",
    );
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

// Issue #4 query-cap / truncation-marker correctness. The gap query is no longer
// pre-budget-capped, so the truncation marker reports the TRUE count of messages
// the budget cut (not a query-cap-relative undercount), and `max_messages = -1`
// (unlimited) is honoured rather than silently bounded.
test("buildResumeTurn: truncation marker reports the true omitted count past the old query cap (issue #4)", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    // 600 messages in the window — past the OLD hardcoded 500 query cap. The OLD
    // code fetched only the newest 500, so a 2-message budget reported omitted=498
    // (cap-relative). The window is the true 600, so the marker must report 598.
    const total = 600;
    for (let i = 0; i < total; i++) {
      await timeline.append(ev(`g${i}`, `msg ${i}`, 1000 + (i + 1)));
    }
    const trigger = ev("reply1", "back now", 1000 + total + 1);

    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      gap: { maxMessages: 2, maxTokens: 1000000, lowerBoundTimestamp: 1000 },
    })) as unknown as ResumeTurnShape;

    assert.ok(turn.content.includes("messages_while_you_were_away"), "gap block present");
    const m = turn.content.match(/earlier_messages_omitted count="(\d+)"/);
    assert.ok(m, "truncation marker present");
    assert.equal(
      Number(m![1]),
      total - 2,
      "marker reports the TRUE omitted count (598), not the old 500-query-cap-relative 498",
    );
    // Newest two kept (the contiguous newest-fit run), oldest truncated.
    assert.ok(turn.content.includes(`msg ${total - 1}`) && turn.content.includes(`msg ${total - 2}`), "newest two kept");
    assert.ok(!turn.content.includes(`msg ${total - 3}`), "older messages truncated by the budget");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("buildResumeTurn: max_messages = -1 is unlimited, not bounded at 500 (issue #4)", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, minimalConfig(), storage);
  try {
    // 520 messages — past the OLD 500 cap. With max_messages = -1 (unlimited) and a
    // generous token budget, the OLD code still capped the query at 500 and dropped
    // the oldest 20; the corrected code keeps all 520 (no message truncation).
    const total = 520;
    for (let i = 0; i < total; i++) {
      await timeline.append(ev(`g${i}`, `umsg ${i}`, 1000 + (i + 1)));
    }
    const trigger = ev("reply1", "back now", 1000 + total + 1);

    const turn = (await builder.buildResumeTurn({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: tailWorkspace,
      selfSessionId: "s1",
      tail: true,
      gap: { maxMessages: -1, maxTokens: 1000000, lowerBoundTimestamp: 1000 },
    })) as unknown as ResumeTurnShape;

    assert.ok(turn.content.includes("messages_while_you_were_away"), "gap block present");
    assert.ok(
      !/earlier_messages_omitted/.test(turn.content),
      "no truncation marker — max_messages = -1 keeps the whole window (not bounded at 500)",
    );
    assert.ok(turn.content.includes("umsg 0"), "the oldest message (beyond the old 500 cap) is kept");
    assert.ok(turn.content.includes(`umsg ${total - 1}`), "the newest message is kept");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

// ── §5 reply-as-trigger flows through the provider's trigger hold (issues #1, #7) ─
//
// Reply triggers are classified UPSTREAM in `emitWithTriggerHold` via the
// resume-unaware `resolveReplyTrigger` callback — not synthesized late in the app
// (the deleted `maybeSynthesizeReplyTrigger`). Consequence: the provider's strip +
// hold guarantees exactly ONE trigger-bearing delivery per reply (so `handleInbound`
// runs its trigger path once → handled exactly once, #1), and the reply rides the
// same debounce + same-sender grouping as a native dm/mention (#7).

const SELF = "@miku:example.org";
const HOLD_MS = 5;
const SETTLE_MS = 30;

/** Build a provider whose `config`/hold is set, capturing every delivery. */
function holdHarness(opts: Pick<MatrixProviderOptions, "resolveReplyTrigger">) {
  const provider = new MatrixProvider(opts);
  // emitWithTriggerHold only reads `config` truthiness + `trigger_hold_ms`.
  (provider as unknown as { config: { trigger_hold_ms: number } }).config = { trigger_hold_ms: HOLD_MS };
  const deliveries: InboundChatEvent[] = [];
  provider.subscribe((event) => deliveries.push(event));
  const drive = (inbound: InboundChatEvent) =>
    (provider as unknown as { emitWithTriggerHold(e: InboundChatEvent): void }).emitWithTriggerHold(inbound);
  return { provider, deliveries, drive };
}

function nativeReply(args: {
  eventId: string;
  body: string;
  replyToId?: string;
  chatType?: MatrixInboundEvent["chatType"];
  senderId?: string;
  mentions?: string[];
  ts?: number;
}): InboundChatEvent {
  const native: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: args.eventId,
    senderId: args.senderId ?? "@alice:example.org",
    senderName: "Alice",
    chatType: args.chatType ?? "channel",
    body: args.body,
    timestamp: new Date(args.ts ?? 1000).toISOString(),
    media: [],
    replyToId: args.replyToId,
    mentions: args.mentions ? { userIds: args.mentions } : undefined,
  };
  return normalizeMatrixInboundEvent(native, { accountId: "miku", selfUserId: SELF });
}

/** A resolver that recognises one bot message id as resumable (the app's job). */
function replyResolverFor(botMsgId: string): NonNullable<MatrixProviderOptions["resolveReplyTrigger"]> {
  return ({ externalId, sender }) =>
    externalId === botMsgId
      ? { type: "reply", reason: "reply to bot message", triggeredBy: { id: sender.id, displayName: sender.displayName } }
      : undefined;
}

const triggerBearing = (ds: InboundChatEvent[]) => ds.filter((d) => d.trigger);

test("group bare reply to a bot message: one held trigger-bearing delivery (handled once) — #1", async () => {
  const { deliveries, drive } = holdHarness({ resolveReplyTrigger: replyResolverFor("$bot-msg") });
  const reply = nativeReply({ eventId: "$reply", body: "where's that image?", replyToId: "$bot-msg" });
  assert.equal(reply.trigger, undefined, "a bare group reply does not natively trigger");

  drive(reply);
  // Delivery 1: the always-stripped raw emit (handleInbound ingests, no trigger path).
  assert.equal(deliveries.length, 1, "immediate raw emit");
  assert.equal(deliveries[0].trigger, undefined, "raw emit is trigger-stripped");

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  // Delivery 2: the held trigger-bearing emit — and ONLY one such delivery.
  const triggered = triggerBearing(deliveries);
  assert.equal(triggered.length, 1, "exactly one trigger-bearing delivery → handled exactly once (#1)");
  assert.equal(triggered[0].trigger?.type, "reply", "resolved as a reply trigger");
  assert.equal(triggered[0].event.trigger?.type, "reply", "trigger mirrored onto event for the downstream fork");
  assert.deepEqual(
    triggered[0].trigger?.groupedEventIds,
    [reply.event.id],
    "the held trigger group carries the reply (by canonical event id)",
  );
});

test("group reply to a NON-bot message: resolver declines → no trigger (still FRESH/ignored)", async () => {
  const { deliveries, drive } = holdHarness({ resolveReplyTrigger: replyResolverFor("$bot-msg") });
  // Reply targets some other user's message the resolver doesn't recognise.
  drive(nativeReply({ eventId: "$reply", body: "nice", replyToId: "$someone-else" }));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  assert.equal(triggerBearing(deliveries).length, 0, "an unresolved reply target never becomes a trigger");
});

test("group reply when resume is disabled (resolver returns undefined): no trigger", async () => {
  // Mirrors `enabled.group !== true`: the app-side resolver short-circuits to undefined.
  const { deliveries, drive } = holdHarness({ resolveReplyTrigger: () => undefined });
  drive(nativeReply({ eventId: "$reply", body: "hello again", replyToId: "$bot-msg" }));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  assert.equal(triggerBearing(deliveries).length, 0, "reply triggers are gated off when the resolver declines");
});

test("self-reply to the bot's own message is excluded from the resolver — no trigger", async () => {
  let resolverCalls = 0;
  const { deliveries, drive } = holdHarness({
    resolveReplyTrigger: (args) => {
      resolverCalls += 1;
      return replyResolverFor("$bot-msg")(args);
    },
  });
  // The bot replies to its own message (sender is self).
  const selfReply = nativeReply({ eventId: "$self-reply", body: "addendum", replyToId: "$bot-msg", senderId: SELF });
  assert.equal(selfReply.event.sender.isSelf, true, "sender is self");

  drive(selfReply);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  assert.equal(resolverCalls, 0, "resolver is NEVER invoked for a self-reply (self-reply guard)");
  assert.equal(triggerBearing(deliveries).length, 0, "a self-reply never becomes a trigger");
});

test("DM reply natively triggers as dm — resolver is bypassed, single held delivery (no double) — #1", async () => {
  let resolverCalls = 0;
  const { deliveries, drive } = holdHarness({
    resolveReplyTrigger: (args) => {
      resolverCalls += 1;
      return replyResolverFor("$bot-msg")(args);
    },
  });
  const dmReply = nativeReply({ eventId: "$dm-reply", body: "and one more thing", replyToId: "$bot-msg", chatType: "direct" });
  assert.equal(dmReply.trigger?.type, "dm", "a DM reply already triggers natively as dm");

  drive(dmReply);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  assert.equal(resolverCalls, 0, "resolver bypassed when a native trigger is already present (the !inbound.trigger guard)");
  const triggered = triggerBearing(deliveries);
  assert.equal(triggered.length, 1, "exactly one trigger-bearing delivery for a DM reply (no double-handle)");
  assert.equal(triggered[0].trigger?.type, "dm", "the single delivery keeps the native dm trigger");
});

test("group reply + @mention natively triggers as mention — resolver bypassed, single delivery — #1", async () => {
  let resolverCalls = 0;
  const { deliveries, drive } = holdHarness({
    resolveReplyTrigger: (args) => {
      resolverCalls += 1;
      return replyResolverFor("$bot-msg")(args);
    },
  });
  const reply = nativeReply({ eventId: "$mention-reply", body: "@miku follow up", replyToId: "$bot-msg", mentions: [SELF] });
  assert.equal(reply.trigger?.type, "mention", "a group reply that also @-mentions triggers natively as mention");

  drive(reply);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  assert.equal(resolverCalls, 0, "resolver bypassed when the mention already triggered");
  const triggered = triggerBearing(deliveries);
  assert.equal(triggered.length, 1, "exactly one trigger-bearing delivery for a group reply+mention (no double-handle)");
  assert.equal(triggered[0].trigger?.type, "mention", "native mention trigger preserved");
});

test("resolved group reply rides same-sender grouping in the hold — one grouped trigger group (#7)", async () => {
  const { deliveries, drive } = holdHarness({ resolveReplyTrigger: replyResolverFor("$bot-msg") });
  // 1) A bare group reply to the bot → resolved into a `reply` trigger, held.
  const reply = nativeReply({ eventId: "$reply", body: "where's that image", replyToId: "$bot-msg", ts: 1000 });
  drive(reply);
  // 2) A same-sender follow-up (no reply, no trigger) arrives within the hold window.
  const followup = nativeReply({ eventId: "$followup", body: "the one you made earlier", ts: 1001 });
  drive(followup);

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const triggered = triggerBearing(deliveries);
  assert.equal(triggered.length, 1, "still exactly one trigger-bearing delivery (#1 holds with grouping)");
  assert.deepEqual(
    triggered[0].trigger?.groupedEventIds,
    [reply.event.id, followup.event.id],
    "the follow-up is folded into the reply's trigger group by the hold (#7)",
  );
});
