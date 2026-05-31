import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
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
    assert.ok(csColumns.has("backfill_fence_timestamp"), "backfill_fence_timestamp column should exist");

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

test("Storage.open upgrades a legacy v1 database through the full migration chain (issue #10)", async () => {
  // This is the only test that exercises the `current < LATEST` upgrade branch
  // of runMigrations. Fresh-open and already-latest re-open both hit early
  // returns; a real local DB from before the additive migrations must run the
  // ALTER/index/create-table steps at HEAD, and a regression would otherwise
  // surface only as a runtime crash on a real user DB.
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-migrate-"));
  const dbPath = path.join(dir, "legacy-v1.db");
  try {
    // Hand-build a v1-shaped database with raw better-sqlite3: a `timeline_events`
    // table WITHOUT `redecrypt_attempts` and WITHOUT `last_edit_timestamp`, no
    // `pending_edits` table, and no `idx_timeline_events_undecryptable` index
    // (that index was rebuilt to carry redecrypt_attempts in v1->v2). The
    // `is_undecryptable` generated column existed in v1 (no migration adds it).
    {
      const raw = new Database(dbPath);
      raw.pragma("journal_mode = WAL");
      raw.exec(`
        create table timeline_events (
          id text primary key,
          external_id text,
          timeline_key text not null,
          provider text not null,
          role text not null check(role in ('user', 'assistant')),
          sender_id text not null,
          sender_display_name text,
          body text not null,
          timestamp integer not null,
          received_at integer not null,
          agent_session_id text,
          event_json text not null,
          enrichment_status text not null default 'pending'
            check(enrichment_status in ('inactive', 'pending', 'processing', 'complete', 'failed', 'skipped')),
          enrichment_retries integer not null default 0,
          trigger_group_id text,
          created_at integer not null,
          updated_at integer not null,
          is_undecryptable integer generated always as
            (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
        );
      `);
      // A pre-existing row that must survive the upgrade and read back.
      const now = 1_000;
      raw
        .prepare(
          `insert into timeline_events (
             id, external_id, timeline_key, provider, role, sender_id,
             sender_display_name, body, timestamp, received_at, agent_session_id,
             event_json, enrichment_status, enrichment_retries, trigger_group_id,
             created_at, updated_at
           ) values (
             @id, @external_id, @timeline_key, @provider, @role, @sender_id,
             @sender_display_name, @body, @timestamp, @received_at, @agent_session_id,
             @event_json, @enrichment_status, 0, null, @created_at, @updated_at
           )`,
        )
        .run({
          id: "legacy-1",
          external_id: "$legacy:example.org",
          timeline_key: TK,
          provider: "matrix",
          role: "user",
          sender_id: "@alice:example.org",
          sender_display_name: "Alice",
          body: "survives the upgrade",
          timestamp: now,
          received_at: now,
          agent_session_id: null,
          event_json: JSON.stringify({ id: "legacy-1", body: "survives the upgrade" }),
          enrichment_status: "complete",
          created_at: now,
          updated_at: now,
        });
      raw.pragma("user_version = 1");
      raw.close();
    }

    // Open via Storage.open: it must run the upgrade chain without throwing.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const inspect = <T>(run: (db: Database.Database) => T): T => storage.read(run);

      // (b) reaches the current LATEST_SCHEMA_VERSION (read from code, not hardcoded).
      const version = inspect(
        (db) => Number(db.pragma("user_version", { simple: true }) as number),
      );
      assert.equal(version, LATEST_SCHEMA_VERSION, "user_version stamped to LATEST");

      // (c) all additive columns / index / table now exist.
      const columns = inspect(
        (db) =>
          new Set(
            (db.pragma("table_info(timeline_events)") as Array<{ name: string }>).map(
              (c) => c.name,
            ),
          ),
      );
      assert.ok(columns.has("redecrypt_attempts"), "redecrypt_attempts column added");
      assert.ok(columns.has("last_edit_timestamp"), "last_edit_timestamp column added");

      const indexExists = inspect(
        (db) =>
          (
            db
              .prepare(
                `select count(*) as n from sqlite_master
                   where type = 'index' and name = 'idx_timeline_events_undecryptable'`,
              )
              .get() as { n: number }
          ).n,
      );
      assert.equal(indexExists, 1, "idx_timeline_events_undecryptable index exists");

      const pendingEditsExists = inspect(
        (db) =>
          (
            db
              .prepare(
                `select count(*) as n from sqlite_master
                   where type = 'table' and name = 'pending_edits'`,
              )
              .get() as { n: number }
          ).n,
      );
      assert.equal(pendingEditsExists, 1, "pending_edits table created");

      // (d) the pre-existing row survives and reads back, with the new column
      // backfilled to its migration default.
      const row = inspect(
        (db) =>
          db
            .prepare(
              `select body, redecrypt_attempts, last_edit_timestamp
                 from timeline_events where id = 'legacy-1'`,
            )
            .get() as
            | { body: string; redecrypt_attempts: number; last_edit_timestamp: number | null }
            | undefined,
      );
      assert.ok(row, "pre-existing row survived the upgrade");
      assert.equal(row?.body, "survives the upgrade");
      assert.equal(row?.redecrypt_attempts, 0, "NOT NULL default backfilled existing row to 0");
      assert.equal(row?.last_edit_timestamp, null, "nullable column backfilled to NULL");
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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
