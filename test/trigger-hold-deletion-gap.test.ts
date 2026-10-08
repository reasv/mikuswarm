import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

// ---------------------------------------------------------------------------
// A request withdrawn before its session launched (ARCHITECTURE.md §8 "Late
// input"): a trigger its sender deletes during the trigger hold, while it is
// queued behind a running session, or while a reply-resume waits, is never
// answered; a moderator's deletion leaves the request alone.
// ---------------------------------------------------------------------------

const LATE = `\n[agent.sessions.late_input]\nenabled = true\nhold_ms = 1500\nextend_ms = 500\nmax_hold_ms = 5000\nfirst_event_wait_ms = 3000\n`;
const send = (message: string): FakeLlmReply => ({ toolCalls: [{ name: "send_message", args: { message, is_reply: false, final: true } }] });
const rows = (h: AppHarness) =>
  h.query<{ id: string; status: string; trigger_event_id: string }>("select id, status, trigger_event_id from agent_sessions order by created_at, rowid");
const settled = (h: AppHarness) => () => {
  const r = rows(h);
  return r.length > 0 && r.every((x) => x.status !== "running" && x.status !== "created");
};
const marked = (h: AppHarness, n = 1) => () =>
  h.logs.filter((l) => l.message === "message_deletion_observed" && l.marked === true).length >= n;
const bodies = (h: AppHarness) => h.sends.map((s) => JSON.stringify(s.msg));

test("a trigger deleted by its sender during the trigger hold is never answered (no session)", async () => {
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 400,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send(`answer ${h.sends.length + 1}`)),
  });
  try {
    // The room is active (its first trigger activated it).
    h.say("hello", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => h.sends.length === 1 && settled(h)(), "first answered");
    const id = h.say("oops wrong room", { mention: true });
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", id).length === 1, "raw emission stored");
    h.redact(id);
    await h.until(marked(h), "marked");
    await h.until(() => h.logs.some((l) => l.message === "late_input_ignored" && l.reason === "deleted_before_launch"), "held trigger dropped");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.sends.length, 1, `answered a deleted trigger: ${bodies(h).join(" | ")}`);
    assert.equal(rows(h).length, 1, "no session row for the deleted trigger");
  } finally {
    await h.stop();
  }
});

test("the first trigger of an inactive room, deleted during the hold, is cancelled at launch (activation path)", async () => {
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 400,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("answer to a deleted message")),
  });
  try {
    const id = h.say("oops wrong room", { mention: true });
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", id).length === 1, "raw emission stored");
    h.redact(id);
    await h.until(marked(h), "marked");
    await h.until(() => rows(h).length === 1 && settled(h)(), "session settled", 8000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.sends.length, 0, `answered a deleted trigger: ${bodies(h).join(" | ")}`);
    assert.equal(rows(h)[0]!.status, "discarded");
    assert.equal(h.llm.requests.length, 0, "nothing was built or sent");
  } finally {
    await h.stop();
  }
});

test("a moderator's deletion during the trigger hold leaves the request: it is answered", async () => {
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 400,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send("still answered")),
  });
  try {
    const id = h.say("a question", { mention: true });
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", id).length === 1, "raw emission stored");
    h.redact(id, { by: "@mod:fake" });
    await h.until(marked(h), "marked");
    await h.until(() => h.sends.length === 1, "answered", 8000);
    assert.ok(h.logs.some((l) => l.message === "late_input_ignored" && l.reason === "deleted_by_other"));
  } finally {
    await h.stop();
  }
});

test("a queued trigger deleted before it launches is cancelled at launch, before anything is built", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstSeen = false;
  const h = await startHarness({
    toml: LATE,
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (!firstSeen) {
        firstSeen = true;
        await gate;
        return send("first answer");
      }
      return send("answer to a deleted message");
    },
  });
  try {
    h.say("first question", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => firstSeen, "first session running");
    const id = h.say("second question I then delete", { mention: true });
    await h.until(() => h.logs.some((l) => l.message === "trigger_not_spawned"), "second trigger queued");
    h.remove(id);
    await h.until(marked(h), "marked");
    release();
    await h.until(() => rows(h).length === 2 && settled(h)(), "both settled", 8000);
    assert.ok(!bodies(h).some((b) => b.includes("answer to a deleted message")), `answered a deleted queued trigger: ${bodies(h).join(" | ")}`);
    const second = rows(h)[1]!;
    assert.equal(second.status, "discarded");
    assert.ok(h.logs.some((l) => l.message === "late_input_cancelled" && l.sessionId === second.id && l.phase === "launch"));
    assert.equal(
      h.llm.requests.filter((r) => !isRecordTurnRequest(r)).length,
      1,
      "the cancelled session never sent a request",
    );
  } finally {
    await h.stop();
  }
});

test("a grouped part deleted before launch leaves the group without a redo", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstSeen = false;
  const seen: FakeLlmRequest[] = [];
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 300,
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (!firstSeen) {
        firstSeen = true;
        await gate;
        return send("first answer");
      }
      seen.push(req);
      return send("second answer");
    },
  });
  try {
    h.say("first question", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => firstSeen, "first session running");
    h.say("look at this", { mention: true });
    const part = h.say("SECRET-PART please ignore");
    await h.until(() => h.logs.some((l) => l.message === "trigger_not_spawned"), "trigger queued with its group");
    h.remove(part);
    await h.until(marked(h), "marked");
    release();
    await h.until(() => rows(h).length === 2 && settled(h)(), "both settled", 8000);
    assert.ok(bodies(h).some((b) => b.includes("second answer")), "the request is still answered");
    const final = JSON.stringify(seen[0]!.body.messages.at(-1));
    assert.ok(final.includes("look at this"));
    assert.ok(!final.includes("SECRET-PART"), "the deleted part left the request");
    assert.equal(h.query<{ redo_count: number }>("select redo_count from agent_sessions where id = ?", rows(h)[1]!.id)[0]!.redo_count, 0);
  } finally {
    await h.stop();
  }
});

test("a queued reply deleted before it launches is never resumed nor answered", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await startHarness({
    toml: `${LATE}revive_max_ms = 0\n\n[agent.sessions.resume]\nenabled = { group = true }\n`,
    script: async (req) => {
      if (isRecordTurnRequest(req)) {
        return { toolCalls: [{ name: "session_record_tool", args: { command: "create", file_text: "the record", finalize: true } }] };
      }
      const text = JSON.stringify(req.body.messages.at(-1));
      const assistants = req.body.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
      if (assistants.at(-1)?.tool_calls?.at(-1)?.function.name === "search_memory") return send("done");
      if (text.includes("[work]")) return { toolCalls: [{ name: "search_memory", args: { pattern: "x" } }] };
      if (text.includes("[block]")) {
        await gate;
        return send("unblocked");
      }
      return send("answer to a deleted reply");
    },
  });
  try {
    h.say("[work] first", { mention: true });
    await h.until(() => h.sends.length === 1 && settled(h)() && h.logs.some((l) => l.message === "session_record_written"), "first done");
    const botMessage = h.sends[0]!.externalId;
    await new Promise((r) => setTimeout(r, 200));
    h.say("[block] busy", { mention: true, sender: { id: "@carol:fake", displayName: "Carol", username: "carol" } });
    await h.until(() => rows(h).length === 2, "blocking session running");
    const id = h.say("and then?", { mention: true, replyTo: botMessage });
    await h.until(() => h.logs.some((l) => l.message === "trigger_not_spawned"), "reply queued");
    h.redact(id);
    await h.until(marked(h), "marked");
    release();
    await h.until(() => rows(h).length === 3 && settled(h)(), "settled", 8000);
    assert.ok(!h.logs.some((l) => l.message === "session_resume_started"), "a deleted reply never resumes");
    assert.ok(!bodies(h).some((b) => b.includes("answer to a deleted reply")), bodies(h).join(" | "));
    assert.equal(rows(h)[2]!.status, "discarded");
  } finally {
    await h.stop();
  }
});

// A message deleted and sent again, corrected, inside one trigger hold (the
// same sender, so one grouped request): the request goes on with the surviving
// part, re-rooted on it, whichever arrives first.
const lastUserText = (req: FakeLlmRequest) => JSON.stringify(req.body.messages.at(-1));

for (const order of ["delete then resend", "resend then delete"] as const) {
  test(`trigger hold, ${order}: the corrected message is answered, re-rooted on it`, async () => {
    const seen: FakeLlmRequest[] = [];
    const h = await startHarness({
      toml: LATE,
      triggerHoldMs: 600,
      script: (req) => {
        if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
        seen.push(req);
        return send(`answer ${h.sends.length + 1}`);
      },
    });
    try {
      h.say("hello", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
      await h.until(() => h.sends.length === 1 && settled(h)(), "first answered");
      const typo = h.say("whats teh tiem in tokyo", { mention: true });
      await h.until(() => h.query("select 1 from timeline_events where external_id = ?", typo).length === 1, "typo stored");
      let fixed: string;
      if (order === "delete then resend") {
        h.redact(typo);
        await h.until(marked(h), "marked");
        fixed = h.say("what's the time in Tokyo?", { mention: true });
      } else {
        fixed = h.say("what's the time in Tokyo?", { mention: true });
        await new Promise((r) => setTimeout(r, 50));
        h.redact(typo);
        await h.until(marked(h), "marked");
      }
      await h.until(() => h.sends.length === 2 && rows(h).length === 2 && settled(h)(), "the corrected message answered", 8000);
      const second = rows(h)[1]!;
      assert.equal(second.status, "completed");
      assert.equal(second.trigger_event_id, `evt-${fixed}`, "re-rooted on the surviving part");
      const final = lastUserText(seen.at(-1)!);
      assert.ok(final.includes("Tokyo?"), final);
      assert.ok(!final.includes("teh tiem"), `the deleted message is no part of the request: ${final}`);
      assert.ok(h.logs.some((l) => l.message === "late_input_rerooted" && l.to === `evt-${fixed}`));
    } finally {
      await h.stop();
    }
  });
}

test("trigger hold: every part of a grouped request deleted by its sender: nothing is answered", async () => {
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 600,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : send(`answer ${h.sends.length + 1}`)),
  });
  try {
    h.say("hello", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => h.sends.length === 1 && settled(h)(), "first answered");
    const a = h.say("first try", { mention: true });
    const b = h.say("second try", { mention: true });
    await h.until(() => h.query("select 1 from timeline_events where external_id in (?, ?)", a, b).length === 2, "both stored");
    h.redact(a);
    h.redact(b);
    await h.until(marked(h, 2), "both marked");
    await h.until(() => h.logs.some((l) => l.message === "late_input_ignored" && l.reason === "deleted_before_launch"), "dropped");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.sends.length, 1);
    assert.equal(rows(h).length, 1);
  } finally {
    await h.stop();
  }
});

for (const order of ["delete then resend", "resend then delete"] as const) {
  test(`queued, ${order}: the corrected message is answered once its slot frees, re-rooted on it`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstSeen = false;
    const seen: FakeLlmRequest[] = [];
    const h = await startHarness({
      toml: LATE,
      triggerHoldMs: 400,
      script: async (req) => {
        if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
        if (!firstSeen) {
          firstSeen = true;
          await gate;
          return send("first answer");
        }
        seen.push(req);
        return send("second answer");
      },
    });
    try {
      h.say("first question", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
      await h.until(() => firstSeen, "first session running");
      const typo = h.say("whats teh tiem in tokyo", { mention: true });
      await h.until(() => h.query("select 1 from timeline_events where external_id = ?", typo).length === 1, "typo stored");
      let fixed: string;
      if (order === "delete then resend") {
        // Deleted within the hold: the request is re-rooted before it is queued.
        h.redact(typo);
        await h.until(marked(h), "marked");
        fixed = h.say("what's the time in Tokyo?", { mention: true });
        await h.until(() => h.logs.some((l) => l.message === "trigger_not_spawned"), "queued");
      } else {
        // Deleted while queued: the request is re-rooted when it launches.
        fixed = h.say("what's the time in Tokyo?", { mention: true });
        await h.until(() => h.logs.some((l) => l.message === "trigger_not_spawned"), "queued with its group");
        h.redact(typo);
        await h.until(marked(h), "marked");
      }
      release();
      await h.until(() => rows(h).length === 2 && settled(h)(), "both settled", 8000);
      assert.ok(bodies(h).some((b) => b.includes("second answer")), `the corrected message is answered: ${bodies(h).join(" | ")}`);
      const second = h.query<{ status: string; trigger_event_id: string; trigger_body: string; redo_count: number }>(
        "select status, trigger_event_id, trigger_body, redo_count from agent_sessions order by created_at, rowid",
      )[1]!;
      assert.equal(second.status, "completed");
      assert.equal(second.trigger_event_id, `evt-${fixed}`);
      assert.equal(second.trigger_body, "what's the time in Tokyo?");
      assert.equal(second.redo_count, 0, "re-rooted before anything was built");
      const final = lastUserText(seen[0]!);
      assert.ok(final.includes("Tokyo?") && !final.includes("teh tiem"), final);
      // The request resolves through its new root (a reply to it belongs to it).
      assert.equal(
        h.query<{ trigger_group_id: string | null }>("select trigger_group_id from timeline_events where external_id = ?", fixed)[0]!.trigger_group_id,
        `evt-${fixed}`,
      );
    } finally {
      await h.stop();
    }
  });
}

test("running: the trigger message deleted while its corrected resend stands redoes the request on the survivor", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = false;
  const seen: FakeLlmRequest[] = [];
  const h = await startHarness({
    toml: LATE,
    triggerHoldMs: 400,
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      seen.push(req);
      if (!blocked) {
        blocked = true;
        await gate;
      }
      return send(`answer ${seen.length}`);
    },
  });
  try {
    const typo = h.say("whats teh tiem in tokyo", { mention: true });
    const fixed = h.say("what's the time in Tokyo?", { mention: true });
    await h.until(() => blocked, "the grouped request is running");
    h.redact(typo);
    await h.until(() => h.logs.some((l) => l.message === "late_input_redo_requested" && l.kind === "delete_part"), "redo requested");
    release();
    await h.until(() => h.sends.length >= 1 && settled(h)(), "answered", 8000);
    assert.equal(h.sends.length, 1, bodies(h).join(" | "));
    const row = rows(h)[0]!;
    assert.equal(row.status, "completed", "not cancelled: a part survives");
    assert.equal(row.trigger_event_id, `evt-${fixed}`);
    const final = lastUserText(seen.at(-1)!);
    assert.ok(final.includes("Tokyo?") && !final.includes("teh tiem"), final);
  } finally {
    await h.stop();
  }
});
