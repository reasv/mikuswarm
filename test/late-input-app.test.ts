/**
 * App-level tests for late input (ARCHITECTURE.md §8 "Late input"): the whole
 * runtime with a fake chat provider and a scripted fake LLM, so redo from
 * scratch, the irreversibility hold, abort-and-interject, cancellation, replay,
 * late additions and implicit replies go through the real launch path, factory,
 * runner and persistence.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

const LATE = (over: Record<string, number> = {}): string => {
  const knobs = { hold_ms: 1500, extend_ms: 500, max_hold_ms: 5000, first_event_wait_ms: 3000, ...over };
  return `\n[agent.sessions.late_input]\nenabled = true\n${Object.entries(knobs).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`;
};

const FOLLOWUP = `
[agent.sessions.followup.text]
enabled = true
user_gap_ms = 7000
wall_clock_ms = 15000
`;

const send = (message: string, final = true): FakeLlmReply => ({
  toolCalls: [{ name: "send_message", args: { message, is_reply: false, final } }],
});

/** All user-side text of a request (the kickoff turn and any interjections). */
function userText(req: FakeLlmRequest): string {
  return req.body.messages
    .filter((m) => m.role === "user")
    .map((m) => messageText(m))
    .join("\n");
}

/** Tool names of the request's assistant calls, oldest first. */
function callNames(req: FakeLlmRequest): string[] {
  return req.body.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.function.name) : []));
}

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

function sessionRows(h: AppHarness) {
  return h.query<{ id: string; status: string; redo_count: number }>(
    "select id, status, redo_count from agent_sessions order by created_at, rowid",
  );
}

function branches(h: AppHarness) {
  return h.query<{ session_id: string; branch_no: number; fork_index: number; reason: string; cause_event_id: string | null }>(
    "select session_id, branch_no, fork_index, reason, cause_event_id from agent_session_branches order by session_id, branch_no",
  );
}

function transcript(h: AppHarness, sessionId: string): Array<Record<string, any>> {
  const [row] = h.query<{ transcript_json: string | null }>(
    "select transcript_json from agent_session_payloads where session_id = ?",
    sessionId,
  );
  return row?.transcript_json ? JSON.parse(row.transcript_json) : [];
}

const settledAll = (h: AppHarness) => () => {
  const rows = sessionRows(h);
  return rows.length > 0 && rows.every((r) => r.status !== "running" && r.status !== "created");
};

test("late input: an edit of the trigger before anything was sent redoes the session from scratch", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE(),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const text = userText(req);
      const reply = send(text.includes("Paris") ? "weather in Paris" : "weather in Lyon");
      if (first) {
        first = false;
        return { ...reply, delayMs: 600 };
      }
      return reply;
    },
  });
  try {
    const id = h.say("weather in Lyon?", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.edit(id, "weather in Paris?", { mention: true });
    await h.until(() => h.sends.length >= 1 && settledAll(h)(), "the redone session sent and settled");
    assert.equal(h.sends.length, 1, "one message: the corrected answer");
    assert.equal((h.sends[0]!.msg as { body?: string }).body, "weather in Paris");
    const [row] = sessionRows(h);
    assert.equal(sessionRows(h).length, 1, "the same session");
    assert.equal(row!.redo_count, 1);
    const [branch] = branches(h);
    assert.equal(branch?.reason, "edit_redo");
    assert.equal(branch?.fork_index, 0);
    assert.equal(branch?.cause_event_id, `evt-${id}`);
    assert.ok(hasLog(h, "late_input_redo", { sessionId: row!.id }));
  } finally {
    await h.stop();
  }
});

test("late input: the first irreversible call waits for the hold deadline", async () => {
  const h = await startHarness({
    toml: LATE(),
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("hello")),
  });
  try {
    const started = Date.now();
    h.say("hi there", { mention: true });
    await h.until(() => h.sends.length >= 1, "the send");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1300, `the send waited for the hold (${elapsed} ms)`);
    await h.until(settledAll(h), "settled");
    const [row] = sessionRows(h);
    const held = transcript(h, row!.id).find((m) => m.role === "toolResult" && m.lateInputHold);
    assert.ok(held, "the tool result records the hold");
    assert.equal(held!.lateInputHold.reason, "hold_deadline");
    assert.ok(held!.lateInputHold.heldMs > 0);
  } finally {
    await h.stop();
  }
});

test("late input: an edit after a message was sent aborts the generation and interjects", async () => {
  let n = 0;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      if (n === 1) return send("first part", false);
      const text = userText(req);
      if (text.includes("edited the message you are answering")) return send("corrected");
      return { ...send("second part"), delayMs: 1500 };
    },
  });
  try {
    const id = h.say("tell me two things", { mention: true });
    await h.until(() => h.sends.length >= 1, "the first message");
    await h.until(() => h.llm.requests.length >= 2, "the second request");
    h.edit(id, "tell me three things", { mention: true });
    await h.until(() => settledAll(h)() && h.sends.length >= 2, "settled");
    const bodies = h.sends.map((s) => (s.msg as { body?: string }).body);
    assert.deepEqual(bodies, ["first part", "corrected"]);
    assert.ok(branches(h).some((b) => b.reason === "turn_aborted"), "the aborted turn is kept as a branch");
    assert.ok(hasLog(h, "late_input_interjected"));
    assert.equal(sessionRows(h)[0]!.redo_count, 0);
  } finally {
    await h.stop();
  }
});

test("late input: deleting the trigger before anything was sent cancels the session", async () => {
  const h = await startHarness({
    toml: LATE(),
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : { ...send("never"), delayMs: 500 }),
  });
  try {
    const id = h.say("oops wrong room", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.remove(id);
    await h.until(settledAll(h), "settled");
    assert.equal(h.sends.length, 0, "nothing sent");
    assert.equal(sessionRows(h)[0]!.status, "discarded");
    assert.ok(hasLog(h, "late_input_cancelled"));
  } finally {
    await h.stop();
  }
});

test("late input: a quick same-sender addition joins the request and redoes it", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE() + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const text = userText(req);
      const reply = send(text.includes("of France") ? "Paris" : "capital of what?");
      if (first) {
        first = false;
        return { ...reply, delayMs: 600 };
      }
      return reply;
    },
  });
  try {
    h.say("what's the capital", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("of France");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["Paris"]);
    assert.equal(sessionRows(h).length, 1);
    assert.ok(branches(h).some((b) => b.reason === "addition_redo"));
    const last = h.llm.requests.filter((r) => !isRecordTurnRequest(r)).at(-1)!;
    assert.ok(userText(last).includes("what's the capital") && userText(last).includes("of France"), "both parts in the rebuilt request");
  } finally {
    await h.stop();
  }
});

test("late input: a redo replays a redo-safe result instead of calling the tool again", async () => {
  let edited = false;
  const h = await startHarness({
    toml: LATE({ hold_ms: 2500 }),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const calls = callNames(req);
      if (!calls.includes("search_memory")) return { toolCalls: [{ name: "search_memory", args: { pattern: "x" } }] };
      return send(edited ? "after edit" : "before edit");
    },
  });
  try {
    const id = h.say("find x", { mention: true });
    // The search runs at once; the send is held until the deadline.
    await h.until(() => hasLog(h, "irreversible_hold") || h.llm.requests.length >= 2, "the send is being held");
    await new Promise((r) => setTimeout(r, 200));
    edited = true;
    h.edit(id, "find x please", { mention: true });
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["after edit"]);
    assert.ok(hasLog(h, "redo_replayed_call", { tool: "search_memory" }), "the search was replayed");
    assert.ok(branches(h).some((b) => b.reason === "edit_redo"));
  } finally {
    await h.stop();
  }
});

const DECIDER = `
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

[decisions.implicit_reply]
enabled = true
threshold = 0.8
`;

test("late input: an implicit reply to the bot's message becomes a reply trigger", async () => {
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }) + DECIDER,
    decideNoul: () => 0.95,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("ok")),
  });
  try {
    h.say("hey bot, recommend a game", { mention: true });
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "first session");
    // Bob answers the bot without the reply function or a mention.
    h.say("I already played that one", { sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => sessionRows(h).length >= 2 && settledAll(h)(), "a second session for the implicit reply");
    assert.ok(hasLog(h, "implicit_reply_evaluated", { replies: true }));
    assert.equal(h.llm.decisions.length >= 1, true);
    const [ctx] = h.query<{ reply_external_id: string }>(
      "select reply_external_id from reply_contexts where event_id = ?",
      "evt-$user2",
    );
    assert.equal(ctx?.reply_external_id, h.sends[0]!.externalId, "recorded as a reply to the bot's message");
  } finally {
    await h.stop();
  }
});

test("late input: a bare message after the bot's message is inert when the classifier says no", async () => {
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }) + DECIDER,
    decideNoul: () => 0.1,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("ok")),
  });
  try {
    h.say("hey bot, recommend a game", { mention: true });
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "first session");
    h.say("anyway, lunch?", { sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => hasLog(h, "implicit_reply_evaluated"), "evaluated");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sessionRows(h).length, 1, "no session");
  } finally {
    await h.stop();
  }
});
