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
      // The agent's own message, wiped when someone deleted it (its sends always have a body).
      [event("matrix:miku:$own", "$own", ROOM_TK, "", { role: "assistant", sender: { id: "@miku:example.org", displayName: "Miku", isSelf: true, isBot: true } }), 6_500],
      // Not wiped: a message with content, an edit, an attachment-only edit, another
      // bot's or a webhook's edited embed-only message, an empty message never
      // edited, one already marked.
      [event("matrix:miku:$e", "$e", ROOM_TK, "edited text"), 6_000],
      [event("matrix:miku:$att", "$att", ROOM_TK, "", { attachments: [{ id: "x", mediaType: "image" }] }), 6_000],
      [event("discord:a:900", "900", "discord:a:room:c", "", { provider: "discord", sender: { id: "4242", displayName: "MusicBot", isBot: true } }), 6_000],
      [event("discord:a:901", "901", "discord:a:room:c", "", { provider: "discord", sender: { id: "4343", displayName: "Hook", isBot: true, isWebhook: true } }), 6_000],
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
        assert.deepEqual(deletedOf("matrix:miku:$own"), { at: 6_500 }, "the agent's own wiped message");
        assert.equal(deletedOf("matrix:miku:$e"), undefined);
        assert.equal(deletedOf("matrix:miku:$att"), undefined);
        assert.equal(deletedOf("discord:a:900"), undefined, "another bot's edited embed-only message");
        assert.equal(deletedOf("discord:a:901"), undefined, "a webhook's edited embed-only message");
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

test("v31→v32 removes the false markers the first v31 step put on bot and webhook rows, marks the agent's own wiped rows", async () => {
  await withStorage(async (storage, dbPath) => {
    const bot = { id: "4242", displayName: "MusicBot", isBot: true };
    const rows: Array<[CanonicalChatEvent, number | null]> = [
      // What the first v31 step did: a marker (at = last edit, no deleter) on a bot's and a webhook's edited embed-only message.
      [event("discord:a:900", "900", "discord:a:room:c", "", { provider: "discord", sender: bot, deleted: { at: 6_000 } }), 6_000],
      [event("discord:a:901", "901", "discord:a:room:c", "", { provider: "discord", sender: { ...bot, isWebhook: true }, deleted: { at: 6_100 } }), 6_100],
      // A live deletion of a bot message (receipt time, never the edit time): kept.
      [event("discord:a:902", "902", "discord:a:room:c", "", { provider: "discord", sender: bot, deleted: { at: 9_000 } }), 6_200],
      // A bot message with content and a live marker: kept.
      [event("discord:a:903", "903", "discord:a:room:c", "now playing", { provider: "discord", sender: bot, deleted: { at: 9_100 } }), null],
      // A marker naming a deleter on a bot row: kept.
      [event("matrix:miku:$bm", "$bm", ROOM_TK, "", { sender: { id: "@bridge:example.org", displayName: "Bridge", isBot: true }, deleted: { at: 6_300, by: "@mod:example.org" } }), 6_300],
      // A human's wiped row the first v31 step marked: kept.
      [event("discord:a:904", "904", "discord:a:room:c", "", { provider: "discord", deleted: { at: 6_400 } }), 6_400],
      // The agent's own message, wiped and skipped by the first v31 step: marked now.
      [event("matrix:miku:$own", "$own", ROOM_TK, "", { role: "assistant", sender: { id: "@miku:example.org", displayName: "Miku", isSelf: true } }), 6_500],
      // The agent's own message with content: untouched.
      [event("matrix:miku:$own2", "$own2", ROOM_TK, "hi", { role: "assistant", sender: { id: "@miku:example.org", displayName: "Miku", isSelf: true } }), 6_600],
    ];
    for (const [r] of rows) await storage.appendTimelineEvent(r, "skipped");
    await storage.write((db) => {
      const setEdited = db.prepare(`update timeline_events set last_edit_timestamp = ? where id = ?`);
      for (const [r, ts] of rows) if (ts !== null) setEdited.run(ts, r.id);
      db.pragma("user_version = 31");
    });
    const bodies = new Map(rows.map(([r]) => [r.id, row(storage, r.id).body]));
    storage.close();
    for (let pass = 0; pass < 2; pass++) {
      const reopened = await Storage.open({ databasePath: dbPath });
      try {
        assert.equal(reopened.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
        const deletedOf = (id: string) => (JSON.parse(row(reopened, id).event_json) as CanonicalChatEvent).deleted;
        assert.equal(deletedOf("discord:a:900"), undefined, "a bot's false marker is removed");
        assert.equal(deletedOf("discord:a:901"), undefined, "a webhook's false marker is removed");
        assert.deepEqual(deletedOf("discord:a:902"), { at: 9_000 }, "a live deletion's marker is kept");
        assert.deepEqual(deletedOf("discord:a:903"), { at: 9_100 });
        assert.deepEqual(deletedOf("matrix:miku:$bm"), { at: 6_300, by: "@mod:example.org" });
        assert.deepEqual(deletedOf("discord:a:904"), { at: 6_400 }, "a human's marker is kept");
        assert.deepEqual(deletedOf("matrix:miku:$own"), { at: 6_500 }, "the agent's own wiped message is marked");
        assert.equal(deletedOf("matrix:miku:$own2"), undefined);
        for (const [id, body] of bodies) assert.equal(row(reopened, id).body, body, "no body changes");
        if (pass === 0) await reopened.write((db) => db.pragma("user_version = 31"));
      } finally {
        reopened.close();
      }
    }
  });
});

test("v32→v33 marks this agent's copy of a sibling agent's wiped message, where the sibling's own copy is marked", async () => {
  await withStorage(async (storage, dbPath) => {
    const chen = { id: "777", displayName: "Chen", isBot: true };
    const rows: Array<[CanonicalChatEvent, number | null]> = [
      // A sibling agent's message wiped in both agents' timelines: its own copy is marked (v32), ours is not.
      [event("discord:chen:555", "555", "discord:chen:room:c", "", { provider: "discord", role: "assistant", sender: { ...chen, isSelf: true }, deleted: { at: 6_000 } }), 6_000],
      [event("discord:miku:555", "555", "discord:miku:room:c", "", { provider: "discord", sender: chen }), 6_050],
      // Its own copy not marked (a sibling message that was never deleted): ours stays as it is.
      [event("discord:chen:556", "556", "discord:chen:room:c", "hello", { provider: "discord", role: "assistant", sender: { ...chen, isSelf: true } }), null],
      [event("discord:miku:556", "556", "discord:miku:room:c", "", { provider: "discord", sender: chen }), 6_100],
      // Another bot's edited embed-only message with no agent copy: never marked.
      [event("discord:miku:557", "557", "discord:miku:room:c", "", { provider: "discord", sender: { id: "4242", displayName: "MusicBot", isBot: true } }), 6_200],
      // A webhook row whose external id matches a marked agent copy: webhooks stay out.
      [event("discord:chen:558", "558", "discord:chen:room:c", "", { provider: "discord", role: "assistant", sender: { ...chen, isSelf: true }, deleted: { at: 6_300 } }), 6_300],
      [event("discord:miku:558", "558", "discord:miku:room:c", "", { provider: "discord", sender: { id: "999", displayName: "Hook", isBot: true, isWebhook: true } }), 6_300],
      // The same external id on another provider: not the same message.
      [event("matrix:miku:555", "555", ROOM_TK, "", { sender: { id: "@bot:example.org", displayName: "Bot", isBot: true } }), 6_400],
      // Our copy with content (not wiped): untouched.
      [event("discord:chen:559", "559", "discord:chen:room:c", "", { provider: "discord", role: "assistant", sender: { ...chen, isSelf: true }, deleted: { at: 6_500 } }), 6_500],
      [event("discord:miku:559", "559", "discord:miku:room:c", "still here", { provider: "discord", sender: chen }), null],
    ];
    for (const [r] of rows) await storage.appendTimelineEvent(r, "skipped");
    await storage.write((db) => {
      const setEdited = db.prepare(`update timeline_events set last_edit_timestamp = ? where id = ?`);
      for (const [r, ts] of rows) if (ts !== null) setEdited.run(ts, r.id);
      db.pragma("user_version = 32");
    });
    const bodies = new Map(rows.map(([r]) => [r.id, row(storage, r.id).body]));
    storage.close();
    for (let pass = 0; pass < 2; pass++) {
      const reopened = await Storage.open({ databasePath: dbPath });
      try {
        assert.equal(reopened.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
        const deletedOf = (id: string) => (JSON.parse(row(reopened, id).event_json) as CanonicalChatEvent).deleted;
        assert.deepEqual(deletedOf("discord:chen:555"), { at: 6_000 });
        assert.deepEqual(deletedOf("discord:miku:555"), { at: 6_050 }, "our copy marked at its own wipe time");
        assert.equal(deletedOf("discord:miku:556"), undefined, "the sibling's copy is not marked");
        assert.equal(deletedOf("discord:miku:557"), undefined, "another bot's embed-only edit");
        assert.equal(deletedOf("discord:miku:558"), undefined, "a webhook row");
        assert.equal(deletedOf("matrix:miku:555"), undefined, "another provider");
        assert.equal(deletedOf("discord:miku:559"), undefined, "not wiped");
        for (const [id, body] of bodies) assert.equal(row(reopened, id).body, body, "no body changes");
        if (pass === 0) await reopened.write((db) => db.pragma("user_version = 32"));
      } finally {
        reopened.close();
      }
    }
  });
});
