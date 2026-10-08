import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, LATEST_SCHEMA_VERSION } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// Deleted messages (ARCHITECTURE.md §6 "Message edits"): a deletion only marks
// the stored message, keeping its content; the v30→v31 migration marks the rows
// the old deletion path had wiped.

const ROOM_TK = "matrix:miku:room:!room:example.org";
const THREAD_TK = `${ROOM_TK}:thread:$root`;
const OTHER_TK = "matrix:miku2:room:!room:example.org";

function event(id: string, externalId: string, timelineKey: string, body: string, extra: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    externalId,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@user:example.org", displayName: "User", isSelf: false },
    body,
    timestamp: 1_000,
    receivedAt: 1_100,
    ...extra,
  };
}

async function withStorage(run: (storage: Storage, dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-deletion-"));
  const dbPath = path.join(dir, "test.db");
  try {
    await run(await Storage.open({ databasePath: dbPath }), dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function row(storage: Storage, id: string): { body: string; event_json: string; last_edit_timestamp: number | null; updated_at: number } {
  return storage.read((db) =>
    db.prepare(`select body, event_json, last_edit_timestamp, updated_at from timeline_events where id = ?`).get(id),
  ) as { body: string; event_json: string; last_edit_timestamp: number | null; updated_at: number };
}

test("markTimelineEventDeleted records when and by whom, keeps the content, and is idempotent", async () => {
  await withStorage(async (storage) => {
    const original = event("matrix:miku:$m", "$m", ROOM_TK, "hello there", {
      attachments: [{ id: "a1", mediaType: "image", filename: "cat.png" }],
    });
    await storage.appendTimelineEvent(original, "skipped");
    const before = row(storage, original.id);

    const first = await storage.markTimelineEventDeleted("matrix", "$m", ROOM_TK, { at: 5_000, by: "@mod:example.org" });
    assert.ok(first);
    assert.equal(first.changed, true);
    assert.deepEqual(first.event.deleted, { at: 5_000, by: "@mod:example.org" });

    const after = row(storage, original.id);
    assert.equal(after.body, "hello there", "the body column is kept");
    assert.equal(after.last_edit_timestamp, null, "a deletion is not an edit");
    assert.equal(after.updated_at, before.updated_at, "nothing else on the row changes");
    const stored = JSON.parse(after.event_json) as CanonicalChatEvent;
    assert.equal(stored.body, "hello there");
    assert.deepEqual(stored.attachments, original.attachments, "attachments are kept");
    assert.deepEqual(stored.deleted, { at: 5_000, by: "@mod:example.org" });

    const again = await storage.markTimelineEventDeleted("matrix", "$m", ROOM_TK, { at: 9_000 });
    assert.equal(again?.changed, false, "a repeated deletion changes nothing");
    assert.deepEqual((JSON.parse(row(storage, original.id).event_json) as CanonicalChatEvent).deleted, {
      at: 5_000,
      by: "@mod:example.org",
    });

    assert.equal(
      await storage.markTimelineEventDeleted("matrix", "$unknown", ROOM_TK, { at: 1 }),
      undefined,
      "a message the store does not have is not marked (and never parked)",
    );
    assert.equal(storage.read((db) => db.prepare(`select count(*) as n from pending_edits`).get() as { n: number }).n, 0);
    storage.close();
  });
});

test("getDeletedMessages finds deleted messages in the room and its threads, never another account's", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(event("matrix:miku:$a", "$a", ROOM_TK, "a"), "skipped");
    await storage.appendTimelineEvent(event("matrix:miku:$t", "$t", THREAD_TK, "t"), "skipped");
    await storage.appendTimelineEvent(event("matrix:miku:$live", "$live", ROOM_TK, "live"), "skipped");
    await storage.appendTimelineEvent(event("matrix:miku2:$o", "$o", OTHER_TK, "o"), "skipped");
    await storage.markTimelineEventDeleted("matrix", "$a", ROOM_TK, { at: 2 });
    await storage.markTimelineEventDeleted("matrix", "$t", THREAD_TK, { at: 3, by: "@x:example.org" });
    await storage.markTimelineEventDeleted("matrix", "$o", OTHER_TK, { at: 4 });
    const found = storage.getDeletedMessages(THREAD_TK, ["$a", "$t", "$live", "$o", "$missing"]);
    assert.deepEqual([...found.keys()].sort(), ["$a", "$t"]);
    assert.deepEqual(found.get("$t"), { at: 3, by: "@x:example.org" });
    storage.close();
  });
});

test("v30→v31 migration marks rows the old deletion path wiped, and nothing else", async () => {
  await withStorage(async (storage, dbPath) => {
    const rows: Array<[CanonicalChatEvent, number | null]> = [
      // Wiped by the old path: empty body, no attachments, edit time = deletion time.
      [event("discord:a:1", "1", "discord:a:room:c", "", { provider: "discord" }), 7_000],
      [event("matrix:miku:$w", "$w", ROOM_TK, "", { attachments: [] }), 8_000],
      // Not wiped: a message with content, an edit, an attachment-only edit, a bot
      // message, an empty message never edited, one already marked.
      [event("matrix:miku:$e", "$e", ROOM_TK, "edited text"), 6_000],
      [event("matrix:miku:$att", "$att", ROOM_TK, "", { attachments: [{ id: "x", mediaType: "image" }] }), 6_000],
      [event("matrix:miku:$bot", "$bot", ROOM_TK, "", { role: "assistant" }), 6_000],
      [event("matrix:miku:$empty", "$empty", ROOM_TK, ""), null],
      [event("matrix:miku:$done", "$done", ROOM_TK, "", { deleted: { at: 1, by: "@u:example.org" } }), 6_000],
    ];
    for (const [r] of rows) await storage.appendTimelineEvent(r, "skipped");
    await storage.write((db) => {
      const setEdited = db.prepare(`update timeline_events set last_edit_timestamp = ? where id = ?`);
      for (const [r, ts] of rows) if (ts !== null) setEdited.run(ts, r.id);
      db.pragma("user_version = 30");
    });
    const bodies = new Map(rows.map(([r]) => [r.id, row(storage, r.id).body]));
    storage.close();

    for (let pass = 0; pass < 2; pass++) {
      const reopened = await Storage.open({ databasePath: dbPath });
      try {
        assert.equal(reopened.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
        const deletedOf = (id: string) => (JSON.parse(row(reopened, id).event_json) as CanonicalChatEvent).deleted;
        assert.deepEqual(deletedOf("discord:a:1"), { at: 7_000 }, "time = last_edit_timestamp, deleter unknown");
        assert.deepEqual(deletedOf("matrix:miku:$w"), { at: 8_000 });
        assert.equal(deletedOf("matrix:miku:$e"), undefined);
        assert.equal(deletedOf("matrix:miku:$att"), undefined);
        assert.equal(deletedOf("matrix:miku:$bot"), undefined);
        assert.equal(deletedOf("matrix:miku:$empty"), undefined);
        assert.deepEqual(deletedOf("matrix:miku:$done"), { at: 1, by: "@u:example.org" }, "an existing marker is kept");
        for (const [id, body] of bodies) assert.equal(row(reopened, id).body, body, "no body changes");
        // Re-stamp so the second pass runs the step again: idempotent.
        if (pass === 0) await reopened.write((db) => db.pragma("user_version = 30"));
      } finally {
        reopened.close();
      }
    }
  });
});
