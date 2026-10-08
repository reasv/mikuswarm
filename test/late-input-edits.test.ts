/**
 * App-level tests for mention edits (ARCHITECTURE.md §8 "Late input"): an edit
 * stores its new mentions, so adding the bot mention to a recent message
 * triggers it and removing it from a trigger cancels the session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, type FakeLlmReply } from "./helpers/fake-llm.js";

const LATE = (over: Record<string, number> = {}): string => {
  const knobs = { hold_ms: 1500, extend_ms: 500, max_hold_ms: 5000, first_event_wait_ms: 3000, ...over };
  return `\n[agent.sessions.late_input]\nenabled = true\n${Object.entries(knobs).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`;
};

const send = (message: string): FakeLlmReply => ({
  toolCalls: [{ name: "send_message", args: { message, is_reply: false, final: true } }],
});

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

function sessionRows(h: AppHarness) {
  return h.query<{ id: string; status: string }>("select id, status from agent_sessions order by created_at, rowid");
}

const settledAll = (h: AppHarness) => () => {
  const rows = sessionRows(h);
  return rows.length > 0 && rows.every((r) => r.status !== "running" && r.status !== "created");
};

test("late input edits: an edit that adds a bot mention to a recent message triggers it", async () => {
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("hi")),
  });
  try {
    const id = h.say("what's the weather");
    await new Promise((r) => setTimeout(r, 300));
    h.edit(id, "@bot what's the weather", { mention: true });
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "a session for the edited message");
    assert.ok(hasLog(h, "late_input_mention_edit_trigger"));
    const [stored] = h.query<{ event_json: string }>("select event_json from timeline_events where external_id = ?", id);
    assert.equal(JSON.parse(stored!.event_json).mentions?.mentionedSelf, true, "the stored message carries the new mention");
  } finally {
    await h.stop();
  }
});

test("late input edits: removing the bot mention from the trigger before anything was sent cancels", async () => {
  const h = await startHarness({
    toml: LATE(),
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : { ...send("never"), delayMs: 300 }),
  });
  try {
    const id = h.say("@bot oops wrong person", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.edit(id, "oops wrong person", { mention: false });
    await h.until(settledAll(h), "settled");
    assert.equal(h.sends.length, 0, "nothing is sent once the mention is withdrawn");
    assert.ok(hasLog(h, "late_input_cancel_requested", { kind: "unmention" }));
    assert.equal(sessionRows(h)[0]!.status, "discarded");
  } finally {
    await h.stop();
  }
});
