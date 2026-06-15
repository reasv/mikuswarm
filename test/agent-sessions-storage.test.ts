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
import type { Logger } from "../src/observability/index.js";
import { resumeUsageSeed } from "../src/app.js";
import { emptyUsageTotals } from "../src/agent/usage.js";
import { sanitizeTriggerFtsMatch } from "../src/search/query.js";

/**
 * `media_assets` + `summarization_jobs` are base (v1) tables present in every real
 * DB. The v7→v8 migration ALTERs `media_assets` (adds caption_attempts/updated_at)
 * and creates keyset indexes on both, so a synthetic legacy fixture must include
 * them in their pre-v8 shape (without the columns the migration adds), or the
 * ALTER/index DDL has nothing to target. FK `references` clauses are dropped — the
 * migration only ALTERs/indexes, never writes, so referential targets are moot.
 */
const LEGACY_MEDIA_AND_JOBS = `
  create table media_assets (
    id text primary key,
    event_id text not null,
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
    caption_status text not null default 'pending'
      check(caption_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
    caption_error text,
    download_status text not null default 'complete'
      check(download_status in ('complete', 'failed')),
    download_error text,
    created_at integer not null
  );
  create table summarization_jobs (
    id text primary key,
    timeline_key text not null,
    level integer not null,
    status text not null default 'pending'
      check(status in ('pending', 'processing', 'complete', 'failed')),
    input_start_id text not null,
    input_end_id text not null,
    input_token_count integer,
    target_token_count integer not null,
    attempts integer not null default 0,
    max_retries integer not null default 2,
    best_effort_draft text,
    error text,
    result_summary_id text,
    created_at integer not null,
    updated_at integer not null
  );`;

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

interface CapturedWarning {
  message: string;
  fields?: Record<string, unknown>;
}

/** A Logger that records `warn` calls so tests can assert on observable signals. */
function makeCapturingLogger(): { logger: Logger; warnings: CapturedWarning[] } {
  const warnings: CapturedWarning[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message, fields) {
      warnings.push({ message, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warnings };
}

async function withCapturingStorage(
  fn: (storage: Storage, warnings: CapturedWarning[]) => Promise<void>,
): Promise<void> {
  const { logger, warnings } = makeCapturingLogger();
  const storage = await Storage.open({ databasePath: ":memory:", logger });
  try {
    await fn(storage, warnings);
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
    triggerSenderId: "@alice:example.org",
    triggerSenderDisplayName: "Alice",
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
    // The durable trigger-sender identity (v18, issue #18): manual resume
    // reconstructs sender-bound tools from these.
    assert.equal(row.trigger_sender_id, "@alice:example.org");
    assert.equal(row.trigger_sender_display_name, "Alice");
    // Unset columns default appropriately.
    assert.equal(row.context_snapshot_json, null);
    assert.equal(row.context_dump_path, null);
    assert.equal(row.transcript_json, null);
    assert.equal(row.token_estimate, null);
    // Actuals columns (v20) unset on a fresh row read as "unknown" (null).
    assert.equal(row.llm_requests, null);
    assert.equal(row.usage_input_tokens, null);
    assert.equal(row.usage_output_tokens, null);
    assert.equal(row.usage_cache_read_tokens, null);
    assert.equal(row.usage_cache_write_tokens, null);
    assert.equal(row.usage_cost, null);
    assert.equal(row.context_tokens, null);
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

test("updateAgentSessionUsage persists the actuals aggregate (v20)", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());
    await storage.updateAgentSessionUsage("s-abc1234567", {
      llmRequests: 7,
      inputTokens: 1234,
      outputTokens: 5678,
      cacheReadTokens: 132_000,
      cacheWriteTokens: 8100,
      cost: 0.0182,
      contextTokens: 46_300,
    });
    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.llm_requests, 7);
    assert.equal(row.usage_input_tokens, 1234);
    assert.equal(row.usage_output_tokens, 5678);
    assert.equal(row.usage_cache_read_tokens, 132_000);
    assert.equal(row.usage_cache_write_tokens, 8100);
    assert.ok(Math.abs((row.usage_cost ?? 0) - 0.0182) < 1e-9);
    assert.equal(row.context_tokens, 46_300);
    // A null contextTokens (no request committed yet) is written through as null.
    await storage.updateAgentSessionUsage("s-abc1234567", {
      llmRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      contextTokens: null,
    });
    assert.equal(storage.getAgentSession("s-abc1234567")!.context_tokens, null);
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

test("LATEST_SCHEMA_VERSION is 24", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 25);
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
    // A real v1+ DB always has `summaries` (base schema since v1); the v5->v6
    // migration ALTERs it, so the synthetic fixture must include it too.
    legacy.exec(
      `create table summaries (
         id text primary key,
         timeline_key text not null,
         level integer not null,
         content text not null,
         earliest_timestamp integer not null,
         latest_timestamp integer not null,
         latest_event_id text not null,
         event_count integer not null,
         token_count integer not null,
         model_id text,
         status text not null default 'complete'
           check(status in ('complete', 'truncated', 'superseded')),
         backfill_job_id text,
         generated_at integer not null,
         created_at integer not null
       );`,
    );
    legacy.exec(LEGACY_MEDIA_AND_JOBS);
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

      // Issue #13: the synthetic `summaries` fixture above has NO diary columns, so
      // the v5->v6 ALTER path genuinely ran here. Assert it added both diary columns.
      const summaryCols = storage.read((db) =>
        (db.prepare(`pragma table_info(summaries)`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      assert.ok(
        summaryCols.includes("diary_status"),
        `migration must add diary_status; have: ${summaryCols.join(", ")}`,
      );
      assert.ok(
        summaryCols.includes("diary_attempts"),
        `migration must add diary_attempts; have: ${summaryCols.join(", ")}`,
      );

      // Issue #12: the partial diary-queue index must exist after migration too.
      const summaryIndexes = storage.read((db) =>
        (
          db
            .prepare(
              `select name from sqlite_master where type = 'index' and tbl_name = 'summaries'`,
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      assert.ok(
        summaryIndexes.includes("idx_summaries_diary"),
        `migration must create idx_summaries_diary; have: ${summaryIndexes.join(", ")}`,
      );

      // v6->v7 (ARCHITECTURE.md §9d): the memory-retrieval index tables exist after
      // migration. (memory_vec is created at runtime, not by this migration.)
      const tables = storage.read((db) =>
        (
          db
            .prepare(`select name from sqlite_master where type in ('table','view')`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      for (const t of [
        "memory_chunks",
        "memory_chunks_fts",
        "embedding_cache",
        "index_meta",
        // v10->v11 (RoomLabelCache): the room_metadata table must exist after migration.
        "room_metadata",
      ]) {
        assert.ok(tables.includes(t), `migration must create ${t}; have: ${tables.join(", ")}`);
      }

      // v10->v11: prove the migrated room_metadata table has the correct shape
      // (columns display_name / resolved_at) by round-tripping a label through the
      // SAME migrated Storage instance — a wrong-named or wrong-shaped table would
      // throw here, where a bare "table exists" check would not.
      await storage.setRoomDisplayName("!migrated:example.org", "Migrated Room");
      const roomMeta = storage.getRoomMetadata("!migrated:example.org");
      assert.ok(roomMeta, "room_metadata row should round-trip after migration");
      assert.equal(roomMeta.displayName, "Migrated Room");
      assert.equal(typeof roomMeta.resolvedAt, "number");
      // The FTS sync triggers are present too.
      const triggers = storage.read((db) =>
        (
          db
            .prepare(`select name from sqlite_master where type = 'trigger'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      for (const tr of ["memory_chunks_ai", "memory_chunks_ad", "memory_chunks_au"]) {
        assert.ok(triggers.includes(tr), `migration must create ${tr}; have: ${triggers.join(", ")}`);
      }
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Issue #11: v7 -> v8 swaps the memory_chunks_au FTS trigger to the guarded form ---

// A v6-shaped timeline_events (the fresh-vs-existing probe keys on this table) so the
// DB is treated as an existing migration target, plus the v7 retrieval tables carrying
// the OLD, UNGUARDED memory_chunks_au trigger. Opening through Storage must run the
// v7->v8 step that drops+recreates it with the WHEN guard (review issue #11).
const V6_TIMELINE_EVENTS = `create table timeline_events (
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
 );`;

// A v7-shaped `summaries` carrying the diary-queue columns (added at v5->v6). The
// chain from v7 doesn't run v5->v6, so the fixture must already have them — the
// v8->v9 step indexes `summaries(latest_timestamp, id) where diary_status is not null`.
const V7_SUMMARIES = `create table summaries (
   id text primary key,
   timeline_key text not null,
   level integer not null,
   content text not null,
   earliest_timestamp integer not null,
   latest_timestamp integer not null,
   latest_event_id text not null,
   event_count integer not null,
   token_count integer not null,
   model_id text,
   status text not null default 'complete'
     check(status in ('complete', 'truncated', 'superseded')),
   backfill_job_id text,
   generated_at integer not null,
   created_at integer not null,
   diary_status text
     check(diary_status in ('pending', 'processing', 'done', 'skipped', 'failed')),
   diary_attempts integer not null default 0
 );`;

// The v7 retrieval tables with the OLD, UNGUARDED update trigger (no WHEN clause) —
// exactly what the v6->v7 migration created before issue #11.
const V7_RETRIEVAL_WITH_UNGUARDED_TRIGGER = `
create table memory_chunks (
  rowid integer primary key autoincrement,
  id text unique not null,
  path text not null,
  ordinal integer not null,
  source text not null default 'memory',
  start_line integer not null,
  end_line integer not null,
  room text,
  entry_ts integer not null,
  text text not null,
  token_count integer not null,
  content_hash text not null,
  model_id text,
  embed_status text not null default 'pending'
    check(embed_status in ('pending','processing','done','failed','skip')),
  embed_attempts integer not null default 0,
  indexed_at integer not null
);
create virtual table memory_chunks_fts using fts5(
  text, room, content='memory_chunks', content_rowid='rowid'
);
create trigger memory_chunks_ai after insert on memory_chunks begin
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;
create trigger memory_chunks_ad after delete on memory_chunks begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
end;
create trigger memory_chunks_au after update on memory_chunks begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;
`;

test("v7 -> v8 migration guards the memory_chunks_au trigger and keeps FTS correct (issue #11)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-au-migrate-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(V6_TIMELINE_EVENTS);
    legacy.exec(V7_RETRIEVAL_WITH_UNGUARDED_TRIGGER);
    // Opening runs the chain to the current LATEST (now v9): the v8->v9 step ALTERs
    // media_assets and indexes summarization_jobs + summaries, so this v7 fixture must
    // include those base tables (with the v6 diary columns on summaries) too, or that
    // later step has nothing to target.
    legacy.exec(LEGACY_MEDIA_AND_JOBS);
    legacy.exec(V7_SUMMARIES);
    legacy.pragma("user_version = 7");

    // Sanity: the fixture trigger is the OLD unguarded form (no WHEN clause).
    const before = legacy
      .prepare(`select sql from sqlite_master where type='trigger' and name='memory_chunks_au'`)
      .get() as { sql: string };
    assert.ok(
      !/\bwhen\b/i.test(before.sql),
      "fixture must start with the unguarded trigger",
    );
    legacy.close();

    // Open through Storage: runs the v7 -> v8 step.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read(
        (db) => db.pragma("user_version", { simple: true }) as number,
      );
      assert.equal(version, LATEST_SCHEMA_VERSION);

      // The trigger now carries the WHEN guard on the FTS-indexed columns.
      const after = storage.read(
        (db) =>
          db
            .prepare(
              `select sql from sqlite_master where type='trigger' and name='memory_chunks_au'`,
            )
            .get() as { sql: string },
      );
      assert.match(after.sql, /when\s+new\.text\s+is\s+not\s+old\.text/i);
      assert.match(after.sql, /new\.room\s+is\s+not\s+old\.room/i);

      // Insert a chunk; FTS MATCH must find it (insert trigger).
      await storage.readAndWrite((db) => {
        db.prepare(
          `insert into memory_chunks
             (id, path, ordinal, source, start_line, end_line, room, entry_ts,
              text, token_count, content_hash, model_id, embed_status, embed_attempts, indexed_at)
           values
             ('c1', 'memory/2026-06-04.md', 0, 'memory', 1, 2, '!room', 1000,
              'unicornflux pinball', 2, 'h1', null, 'pending', 0, 5000)`,
        ).run();
      });
      const found = storage.read(
        (db) =>
          db
            .prepare(
              `select rowid from memory_chunks_fts where memory_chunks_fts match 'unicornflux'`,
            )
            .all() as Array<{ rowid: number }>,
      );
      assert.equal(found.length, 1, "FTS must find the inserted chunk");

      // An embed-status-ONLY update (the frequent case the guard targets) must NOT
      // touch FTS, and the external-content FTS index must remain internally consistent.
      await storage.readAndWrite((db) => {
        db.prepare(`update memory_chunks set embed_status='done', model_id='m1' where id='c1'`).run();
      });
      // integrity-check raises if the external-content index has drifted.
      assert.doesNotThrow(() =>
        storage.read((db) =>
          db.prepare(`insert into memory_chunks_fts(memory_chunks_fts) values('integrity-check')`).run(),
        ),
      );
      const stillFound = storage.read(
        (db) =>
          db
            .prepare(
              `select rowid from memory_chunks_fts where memory_chunks_fts match 'unicornflux'`,
            )
            .all() as Array<{ rowid: number }>,
      );
      assert.equal(stillFound.length, 1, "FTS still matches after an embed-status-only update");

      // A text change DOES resync FTS (old token gone, new token present).
      await storage.readAndWrite((db) => {
        db.prepare(`update memory_chunks set text='zephyrquartz arcade' where id='c1'`).run();
      });
      const oldGone = storage.read(
        (db) =>
          db
            .prepare(
              `select rowid from memory_chunks_fts where memory_chunks_fts match 'unicornflux'`,
            )
            .all() as Array<{ rowid: number }>,
      );
      assert.equal(oldGone.length, 0, "stale FTS term must be retracted on text change");
      const newFound = storage.read(
        (db) =>
          db
            .prepare(
              `select rowid from memory_chunks_fts where memory_chunks_fts match 'zephyrquartz'`,
            )
            .all() as Array<{ rowid: number }>,
      );
      assert.equal(newFound.length, 1, "new FTS term must be indexed on text change");
      assert.doesNotThrow(() =>
        storage.read((db) =>
          db.prepare(`insert into memory_chunks_fts(memory_chunks_fts) values('integrity-check')`).run(),
        ),
      );
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Issue #16: the memory_chunks FTS triggers round-trip insert→MATCH→delete→MATCH ---
//
// Group 4's v7->v8 test (above) round-trips insert→MATCH and update (status-only and
// text), but never deletes a row. This pins the external-content `'delete'` trigger
// syntax of `memory_chunks_ad` against the CURRENT schema (a fresh Storage open, not a
// legacy migration fixture) independent of the indexer: a deleted row's terms must be
// retracted from FTS, and the external-content index must stay internally consistent.

test("memory_chunks FTS triggers round-trip insert→MATCH→delete→MATCH on the current schema (issue #16)", async () => {
  // A fresh in-memory Storage applies the full SCHEMA, including the FTS triggers.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Insert a chunk; the `_ai` trigger must make it findable by FTS MATCH.
    await storage.readAndWrite((db) => {
      db.prepare(
        `insert into memory_chunks
           (id, path, ordinal, source, start_line, end_line, room, entry_ts,
            text, token_count, content_hash, model_id, embed_status, embed_attempts, indexed_at)
         values
           ('c1', 'memory/2026-06-04.md', 0, 'memory', 1, 2, '!room', 1000,
            'unicornflux pinball', 2, 'h1', null, 'pending', 0, 5000)`,
      ).run();
    });
    const rowid = storage.read(
      (db) =>
        (db.prepare(`select rowid from memory_chunks where id='c1'`).get() as { rowid: number })
          .rowid,
    );
    const found = storage.read(
      (db) =>
        db
          .prepare(`select rowid from memory_chunks_fts where memory_chunks_fts match 'unicornflux'`)
          .all() as Array<{ rowid: number }>,
    );
    assert.deepEqual(
      found.map((r) => r.rowid),
      [rowid],
      "FTS must find the inserted chunk",
    );

    // Delete the row; the `_ad` `'delete'` trigger must retract its terms from FTS.
    await storage.readAndWrite((db) => {
      db.prepare(`delete from memory_chunks where id='c1'`).run();
    });
    const afterDelete = storage.read(
      (db) =>
        db
          .prepare(`select rowid from memory_chunks_fts where memory_chunks_fts match 'unicornflux'`)
          .all() as Array<{ rowid: number }>,
    );
    assert.equal(afterDelete.length, 0, "FTS must not match a deleted chunk");

    // integrity-check raises if the external-content index drifted from the table.
    assert.doesNotThrow(() =>
      storage.read((db) =>
        db.prepare(`insert into memory_chunks_fts(memory_chunks_fts) values('integrity-check')`).run(),
      ),
    );
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// --- Issue #5: missing-row writes are observable (warn, no throw) ---

test("updateAgentSessionStatus on a non-existent id warns and does not throw", async () => {
  await withCapturingStorage(async (storage, warnings) => {
    // No row inserted: the UPDATE matches zero rows.
    await storage.updateAgentSessionStatus("s-nonexistent", "running", {
      startedAt: 1_000,
      updatedAt: 1_000,
    });

    assert.equal(warnings.length, 1, "exactly one warning for the no-op update");
    const warn = warnings[0];
    assert.match(warn.message, /updateAgentSessionStatus/);
    assert.equal(warn.fields?.method, "updateAgentSessionStatus");
    assert.equal(warn.fields?.sessionId, "s-nonexistent");
  });
});

test("saveAgentSessionSnapshot on a non-existent id warns and does not throw", async () => {
  await withCapturingStorage(async (storage, warnings) => {
    await storage.saveAgentSessionSnapshot("s-missing-snap", {
      snapshotJson: "{}",
      dumpPath: null,
      tokenEstimate: null,
      updatedAt: 1_000,
    });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].fields?.method, "saveAgentSessionSnapshot");
    assert.equal(warnings[0].fields?.sessionId, "s-missing-snap");
  });
});

test("saveAgentSessionTranscript on a non-existent id warns and does not throw", async () => {
  await withCapturingStorage(async (storage, warnings) => {
    await storage.saveAgentSessionTranscript("s-missing-tx", "[]", 1_000);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].fields?.method, "saveAgentSessionTranscript");
    assert.equal(warnings[0].fields?.sessionId, "s-missing-tx");
  });
});

test("a write to an existing session row does NOT warn", async () => {
  await withCapturingStorage(async (storage, warnings) => {
    await storage.insertAgentSession(baseInsert());
    await storage.updateAgentSessionStatus("s-abc1234567", "running", {
      startedAt: 2_000,
      updatedAt: 2_000,
    });
    await storage.saveAgentSessionSnapshot("s-abc1234567", {
      snapshotJson: "{}",
      dumpPath: null,
      tokenEstimate: null,
      updatedAt: 3_000,
    });
    await storage.saveAgentSessionTranscript("s-abc1234567", "[]", 4_000);

    assert.equal(warnings.length, 0, "matched rows must not warn");
  });
});

// --- Issue #6: status CHECK constraint is enforced at the DB layer ---

test("inserting a session with an out-of-band status is rejected by the DB", async () => {
  await withStorage(async (storage) => {
    await assert.rejects(
      // Cast through unknown: the TS union forbids this, but a raw/buggy caller
      // could still try, and the CHECK constraint is the backstop.
      storage.insertAgentSession(
        baseInsert({ status: "bogus" as unknown as AgentSessionInsert["status"] }),
      ),
      /CHECK constraint failed/,
    );
  });
});

test("updating a session to an out-of-band status is rejected by the DB", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());
    await assert.rejects(
      storage.updateAgentSessionStatus(
        "s-abc1234567",
        "bogus" as unknown as AgentSessionInsert["status"],
        { updatedAt: 2_000 },
      ),
      /CHECK constraint failed/,
    );
    // The row keeps its original valid status.
    assert.equal(storage.getAgentSession("s-abc1234567")?.status, "created");
  });
});

test("all spec-defined statuses (incl. reserved 'suspended') are accepted", async () => {
  await withStorage(async (storage) => {
    const statuses: AgentSessionInsert["status"][] = [
      "created",
      "running",
      "completed",
      "discarded",
      "interrupted",
      "suspended",
    ];
    for (const [i, status] of statuses.entries()) {
      const id = `s-status${i}xxx`;
      await storage.insertAgentSession(baseInsert({ id, status }));
      assert.equal(storage.getAgentSession(id)?.status, status);
    }
  });
});

// --- Issue #7: insertAgentSession can set started_at (insert-as-running) ---

test("insert-as-running with startedAt round-trips a non-null started_at", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(
      baseInsert({
        id: "s-running-st",
        status: "running",
        startedAt: 7_777,
      }),
    );
    const row = storage.getAgentSession("s-running-st");
    assert.ok(row);
    assert.equal(row.status, "running");
    assert.equal(row.started_at, 7_777);
  });
});

test("chat-style insert (created, no startedAt) leaves started_at null", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert({ id: "s-created-st" }));
    const row = storage.getAgentSession("s-created-st");
    assert.ok(row);
    assert.equal(row.status, "created");
    assert.equal(row.started_at, null);
  });
});

test("explicit startedAt: null is treated the same as omitted", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert({ id: "s-null-st", startedAt: null }));
    assert.equal(storage.getAgentSession("s-null-st")?.started_at, null);
  });
});

// --- Issue #14: storage test gaps ---

test("resetStaleSessions strictly advances updated_at on healed rows", async () => {
  await withStorage(async (storage) => {
    // Insert a running row with a fixed, old updated_at.
    await storage.insertAgentSession(
      baseInsert({ id: "s-stale00000", status: "running", updatedAt: 1_000 }),
    );
    const before = storage.getAgentSession("s-stale00000");
    assert.ok(before);
    assert.equal(before.updated_at, 1_000);

    const healed = await storage.resetStaleSessions();
    assert.equal(healed, 1);

    const after = storage.getAgentSession("s-stale00000");
    assert.ok(after);
    assert.equal(after.status, "interrupted");
    // resetStaleSessions stamps Date.now(); the captured baseline (1_000) is far
    // in the past, so the healed row's updated_at must have strictly advanced.
    assert.ok(
      after.updated_at > before.updated_at,
      `updated_at should advance: ${before.updated_at} -> ${after.updated_at}`,
    );
  });
});

test("both agent_sessions indexes exist on a fresh DB", async () => {
  await withStorage(async (storage) => {
    const names = storage.read((db) =>
      (
        db
          .prepare(
            `select name from sqlite_master
             where type = 'index' and tbl_name = 'agent_sessions'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    assert.ok(
      names.includes("idx_agent_sessions_timeline"),
      `missing idx_agent_sessions_timeline; have: ${names.join(", ")}`,
    );
    assert.ok(
      names.includes("idx_agent_sessions_status"),
      `missing idx_agent_sessions_status; have: ${names.join(", ")}`,
    );
  });
});

test("both agent_sessions indexes exist after a v4 -> v5 migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-idx-migrate-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    // Minimal v4 DB: the fresh-vs-existing probe keys on `timeline_events`, so it
    // must exist with the full v4 column set referenced by SCHEMA's index DDL.
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
    // A real v1+ DB always has `summaries` (base schema since v1); the v5->v6
    // migration ALTERs it, so the synthetic fixture must include it too.
    legacy.exec(
      `create table summaries (
         id text primary key,
         timeline_key text not null,
         level integer not null,
         content text not null,
         earliest_timestamp integer not null,
         latest_timestamp integer not null,
         latest_event_id text not null,
         event_count integer not null,
         token_count integer not null,
         model_id text,
         status text not null default 'complete'
           check(status in ('complete', 'truncated', 'superseded')),
         backfill_job_id text,
         generated_at integer not null,
         created_at integer not null
       );`,
    );
    legacy.exec(LEGACY_MEDIA_AND_JOBS);
    legacy.pragma("user_version = 4");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const names = storage.read((db) =>
        (
          db
            .prepare(
              `select name from sqlite_master
               where type = 'index' and tbl_name = 'agent_sessions'`,
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      assert.ok(names.includes("idx_agent_sessions_timeline"));
      assert.ok(names.includes("idx_agent_sessions_status"));
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveAgentSessionSnapshot leaves an already-written transcript untouched", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    // Write the transcript FIRST (reverse of the existing snapshot-preserved test).
    await storage.saveAgentSessionTranscript(
      "s-abc1234567",
      '[{"role":"user"},{"role":"assistant"}]',
      2_000,
    );

    // Now write the snapshot; it must not clobber the transcript column.
    await storage.saveAgentSessionSnapshot("s-abc1234567", {
      snapshotJson: '{"prefix":true}',
      dumpPath: "/dumps/s-abc1234567.json",
      tokenEstimate: 123,
      updatedAt: 3_000,
    });

    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    // Snapshot columns written.
    assert.equal(row.context_snapshot_json, '{"prefix":true}');
    assert.equal(row.token_estimate, 123);
    assert.equal(row.updated_at, 3_000);
    // Transcript survives the snapshot write.
    assert.equal(row.transcript_json, '[{"role":"user"},{"role":"assistant"}]');
  });
});

// ---------------------------------------------------------------------------
// Populated-row migration coverage (issue #21): the v16→v17 CHECK-widening
// step REBUILDS agent_sessions (rename → create → insert…select * → drop),
// and the v17→v18 step ALTERs in the trigger-sender columns. The pre-existing
// chain test only exercised them on an EMPTY table — these run with rows.
// ---------------------------------------------------------------------------

/** The v5..v16 `agent_sessions` shape: narrow status CHECK, no sender columns. */
const V16_AGENT_SESSIONS = `create table agent_sessions (
   id text primary key,
   timeline_key text not null,
   session_type text not null default 'default',
   status text not null
     check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended')),
   model_id text,
   trigger_event_id text,
   trigger_external_id text,
   trigger_body text,
   context_snapshot_json text,
   context_dump_path text,
   transcript_json text,
   token_estimate integer,
   no_reply integer not null default 0,
   error text,
   created_at integer not null,
   started_at integer,
   updated_at integer not null,
   completed_at integer
 );
 create index idx_agent_sessions_timeline on agent_sessions(timeline_key, created_at desc);
 create index idx_agent_sessions_status on agent_sessions(status, updated_at desc);`;

/** The v17 shape: widened CHECK (resume states), still no sender columns. */
const V17_AGENT_SESSIONS = V16_AGENT_SESSIONS.replace(
  `'interrupted', 'suspended'))`,
  `'interrupted', 'suspended',
                      'resuming', 'failed-resumable'))`,
);

const FULL_ROW_INSERT = `insert into agent_sessions (
   id, timeline_key, session_type, status, model_id,
   trigger_event_id, trigger_external_id, trigger_body,
   context_snapshot_json, context_dump_path, transcript_json,
   token_estimate, no_reply, error, created_at, started_at, updated_at, completed_at
 ) values (
   @id, @timelineKey, @sessionType, @status, @modelId,
   @triggerEventId, @triggerExternalId, @triggerBody,
   @snapshot, @dumpPath, @transcript,
   @tokenEstimate, @noReply, @error, @createdAt, @startedAt, @updatedAt, @completedAt
 )`;

function legacyRow(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    timelineKey: "matrix:miku:room:!room",
    sessionType: "default",
    status,
    modelId: "anthropic/claude",
    triggerEventId: `evt-${id}`,
    triggerExternalId: `$server-${id}`,
    triggerBody: "hello there",
    snapshot: '[{"type":"system"}]',
    dumpPath: `/dumps/${id}.json`,
    transcript: '[{"role":"user"}]',
    tokenEstimate: 42,
    noReply: 0,
    error: null,
    createdAt: 1_000,
    startedAt: 1_100,
    updatedAt: 2_000,
    completedAt: 3_000,
    ...overrides,
  };
}

test("v16 -> v17 table rebuild preserves populated agent_sessions rows (and v18 adds sender columns)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-v16-rows-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(V6_TIMELINE_EVENTS); // fresh-vs-existing probe keys on this table
    legacy.exec(V16_AGENT_SESSIONS);
    const insert = legacy.prepare(FULL_ROW_INSERT);
    insert.run(legacyRow("s-mig-a", "completed", { noReply: 1 }));
    insert.run(legacyRow("s-mig-b", "interrupted", { error: "stopped", completedAt: null }));
    insert.run(legacyRow("s-mig-c", "discarded", { error: "boom" }));
    legacy.pragma("user_version = 16");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => db.pragma("user_version", { simple: true }) as number);
      assert.equal(version, LATEST_SCHEMA_VERSION);

      // Every row survived the rebuild with its values intact.
      const count = storage.read(
        (db) => (db.prepare(`select count(*) as n from agent_sessions`).get() as { n: number }).n,
      );
      assert.equal(count, 3);
      const a = storage.getAgentSession("s-mig-a");
      assert.ok(a);
      assert.equal(a.status, "completed");
      assert.equal(a.model_id, "anthropic/claude");
      assert.equal(a.trigger_event_id, "evt-s-mig-a");
      assert.equal(a.trigger_external_id, "$server-s-mig-a");
      assert.equal(a.trigger_body, "hello there");
      assert.equal(a.context_snapshot_json, '[{"type":"system"}]');
      assert.equal(a.context_dump_path, "/dumps/s-mig-a.json");
      assert.equal(a.transcript_json, '[{"role":"user"}]');
      assert.equal(a.token_estimate, 42);
      assert.equal(a.no_reply, 1);
      assert.equal(a.error, null);
      assert.equal(a.created_at, 1_000);
      assert.equal(a.started_at, 1_100);
      assert.equal(a.updated_at, 2_000);
      assert.equal(a.completed_at, 3_000);
      const b = storage.getAgentSession("s-mig-b");
      assert.equal(b?.status, "interrupted");
      assert.equal(b?.error, "stopped");
      assert.equal(b?.completed_at, null);
      assert.equal(storage.getAgentSession("s-mig-c")?.error, "boom");

      // v18 columns exist and backfilled to NULL on legacy rows.
      assert.equal(a.trigger_sender_id, null);
      assert.equal(a.trigger_sender_display_name, null);

      // v20 actuals columns exist and backfilled to NULL on legacy rows.
      assert.equal(a.llm_requests, null);
      assert.equal(a.usage_input_tokens, null);
      assert.equal(a.usage_cost, null);
      assert.equal(a.context_tokens, null);
      // And the migrated DB accepts a usage update.
      await storage.updateAgentSessionUsage("s-mig-a", {
        llmRequests: 2,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        cost: 0.001,
        contextTokens: 1000,
      });
      assert.equal(storage.getAgentSession("s-mig-a")?.context_tokens, 1000);

      // The widened CHECK accepts the resume states on a migrated row.
      await storage.updateAgentSessionStatus("s-mig-b", "resuming", { error: "529" });
      assert.equal(storage.getAgentSession("s-mig-b")?.status, "resuming");
      await storage.updateAgentSessionStatus("s-mig-b", "failed-resumable", { error: "529" });
      assert.equal(storage.getAgentSession("s-mig-b")?.status, "failed-resumable");

      // Both indexes were recreated by the rebuild.
      const indexes = storage.read((db) =>
        (
          db
            .prepare(`select name from sqlite_master where type = 'index' and tbl_name = 'agent_sessions'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      assert.ok(indexes.includes("idx_agent_sessions_timeline"));
      assert.ok(indexes.includes("idx_agent_sessions_status"));

      // A fresh insert with the sender identity round-trips on the migrated DB.
      await storage.insertAgentSession(baseInsert({ id: "s-post-mig-1" }));
      const fresh = storage.getAgentSession("s-post-mig-1");
      assert.equal(fresh?.trigger_sender_id, "@alice:example.org");
      assert.equal(fresh?.trigger_sender_display_name, "Alice");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v17 -> v18 ALTER adds the trigger-sender columns with populated rows intact (issue #18)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-v17-rows-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(V6_TIMELINE_EVENTS);
    legacy.exec(V17_AGENT_SESSIONS);
    const insert = legacy.prepare(FULL_ROW_INSERT);
    // A parked resume row — exactly what a manual resume reads post-migration.
    insert.run(legacyRow("s-parked-01", "failed-resumable", { error: "529 overloaded", completedAt: null }));
    insert.run(legacyRow("s-done-0001", "completed", { noReply: 1 }));
    legacy.pragma("user_version = 17");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => db.pragma("user_version", { simple: true }) as number);
      assert.equal(version, LATEST_SCHEMA_VERSION);

      const parked = storage.getAgentSession("s-parked-01");
      assert.ok(parked);
      assert.equal(parked.status, "failed-resumable");
      assert.equal(parked.error, "529 overloaded");
      assert.equal(parked.context_snapshot_json, '[{"type":"system"}]');
      assert.equal(parked.transcript_json, '[{"role":"user"}]');
      // New columns backfill to NULL (resume then falls back to the bot identity).
      assert.equal(parked.trigger_sender_id, null);
      assert.equal(parked.trigger_sender_display_name, null);
      assert.equal(storage.getAgentSession("s-done-0001")?.no_reply, 1);

      // New writes carry the sender identity.
      await storage.insertAgentSession(
        baseInsert({ id: "s-post-mig-2", triggerSenderId: "@bob:example.org", triggerSenderDisplayName: "Bob" }),
      );
      const fresh = storage.getAgentSession("s-post-mig-2");
      assert.equal(fresh?.trigger_sender_id, "@bob:example.org");
      assert.equal(fresh?.trigger_sender_display_name, "Bob");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #9 (pairs with #1): the per-branch resume usage-seed choice.
//
// `resumeUsageSeed(row, mode)` is the pure factoring of the seed decision
// `resumeSessionRun` applies. The load-bearing invariant: a `fresh`-classified
// row must NOT inherit the row's usage columns even when they are populated —
// usage persists at the Layer-0 `done` commit (enqueued BEFORE the turn's
// transcript flush), so a crash in that window leaves usage columns written
// while `transcript_json` is null, which `loadResumeMaterial` classifies as
// `fresh`. Seeding fresh from the row would double-count those requests and
// could trip the first-request budget check (spec §6.2/D3). Only `continue`
// mode inherits. The pre-#1 code seeded BOTH branches from the row; these
// tests fail on that behavior.
// ---------------------------------------------------------------------------

test("resumeUsageSeed: a fresh-mode row with NON-NULL usage columns yields an empty seed", async () => {
  await withStorage(async (storage) => {
    // A row whose usage columns are populated (first request committed) but
    // whose transcript never flushed — the real crash window that classifies
    // `fresh`. We populate usage but leave transcript_json null.
    await storage.insertAgentSession(baseInsert());
    await storage.updateAgentSessionUsage("s-abc1234567", {
      llmRequests: 3,
      inputTokens: 4_000,
      outputTokens: 800,
      cacheReadTokens: 120_000,
      cacheWriteTokens: 5_000,
      cost: 0.07,
      contextTokens: 190_000,
    });
    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    // Sanity: usage IS populated, transcript is NOT (the crash window).
    assert.equal(row.llm_requests, 3);
    assert.equal(row.context_tokens, 190_000);
    assert.equal(row.transcript_json, null);

    // Fresh path: the rebuilt tracker must start from zero totals / null
    // contextTokens, NOT the populated row (else double-count + D3 violation).
    const seed = resumeUsageSeed(row, "fresh");
    assert.deepEqual(seed, emptyUsageTotals());
    assert.equal(seed.llmRequests, 0);
    assert.equal(seed.inputTokens, 0);
    assert.equal(seed.outputTokens, 0);
    assert.equal(seed.cacheReadTokens, 0);
    assert.equal(seed.cacheWriteTokens, 0);
    assert.equal(seed.cost, 0);
    assert.equal(seed.contextTokens, null);
  });
});

test("resumeUsageSeed: a continue-mode row DOES inherit its persisted usage totals", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());
    await storage.updateAgentSessionUsage("s-abc1234567", {
      llmRequests: 3,
      inputTokens: 4_000,
      outputTokens: 800,
      cacheReadTokens: 120_000,
      cacheWriteTokens: 5_000,
      cost: 0.07,
      contextTokens: 190_000,
    });
    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);

    // Continue path: keep accumulating from the persisted totals (spec §4.3).
    const seed = resumeUsageSeed(row, "continue");
    assert.equal(seed.llmRequests, 3);
    assert.equal(seed.inputTokens, 4_000);
    assert.equal(seed.outputTokens, 800);
    assert.equal(seed.cacheReadTokens, 120_000);
    assert.equal(seed.cacheWriteTokens, 5_000);
    assert.ok(Math.abs(seed.cost - 0.07) < 1e-9);
    assert.equal(seed.contextTokens, 190_000);
  });
});

test("resumeUsageSeed: a legacy row with NULL usage columns yields an empty seed in either mode", async () => {
  await withStorage(async (storage) => {
    // No updateAgentSessionUsage call: usage columns read as null (legacy row).
    await storage.insertAgentSession(baseInsert());
    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row);
    assert.equal(row.llm_requests, null);
    assert.equal(row.context_tokens, null);

    // Both branches collapse to the zero/null totals when nothing was committed.
    assert.deepEqual(resumeUsageSeed(row, "fresh"), emptyUsageTotals());
    assert.deepEqual(resumeUsageSeed(row, "continue"), emptyUsageTotals());
  });
});

// ---------------------------------------------------------------------------
// Console sessions filter (ARCHITECTURE.md §11): `searchAgentSessionsByTimeline`
// (status / type / trigger-message FTS) + `getAgentSessionTimelineFacets`, backed
// by the `agent_sessions_fts` external-content FTS5 index (v23). All filters are
// AND-combined; values within a category are OR'd.
// ---------------------------------------------------------------------------

const FILTER_ROOM = "matrix:miku:room:!filter";

async function seedFilterRows(storage: Storage): Promise<void> {
  await storage.insertAgentSession(
    baseInsert({
      id: "s-rocket-1",
      timelineKey: FILTER_ROOM,
      status: "completed",
      sessionType: "default",
      triggerBody: "deploy the rocket to mars",
      createdAt: 100,
    }),
  );
  await storage.insertAgentSession(
    baseInsert({
      id: "s-cat-2",
      timelineKey: FILTER_ROOM,
      status: "running",
      sessionType: "proactive",
      triggerBody: "feed the cat please",
      createdAt: 200,
    }),
  );
  await storage.insertAgentSession(
    baseInsert({
      id: "s-rocket-3",
      timelineKey: FILTER_ROOM,
      status: "failed-resumable",
      sessionType: "diary",
      triggerBody: "rocket launch checklist",
      createdAt: 300,
    }),
  );
  // A different room with a body that WOULD match — proves room scoping.
  await storage.insertAgentSession(
    baseInsert({
      id: "s-other-4",
      timelineKey: "matrix:miku:room:!other",
      status: "completed",
      sessionType: "default",
      triggerBody: "rocket elsewhere",
      createdAt: 400,
    }),
  );
}

test("searchAgentSessionsByTimeline: FTS over trigger_body is room-scoped and reverse-chron", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const match = sanitizeTriggerFtsMatch("rocket");
    assert.ok(match, "non-empty query sanitizes to a MATCH expr");
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: match });
    // s-rocket-3 (300) before s-rocket-1 (100); the other-room row never leaks.
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-3", "s-rocket-1"],
    );
  });
});

test("searchAgentSessionsByTimeline: a bare partial term is an implicit prefix (search-as-you-type)", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    // No trailing `*` — typing "roc" must still find "rocket" (the box is incremental).
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: sanitizeTriggerFtsMatch("roc"),
    });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-3", "s-rocket-1"],
    );
    // An explicit trailing `*` collapses to the same prefix (no double star).
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: sanitizeTriggerFtsMatch("rock*") })
        .map((h) => h.id)
        .sort(),
      ["s-rocket-1", "s-rocket-3"],
    );
    // Multi-term: each fragment is its own prefix, AND-combined.
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, {
          triggerMatch: sanitizeTriggerFtsMatch("dep roc"),
        })
        .map((h) => h.id),
      ["s-rocket-1"],
    );
  });
});

test("searchAgentSessionsByTimeline: status filter (OR within category)", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      statuses: ["running", "failed-resumable"],
    });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-3", "s-cat-2"],
    );
  });
});

test("searchAgentSessionsByTimeline: session-type filter", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      sessionTypes: ["diary", "proactive"],
    });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-3", "s-cat-2"],
    );
  });
});

test("searchAgentSessionsByTimeline: filters are AND-combined across categories", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const match = sanitizeTriggerFtsMatch("rocket");
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: match,
      statuses: ["failed-resumable"],
    });
    // Only s-rocket-3 matches BOTH the text and the status.
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-3"],
    );
  });
});

test("searchAgentSessionsByTimeline: no filters == getAgentSessionsByTimeline", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const filtered = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {});
    const plain = storage.getAgentSessionsByTimeline(FILTER_ROOM);
    assert.deepEqual(
      filtered.map((h) => h.id),
      plain.map((h) => h.id),
    );
    // Three rows in this room, reverse-chron.
    assert.deepEqual(
      filtered.map((h) => h.id),
      ["s-rocket-3", "s-cat-2", "s-rocket-1"],
    );
  });
});

test("searchAgentSessionsByTimeline: FTS operators in user text can't inject syntax", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    // Quotes/operators are neutralized by sanitizeTriggerFtsMatch — the query must
    // not throw, and the bare term still matches.
    const match = sanitizeTriggerFtsMatch('rocket OR "); drop');
    assert.ok(match);
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: match });
    // "rocket" AND "drop" — no row has both, so zero hits, but crucially no error.
    assert.deepEqual(hits, []);
    // The bare token alone still works.
    const ok = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: sanitizeTriggerFtsMatch("checklist"),
    });
    assert.deepEqual(
      ok.map((h) => h.id),
      ["s-rocket-3"],
    );
  });
});

test("agent_sessions_fts stays correct across a status update (au trigger gated on trigger_body)", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    // A status churn (the common case) must not corrupt or drop the FTS row.
    await storage.updateAgentSessionStatus("s-rocket-1", "running");
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: sanitizeTriggerFtsMatch("mars"),
    });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-rocket-1"],
    );
  });
});

test("getAgentSessionTimelineFacets: distinct types present in the room, sorted", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    const facets = storage.getAgentSessionTimelineFacets(FILTER_ROOM);
    assert.deepEqual(facets.types, ["default", "diary", "proactive"]);
    // Empty room → no types.
    assert.deepEqual(storage.getAgentSessionTimelineFacets("matrix:miku:room:!empty").types, []);
  });
});

// ---------------------------------------------------------------------------
// Interjection search (ARCHITECTURE.md §8/§11): a session is reachable by an
// interjection's text, not only its trigger — the "timeline message → session"
// debug path. `searchAgentSessionsByTimeline` ORs trigger_body and interjection
// bodies; both are room-scoped through the parent session.
// ---------------------------------------------------------------------------

test("searchAgentSessionsByTimeline: a session is found by an interjection body, not just its trigger", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(
      baseInsert({ id: "s-int-1", timelineKey: FILTER_ROOM, triggerBody: "alpha trigger" }),
    );
    await storage.insertSessionInterjection({
      sessionId: "s-int-1",
      eventId: "evt-int-1",
      externalId: "$int-1",
      kind: "reply",
      body: "zulu interjection text",
      createdAt: 1_500,
    });

    // The interjection word finds the session even though it's not in the trigger.
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: sanitizeTriggerFtsMatch("zulu") })
        .map((h) => h.id),
      ["s-int-1"],
    );
    // The trigger word still finds it too (OR over both corpora).
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: sanitizeTriggerFtsMatch("alpha") })
        .map((h) => h.id),
      ["s-int-1"],
    );
  });
});

test("searchAgentSessionsByTimeline: interjection match is room-scoped through the session", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(
      baseInsert({ id: "s-here", timelineKey: FILTER_ROOM, triggerBody: "here trigger" }),
    );
    await storage.insertAgentSession(
      baseInsert({ id: "s-there", timelineKey: "matrix:miku:room:!other", triggerBody: "there trigger" }),
    );
    await storage.insertSessionInterjection({
      sessionId: "s-here",
      kind: "reply",
      body: "shared keyword",
      createdAt: 1_500,
    });
    await storage.insertSessionInterjection({
      sessionId: "s-there",
      kind: "reply",
      body: "shared keyword",
      createdAt: 1_500,
    });

    // Same interjection text in two rooms — only the queried room's session returns.
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, { triggerMatch: sanitizeTriggerFtsMatch("keyword") })
        .map((h) => h.id),
      ["s-here"],
    );
  });
});

test("searchAgentSessionsByTimeline: multiple matching interjections return the session once", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(
      baseInsert({ id: "s-multi", timelineKey: FILTER_ROOM, triggerBody: "t" }),
    );
    for (let i = 0; i < 3; i++) {
      await storage.insertSessionInterjection({
        sessionId: "s-multi",
        kind: "co-reply",
        body: `recurring token ${i}`,
        createdAt: 1_000 + i,
      });
    }
    const hits = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: sanitizeTriggerFtsMatch("recurring"),
    });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["s-multi"],
    );
  });
});

test("searchAgentSessionsByTimeline: status/type filters still AND with an interjection match", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(
      baseInsert({
        id: "s-run",
        timelineKey: FILTER_ROOM,
        status: "running",
        sessionType: "default",
        triggerBody: "t1",
      }),
    );
    await storage.insertAgentSession(
      baseInsert({
        id: "s-done",
        timelineKey: FILTER_ROOM,
        status: "completed",
        sessionType: "default",
        triggerBody: "t2",
      }),
    );
    for (const id of ["s-run", "s-done"]) {
      await storage.insertSessionInterjection({
        sessionId: id,
        kind: "reply",
        body: "needle",
        createdAt: 1_500,
      });
    }
    // Both sessions have the interjection; the status filter narrows to one.
    assert.deepEqual(
      storage
        .searchAgentSessionsByTimeline(FILTER_ROOM, {
          triggerMatch: sanitizeTriggerFtsMatch("needle"),
          statuses: ["running"],
        })
        .map((h) => h.id),
      ["s-run"],
    );
  });
});

test("v23 -> v24 builds session_interjections + its FTS and supports interjection search", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-v23-int-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(V6_TIMELINE_EVENTS);
    legacy.exec(V22_AGENT_SESSIONS);
    // A v23 DB additionally has agent_sessions_fts (v22→v23); build it so the
    // fixture is a faithful v23 and the v23→v24 step is the only one that runs.
    legacy.exec(`create virtual table agent_sessions_fts using fts5(
      trigger_body, content='agent_sessions', content_rowid='rowid');`);
    const insert = legacy.prepare(FULL_ROW_INSERT);
    insert.run(legacyRow("s-v23", "completed", { triggerBody: "legacy trigger" }));
    legacy.pragma("user_version = 23");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(
        storage.read((db) => db.pragma("user_version", { simple: true }) as number),
        LATEST_SCHEMA_VERSION,
      );
      const room = "matrix:miku:room:!room";
      await storage.insertSessionInterjection({
        sessionId: "s-v23",
        eventId: "evt-x",
        kind: "reply",
        body: "postmigration interjection",
        createdAt: 5_000,
      });
      assert.deepEqual(
        storage
          .searchAgentSessionsByTimeline(room, {
            triggerMatch: sanitizeTriggerFtsMatch("postmigration"),
          })
          .map((h) => h.id),
        ["s-v23"],
      );
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v22 -> v23 migration: create `agent_sessions_fts` and BACKFILL it from rows that
// already exist (the triggers only cover rows written from here on).
// ---------------------------------------------------------------------------

/** The v22 `agent_sessions` shape: full current columns, but NO FTS index yet. */
const V22_AGENT_SESSIONS = `create table agent_sessions (
   id text primary key,
   timeline_key text not null,
   session_type text not null default 'default',
   status text not null
     check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended',
                      'resuming', 'failed-resumable')),
   model_id text,
   trigger_event_id text,
   trigger_external_id text,
   trigger_body text,
   trigger_sender_id text,
   trigger_sender_display_name text,
   context_snapshot_json text,
   context_dump_path text,
   transcript_json text,
   token_estimate integer,
   llm_requests integer,
   usage_input_tokens integer,
   usage_output_tokens integer,
   usage_cache_read_tokens integer,
   usage_cache_write_tokens integer,
   usage_cost real,
   context_tokens integer,
   no_reply integer not null default 0,
   error text,
   created_at integer not null,
   started_at integer,
   updated_at integer not null,
   completed_at integer
 );
 create index idx_agent_sessions_timeline on agent_sessions(timeline_key, created_at desc);
 create index idx_agent_sessions_status on agent_sessions(status, updated_at desc);`;

test("v22 -> v23 builds agent_sessions_fts and backfills existing rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-v22-fts-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(V6_TIMELINE_EVENTS); // fresh-vs-existing probe keys on this table
    legacy.exec(V22_AGENT_SESSIONS);
    const insert = legacy.prepare(FULL_ROW_INSERT);
    insert.run(legacyRow("s-pre-rocket", "completed", { triggerBody: "rocket to the moon" }));
    insert.run(legacyRow("s-pre-cat", "running", { triggerBody: "where is the cat" }));
    legacy.pragma("user_version = 22");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(
        storage.read((db) => db.pragma("user_version", { simple: true }) as number),
        LATEST_SCHEMA_VERSION,
      );
      // The pre-existing rows are now searchable (backfill worked).
      const room = "matrix:miku:room:!room";
      const hits = storage.searchAgentSessionsByTimeline(room, {
        triggerMatch: sanitizeTriggerFtsMatch("rocket"),
      });
      assert.deepEqual(
        hits.map((h) => h.id),
        ["s-pre-rocket"],
      );
      // And a row inserted post-migration is indexed by the live triggers.
      await storage.insertAgentSession(
        baseInsert({ id: "s-post-fts", timelineKey: room, triggerBody: "another rocket flight" }),
      );
      assert.equal(
        storage
          .searchAgentSessionsByTimeline(room, { triggerMatch: sanitizeTriggerFtsMatch("rocket") })
          .length,
        2,
      );
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
