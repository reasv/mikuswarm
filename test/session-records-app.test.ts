/**
 * App-level tests for session records (spec SESSION-RECORDS): the whole runtime
 * (`startMikuAgent`) with a fake chat provider and a scripted fake LLM endpoint,
 * so every assertion goes through the real launch path, factory, runner, record
 * turn, injection and persistence.
 *
 * Script convention: a trigger whose text contains `[work]` does one non-exempt
 * tool call (search_memory) before its final send; anything else only sends
 * (pure chat). The record turn is answered by `recordTurn`, which each test sets.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, requestToolNames, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

type Msg = FakeLlmRequest["body"]["messages"][number];

const finalize = (text: string): FakeLlmReply => ({
  toolCalls: [{ name: "session_record_tool", args: { command: "create", file_text: text, finalize: true } }],
});

/** The newest user-turn text that is not the record prompt. */
function triggerText(req: FakeLlmRequest): string {
  const users = req.body.messages.filter((m) => m.role === "user" && !messageText(m).includes("Write its session record"));
  return messageText(users.at(-1));
}

/** Tool name of the last assistant tool call in the request. */
function lastCallName(req: FakeLlmRequest): string | undefined {
  const assistants = req.body.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
  return assistants.at(-1)?.tool_calls?.at(-1)?.function.name;
}

interface ChatScript {
  /** Record-turn answer; called once per record-turn request. */
  recordTurn: (req: FakeLlmRequest) => FakeLlmReply;
}

function chatScript(state: ChatScript) {
  return (req: FakeLlmRequest): FakeLlmReply => {
    if (isRecordTurnRequest(req)) return state.recordTurn(req);
    const last = lastCallName(req);
    if (last === "search_memory") {
      return { toolCalls: [{ name: "send_message", args: { message: "done", is_reply: false, final: true } }] };
    }
    const text = triggerText(req);
    if (text.includes("[work]")) return { toolCalls: [{ name: "search_memory", args: { pattern: "x" } }] };
    return { toolCalls: [{ name: "send_message", args: { message: "hi", is_reply: false, final: true } }] };
  };
}

interface SessionRow {
  id: string;
  status: string;
  transcript_json: string | null;
}

function sessions(h: AppHarness): SessionRow[] {
  return h.query<SessionRow>(
    "select s.id, s.status, p.transcript_json from agent_sessions s left join agent_session_payloads p on p.session_id = s.id order by s.created_at, s.rowid",
  );
}

function records(h: AppHarness) {
  return h.query<{ session_id: string; text: string; builds_on: string; model_id: string | null }>(
    "select session_id, text, builds_on, model_id from session_records",
  );
}

function transcript(row: SessionRow): Array<Record<string, any>> {
  return row.transcript_json ? JSON.parse(row.transcript_json) : [];
}

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

function recordOutcomeLogged(h: AppHarness, sessionId: string): boolean {
  return ["session_record_written", "session_record_failed", "session_record_skipped"].some((m) =>
    hasLog(h, m, { sessionId }),
  );
}

/**
 * Wait until `count` sessions exist and are settled, and each one that did tool
 * work has a record outcome logged (pure chat writes none).
 */
async function settled(h: AppHarness, count: number): Promise<SessionRow[]> {
  await h.until(() => {
    const rows = sessions(h);
    if (rows.length < count || rows.some((r) => r.status === "running" || r.status === "created")) return false;
    return rows.every((r) => {
      const worked = transcript(r).some(
        (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.name === "search_memory" || b.name === "read_session_record"),
      );
      return !worked || recordOutcomeLogged(h, r.id);
    });
  }, `${count} session(s) settled`);
  // Let the post-turn flush land.
  await new Promise((r) => setTimeout(r, 100));
  return sessions(h);
}

/** The first non-record request whose trigger contains `marker`. */
function firstRequestFor(h: AppHarness, marker: string): FakeLlmRequest {
  const req = h.llm.requests.find((r) => !isRecordTurnRequest(r) && triggerText(r).includes(marker));
  assert.ok(req, `a request for ${marker}`);
  return req!;
}

function injectedCall(req: FakeLlmRequest): Msg | undefined {
  return req.body.messages.find((m: Msg) => m.tool_calls?.some((tc) => tc.function.name === "read_session_record"));
}

const DYNAMIC = `
[agent.tools.dynamic]
enabled = true
immediate = ["send_message", "search_memory", "session_*"]
index = "none"
`;

// ── Record turn: which sessions write, and what the turn looks like ─────────────

test("app: a session with tool work writes a record; pure chat writes none", async () => {
  const h = await startHarness({ script: chatScript({ recordTurn: () => finalize("found X at memory/a.md") }) });
  try {
    h.say("chat only", { mention: true });
    await settled(h, 1);
    h.say("[work] look it up", { mention: true });
    const rows = await settled(h, 2);
    const rec = records(h);
    assert.equal(rec.length, 1, "only the working session writes a record");
    assert.equal(rec[0]!.session_id, rows[1]!.id);
    assert.equal(rec[0]!.text, "found X at memory/a.md");
    assert.equal(rec[0]!.model_id, "fake-model", "model_id is the member that served the record turn");
    assert.equal(h.llm.requests.filter(isRecordTurnRequest).length, 1, "no record turn for pure chat");
    // The record turn is part of the rollout, harness-marked.
    const t = transcript(rows[1]!);
    const prompt = t.find((m) => m.harness?.kind === "record_turn");
    assert.ok(prompt, "record_turn prompt persisted");
    assert.match(prompt.content[0].text, /^This session is over\. Write its session record/);
    assert.ok(t.some((m) => m.role === "toolResult" && m.toolName === "session_record_tool"), "record tool result persisted");
  } finally {
    await h.stop();
  }
});

test("app: model_id is the chain member that actually served the record turn", async () => {
  const script = chatScript({ recordTurn: () => finalize("rec") });
  const h = await startHarness({
    // The head fails the record turn; the fallback member serves it.
    script: (req) => (isRecordTurnRequest(req) && req.body.model === "fake-model" ? { error: { status: 503, body: "{}" } } : script(req)),
    toml: `
[models.default]
fallback = ["backup"]

[models.backup]
id = "backup-model"
provider = "fake"
api = "openai-completions"
endpoint = "LLM_URL"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
context_window = 128000
`,
  });
  try {
    h.say("[work] go", { mention: true });
    await settled(h, 1);
    assert.equal(records(h)[0]?.model_id, "backup-model");
  } finally {
    await h.stop();
  }
});

test("app: dynamic loading — record_load is a synthetic tool_search select call; the record tool is never immediate", async () => {
  const h = await startHarness({ script: chatScript({ recordTurn: () => finalize("rec") }), toml: DYNAMIC });
  try {
    h.say("[work] go", { mention: true });
    const [row] = await settled(h, 1);
    const mainTools = requestToolNames(firstRequestFor(h, "[work] go"));
    assert.ok(!mainTools.includes("session_record_tool"), "harness-only tool not immediate even when a glob matches it");
    assert.ok(mainTools.includes("read_session_record"), "read_session_record is immediate even when the list omits it");
    const recordReq = h.llm.requests.find(isRecordTurnRequest)!;
    assert.ok(requestToolNames(recordReq).includes("session_record_tool"), "loaded before the record-turn request");
    // The wire: record prompt, then the synthetic tool_search call + its result.
    const msgs = recordReq.body.messages;
    const promptIdx = msgs.findIndex((m: Msg) => m.role === "user" && messageText(m).includes("Write its session record"));
    const loadCall = msgs[promptIdx + 1]!;
    assert.equal(loadCall.role, "assistant");
    assert.equal(loadCall.tool_calls![0]!.function.name, "tool_search");
    assert.deepEqual(JSON.parse(loadCall.tool_calls![0]!.function.arguments), { query: "select:session_record_tool" });
    assert.equal(msgs[promptIdx + 2]!.role, "tool");
    assert.match(messageText(msgs[promptIdx + 2]), /Loaded 1 tool\(s\) — now directly callable:\n- session_record_tool — /);
    // Persisted with the harness marker and addedToolNames, stamped with the head model.
    const load = transcript(row!).filter((m) => m.harness?.kind === "record_load");
    assert.equal(load.length, 2, "assistant call + tool result");
    assert.deepEqual(load[1]!.addedToolNames, ["session_record_tool"]);
    assert.equal(load[0]!.model, "fake-model");
    assert.equal(load[0]!.api, "openai-completions");
    assert.equal(records(h).length, 1);
  } finally {
    await h.stop();
  }
});

test("app: the record-turn gate blocks every other tool, then the record is written", async () => {
  let turn = 0;
  const h = await startHarness({
    script: chatScript({
      recordTurn: () => {
        turn += 1;
        return turn === 1 ? { toolCalls: [{ name: "search_memory", args: { pattern: "sneaky" } }] } : finalize("rec after block");
      },
    }),
  });
  try {
    h.say("[work] go", { mention: true });
    const [row] = await settled(h, 1);
    const blocked = transcript(row!).find(
      (m) => m.role === "toolResult" && m.toolName === "search_memory" && /Only session_record_tool is available/.test(m.content?.[0]?.text ?? ""),
    );
    assert.ok(blocked, "search_memory refused during the record turn");
    assert.equal(records(h)[0]?.text, "rec after block");
  } finally {
    await h.stop();
  }
});

test("app: the gate also covers the factory's loading tools (tool_search) during the record turn", async () => {
  let turn = 0;
  const h = await startHarness({
    script: chatScript({
      recordTurn: () => {
        turn += 1;
        return turn === 1 ? { toolCalls: [{ name: "tool_search", args: { query: "select:web_fetch" } }] } : finalize("rec");
      },
    }),
    toml: DYNAMIC,
  });
  try {
    h.say("[work] go", { mention: true });
    const [row] = await settled(h, 1);
    const blocked = transcript(row!).find(
      (m) => m.role === "toolResult" && m.toolName === "tool_search" && !m.harness && /Only session_record_tool is available/.test(m.content?.[0]?.text ?? ""),
    );
    assert.ok(blocked, "tool_search refused during the record turn");
  } finally {
    await h.stop();
  }
});

// ── Record turn failures: no row, a reason in the log ──────────────────────────

const failureCases: Array<{ name: string; toml?: string; recordTurn: () => FakeLlmReply; reason: string }> = [
  {
    name: "max_turns",
    toml: "[session_records]\nmax_turns = 2\n",
    recordTurn: () => ({ toolCalls: [{ name: "session_record_tool", args: { command: "create", file_text: "draft only" } }] }),
    reason: "max_turns",
  },
  {
    name: "timeout",
    toml: "[session_records]\ntimeout_ms = 1000\n",
    recordTurn: () => ({ ...finalize("too late"), delayMs: 3000 }),
    reason: "timeout",
  },
  { name: "ending without finalize", recordTurn: () => ({ text: "here is my record" }), reason: "not_finalized" },
  {
    name: "LLM error",
    recordTurn: () => ({ error: { status: 400, body: JSON.stringify({ error: { message: "bad request" } }) } }),
    reason: "llm_error",
  },
];

for (const c of failureCases) {
  test(`app: record turn ${c.name} → no row, session_record_failed{${c.reason}}`, async () => {
    const h = await startHarness({ script: chatScript({ recordTurn: c.recordTurn }), toml: c.toml });
    try {
      h.say("[work] go", { mention: true });
      const [row] = await settled(h, 1);
      assert.equal(records(h).length, 0);
      assert.ok(hasLog(h, "session_record_failed", { sessionId: row!.id, reason: c.reason }), `failed{${c.reason}}`);
      assert.equal(row!.status, "completed", "the session itself is unaffected");
    } finally {
      await h.stop();
    }
  });
}

test("app: finalize on the empty draft is the skip — no row, session_record_skipped", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => ({ toolCalls: [{ name: "session_record_tool", args: { command: "finalize" } }] }) }),
  });
  try {
    h.say("[work] go", { mention: true });
    const [row] = await settled(h, 1);
    assert.equal(records(h).length, 0);
    assert.ok(hasLog(h, "session_record_skipped", { sessionId: row!.id, reason: "empty" }));
  } finally {
    await h.stop();
  }
});

// ── Injection (spec §4/§6.1) ─────────────────────────────────────────────────

test("app: a reply to a bot message injects that session's record (kickoff regression)", async () => {
  let n = 0;
  const h = await startHarness({ script: chatScript({ recordTurn: () => finalize(`record #${++n}`) }) });
  try {
    h.say("[work] first", { mention: true });
    const [a] = await settled(h, 1);
    h.say("[work] about that", { mention: true, replyTo: h.sends.at(-1)!.externalId });
    const rows = await settled(h, 2);
    const b = rows[1]!;
    // The wire: the synthetic call + result follow the trigger turn.
    const req = firstRequestFor(h, "about that");
    const call = injectedCall(req);
    assert.ok(call, "synthetic read_session_record call sent");
    assert.deepEqual(JSON.parse(call!.tool_calls![0]!.function.arguments), { session_id: a!.id });
    const result = req.body.messages.find((m: Msg) => m.role === "tool" && m.tool_call_id === call!.tool_calls![0]!.id);
    assert.ok(messageText(result).includes("record #1"), "the record text reaches the model");
    // The transcript: the harness-marked pair.
    const pair = transcript(b).filter((m) => m.harness?.kind === "injection");
    assert.equal(pair.length, 2);
    assert.equal(pair[0]!.role, "assistant");
    assert.equal(pair[0]!.model, "fake-model");
    assert.equal(pair[1]!.role, "toolResult");
    assert.equal(pair[1]!.isError, false);
    // B builds on A.
    assert.deepEqual(JSON.parse(records(h).find((r) => r.session_id === b.id)!.builds_on), [a!.id]);
  } finally {
    await h.stop();
  }
});

test("app: no record turn when session_record_tool is not in the catalog (Z2)", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => assert.fail("no record turn expected") }),
    toml: `
[agent]
disabled_tools = ["session_record_tool"]
`,
  });
  try {
    h.say("[work] look it up", { mention: true });
    const [a] = await settled(h, 1);
    assert.ok(hasLog(h, "session_record_skipped", { sessionId: a!.id, reason: "tool_unavailable" }));
    assert.equal(h.llm.requests.filter(isRecordTurnRequest).length, 0);
    assert.equal(records(h).length, 0);
  } finally {
    await h.stop();
  }
});

test("app: no injection (and no wait) when read_session_record is not in the catalog (Z2)", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => ({ ...finalize("slow record"), delayMs: 1500 }) }),
    toml: `
[agent.session_types.default]
tools = ["send_message", "search_memory", "session_record_tool"]
`,
  });
  try {
    h.say("[work] first", { mention: true });
    await h.until(() => h.llm.requests.some(isRecordTurnRequest), "record turn started");
    const t0 = Date.now();
    h.say("what did you find", { mention: true, replyTo: h.sends.at(-1)!.externalId });
    await h.until(() => h.llm.requests.some((r) => !isRecordTurnRequest(r) && triggerText(r).includes("what did you find")), "reply request");
    assert.ok(Date.now() - t0 < 1200, "the reply did not wait for the in-flight record");
    await settled(h, 2);
    assert.equal(injectedCall(firstRequestFor(h, "what did you find")), undefined, "nothing injected");
    assert.equal(records(h).length, 1, "the record itself is still written");
  } finally {
    await h.stop();
  }
});

test("app: a reply that arrives while the record is being written waits for it", async () => {
  const h = await startHarness({ script: chatScript({ recordTurn: () => ({ ...finalize("slow record"), delayMs: 600 }) }) });
  try {
    h.say("[work] first", { mention: true });
    // The final message is out; the record turn is now running (slot already free).
    await h.until(() => h.llm.requests.some(isRecordTurnRequest), "record turn started");
    h.say("what did you find", { mention: true, replyTo: h.sends.at(-1)!.externalId });
    await settled(h, 2);
    const req = firstRequestFor(h, "what did you find");
    assert.ok(
      req.body.messages.some((m: Msg) => m.role === "tool" && messageText(m).includes("slow record")),
      "the reply waited for the in-flight record and got it",
    );
  } finally {
    await h.stop();
  }
});

test("app: a reply proceeds without the record once its production times out", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => ({ ...finalize("never lands"), delayMs: 4000 }) }),
    toml: "[session_records]\ntimeout_ms = 1000\n",
  });
  try {
    h.say("[work] first", { mention: true });
    await h.until(() => h.sends.length >= 1, "first send");
    const started = Date.now();
    h.say("and?", { mention: true, replyTo: h.sends[0]!.externalId });
    await h.until(() => h.sends.length >= 2, "reply answered", 5000);
    assert.ok(Date.now() - started < 3500, "did not wait past the record deadline");
    assert.equal(injectedCall(firstRequestFor(h, "and?")), undefined, "nothing injected");
    await settled(h, 2);
    assert.equal(records(h).length, 0);
  } finally {
    await h.stop();
  }
});

// ── Fold-after-settle (spec §7) ──────────────────────────────────────────────

const FOLLOWUP = `
[agent.sessions.followup.text]
enabled = true
user_gap_ms = 7000
wall_clock_ms = 15000
`;

test("app: a reply-resume waits until the timed-out record turn has settled (Z3)", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => ({ ...finalize("late record"), delayMs: 2500 }) }),
    toml: `
[session_records]
timeout_ms = 1000

[agent.sessions.resume]
enabled = { group = true }
`,
  });
  try {
    h.say("[work] first", { mention: true });
    await h.until(() => h.llm.requests.some(isRecordTurnRequest), "record turn started");
    h.say("and then?", { mention: true, replyTo: h.sends.at(-1)!.externalId });
    await h.until(() => hasLog(h, "session_resume_started"), "reply resumed the session");
    const idx = (m: string) => h.logs.findIndex((l) => l.message === m);
    assert.ok(idx("session_record_failed") >= 0, "the record turn timed out");
    assert.ok(
      idx("session_record_failed") < idx("session_resume_started"),
      "the resume started only after the record turn was over",
    );
    await settled(h, 1);
  } finally {
    await h.stop();
  }
});

test("app: a follow-up after the owner settled starts a fresh session with the owner's record", async () => {
  const h = await startHarness({ script: chatScript({ recordTurn: () => finalize("owner record") }), toml: FOLLOWUP });
  try {
    h.say("[work] look it up", { mention: true });
    const [owner] = await settled(h, 1);
    // A bare (un-mentioned) same-sender follow-up: folds, never resumes.
    h.say("oh and the second one too");
    const rows = await settled(h, 2);
    assert.equal(rows.length, 2, "a fresh session");
    const fresh = rows[1]!;
    assert.notEqual(fresh.id, owner!.id);
    assert.equal(owner!.status, "completed");
    const injected = transcript(fresh).find((m) => m.role === "toolResult" && m.harness?.kind === "injection");
    assert.ok(injected, "owner's record injected");
    assert.ok(injected.content[0].text.includes("owner record"));
    assert.equal(injected.harness.decisionGroup, undefined, "outside any judgement");
    assert.ok(hasLog(h, "follow_up_fold_after_settle", { ownerSessionId: owner!.id, action: "spawn" }));
  } finally {
    await h.stop();
  }
});

// ── Decision points (spec §6.2/§8) ───────────────────────────────────────────

const DECISIONS = `
[models.decider]
id = "decider-1"
provider = "fake"
api = "system-one"
endpoint = "LLM_URL/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1
context_window = 32000

[decisions]
enabled = true
model = "decider"

[decisions.routing]
enabled = true

[decisions.routing.tasks.lookup]
description = "looking something up"
models = ["default"]

[decisions.records]
enabled = true
candidates = 3
inject_threshold = 0.6
`;

test("app: a reply steered after the rollout's last check is redelivered, not dropped (Z5)", async () => {
  let h!: AppHarness;
  let held = false;
  h = await startHarness({
    script: chatScript({ recordTurn: () => finalize("record A") }),
    // The agent loop is over; the run has not settled yet. A reply to the bot now
    // still steers into the session (it is running) but nothing will read it.
    onTyping: async (on) => {
      if (on || held || h === undefined || h.sends.length === 0) return;
      held = true;
      h.say("wait, also this", { mention: true, replyTo: h.sends.at(-1)!.externalId });
      await h.until(() => hasLog(h, "reply_steered"), "the reply steered into the ending session");
    },
  });
  try {
    h.say("[work] first", { mention: true });
    const rows = await settled(h, 2);
    const a = rows[0]!;
    assert.ok(hasLog(h, "steer_unread_redelivered", { sessionId: a.id, form: "reply" }));
    assert.ok(hasLog(h, "follow_up_fold_after_settle", { ownerSessionId: a.id, form: "reply" }));
    assert.ok(!transcript(a).some((m) => JSON.stringify(m).includes("wait, also this")), "A never read it");
    // Exactly once: one fresh session answers it, starting with A's record.
    const handling = h.llm.requests.filter((r) => !isRecordTurnRequest(r) && triggerText(r).includes("wait, also this"));
    assert.ok(handling.length >= 1);
    assert.equal(sessions(h).length, 2);
    const call = injectedCall(handling[0]!);
    assert.ok(call, "the fresh session starts with the owner's record");
    assert.deepEqual(JSON.parse(call!.tool_calls![0]!.function.arguments), { session_id: a.id });
  } finally {
    await h.stop();
  }
});

test("app: a steered reply whose trigger-hold twin is still due is left to the twin (Z5)", async () => {
  let h!: AppHarness;
  let held = false;
  let replyTo = "";
  h = await startHarness({
    script: chatScript({ recordTurn: () => finalize("record A") }),
    onTyping: async (on) => {
      if (on || held || h === undefined || h.sends.length === 0) return;
      held = true;
      replyTo = h.sends.at(-1)!.externalId;
      // The trigger hold's immediate emission: no trigger yet.
      h.say("wait, also this", { replyTo, id: "$twin" });
      await h.until(() => hasLog(h, "reply_steered"), "the raw emission steered");
    },
  });
  try {
    h.say("[work] first", { mention: true });
    await settled(h, 1);
    await h.until(() => hasLog(h, "session_record_written"), "A's record");
    assert.ok(!hasLog(h, "steer_unread_redelivered"), "not redelivered while its twin is due");
    // The twin (post-hold, trigger-bearing) arrives after A settled: native path.
    h.say("wait, also this", { mention: true, replyTo, id: "$twin" });
    await settled(h, 2);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sessions(h).length, 2, "handled exactly once");
  } finally {
    await h.stop();
  }
});

test("app: routing and records write decision rows with separate groups; the judged record is injected", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => finalize("judged record") }),
    toml: DECISIONS,
    decideNoul: () => 0.9,
  });
  try {
    h.say("[work] first", { mention: true });
    const [a] = await settled(h, 1);
    // Not a reply: the records point judges the recent bot sessions.
    h.say("tell me more", {
      mention: true,
      attachments: [{ id: "att1", mediaType: "file", filename: "notes.txt", caption: "a list of three notes" }],
    });
    const rows = await settled(h, 2);
    const b = rows[1]!;
    const evals = h.query<{
      point: string;
      decision_group: string;
      candidate_session_id: string | null;
      source: string;
      state_json: string;
      trigger_event_id: string | null;
    }>(
      "select point, decision_group, candidate_session_id, source, state_json, trigger_event_id from decision_evaluations where agent_session_id = ?",
      b.id,
    );
    const routing = evals.filter((e) => e.point === "routing");
    const recs = evals.filter((e) => e.point === "records");
    assert.equal(routing.length, 1, "one routing row");
    assert.equal(recs.length, 1, "one records row per candidate");
    assert.notEqual(routing[0]!.decision_group, recs[0]!.decision_group, "separate decision groups");
    assert.equal(recs[0]!.candidate_session_id, a!.id);
    assert.equal(recs[0]!.source, "model");
    // Both points name the trigger event.
    assert.ok(routing[0]!.trigger_event_id, "routing row has trigger_event_id");
    assert.equal(routing[0]!.trigger_event_id, recs[0]!.trigger_event_id);
    // Non-reply state: recent_chat carries the record's bot message where it sat.
    const state = JSON.parse(recs[0]!.state_json);
    assert.ok(Array.isArray(state.recent_chat), "non-reply framing");
    assert.ok(state.recent_chat.some((m: { self?: boolean; text: string }) => m.self === true && m.text === "done"));
    assert.equal(state.reply_to, undefined);
    // The trigger's attachments ride on the request, as the routing point renders them.
    assert.deepEqual(state.request.attachments, ["a list of three notes"]);
    // Injected with the records group on its harness marker.
    const injected = transcript(b).find(
      (m) => m.role === "assistant" && m.harness?.kind === "injection" && m.content?.[0]?.name === "read_session_record",
    );
    assert.ok(injected, "the judged record was injected");
    assert.equal(injected.harness.decisionGroup, recs[0]!.decision_group);
  } finally {
    await h.stop();
  }
});

test("app: a record judged irrelevant is not injected into a non-reply trigger", async () => {
  const h = await startHarness({
    script: chatScript({ recordTurn: () => finalize("unrelated record") }),
    toml: DECISIONS,
    decideNoul: () => 0.1,
  });
  try {
    h.say("[work] first", { mention: true });
    await settled(h, 1);
    h.say("something else entirely", { mention: true });
    await settled(h, 2);
    assert.equal(injectedCall(firstRequestFor(h, "something else entirely")), undefined);
  } finally {
    await h.stop();
  }
});

// ── Shutdown (L4) ────────────────────────────────────────────────────────────

test("app: shutdown aborts an in-flight record turn — no row, failed{shutdown}", async () => {
  const h = await startHarness({ script: chatScript({ recordTurn: () => ({ ...finalize("late"), delayMs: 8000 }) }) });
  let stopped = false;
  try {
    h.say("[work] go", { mention: true });
    await h.until(() => h.llm.requests.some(isRecordTurnRequest), "record turn started");
    const [row] = sessions(h);
    const t0 = Date.now();
    await h.stop();
    stopped = true;
    assert.ok(Date.now() - t0 < 6000, "shutdown did not wait for the record turn");
    assert.ok(hasLog(h, "session_record_failed", { sessionId: row!.id, reason: "shutdown" }));
    assert.ok(!hasLog(h, "session_record_written"));
  } finally {
    if (!stopped) await h.stop();
  }
});
