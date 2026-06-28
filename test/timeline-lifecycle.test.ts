import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LATEST_SCHEMA_VERSION, Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:miku:room:!room";

test("getTimelineState returns 'inactive' for a never-triggered timeline", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    assert.equal(storage.getTimelineState("matrix:miku:room:!unknown"), "inactive");
  } finally {
    storage.close();
  }
});

test("setTimelineState upserts and getTimelineState reflects each transition", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState(TK, "activating");
    assert.equal(storage.getTimelineState(TK), "activating");
    await storage.setTimelineState(TK, "active");
    assert.equal(storage.getTimelineState(TK), "active");
    // The CHECK constraint allows the deferred 'backfilling' state too.
    await storage.setTimelineState(TK, "backfilling");
    assert.equal(storage.getTimelineState(TK), "backfilling");
  } finally {
    storage.close();
  }
});

test("resetStaleActivations flips only 'activating' timelines back to 'inactive'", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState("matrix:miku:room:!a", "activating");
    await storage.setTimelineState("matrix:miku:room:!b", "active");
    await storage.setTimelineState("matrix:miku:room:!c", "activating");

    const count = await storage.resetStaleActivations();
    assert.equal(count, 2, "both 'activating' rows should be reset");
    assert.equal(storage.getTimelineState("matrix:miku:room:!a"), "inactive");
    assert.equal(storage.getTimelineState("matrix:miku:room:!b"), "active", "active timelines untouched");
    assert.equal(storage.getTimelineState("matrix:miku:room:!c"), "inactive");
  } finally {
    storage.close();
  }
});

test("setTimelineState preserves existing compaction cursors", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.saveTimelineCompactionState({
      schemaVersion: 1,
      timelineKey: TK,
      compactStartEventId: "compact-start",
      richStartEventId: "rich-start",
      updatedAt: 1_000,
    });
    await storage.setTimelineState(TK, "active");

    const state = storage.getTimelineCompactionState(TK);
    assert.equal(state?.compactStartEventId, "compact-start");
    assert.equal(state?.richStartEventId, "rich-start");
    assert.equal(storage.getTimelineState(TK), "active");
  } finally {
    storage.close();
  }
});

test("setTimelineState before any compaction state seeds a minimal valid row", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState(TK, "activating");
    const state = storage.getTimelineCompactionState(TK);
    assert.ok(state, "a compaction-state row should exist after setTimelineState");
    assert.equal(state?.compactStartEventId, null);
    assert.equal(state?.richStartEventId, null);
  } finally {
    storage.close();
  }
});

test("timeline_events accepts the 'inactive' enrichment_status", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(userEvent({ id: "e1", body: "hi", timestamp: 1_000 }), "inactive");
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("e1") as {
        enrichment_status: string;
      }).enrichment_status,
    );
    assert.equal(status, "inactive");
  } finally {
    storage.close();
  }
});

test("activateTimelineEvents flips only 'inactive' rows to 'pending' and returns the count", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(userEvent({ id: "i1", body: "a", timestamp: 1 }), "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "i2", body: "b", timestamp: 2 }), "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "s1", body: "c", timestamp: 3 }), "skipped");
    await storage.appendTimelineEvent(userEvent({ id: "p1", body: "d", timestamp: 4 }), "pending");

    const changed = await storage.activateTimelineEvents(TK);
    assert.equal(changed, 2, "only the two inactive rows should be activated");

    const statuses = storage.read((db) =>
      Object.fromEntries(
        (db.prepare("select id, enrichment_status from timeline_events").all() as Array<{
          id: string;
          enrichment_status: string;
        }>).map((r) => [r.id, r.enrichment_status]),
      ),
    );
    assert.equal(statuses.i1, "pending");
    assert.equal(statuses.i2, "pending");
    assert.equal(statuses.s1, "skipped", "skipped rows must not be activated");
    assert.equal(statuses.p1, "pending");
  } finally {
    storage.close();
  }
});

test("fresh database opens at the latest user_version with the full canonical schema", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // The versioned migration runner stamps a fresh DB at the latest version
    // (v2: redecrypt_attempts added; v3: pending_edits table added; v4:
    // last_edit_timestamp added; v5: agent_sessions table added). A fresh DB
    // must NOT run the additive migration steps — SCHEMA already built everything.
    const userVersion = storage.read((db) => db.pragma("user_version", { simple: true }) as number);
    assert.equal(userVersion, LATEST_SCHEMA_VERSION, "fresh DB should be stamped at the latest schema version");

    // enrichment_status CHECK includes 'inactive' (baked into the canonical schema).
    await storage.appendTimelineEvent(userEvent({ id: "inact-1", body: "x", timestamp: 1000 }), "inactive");
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("inact-1") as {
        enrichment_status: string;
      }).enrichment_status,
    );
    assert.equal(status, "inactive");

    // The is_undecryptable generated column exists (table_xinfo lists generated columns).
    const teColumns = storage.read((db) =>
      new Set(
        (db.prepare("pragma table_xinfo(timeline_events)").all() as Array<{ name: string }>).map((c) => c.name),
      ),
    );
    assert.ok(teColumns.has("is_undecryptable"), "is_undecryptable generated column should exist");
    assert.ok(teColumns.has("enrichment_retries"), "enrichment_retries column should exist");
    assert.ok(teColumns.has("redecrypt_attempts"), "redecrypt_attempts column should exist (v2)");
    assert.ok(teColumns.has("last_edit_timestamp"), "last_edit_timestamp column should exist (v4)");
    assert.ok(teColumns.has("trigger_group_id"), "trigger_group_id column should exist");

    // The partial index over the generated column exists.
    const teIndexes = storage.read((db) =>
      new Set(
        (db.prepare("select name from sqlite_master where type='index' and tbl_name='timeline_events'").all() as Array<{ name: string }>).map((r) => r.name),
      ),
    );
    assert.ok(teIndexes.has("idx_timeline_events_undecryptable"), "undecryptable partial index should exist");

    // timeline_compaction_state lifecycle columns exist.
    const csColumns = storage.read((db) =>
      new Set(
        (db.prepare("pragma table_info(timeline_compaction_state)").all() as Array<{ name: string }>).map((c) => c.name),
      ),
    );
    assert.ok(csColumns.has("timeline_state"), "timeline_state column should exist");
    // The dead `backfill_fence_timestamp` was dropped in v28->v29 (MESSAGE-BACKFETCH
    // §4.2); its slot is now the message-backfetch context floor.
    assert.ok(!csColumns.has("backfill_fence_timestamp"), "dead backfill_fence_timestamp column should be gone");
    assert.ok(csColumns.has("context_floor_event_id"), "context_floor_event_id column should exist");

    // media_assets.caption_error exists.
    const maColumns = storage.read((db) =>
      new Set(
        (db.prepare("pragma table_info(media_assets)").all() as Array<{ name: string }>).map((c) => c.name),
      ),
    );
    assert.ok(maColumns.has("caption_error"), "caption_error column should exist");

    // The pending_edits table exists (v3) — parks edits that arrive before their target.
    const tables = storage.read((db) =>
      new Set(
        (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name),
      ),
    );
    assert.ok(tables.has("pending_edits"), "pending_edits table should exist (v3)");
    assert.ok(tables.has("agent_sessions"), "agent_sessions table should exist (v5)");
  } finally {
    storage.close();
  }
});

test("re-opening an existing database is idempotent (stays at latest version, preserves data)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-reopen-"));
  const dbPath = path.join(dir, "db.sqlite");
  try {
    // First open creates the schema and writes a row.
    const first = await Storage.open({ databasePath: dbPath });
    try {
      await first.appendTimelineEvent(userEvent({ id: "persist-1", body: "keep me", timestamp: 1000 }), "inactive");
      await first.setTimelineState(TK, "active");
      assert.equal(first.read((db) => db.pragma("user_version", { simple: true }) as number), LATEST_SCHEMA_VERSION);
    } finally {
      first.close();
    }

    // Re-opening runs the migration runner again — it must be a no-op: stays at
    // the latest version, no error, and previously written data is intact. (The
    // additive ALTER step must NOT re-run and hit "duplicate column".)
    const second = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(second.read((db) => db.pragma("user_version", { simple: true }) as number), LATEST_SCHEMA_VERSION, "should stay at the latest version");
      const body = second.read((db) =>
        (db.prepare("select body from timeline_events where id = ?").get("persist-1") as { body: string } | undefined)?.body,
      );
      assert.equal(body, "keep me", "row should survive a re-open");
      assert.equal(second.getTimelineState(TK), "active", "timeline state should survive a re-open");
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const INACTIVE_TK = "matrix:miku:room:!inactive";
const ACTIVE_TK = "matrix:miku:room:!active";
const ACTIVATING_TK = "matrix:miku:room:!activating";
const NEVER_TK = "matrix:miku:room:!never"; // never-engaged: no compaction-state row

function eventIds(storage: Storage): Set<string> {
  return new Set(
    (storage.read((db) =>
      db.prepare("select id from timeline_events").all() as Array<{ id: string }>,
    )).map((r) => r.id),
  );
}

test("pruneInactiveTimelineEvents deletes only old events from inactive timelines", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState(INACTIVE_TK, "inactive");
    await storage.setTimelineState(ACTIVE_TK, "active");
    await storage.setTimelineState(ACTIVATING_TK, "activating");

    // Old events (timestamp 1000) across every state, plus a never-engaged room.
    await storage.appendTimelineEvent(userEvent({ id: "old-inactive", body: "x", timestamp: 1_000, timelineKey: INACTIVE_TK }), "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "old-never", body: "x", timestamp: 1_000, timelineKey: NEVER_TK }), "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "old-active", body: "x", timestamp: 1_000, timelineKey: ACTIVE_TK }), "pending");
    await storage.appendTimelineEvent(userEvent({ id: "old-activating", body: "x", timestamp: 1_000, timelineKey: ACTIVATING_TK }), "pending");
    // A recent event on the inactive timeline (after the cutoff) must survive.
    await storage.appendTimelineEvent(userEvent({ id: "recent-inactive", body: "x", timestamp: 9_000, timelineKey: INACTIVE_TK }), "inactive");

    const pruned = await storage.pruneInactiveTimelineEvents(5_000);
    assert.equal(pruned, 2, "only the two old inactive/never-engaged events should be pruned");

    const remaining = eventIds(storage);
    assert.ok(!remaining.has("old-inactive"), "old inactive event pruned");
    assert.ok(!remaining.has("old-never"), "old never-engaged (no row) event pruned");
    assert.ok(remaining.has("old-active"), "active-timeline events are never pruned");
    assert.ok(remaining.has("old-activating"), "activating-timeline events are never pruned");
    assert.ok(remaining.has("recent-inactive"), "recent inactive events (after cutoff) survive");
  } finally {
    storage.close();
  }
});

test("pruneInactiveTimelineEvents treats the cutoff as exclusive (timestamp === cutoff survives)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState(INACTIVE_TK, "inactive");
    // The prune query is `timestamp < ?` (strict), so an event sitting exactly
    // on the cutoff must survive; only strictly-older events are deleted.
    await storage.appendTimelineEvent(userEvent({ id: "at-cutoff", body: "x", timestamp: 5_000, timelineKey: INACTIVE_TK }), "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "below-cutoff", body: "x", timestamp: 4_999, timelineKey: INACTIVE_TK }), "inactive");

    const pruned = await storage.pruneInactiveTimelineEvents(5_000);
    assert.equal(pruned, 1, "only the strictly-older event is pruned");

    const remaining = eventIds(storage);
    assert.ok(remaining.has("at-cutoff"), "event with timestamp === cutoff survives (query is strict <)");
    assert.ok(!remaining.has("below-cutoff"), "event with timestamp < cutoff is pruned");
  } finally {
    storage.close();
  }
});

test("pruneInactiveTimelineEvents is a no-op when nothing is old enough", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setTimelineState(INACTIVE_TK, "inactive");
    await storage.appendTimelineEvent(userEvent({ id: "e1", body: "x", timestamp: 9_000, timelineKey: INACTIVE_TK }), "inactive");
    // Cutoff older than every stored event → nothing deleted (mirrors the
    // retention=0 gate, which the app enforces by not calling this at all).
    const pruned = await storage.pruneInactiveTimelineEvents(1_000);
    assert.equal(pruned, 0);
    assert.ok(eventIds(storage).has("e1"));
  } finally {
    storage.close();
  }
});

function userEvent(overrides: { id: string; body: string; timestamp: number; timelineKey?: string }): CanonicalChatEvent {
  return {
    id: overrides.id,
    timelineKey: overrides.timelineKey ?? TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: overrides.body,
    timestamp: overrides.timestamp,
    receivedAt: overrides.timestamp,
  };
}
