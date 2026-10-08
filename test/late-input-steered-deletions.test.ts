/**
 * Deleted messages steered into a session outside its trigger group (ARCHITECTURE.md
 * §8 "Late input"): an interjected late addition its sender deletes while the run is
 * live gets a deletion note (or is taken back while still unread); a moderator's
 * deletion and one after the run ended change nothing; a parked co-reply deleted
 * before its owner went live is never steered with its content.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

const LATE = (over: Record<string, number> = {}): string => {
  const knobs = { hold_ms: 0, extend_ms: 500, max_hold_ms: 5000, first_event_wait_ms: 3000, max_redos: 0, ...over };
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

function userText(req: FakeLlmRequest): string {
  return req.body.messages
    .filter((m) => m.role === "user")
    .map((m) => messageText(m))
    .join("\n");
}

const chatRequests = (h: AppHarness) => h.llm.requests.filter((r) => !isRecordTurnRequest(r));

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

const settledAll = (h: AppHarness) => () => {
  const rows = h.query<{ status: string }>("select status from agent_sessions");
  return rows.length > 0 && rows.every((r) => r.status !== "running" && r.status !== "created");
};

const NOTE = "deleted a message";

test("an interjected late addition its sender deletes after the session read it gets a deletion note", async () => {
  const h = await startHarness({
    toml: LATE() + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const text = userText(req);
      if (text.includes(NOTE)) return send("Paris, leaving that out");
      if (text.includes("of France")) return { ...send("Paris"), delayMs: 1500 };
      return { ...send("capital of what?"), delayMs: 800 };
    },
  });
  try {
    h.say("what's the capital", { mention: true });
    await h.until(() => chatRequests(h).length >= 1, "first request");
    const addition = h.say("of France");
    await h.until(() => chatRequests(h).some((r) => userText(r).includes("of France")), "the addition was read");
    h.remove(addition);
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    assert.ok(hasLog(h, "late_input_interjected", { kind: "delete_part" }), "a deletion note was interjected");
    const last = chatRequests(h).at(-1)!;
    assert.ok(userText(last).includes(NOTE), "the next request carries the note");
    assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["Paris, leaving that out"]);
  } finally {
    await h.stop();
  }
});

test("an interjected late addition deleted while still unread is taken back: the session never reads it", async () => {
  let firstStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await startHarness({
    toml: LATE({ first_event_wait_ms: 10_000 }) + FOLLOWUP,
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (!firstStarted) {
        firstStarted = true;
        // The first request is still waiting for its first event when the addition
        // is interjected (the abort waits for it), and when it is deleted.
        await gate;
        return send("capital of what?");
      }
      return send(userText(req).includes("of France") ? "Paris" : "which country?");
    },
  });
  try {
    h.say("what's the capital", { mention: true });
    await h.until(() => firstStarted, "first request");
    const addition = h.say("of France");
    await h.until(() => hasLog(h, "late_input_interjected"), "interjected");
    h.remove(addition);
    await h.until(() => hasLog(h, "late_input_withdrawn", { unread: true }), "withdrawn");
    release();
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    assert.ok(!chatRequests(h).some((r) => userText(r).includes("of France")), "the deleted addition never reached the model");
    assert.ok(!chatRequests(h).some((r) => userText(r).includes(NOTE)), "nothing to correct: no note");
  } finally {
    await h.stop();
  }
});

for (const variant of ["moderator", "after_run_end"] as const) {
  test(`an interjected addition: ${variant === "moderator" ? "a moderator's deletion" : "its sender's deletion after the run ended"} changes nothing`, async () => {
    const h = await startHarness({
      toml: LATE() + FOLLOWUP,
      script: (req) => {
        if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
        const text = userText(req);
        if (text.includes("of France")) return { ...send("Paris"), delayMs: variant === "moderator" ? 1200 : 0 };
        return { ...send("capital of what?"), delayMs: 800 };
      },
    });
    try {
      h.say("what's the capital", { mention: true });
      await h.until(() => chatRequests(h).length >= 1, "first request");
      const addition = h.say("of France");
      await h.until(() => chatRequests(h).some((r) => userText(r).includes("of France")), "the addition was read");
      if (variant === "moderator") {
        h.redact(addition, { by: "@mod:fake" });
        await h.until(() => hasLog(h, "late_input_ignored", { reason: "deleted_by_other" }), "moderator deletion seen");
        await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
      } else {
        await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
        h.remove(addition);
        await h.until(() => hasLog(h, "late_input_ignored", { reason: "after_run_end" }), "deletion after the run seen");
      }
      const requests = chatRequests(h).length;
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!chatRequests(h).some((r) => userText(r).includes(NOTE)), "no deletion note");
      assert.equal(chatRequests(h).length, requests, "nothing more was asked");
      assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["Paris"]);
    } finally {
      await h.stop();
    }
  });
}

test("a parked co-reply deleted by its sender before the owner went live is never steered", async () => {
  let releaseBusy!: () => void;
  const busy = new Promise<void>((r) => (releaseBusy = r));
  const h = await startHarness({
    toml: `\n[agent.sessions]\nmax_concurrent = 1\ncoalesce_window_ms = 60000\n` + LATE(),
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const text = userText(req);
      if (text.includes("unrelated question")) {
        await busy;
        return send("unrelated answer");
      }
      return send("answered the poll");
    },
  });
  try {
    const dave = { id: "@dave:fake", displayName: "Dave", username: "dave" };
    const bob = { id: "@bob:fake", displayName: "Bob", username: "bob" };
    const carol = { id: "@carol:fake", displayName: "Carol", username: "carol" };
    h.say("unrelated question", { mention: true, sender: dave });
    await h.until(() => chatRequests(h).length >= 1, "the busy session runs");
    const poll = h.say("pizza or pasta?", { sender: bob });
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", poll).length === 1, "stored");
    h.say("pizza, obviously", { mention: true, replyTo: poll });
    await h.until(() => hasLog(h, "trigger_not_spawned"), "alice's reply queued");
    const coReply = h.say("carol's secret pasta take", { mention: true, replyTo: poll, sender: carol });
    await h.until(() => hasLog(h, "co_reply_deferred"), "carol's co-reply parked");
    h.remove(coReply);
    await h.until(() => hasLog(h, "message_deletion_observed", { targetExternalId: coReply }), "deleted");
    releaseBusy();
    await h.until(() => settledAll(h)() && h.sends.length >= 2, "both sessions answered");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(hasLog(h, "late_input_ignored", { reason: "deleted_before_steer" }));
    assert.ok(!chatRequests(h).some((r) => userText(r).includes("secret pasta")), "the deleted co-reply never reached the model");
    assert.equal(h.query("select 1 from agent_sessions").length, 2, "nor started a session of its own");
  } finally {
    await h.stop();
  }
});

test("a parked co-reply a moderator deleted is steered as the placeholder, never its content", async () => {
  let releaseBusy!: () => void;
  const busy = new Promise<void>((r) => (releaseBusy = r));
  const h = await startHarness({
    toml: `\n[agent.sessions]\nmax_concurrent = 1\ncoalesce_window_ms = 60000\n` + LATE(),
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (userText(req).includes("unrelated question")) {
        await busy;
        return send("unrelated answer");
      }
      return send("answered the poll");
    },
  });
  try {
    const dave = { id: "@dave:fake", displayName: "Dave", username: "dave" };
    const bob = { id: "@bob:fake", displayName: "Bob", username: "bob" };
    const carol = { id: "@carol:fake", displayName: "Carol", username: "carol" };
    h.say("unrelated question", { mention: true, sender: dave });
    await h.until(() => chatRequests(h).length >= 1, "the busy session runs");
    const poll = h.say("pizza or pasta?", { sender: bob });
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", poll).length === 1, "stored");
    h.say("pizza, obviously", { mention: true, replyTo: poll });
    await h.until(() => hasLog(h, "trigger_not_spawned"), "alice's reply queued");
    const coReply = h.say("carol's rude pasta take", { mention: true, replyTo: poll, sender: carol });
    await h.until(() => hasLog(h, "co_reply_deferred"), "carol's co-reply parked");
    h.redact(coReply, { by: "@mod:fake" });
    await h.until(() => hasLog(h, "message_deletion_observed", { targetExternalId: coReply }), "deleted");
    releaseBusy();
    await h.until(() => hasLog(h, "co_reply_coalesced"), "steered");
    await h.until(() => settledAll(h)() && h.sends.length >= 2, "both sessions answered");
    assert.ok(!chatRequests(h).some((r) => userText(r).includes("rude pasta")), "the deleted content never reached the model");
    assert.ok(chatRequests(h).some((r) => userText(r).includes("[message deleted by")), "the placeholder did");
  } finally {
    await h.stop();
  }
});

test("a deleted revival addition that was part of the request, nothing irreversible yet: redone without it", async () => {
  let n = 0;
  const h = await startHarness({
    toml: LATE({ max_redos: 3 }) + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      if (n === 1) return { toolCalls: [{ name: "no_reply", args: {} }] };
      const text = userText(req);
      if (text.includes("and in Osaka")) return { toolCalls: [{ name: "no_reply", args: {} }], delayMs: 1500 };
      return send("Tokyo only");
    },
  });
  try {
    const trigger = h.say("what time is it in Tokyo", { mention: true });
    await h.until(() => settledAll(h)() && chatRequests(h).length >= 1, "first run");
    const triggerTs = h.query<{ timestamp: number }>("select timestamp from timeline_events where external_id = ?", trigger)[0]!.timestamp;
    const addition = h.say("and in Osaka", { timestamp: triggerTs + 1 });
    await h.until(() => hasLog(h, "late_input_revived"), "revived");
    await h.until(() => chatRequests(h).some((r) => userText(r).includes("and in Osaka")), "the revival was read");
    h.remove(addition);
    await h.until(() => hasLog(h, "late_input_redo_requested", { kind: "delete_part" }), "redo requested");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    const last = chatRequests(h).at(-1)!;
    assert.ok(!userText(last).includes("and in Osaka"), "the rebuilt session never sees the deleted addition");
    assert.ok(!userText(last).includes(NOTE), "a redo needs no note");
    assert.deepEqual(h.sends.map((s) => (s.msg as { body?: string }).body), ["Tokyo only"]);
  } finally {
    await h.stop();
  }
});

// A session without a late-input controller (a proactive or bot-triggered one)
// receiving a reply-steer: no redo is possible, but a deletion of the steered
// reply still reaches it, as the same short note (or taken back while unread).
// Driven here through a bot-triggered session, which shares the path.
const OTHER_BOT = { id: "@otherbot:fake", displayName: "OtherBot", isBot: true } as unknown as { id: string; displayName: string };

for (const read of [true, false]) {
  test(`no controller: a reply-steer its sender deletes ${read ? "after it was read gets the deletion note" : "while unread is taken back"}`, async () => {
    const h = await startHarness({
      toml: LATE(),
      script: (req) => {
        if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
        const text = userText(req);
        if (text.includes(NOTE)) return send("done, leaving it out");
        if (text.includes("my reply")) return { ...send("got your reply", false), delayMs: 1500 };
        if (chatRequests(h).length === 1) return send("posted", false);
        return { ...send("still working", !read), delayMs: 1500 };
      },
    });
    try {
      h.say("hey bot, do the thing", { mention: true, sender: OTHER_BOT });
      await h.until(() => h.sends.length === 1, "the bot-triggered session posted");
      const session = h.query<{ id: string }>("select id from agent_sessions")[0]!.id;
      const reply = h.say("my reply", { replyTo: h.sends[0]!.externalId });
      await h.until(() => hasLog(h, "reply_steered", { eventId: `evt-${reply}` }), "reply steered");
      if (read) await h.until(() => chatRequests(h).some((r) => userText(r).includes("my reply")), "the reply was read");
      h.remove(reply);
      await h.until(() => settledAll(h)(), "settled", 15000);
      if (read) {
        assert.ok(hasLog(h, "late_input_interjected", { sessionId: session, kind: "delete_part", controller: false }), "the note was steered");
        assert.ok(userText(chatRequests(h).at(-1)!).includes(NOTE), "the next request carries the note");
        assert.ok(userText(chatRequests(h).at(-1)!).includes("Leave it out."));
      } else {
        assert.ok(hasLog(h, "late_input_withdrawn", { sessionId: session, unread: true }), "taken back");
        assert.ok(!chatRequests(h).some((r) => userText(r).includes("my reply")), "never read");
        assert.ok(!chatRequests(h).some((r) => userText(r).includes(NOTE)), "no note for a reply never read");
      }
    } finally {
      await h.stop();
    }
  });
}
