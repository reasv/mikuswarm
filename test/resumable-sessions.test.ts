import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/index.js";
import { loadCompletedSessionMaterial } from "../src/agent/index.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { AgentSessionRow } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
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

test("getLatestEventTimestampForSession returns the newest send (gap lower bound)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  try {
    await timeline.append({ ...ev("a", "first", 1000, "assistant"), id: "a", agentSessionId: "s1" });
    await timeline.append({ ...ev("b", "second", 3000, "assistant"), id: "b", agentSessionId: "s1" });
    await timeline.append({ ...ev("c", "other", 9000, "assistant"), id: "c", agentSessionId: "s2" });
    assert.equal(storage.getLatestEventTimestampForSession("s1"), 3000);
    assert.equal(storage.getLatestEventTimestampForSession("s2"), 9000);
    assert.equal(storage.getLatestEventTimestampForSession("none"), undefined);
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
