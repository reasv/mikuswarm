import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { PendingDeletions } from "../src/timeline/pending-deletions.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { startHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest } from "./helpers/fake-llm.js";

// ---------------------------------------------------------------------------
// Deletions of messages not stored yet (ARCHITECTURE.md §6 "Message edits"):
// parked with a bounded TTL and size, applied when the message is appended.
// ---------------------------------------------------------------------------

const ROOM = "matrix:miku:room:!room:example.org";

function event(id: string, externalId: string, timelineKey = ROOM): CanonicalChatEvent {
  return {
    id,
    externalId,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_000,
    receivedAt: 1_100,
  };
}

test("PendingDeletions: matches the room or its threads, once; expires; is bounded", () => {
  let now = 0;
  const parked = new PendingDeletions({ ttlMs: 1_000, maxEntries: 2, now: () => now });
  parked.park("matrix", "$a", [ROOM], { at: 5, by: "@alice:example.org" });
  assert.equal(parked.take("matrix", "$a", "matrix:miku:room:!other:example.org"), undefined, "another room");
  assert.equal(parked.take("discord", "$a", ROOM), undefined, "another provider");
  assert.deepEqual(parked.take("matrix", "$a", `${ROOM}:thread:$root`), { at: 5, by: "@alice:example.org" }, "a thread of the room");
  assert.equal(parked.take("matrix", "$a", ROOM), undefined, "taken once");
  // Expiry.
  parked.park("matrix", "$b", [ROOM], { at: 6 });
  now = 1_001;
  assert.equal(parked.take("matrix", "$b", ROOM), undefined, "expired");
  // Bounded: the oldest go first; expired ones are swept on park.
  parked.park("matrix", "$c", [ROOM], { at: 7 });
  parked.park("matrix", "$d", [ROOM], { at: 8 });
  parked.park("matrix", "$e", [ROOM], { at: 9 });
  assert.equal(parked.size, 2);
  assert.equal(parked.take("matrix", "$c", ROOM), undefined, "evicted");
  assert.deepEqual(parked.take("matrix", "$e", ROOM), { at: 9 });
  now = 5_000;
  parked.park("matrix", "$f", [ROOM], { at: 10 });
  assert.equal(parked.size, 1, "the expired entry was swept");
});

test("PendingDeletions: two accounts sharing a room each park and take their own deletion", () => {
  const parked = new PendingDeletions();
  const other = "matrix:chen:room:!room:example.org";
  parked.park("matrix", "$m", [ROOM], { at: 1 });
  parked.park("matrix", "$m", [other], { at: 2 });
  assert.equal(parked.size, 2);
  assert.deepEqual(parked.take("matrix", "$m", other), { at: 2 });
  assert.deepEqual(parked.take("matrix", "$m", ROOM), { at: 1 });
  // One parking for several candidate rooms (a redaction's room and DM keys) is taken once.
  parked.park("matrix", "$r", [ROOM, "matrix:miku:dm:!room:example.org"], { at: 3 });
  assert.equal(parked.size, 1);
  assert.deepEqual(parked.take("matrix", "$r", "matrix:miku:dm:!room:example.org"), { at: 3 });
  assert.equal(parked.take("matrix", "$r", ROOM), undefined);
  assert.equal(parked.size, 0);
});

test("appendIfMissing sets a parked deletion's marker in the insert, keeping the content", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    const result = await timeline.markDeleted("matrix", "$m", ROOM, { at: 2_000 });
    assert.deepEqual(result, { parked: true });
    const { event: stored, duplicate } = await timeline.appendIfMissing(event("matrix:miku:$m", "$m", `${ROOM}:thread:$root`), "skipped");
    assert.equal(duplicate, false);
    assert.deepEqual(stored.deleted, { at: 2_000 });
    const row = storage.getTimelineEventById("matrix:miku:$m")!;
    assert.deepEqual(row.deleted, { at: 2_000 });
    assert.equal(row.body, "hello");
    // Another message is untouched.
    const other = await timeline.appendIfMissing(event("matrix:miku:$n", "$n"), "skipped");
    assert.equal(other.event.deleted, undefined);
  } finally {
    storage.close();
  }
});

test("a deletion queued just ahead of its message's append is parked inside the write, so the append takes it", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    // Both on the single-writer queue, the deletion first: it finds nothing,
    // and the append runs before the deletion's caller resumes.
    const deletion = timeline.markDeleted("matrix", "$race", ROOM, { at: 3_000, by: "@alice:example.org" });
    const append = timeline.appendIfMissing(event("matrix:miku:$race", "$race"), "skipped");
    const [result, appended] = await Promise.all([deletion, append]);
    assert.deepEqual(result, { parked: true });
    assert.deepEqual(appended.event.deleted, { at: 3_000, by: "@alice:example.org" });
    assert.deepEqual(storage.getTimelineEventById("matrix:miku:$race")!.deleted, { at: 3_000, by: "@alice:example.org" });
    assert.equal(timeline.pendingDeletions.size, 0);
  } finally {
    storage.close();
  }
});

test("a redaction's candidate timelines are resolved inside the write (a thread message of the room)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    await timeline.appendIfMissing(event("matrix:miku:$t", "$t", `${ROOM}:thread:$root`), "skipped");
    const dmKey = "matrix:miku:dm:!room:example.org";
    const result = await timeline.markDeleted("matrix", "$t", ROOM, { at: 4_000 }, { lookupTimelineKeys: [dmKey, ROOM] });
    assert.ok("event" in result && result.changed);
    assert.equal(result.event.timelineKey, `${ROOM}:thread:$root`);
    // A target found elsewhere (a buffer) parks nothing.
    const elsewhere = await timeline.markDeleted("matrix", "$gone", ROOM, { at: 5_000 }, { markElsewhere: () => true });
    assert.deepEqual(elsewhere, { parked: false });
    assert.equal(timeline.pendingDeletions.size, 0);
  } finally {
    storage.close();
  }
});

test("app: a deletion that arrives before its message (still buffered) marks it when it lands; a deleted trigger is not answered", async () => {
  const h = await startHarness({
    toml: `\n[agent.sessions.late_input]\nenabled = true\n`,
    script: (req) => (isRecordTurnRequest(req) ? { text: "NO_REPLY" } : { toolCalls: [{ name: "send_message", args: { message: "answered", is_reply: false, final: true } }] }),
  });
  try {
    h.redact("$early");
    await h.until(() => h.logs.some((l) => l.message === "message_deletion_observed" && l.parked === true), "parked");
    h.say("ask me something", { mention: true, id: "$early" });
    await h.until(() => h.query("select 1 from timeline_events where external_id = '$early'").length === 1, "stored");
    const [row] = h.query<{ event_json: string }>("select event_json from timeline_events where external_id = '$early'");
    assert.equal(JSON.parse(row!.event_json).deleted.by, "@alice:fake");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(h.sends.length, 0, "a deleted trigger is never answered");
  } finally {
    await h.stop();
  }
});
