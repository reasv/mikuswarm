import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// v19 → v20 repair of reply quotes stored with a target's pre-edit text: the
// provider's by-id lookup returned the original event, and an edit arriving
// after the reply never touched the stored quote.

const ROOM_TK = "matrix:miku:room:!room:example.org";
const THREAD_TK = `${ROOM_TK}:thread:$root`;
const OTHER_TK = "matrix:miku2:room:!room:example.org";

function event(id: string, externalId: string, timelineKey: string, body: string): CanonicalChatEvent {
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
  };
}

function quoteOf(storage: Storage, eventId: string): string | null | undefined {
  return storage.read(
    (db) =>
      (
        db.prepare(`select body from reply_contexts where event_id = ?`).get(eventId) as
          | { body: string | null }
          | undefined
      )?.body,
  );
}

test("v19→v20 migration repairs stale quotes of edited messages, scoped like getEditedBody", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-edited-quote-repair-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const rows: Array<[CanonicalChatEvent, number | null]> = [
        // Edited target in the room, and the same event under another account.
        [event("matrix:miku:$edited", "$edited", ROOM_TK, "the full edited text"), 5_000],
        [event("matrix:miku2:$edited", "$edited", OTHER_TK, "account two's own edit"), 5_000],
        // Edited target living in a thread.
        [event("matrix:miku:$threaded", "$threaded", THREAD_TK, "edited in the thread"), 5_000],
        // Never edited: its quote must not change even if it differs.
        [event("matrix:miku:$plain", "$plain", ROOM_TK, "plain stored body"), null],
        // Quoting events.
        [event("matrix:miku:$q1", "$q1", ROOM_TK, "reply"), null],
        [event("matrix:miku:$q2", "$q2", THREAD_TK, "thread reply"), null],
        [event("matrix:miku:$q3", "$q3", ROOM_TK, "reply to threaded"), null],
        [event("matrix:miku:$q4", "$q4", ROOM_TK, "reply to plain"), null],
        [event("matrix:miku:$q5", "$q5", ROOM_TK, "reply to redacted"), null],
        [event("matrix:miku2:$q1", "$q1", OTHER_TK, "account two reply"), null],
      ];
      for (const [row] of rows) await storage.appendTimelineEvent(row, "skipped");

      await storage.write((db) => {
        const setEdited = db.prepare(`update timeline_events set last_edit_timestamp = ? where id = ?`);
        for (const [row, editTs] of rows) if (editTs !== null) setEdited.run(editTs, row.id);
        const quote = db.prepare(
          `insert into reply_contexts (event_id, reply_external_id, body, created_at) values (?, ?, ?, 0)`,
        );
        quote.run("matrix:miku:$q1", "$edited", "the ful");
        quote.run("matrix:miku:$q2", "$edited", "the ful");
        quote.run("matrix:miku:$q3", "$threaded", "edited in");
        quote.run("matrix:miku:$q4", "$plain", "provider text");
        quote.run("matrix:miku:$q5", "$edited", null);
        quote.run("matrix:miku2:$q1", "$edited", "the ful");
        // Re-stamp as v19 so the next open applies the v19→v20 step.
        db.pragma("user_version = 19");
      });
      storage.close();
    }

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 21, "migration stamps the latest version");

      assert.equal(quoteOf(storage, "matrix:miku:$q1"), "the full edited text");
      assert.equal(quoteOf(storage, "matrix:miku:$q2"), "the full edited text", "a thread reply gets its room's target");
      assert.equal(quoteOf(storage, "matrix:miku:$q3"), "edited in the thread", "a room reply finds a thread target");
      assert.equal(quoteOf(storage, "matrix:miku:$q4"), "provider text", "an unedited target's quote is untouched");
      assert.equal(quoteOf(storage, "matrix:miku:$q5"), null, "a body-less stub stays a stub");
      assert.equal(
        quoteOf(storage, "matrix:miku2:$q1"),
        "account two's own edit",
        "each account's quote takes its own account's row",
      );
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
