/**
 * Deleted messages end to end (ARCHITECTURE.md §6 "Message edits"): a Discord
 * deletion and a Matrix redaction (own and a moderator's) mark the stored
 * message and keep its content; nothing is re-indexed or re-summarized; the next
 * session sees the deletion placeholder.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, type FakeLlmRequest } from "./helpers/fake-llm.js";
import type { CanonicalChatEvent } from "../src/types.js";

function storedOf(h: AppHarness, externalId: string): { body: string; event: CanonicalChatEvent; updated_at: number } {
  const [row] = h.query<{ body: string; event_json: string; updated_at: number }>(
    "select body, event_json, updated_at from timeline_events where external_id = ?",
    externalId,
  );
  assert.ok(row, `stored: ${externalId}`);
  return { body: row.body, event: JSON.parse(row.event_json) as CanonicalChatEvent, updated_at: row.updated_at };
}

function deletionLogs(h: AppHarness, externalId: string) {
  return h.logs.filter((l) => l.message === "message_deletion_observed" && l.targetExternalId === externalId);
}

function userText(req: FakeLlmRequest): string {
  return req.body.messages.filter((m) => m.role === "user").map((m) => messageText(m)).join("\n");
}

test("deletions mark the stored message, keep its content, and touch nothing else", async () => {
  const h = await startHarness({ script: () => ({ text: "NO_REPLY" }) });
  try {
    const plain = h.say("a message that gets deleted");
    const own = h.say("a message its sender redacts");
    const moderated = h.say("a message a moderator redacts");
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", moderated).length === 1, "stored");
    const before = storedOf(h, plain);
    const chatIndexBefore = JSON.stringify(h.query("select * from chat_index order by event_id"));

    h.remove(plain);
    h.redact(own, { timestamp: 7_000 });
    h.redact(moderated, { by: "@mod:fake", timestamp: 8_000 });
    h.redact("$not-a-stored-message");
    await h.until(() => h.logs.filter((l) => l.message === "message_deletion_observed").length === 3, "all deletions observed");

    const a = storedOf(h, plain);
    assert.equal(a.body, "a message that gets deleted");
    assert.equal(a.event.body, "a message that gets deleted");
    assert.equal(typeof a.event.deleted?.at, "number");
    assert.equal(a.event.deleted?.by, undefined, "a Discord deletion names no deleter");
    assert.equal(a.updated_at, before.updated_at);
    assert.deepEqual(storedOf(h, own).event.deleted, { at: 7_000, by: "@alice:fake" });
    assert.deepEqual(storedOf(h, moderated).event.deleted, { at: 8_000, by: "@mod:fake" });
    assert.equal(storedOf(h, moderated).body, "a message a moderator redacts");
    assert.equal(h.query("select * from pending_edits").length, 0, "an unknown target is dropped, never parked");

    // Nothing re-indexed, re-enriched, re-summarized.
    assert.ok(!h.logs.some((l) => l.message === "edit_applied"));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(JSON.stringify(h.query("select * from chat_index order by event_id")), chatIndexBefore, "search index unchanged");
    assert.equal(h.query("select * from summarization_jobs").length, 0);

    // An edit, by contrast, re-indexes its message at once.
    const edited = h.say("a message that gets edited");
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", edited).length === 1, "stored");
    h.edit(edited, "an edited message");
    await h.until(() => h.logs.some((l) => l.message === "edit_applied"), "edit applied");
    await h.until(() => h.query("select 1 from chat_index where body like '%edited message%'").length === 1, "the edit is re-indexed");

    // A repeated deletion changes nothing.
    h.redact(moderated, { by: "@other:fake", timestamp: 9_000 });
    await h.until(() => deletionLogs(h, moderated).length === 2, "repeat observed");
    assert.equal(deletionLogs(h, moderated)[1]?.marked, false);
    assert.deepEqual(storedOf(h, moderated).event.deleted, { at: 8_000, by: "@mod:fake" });
  } finally {
    await h.stop();
  }
});

test("the next session sees a deleted message as the placeholder, never its content", async () => {
  const h = await startHarness({
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : { text: "NO_REPLY" }),
  });
  try {
    const gone = h.say("the secret launch code is 1234");
    const moderated = h.say("something rude");
    await h.until(() => h.query("select 1 from timeline_events where external_id = ?", moderated).length === 1, "stored");
    h.remove(gone);
    h.redact(moderated, { by: "@mod:fake" });
    await h.until(() => h.logs.filter((l) => l.message === "message_deletion_observed").length === 2, "deleted");
    h.say("what did I miss?", { mention: true });
    await h.until(() => h.llm.requests.some((r) => !isRecordTurnRequest(r)), "a session request");
    const text = userText(h.llm.requests.find((r) => !isRecordTurnRequest(r))!);
    assert.ok(!text.includes("launch code") && !text.includes("something rude"), "deleted content never reaches the model");
    assert.ok(text.includes("[message deleted]"));
    assert.ok(text.includes("[message deleted by @mod:fake]"), "a moderator's deletion names the moderator");
  } finally {
    await h.stop();
  }
});
