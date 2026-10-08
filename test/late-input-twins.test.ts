/**
 * Late input under the providers' trigger hold (ARCHITECTURE.md §8 "Late
 * input"): every message is delivered at once without its trigger, and a
 * trigger again after the hold as its trigger-bearing twin (the harness's
 * `triggerHoldMs`). A message that triggers is decided on its twin; a bare part
 * of a newer request's hold belongs to that request only.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

const LATE = `
[agent.sessions.late_input]
enabled = true
hold_ms = 0
extend_ms = 500
max_hold_ms = 5000
first_event_wait_ms = 3000
`;

const FOLLOWUP = `
[agent.sessions.followup.text]
enabled = true
user_gap_ms = 7000
wall_clock_ms = 15000
`;

const send = (message: string): FakeLlmReply => ({
  toolCalls: [{ name: "send_message", args: { message, is_reply: false, final: true } }],
});

function userText(req: FakeLlmRequest): string {
  return req.body.messages
    .filter((m) => m.role === "user")
    .map((m) => messageText(m))
    .join("\n");
}

function hasLog(h: AppHarness, message: string): boolean {
  return h.logs.some((l) => l.message === message);
}

function sessionRows(h: AppHarness) {
  return h.query<{ id: string; status: string }>("select id, status from agent_sessions order by created_at, rowid");
}

const settledAll = (h: AppHarness) => () => {
  const rows = sessionRows(h);
  return rows.length > 0 && rows.every((r) => r.status !== "running" && r.status !== "created");
};

test("late input twins: a DM reply to the request is decided on its trigger-bearing twin", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 400,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const reply = send(userText(req).includes("the blue one") ? "blue it is" : "which one?");
      if (first) {
        first = false;
        return { ...reply, delayMs: 1500 };
      }
      return reply;
    },
  });
  try {
    const id = h.say("pick a color for me", { dm: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("the blue one", { dm: true, replyTo: id });
    // The raw (trigger-less) delivery is not consumed: were it, a fallback to its
    // native fate would have no trigger, and the twin would be suppressed.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!hasLog(h, "late_input_addition") && !hasLog(h, "late_input_redo_requested"), "not decided on the raw delivery");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    assert.equal(sessionRows(h).length, 1, "no parallel session");
    assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["blue it is"]);
  } finally {
    await h.stop();
  }
});

test("late input twins: a bare part of a re-@'s hold joins that request, not the running one", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE + FOLLOWUP,
    triggerHoldMs: 300,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (first) {
        first = false;
        return { ...send("planned"), delayMs: 1500 };
      }
      return send(userText(req).includes("hotel") ? "booked" : "planned");
    },
  });
  try {
    h.say("plan a trip", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("also book a hotel", { mention: true });
    h.say("in Rome");
    await h.until(() => sessionRows(h).length >= 2 && settledAll(h)() && h.sends.length >= 2, "both requests answered");
    const firstSession = sessionRows(h)[0]!.id;
    const branches = h.query<{ session_id: string; reason: string }>("select session_id, reason from agent_session_branches");
    assert.ok(!branches.some((b) => b.session_id === firstSession && b.reason === "addition_redo"), "the trip session is not redone");
    const tripRequests = h.llm.requests.filter((r) => !isRecordTurnRequest(r) && userText(r).includes("plan a trip") && !userText(r).includes("hotel"));
    assert.ok(tripRequests.length > 0 && tripRequests.every((r) => !userText(r).includes("in Rome")), "the part never joined the trip request");
    const hotel = h.llm.requests.filter((r) => !isRecordTurnRequest(r) && userText(r).includes("also book a hotel"));
    assert.ok(hotel.some((r) => userText(r).includes("in Rome")), "the part is in the hotel request's group");
  } finally {
    await h.stop();
  }
});
