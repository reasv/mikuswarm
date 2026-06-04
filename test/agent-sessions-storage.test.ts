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

test("LATEST_SCHEMA_VERSION is 7", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 7);
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
      for (const t of ["memory_chunks", "memory_chunks_fts", "embedding_cache", "index_meta"]) {
        assert.ok(tables.includes(t), `migration must create ${t}; have: ${tables.join(", ")}`);
      }
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
