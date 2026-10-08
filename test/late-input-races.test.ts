/**
 * App-level regression tests for late-input races and edge cases (ARCHITECTURE.md
 * §8 "Late input"): a held send and a redo decided around the same moment, a
 * correction while the first send executes, the run-ending window, revival vs
 * the expiry timer, mention edits, the `max_folded` bound, and routing a
 * follow-up when the sender has a newer queued request.
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

const DECIDER = (lateAddition: Record<string, number> = {}) => `
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

[decisions.late_addition]
enabled = true
threshold = 0.7
${Object.entries(lateAddition).map(([k, v]) => `${k} = ${v}`).join("\n")}
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

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

function sessionRows(h: AppHarness) {
  return h.query<{ id: string; status: string; redo_count: number }>(
    "select id, status, redo_count from agent_sessions order by created_at, rowid",
  );
}

function branches(h: AppHarness) {
  return h.query<{ session_id: string; reason: string }>(
    "select session_id, reason from agent_session_branches order by session_id, branch_no",
  );
}

function transcript(h: AppHarness, sessionId: string): Array<Record<string, any>> {
  const [row] = h.query<{ transcript_json: string | null }>(
    "select transcript_json from agent_session_payloads where session_id = ?",
    sessionId,
  );
  return row?.transcript_json ? JSON.parse(row.transcript_json) : [];
}

const bodies = (h: AppHarness) => h.sends.map((s) => (s.msg as { body?: string }).body);

const settledAll = (h: AppHarness) => () => {
  const rows = sessionRows(h);
  return rows.length > 0 && rows.every((r) => r.status !== "running" && r.status !== "created");
};

test("late input races: a judged addition decided while the first send is held redoes, never sends twice", async () => {
  // The verdict arrives after the hold deadline, so the send is waiting only for
  // it: the redo must be filed before the hold lets the uncorrected send out.
  const h = await startHarness({
    toml: LATE({ hold_ms: 700 }) + DECIDER(),
    decideNoul: () => new Promise((r) => setTimeout(() => r(0.9), 1200)),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      return { ...send(userText(req).includes("in Celsius") ? "20 C" : "68 F"), delayMs: 150 };
    },
  });
  try {
    h.say("temperature in Rome?", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("in Celsius please");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(bodies(h), ["20 C"], "only the corrected answer is sent");
    assert.ok(branches(h).some((b) => b.reason === "addition_redo"));
  } finally {
    await h.stop();
  }
});

test("late input races: an edit while the first send executes interjects instead of redoing", async () => {
  let sendInFlight!: () => void;
  const inFlight = new Promise<void>((r) => (sendInFlight = r));
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((r) => (releaseSend = r));
  let firstSend = true;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const t = userText(req);
      if (t.includes("edited the message")) return { toolCalls: [{ name: "no_reply", args: {} }] };
      return send(t.includes("Paris") ? "weather in Paris" : "weather in Lyon");
    },
    onSend: async () => {
      if (!firstSend) return;
      firstSend = false;
      sendInFlight();
      await sendGate; // delivered, the provider has not returned yet
    },
  });
  try {
    const id = h.say("weather in Lyon?", { mention: true });
    await inFlight;
    h.edit(id, "weather in Paris?", { mention: true });
    await new Promise((r) => setTimeout(r, 300));
    releaseSend();
    await h.until(settledAll(h), "settled");
    assert.ok(!branches(h).some((b) => b.reason === "edit_redo"), "no redo after a delivered send");
    assert.deepEqual(bodies(h), ["weather in Lyon"], "the answer is not sent twice");
    assert.ok(hasLog(h, "late_input_interjected"), "the edit is interjected");
  } finally {
    await h.stop();
  }
});

test("late input races: deleting the trigger while the first send executes does not discard the session", async () => {
  let sendInFlight!: () => void;
  const inFlight = new Promise<void>((r) => (sendInFlight = r));
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((r) => (releaseSend = r));
  let firstSend = true;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (userText(req).includes("deleted the message")) return { toolCalls: [{ name: "no_reply", args: {} }] };
      return send("hello");
    },
    onSend: async () => {
      if (!firstSend) return;
      firstSend = false;
      sendInFlight();
      await sendGate;
    },
  });
  try {
    const id = h.say("hi", { mention: true });
    await inFlight;
    h.remove(id);
    await new Promise((r) => setTimeout(r, 300));
    releaseSend();
    await h.until(settledAll(h), "settled");
    assert.equal(h.sends.length, 1);
    assert.notEqual(sessionRows(h)[0]!.status, "discarded", "a session that delivered a message is not discarded as cancelled");
    assert.ok(!hasLog(h, "late_input_cancelled"));
  } finally {
    await h.stop();
  }
});

test("late input races: an edit sent before the run end that lands while the run is ending revives it", async () => {
  let h!: AppHarness;
  let edited = false;
  let triggerId = "";
  let triggerTs = 0;
  h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      // Before the edit the request is not for the bot; after it, it is.
      if (userText(req).includes("please answer")) return send("answered");
      return { text: "NO_REPLY" };
    },
    onTyping: async (on) => {
      if (on || edited || h === undefined || !triggerId) return;
      edited = true;
      // Written before the run ended (server time), delivered while it ends.
      h.edit(triggerId, "hello bot, please answer", { mention: true, timestamp: triggerTs + 1 });
      await h.until(() => h.logs.some((l) => l.message === "edit_applied"), "the edit applied");
    },
  });
  try {
    triggerTs = Date.now();
    triggerId = h.say("hello bot", { mention: true, timestamp: triggerTs });
    await h.until(() => edited, "the edit was made");
    await h.until(() => h.sends.length >= 1 && settledAll(h)(), "the edit was answered");
    assert.deepEqual(bodies(h), ["answered"]);
    assert.ok(hasLog(h, "late_input_revived"), "revived with the edit");
  } finally {
    await h.stop();
  }
});

test("late input races: an edit landing while the run is ending leaves no stale redo behind", async () => {
  let h!: AppHarness;
  let edited = false;
  let triggerId = "";
  h = await startHarness({
    toml: LATE({ hold_ms: 0 }) + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const t = userText(req);
      if (t.includes("and in Osaka")) return send("addendum");
      if (t.includes("edited the message")) return send("answer");
      // Nothing sent before the edit: a redo would still have been possible.
      return { text: "NO_REPLY" };
    },
    onTyping: async (on) => {
      if (on || edited || h === undefined || !triggerId) return;
      edited = true;
      h.edit(triggerId, "what time is it in Kyoto", { mention: true });
      await h.until(() => h.logs.some((l) => l.message === "edit_applied"), "the edit applied");
    },
  });
  try {
    const sentAt = Date.now();
    triggerId = h.say("what time is it in Tokyo", { mention: true, timestamp: sentAt });
    await h.until(() => edited && hasLog(h, "late_input_revived"), "the edit revived the ending session");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled after the edit");
    // A later revival must not find a stale restart from that edit.
    h.say("and in Osaka", { timestamp: sentAt + 1 });
    await h.until(() => h.sends.length >= 2 && settledAll(h)(), "the second revival sent");
    assert.deepEqual(bodies(h), ["answer", "addendum"]);
    assert.ok(!hasLog(h, "late_input_redo"), "no stale redo");
  } finally {
    await h.stop();
  }
});

test("late input races: a revival late in the window is not torn down by the first run's expiry", async () => {
  let n = 0;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0, revive_max_ms: 1500 }) + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      return n === 1 ? send("answer") : { ...send("addendum"), delayMs: 1200 };
    },
  });
  try {
    const sentAt = Date.now();
    h.say("what time is it in Tokyo", { mention: true, timestamp: sentAt });
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "first run");
    await new Promise((r) => setTimeout(r, 900));
    h.say("and in Osaka", { timestamp: sentAt + 1 });
    await h.until(() => hasLog(h, "late_input_revived"), "revived");
    await h.until(() => h.sends.length >= 2 && settledAll(h)(), "the revived run sent and settled");
    await new Promise((r) => setTimeout(r, 300));
    const [row] = sessionRows(h);
    const messages = transcript(h, row!.id);
    const sentInTranscript = JSON.stringify(messages).includes("addendum");
    assert.ok(sentInTranscript, "the revived run's turns are persisted");
  } finally {
    await h.stop();
  }
});

test("late input races: at most max_folded additions join, however many are judged at once", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE({ hold_ms: 2500 }) + DECIDER({ max_folded: 1 }),
    decideNoul: () => new Promise((r) => setTimeout(() => r(0.9), 200)),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (first) {
        first = false;
        return { ...send("first"), delayMs: 400 };
      }
      return send("done");
    },
  });
  try {
    h.say("plan a trip", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("to Rome");
    h.say("in May");
    h.say("for two");
    await h.until(() => settledAll(h)() && h.sends.length >= 1, "settled");
    await new Promise((r) => setTimeout(r, 300));
    const joined = h.logs.filter((l) => l.message === "late_input_addition");
    assert.equal(joined.length, 1, "one addition joined");
    const last = h.llm.requests.filter((r) => !isRecordTurnRequest(r)).at(-1)!;
    const parts = ["to Rome", "in May", "for two"].filter((p) => userText(last).includes(p));
    assert.equal(parts.length, 1, `only one addition is part of the request (${parts.join(", ")})`);
  } finally {
    await h.stop();
  }
});

test("late input races: a follow-up to a queued newer request does not redo the older running one", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }) + FOLLOWUP,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const t = userText(req);
      if (first) {
        first = false;
        return { ...send("sunny"), delayMs: 800 };
      }
      return send(t.includes("translate") ? "Hallo" : "?");
    },
  });
  try {
    h.say("weather in Rome?", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    h.say("translate 'hello'", { mention: true });
    await h.until(() => hasLog(h, "trigger_not_spawned", { action: "queued" }), "the second request is queued");
    h.say("into German");
    await h.until(() => sessionRows(h).length >= 2 && settledAll(h)() && h.sends.length >= 2, "both requests answered");
    const firstSession = sessionRows(h)[0]!.id;
    assert.ok(!branches(h).some((b) => b.session_id === firstSession), "the weather session is not redone");
    const weatherRequests = h.llm.requests.filter((r) => !isRecordTurnRequest(r) && userText(r).includes("weather in Rome") && !userText(r).includes("translate"));
    assert.ok(weatherRequests.every((r) => !userText(r).includes("into German")), "the follow-up never joined the weather request");
  } finally {
    await h.stop();
  }
});

test("late input races: the hold waits for a late-addition verdict at most max_hold_ms plus the point's timeout", async () => {
  const h = await startHarness({
    toml: LATE({ hold_ms: 300, max_hold_ms: 800 }) + DECIDER({ timeout_ms: 500 }) + "\n[enrichment]\ntrigger_wait_timeout_ms = 8000\n",
    decideNoul: () => 0.9,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : { ...send("a cat"), delayMs: 100 }),
  });
  try {
    const started = Date.now();
    h.say("what is this?", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    // An image candidate: judging it waits for its download first.
    h.say("", { attachments: [{ id: "att-1", mediaType: "image", mimeType: "image/png", filename: "cat.png", sizeBytes: 10, remoteUrl: "mxc://fake/cat" } as never] });
    await h.until(() => h.sends.length >= 1, "the send", 15_000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `the send was not held for the whole download wait (${elapsed} ms)`);
    assert.ok(hasLog(h, "late_input_verdict_timeout"));
  } finally {
    await h.stop();
  }
});

test("late input races: a cancel undoes the session's reaction before discarding it", async () => {
  const reactions: string[] = [];
  let n = 0;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    channelClient: {
      react: async (id: string, emoji: string) => {
        reactions.push(`+${id}:${emoji}`);
        return { display: emoji };
      },
      unreact: async (id: string, emoji: string) => {
        reactions.push(`-${id}:${emoji}`);
        return { removed: 1 };
      },
    },
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      if (n === 1) return { toolCalls: [{ name: "react", args: { message_id: "$user1", emoji: "👀" } }] };
      return { ...send("never"), delayMs: 800 };
    },
  });
  try {
    const id = h.say("hi bot", { mention: true });
    await h.until(() => reactions.length >= 1 && h.llm.requests.length >= 2, "reacted, then the next request");
    h.remove(id);
    await h.until(settledAll(h), "settled");
    assert.equal(h.sends.length, 0);
    assert.equal(sessionRows(h)[0]!.status, "discarded");
    assert.deepEqual(reactions, ["+$user1:👀", "-$user1:👀"], "the reaction was removed");
  } finally {
    await h.stop();
  }
});

test("late input races: after a partial compensation, an undone reaction is never undone again", async () => {
  const unreacts: string[] = [];
  let n = 0;
  let edits = 0;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0 }),
    channelClient: {
      react: async (_id: string, emoji: string) => ({ display: emoji }),
      unreact: async (_id: string, emoji: string) => {
        unreacts.push(emoji);
        if (emoji === "👀") throw new Error("forbidden");
        return { removed: 1 };
      },
    },
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      if (n === 1) return { toolCalls: [{ name: "react", args: { message_id: "$user1", emoji: "👀" } }] };
      if (n === 2) return { toolCalls: [{ name: "react", args: { message_id: "$user1", emoji: "👍" } }] };
      if (n <= 4) return { ...send("slow"), delayMs: 700 };
      return { toolCalls: [{ name: "no_reply", args: {} }] };
    },
  });
  try {
    const id = h.say("hi bot", { mention: true });
    for (const body of ["hi bot!", "hi bot!!"]) {
      const want = ++edits;
      await h.until(() => h.llm.requests.filter((r) => !isRecordTurnRequest(r)).length >= 2 + want, `request ${2 + want}`);
      h.edit(id, body, { mention: true });
      const applied = (l: Record<string, unknown>) =>
        l.message === "late_input_redo_impossible" || (l.message === "late_input_interjected" && l.reason === "compensation_failed");
      await h.until(() => h.logs.filter(applied).length >= want, `correction ${want} applied`);
    }
    await h.until(settledAll(h), "settled");
    assert.equal(unreacts.filter((e) => e === "👍").length, 1, "the compensated reaction is undone once");
  } finally {
    await h.stop();
  }
});

test("late input races: an addition arriving after the trigger's hold bound still gets its verdict honoured", async () => {
  let first = true;
  const h = await startHarness({
    toml: LATE({ hold_ms: 300, extend_ms: 200, max_hold_ms: 800 }) + DECIDER({ timeout_ms: 500 }),
    decideNoul: () => new Promise((r) => setTimeout(() => r(0.95), 100)),
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const reply = send(userText(req).includes("in Celsius") ? "20 C" : "68 F");
      if (first) {
        first = false;
        return { ...reply, delayMs: 3000 };
      }
      return reply;
    },
  });
  try {
    h.say("temperature in Rome?", { mention: true });
    await h.until(() => h.llm.requests.length >= 1, "first request");
    // Inside the candidate window and before any delivery, but after the
    // trigger's arrival + max_hold_ms + timeout_ms (1.3 s).
    await new Promise((r) => setTimeout(r, 1600));
    h.say("in Celsius please");
    await h.until(() => h.sends.length >= 1, "a send", 15_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!hasLog(h, "late_input_verdict_timeout"), "a 100 ms verdict is not discarded as a timeout");
    assert.deepEqual(bodies(h), ["20 C"]);
  } finally {
    await h.stop();
  }
});

test("late input races: a send the output gate blocked does not stop a later edit from redoing", async () => {
  let n = 0;
  const h = await startHarness({
    toml: LATE({ hold_ms: 0, extend_ms: 0, max_hold_ms: 0 }) + `
[checks.style_vocab]
kind = "style"
remedy = "revise"
agent_explanation = "Uses stock vocabulary ({matched})."
words = ["delve"]
min_chars = 1
`,
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      n += 1;
      if (req.body.messages.some((m) => messageText(m).includes("in Kyoto"))) return send("Kyoto answer");
      if (n === 1) return send("let us delve into Tokyo time");
      return { ...send("Tokyo answer"), delayMs: 1500 };
    },
  });
  try {
    const id = h.say("what time is it in Tokyo", { mention: true });
    await h.until(() => h.llm.requests.filter((r) => !isRecordTurnRequest(r)).length >= 2, "blocked once, the revised request in flight");
    h.edit(id, "what time is it in Kyoto", { mention: true });
    await h.until(settledAll(h), "settled", 15_000);
    assert.ok(hasLog(h, "late_input_redo"), "the edit redid the session");
    assert.ok(!hasLog(h, "late_input_interjected"), "the blocked send is no effect to interject after");
    assert.deepEqual(bodies(h), ["Kyoto answer"]);
  } finally {
    await h.stop();
  }
});

test("late input races: a correction while a redo compensates joins the rebuild, no stale rollout runs", async () => {
  let reacted = false;
  let compensating = false;
  const allText = (req: FakeLlmRequest) => req.body.messages.map((m) => messageText(m)).join("\n");
  const h = await startHarness({
    toml: LATE({ hold_ms: 0, extend_ms: 0, max_hold_ms: 0, first_event_wait_ms: 100 }),
    channelClient: {
      react: async (_id: string, emoji: string) => ({ display: emoji }),
      unreact: async () => {
        compensating = true;
        await new Promise((r) => setTimeout(r, 1000));
        return { removed: 1 };
      },
    },
    script: (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      const t = allText(req);
      if (!reacted) {
        reacted = true;
        return { toolCalls: [{ name: "react", args: { message_id: "$user1", emoji: "👀" } }] };
      }
      if (t.includes("not executed: the request changed")) return { text: "NO_REPLY" };
      const v = t.includes("v3") ? "v3" : t.includes("v2") ? "v2" : "v1";
      return { ...send(`answer ${v}`), delayMs: v === "v1" ? 1500 : 300 };
    },
  });
  try {
    const id = h.say("v1 hi bot", { mention: true });
    await h.until(() => reacted && h.llm.requests.length >= 2, "reacted, next request in flight");
    h.edit(id, "v2 hi bot", { mention: true });
    await h.until(() => compensating, "compensation running");
    await new Promise((r) => setTimeout(r, 200));
    h.edit(id, "v3 hi bot", { mention: true });
    await h.until(settledAll(h), "settled", 15_000);
    assert.deepEqual(bodies(h), ["answer v3"]);
    const stale = h.llm.requests.filter((r) => !isRecordTurnRequest(r) && allText(r).includes("not executed: the request changed"));
    assert.equal(stale.length, 0, "no rebuilt rollout ran with a redo pending");
    assert.equal(h.logs.filter((l) => l.message === "late_input_redo" && l.phase !== "building").length, 1, "one redo");
  } finally {
    await h.stop();
  }
});
