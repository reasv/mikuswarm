import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Storage } from "../src/storage/index.js";
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

test("getOldestEventTimestamp returns the minimum timestamp or undefined when empty", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    assert.equal(storage.getOldestEventTimestamp(TK), undefined);
    await storage.appendTimelineEvent(userEvent({ id: "e1", body: "a", timestamp: 5_000 }));
    await storage.appendTimelineEvent(userEvent({ id: "e2", body: "b", timestamp: 2_000 }));
    await storage.appendTimelineEvent(userEvent({ id: "e3", body: "c", timestamp: 9_000 }));
    assert.equal(storage.getOldestEventTimestamp(TK), 2_000);
  } finally {
    storage.close();
  }
});

test("migration widens enrichment_status CHECK and migrates existing compaction rows to 'active'", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-migrate-"));
  const dbPath = path.join(dir, "old.db");
  try {
    // Hand-build a database matching the pre-lifecycle schema: the narrow
    // enrichment_status CHECK (no 'inactive') and a timeline_compaction_state
    // table without the lifecycle columns, with one pre-existing (active) row.
    const legacy = new Database(dbPath);
    legacy.exec(`
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
          check(enrichment_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
        enrichment_retries integer not null default 0,
        trigger_group_id text,
        created_at integer not null,
        updated_at integer not null
      );
      create table timeline_compaction_state (
        timeline_key text primary key,
        compact_start_event_id text,
        rich_start_event_id text,
        state_json text not null,
        updated_at integer not null
      );
      insert into timeline_compaction_state (timeline_key, compact_start_event_id, rich_start_event_id, state_json, updated_at)
        values ('${TK}', null, null, '{"schemaVersion":1}', 1000);
      insert into timeline_events (
        id, external_id, timeline_key, provider, role, sender_id, sender_display_name,
        body, timestamp, received_at, agent_session_id, event_json, enrichment_status,
        enrichment_retries, trigger_group_id, created_at, updated_at
      ) values (
        'legacy-1', null, '${TK}', 'matrix', 'user', '@a:x', null,
        'old', 1000, 1000, null, '{}', 'complete', 0, null, 1000, 1000
      );
      create table media_assets (
        id text primary key,
        event_id text not null references timeline_events(id) on delete cascade,
        role text not null,
        source_index integer,
        link_preview_id text,
        local_path text,
        mime_type text,
        media_type text not null,
        size_bytes integer,
        width integer,
        height integer,
        duration_seconds real,
        original_filename text,
        detected_content text,
        detected_metadata_json text,
        caption text,
        caption_model text,
        caption_status text not null default 'pending',
        caption_error text,
        download_status text not null default 'complete',
        download_error text,
        created_at integer not null
      );
      insert into media_assets (id, event_id, role, media_type, caption_status, download_status, created_at)
        values ('asset-1', 'legacy-1', 'attachment', 'image', 'complete', 'complete', 1000);
    `);
    legacy.close();

    // Opening through Storage runs the migrations.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      // The pre-existing compaction row must now be 'active', not the default 'inactive'.
      assert.equal(storage.getTimelineState(TK), "active");

      // The legacy row survived the table rebuild.
      const legacyBody = storage.read((db) =>
        (db.prepare("select body from timeline_events where id = ?").get("legacy-1") as { body: string }).body,
      );
      assert.equal(legacyBody, "old");

      // The child media_assets row survived the rebuild (FK references the table by
      // name, which now points at the rebuilt table).
      const assetCount = storage.read((db) =>
        (db.prepare("select count(*) as c from media_assets where event_id = ?").get("legacy-1") as { c: number }).c,
      );
      assert.equal(assetCount, 1, "child media_assets row should survive the parent-table rebuild");

      // The rebuilt indexes exist.
      const indexNames = storage.read((db) =>
        new Set(
          (db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'timeline_events'").all() as Array<{ name: string }>).map((r) => r.name),
        ),
      );
      for (const idx of [
        "idx_timeline_events_timeline_time",
        "idx_timeline_events_external",
        "idx_timeline_events_enrichment",
        "idx_timeline_events_trigger_group",
      ]) {
        assert.ok(indexNames.has(idx), `index ${idx} should exist after rebuild`);
      }

      // ON DELETE CASCADE is still in force after re-enabling foreign keys.
      await storage.write((db) => db.prepare("delete from timeline_events where id = ?").run("legacy-1"));
      const assetCountAfterDelete = storage.read((db) =>
        (db.prepare("select count(*) as c from media_assets where event_id = ?").get("legacy-1") as { c: number }).c,
      );
      assert.equal(assetCountAfterDelete, 0, "deleting the parent should cascade to media_assets");

      // Inserting 'inactive' now succeeds — the CHECK was widened.
      await storage.appendTimelineEvent(userEvent({ id: "new-inactive", body: "x", timestamp: 2000 }), "inactive");
      assert.equal(storage.getTimelineState("matrix:miku:room:!fresh"), "inactive");
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function userEvent(overrides: { id: string; body: string; timestamp: number }): CanonicalChatEvent {
  return {
    id: overrides.id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: overrides.body,
    timestamp: overrides.timestamp,
    receivedAt: overrides.timestamp,
  };
}
