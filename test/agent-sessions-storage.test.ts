import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  LATEST_SCHEMA_VERSION,
  Storage,
  type AgentSessionInsert,
} from "../src/storage/index.js";

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

function baseInsert(overrides: Partial<AgentSessionInsert> = {}): AgentSessionInsert {
  const now = 1_000;
  return {
    id: "s-abc1234567",
    timelineKey: "matrix:miku:room:!room",
    sessionType: "default",
    status: "created",
    modelId: "anthropic/claude",
    triggerEventId: "evt-1",
    triggerExternalId: "$server-1",
    triggerBody: "hello there",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("fresh DB has agent_sessions table: insert + getAgentSession round-trips", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row, "row should exist");
    assert.equal(row.id, "s-abc1234567");
    assert.equal(row.timeline_key, "matrix:miku:room:!room");
    assert.equal(row.session_type, "default");
    assert.equal(row.status, "created");
    assert.equal(row.model_id, "anthropic/claude");
    assert.equal(row.trigger_event_id, "evt-1");
    assert.equal(row.trigger_external_id, "$server-1");
    assert.equal(row.trigger_body, "hello there");
    // Unset columns default appropriately.
    assert.equal(row.context_snapshot_json, null);
    assert.equal(row.context_dump_path, null);
    assert.equal(row.transcript_json, null);
    assert.equal(row.token_estimate, null);
    assert.equal(row.no_reply, 0);
    assert.equal(row.error, null);
    assert.equal(row.created_at, 1_000);
    assert.equal(row.started_at, null);
    assert.equal(row.updated_at, 1_000);
    assert.equal(row.completed_at, null);
  });
});

test("getAgentSession returns undefined for a missing id", async () => {
  await withStorage(async (storage) => {
    assert.equal(storage.getAgentSession("s-missing"), undefined);
  });
});

test("insert -> updateStatus -> saveSnapshot -> saveTranscript round-trips; transcript flush does not clobber snapshot", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    await storage.updateAgentSessionStatus("s-abc1234567", "running", {
      startedAt: 2_000,
      updatedAt: 2_000,
    });

    let row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.status, "running");
    assert.equal(row.started_at, 2_000);
    assert.equal(row.updated_at, 2_000);

    // Snapshot written once.
    await storage.saveAgentSessionSnapshot("s-abc1234567", {
      snapshotJson: '{"prefix":true}',
      dumpPath: "/dumps/s-abc1234567.json",
      tokenEstimate: 4_242,
      updatedAt: 3_000,
    });

    row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.context_snapshot_json, '{"prefix":true}');
    assert.equal(row.context_dump_path, "/dumps/s-abc1234567.json");
    assert.equal(row.token_estimate, 4_242);
    assert.equal(row.updated_at, 3_000);
    // Status untouched by snapshot save.
    assert.equal(row.status, "running");

    // Cheap transcript flush must NOT touch snapshot columns.
    await storage.saveAgentSessionTranscript("s-abc1234567", '[{"role":"user"}]', 4_000);

    row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.transcript_json, '[{"role":"user"}]');
    assert.equal(row.updated_at, 4_000);
    // Snapshot survives the transcript flush.
    assert.equal(row.context_snapshot_json, '{"prefix":true}');
    assert.equal(row.context_dump_path, "/dumps/s-abc1234567.json");
    assert.equal(row.token_estimate, 4_242);

    // A second transcript flush updates only transcript + updated_at.
    await storage.saveAgentSessionTranscript(
      "s-abc1234567",
      '[{"role":"user"},{"role":"assistant"}]',
      5_000,
    );
    row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.transcript_json, '[{"role":"user"},{"role":"assistant"}]');
    assert.equal(row.updated_at, 5_000);
    assert.equal(row.context_snapshot_json, '{"prefix":true}');

    // Terminal completion with no_reply + error fields.
    await storage.updateAgentSessionStatus("s-abc1234567", "completed", {
      completedAt: 6_000,
      noReply: true,
      updatedAt: 6_000,
    });
    row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.status, "completed");
    assert.equal(row.completed_at, 6_000);
    assert.equal(row.no_reply, 1);
    assert.equal(row.updated_at, 6_000);
    // Snapshot + transcript still intact.
    assert.equal(row.context_snapshot_json, '{"prefix":true}');
    assert.equal(row.transcript_json, '[{"role":"user"},{"role":"assistant"}]');
  });
});

test("updateAgentSessionStatus updates only provided fields and always bumps updated_at", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert({ updatedAt: 1_000 }));

    // No opts: status + updated_at only; started_at/completed_at/no_reply/error untouched.
    await storage.updateAgentSessionStatus("s-abc1234567", "discarded", {
      error: "boom",
      updatedAt: 9_000,
    });
    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.status, "discarded");
    assert.equal(row.error, "boom");
    assert.equal(row.updated_at, 9_000);
    assert.equal(row.started_at, null);
    assert.equal(row.completed_at, null);
    assert.equal(row.no_reply, 0);
  });
});

test("resetStaleSessions flips only running/created to interrupted and returns the count", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert({ id: "s-running000", status: "running" }));
    await storage.insertAgentSession(baseInsert({ id: "s-created000", status: "created" }));
    await storage.insertAgentSession(baseInsert({ id: "s-complete00", status: "completed" }));
    await storage.insertAgentSession(baseInsert({ id: "s-discard000", status: "discarded" }));

    const healed = await storage.resetStaleSessions();
    assert.equal(healed, 2);

    assert.equal(storage.getAgentSession("s-running000")?.status, "interrupted");
    assert.equal(storage.getAgentSession("s-created000")?.status, "interrupted");
    // Terminal states untouched.
    assert.equal(storage.getAgentSession("s-complete00")?.status, "completed");
    assert.equal(storage.getAgentSession("s-discard000")?.status, "discarded");

    // Idempotent: a second sweep heals nothing.
    assert.equal(await storage.resetStaleSessions(), 0);
  });
});

test("LATEST_SCHEMA_VERSION is 5", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 5);
});

test("opening a v4 DB without agent_sessions migrates it and creates the table", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-migrate-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    // Build a v4-shaped legacy database WITHOUT agent_sessions. The fresh-vs-
    // existing probe in Storage.open keys on the presence of `timeline_events`,
    // so that table must exist for the DB to be treated as an existing
    // (migration) database rather than a fresh build. The table must carry the
    // full v4 column set (incl. enrichment_retries, trigger_group_id, the
    // is_undecryptable generated column, redecrypt_attempts, last_edit_timestamp)
    // because SCHEMA's `if not exists` index DDL — run after migrations on the
    // existing-DB path — references those columns.
    const legacy = new Database(dbPath);
    legacy.exec(
      `create table timeline_events (
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
         redecrypt_attempts integer not null default 0,
         last_edit_timestamp integer,
         trigger_group_id text,
         created_at integer not null,
         updated_at integer not null,
         is_undecryptable integer generated always as
           (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
       );`,
    );
    legacy.pragma("user_version = 4");
    // Sanity: table absent before migration.
    const before = legacy
      .prepare(
        `select count(*) as n from sqlite_master where type = 'table' and name = 'agent_sessions'`,
      )
      .get() as { n: number };
    assert.equal(before.n, 0);
    legacy.close();

    // Opening through Storage runs the v4 -> v5 migration step.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      // The migration created the table and round-trips through the API.
      await storage.insertAgentSession(baseInsert());
      const row = storage.getAgentSession("s-abc1234567");
      assert.ok(row, "agent_sessions row should round-trip after migration");
      assert.equal(row.status, "created");

      // Version stamped to LATEST.
      const version = storage.read(
        (db) => db.pragma("user_version", { simple: true }) as number,
      );
      assert.equal(version, LATEST_SCHEMA_VERSION);
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
