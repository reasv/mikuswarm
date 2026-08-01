import assert from "node:assert/strict";
import test from "node:test";
import {
  LATEST_SCHEMA_VERSION,
  Storage,
  type AgentSessionInsert,
} from "../src/storage/index.js";
import type { Logger } from "../src/observability/index.js";
import { resumeUsageSeed } from "../src/app.js";
import { emptyUsageTotals } from "../src/agent/usage.js";
import { sanitizeTriggerFtsMatch } from "../src/search/query.js";

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

test("LATEST_SCHEMA_VERSION is 11", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 11);
});

// --- Issue #16: the memory_chunks FTS triggers round-trip insert→MATCH→delete→MATCH ---
//
// This pins the external-content `'delete'` trigger syntax of `memory_chunks_ad`
// against the CURRENT schema (a fresh Storage open) independent of the indexer: a
// deleted row's terms must be retracted from FTS, and the external-content index must
// stay internally consistent.

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

test("all agent_sessions indexes exist on a fresh DB", async () => {
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
    for (const expected of [
      "idx_agent_sessions_timeline",
      "idx_agent_sessions_status",
      "idx_agent_sessions_recent",
      "idx_agent_sessions_sender_recent",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}; have: ${names.join(", ")}`);
    }
  });
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

test("session list reads omit heavyweight detail payloads", async () => {
  await withStorage(async (storage) => {
    await seedFilterRows(storage);
    await storage.saveAgentSessionSnapshot("s-rocket-3", {
      snapshotJson: JSON.stringify([{ type: "system", content: "large frozen context".repeat(100) }]),
      dumpPath: "/tmp/s-rocket-3.json",
      tokenEstimate: 123,
    });
    await storage.saveAgentSessionTranscript(
      "s-rocket-3",
      JSON.stringify([{ role: "assistant", content: "large rollout".repeat(100) }]),
    );

    const plain = storage.getAgentSessionsByTimeline(FILTER_ROOM);
    const filtered = storage.searchAgentSessionsByTimeline(FILTER_ROOM, {
      triggerMatch: sanitizeTriggerFtsMatch("rocket"),
    });
    for (const row of [...plain, ...filtered]) {
      assert.equal(Object.hasOwn(row, "context_snapshot_json"), false);
      assert.equal(Object.hasOwn(row, "context_dump_path"), false);
      assert.equal(Object.hasOwn(row, "transcript_json"), false);
    }

    // The single-session detail read remains the full durable row; optimizing the
    // list must not remove the context/rollout data the console opens on click.
    const detail = storage.getAgentSession("s-rocket-3");
    assert.ok(detail?.context_snapshot_json?.includes("large frozen context"));
    assert.ok(detail?.transcript_json?.includes("large rollout"));
    assert.equal(detail?.context_dump_path, "/tmp/s-rocket-3.json");
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

// A room subsumes its thread sub-timelines in the console drill-down (mirrors
// `listConsoleRooms` folding threads into their parent room): a session that
// landed on a `<room>:thread:<root>` timeline is reachable — and counted — from
// the room key, without leaking sessions from a different room.
test("room session drill-down includes thread sub-timelines, scoped to the room", async () => {
  await withStorage(async (storage) => {
    const room = "matrix:miku:room:!thr:example.org";
    const thread = `${room}:thread:$root`;
    const sibling = "matrix:miku:room:!sib:example.org";
    await storage.insertAgentSession(
      baseInsert({ id: "s-room", timelineKey: room, triggerBody: "room msg", createdAt: 100 }),
    );
    await storage.insertAgentSession(
      baseInsert({
        id: "s-thread",
        timelineKey: thread,
        sessionType: "diary",
        triggerBody: "thread msg",
        createdAt: 200,
      }),
    );
    // A sibling room whose own thread must NOT leak into `room`'s drill-down.
    await storage.insertAgentSession(
      baseInsert({
        id: "s-sibling",
        timelineKey: `${sibling}:thread:$x`,
        triggerBody: "sibling msg",
        createdAt: 300,
      }),
    );

    // Plain list: room + thread session, reverse-chron; sibling excluded.
    assert.deepEqual(
      storage.getAgentSessionsByTimeline(room).map((r) => r.id),
      ["s-thread", "s-room"],
    );
    // Search: an empty filter matches the same room+thread set.
    assert.deepEqual(
      storage.searchAgentSessionsByTimeline(room, {}).map((r) => r.id),
      ["s-thread", "s-room"],
    );
    // Type facets aggregate across the room and its threads.
    assert.deepEqual(storage.getAgentSessionTimelineFacets(room).types, ["default", "diary"]);
    // Sibling room sees only its own thread session.
    assert.deepEqual(
      storage.getAgentSessionsByTimeline(sibling).map((r) => r.id),
      ["s-sibling"],
    );
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

// --- Issue #10: logical_model_id empty-string footgun ---
// ---------------------------------------------------------------------------
// Fix 2: LIKE wildcard escaping — account key with `_` must not cross-match
// (spec MULTI-AGENT-SUPPORT §8, database.ts usageCostClauses + getDistinctTimelineKeysForAccountPrefixes)
// ---------------------------------------------------------------------------

test("sumUsageCost timelineKeyPrefixes: account key with underscore does not cross-match other accounts", async () => {
  // An account key with `_` (a LIKE single-char wildcard) must not cross-match
  // keys that differ at that position. Without escaping, prefix "matrix:a_ice"
  // would match both "matrix:a_ice:t:!r:hs" (exact) and "matrix:alice:t:!r:hs"
  // (the underscore matches 'l').
  await withStorage(async (storage) => {
    // Row attributed to "matrix:a_ice" (account with underscore in key).
    await storage.insertUsageEvent({
      class: "agent_loop",
      modelId: "m1",
      costUsd: 1,
      timelineKey: "matrix:a_ice:t:!room:hs",
    });
    // Row attributed to "matrix:alice" (different account, 'l' where underscore was).
    await storage.insertUsageEvent({
      class: "agent_loop",
      modelId: "m1",
      costUsd: 10,
      timelineKey: "matrix:alice:t:!room:hs",
    });
    await storage.waitForIdle();

    // Querying for "matrix:a_ice" must find only its own $1 row, not alice's $10.
    const cost = storage.sumUsageCost({ since: 0, timelineKeyPrefixes: ["matrix:a_ice"] });
    assert.equal(cost, 1, "underscore in account key must not match 'l' in alice's key");

    // Querying for "matrix:alice" must find only its own $10 row.
    const aliceCost = storage.sumUsageCost({ since: 0, timelineKeyPrefixes: ["matrix:alice"] });
    assert.equal(aliceCost, 10, "alice's scoped sum must not be cross-contaminated");
  });
});

test("getDistinctTimelineKeysForAccountPrefixes: underscore in prefix does not cross-match", async () => {
  // Same escaping requirement for the Phase 2 search-filter function.
  await withStorage(async (storage) => {
    // Seed backing timeline_events rows (FK requirement for chat_index) then minimal
    // chat_index rows for two accounts: one with underscore, one without.
    // getDistinctTimelineKeysForAccountPrefixes queries chat_index, not usage_events.
    await storage.readAndWrite((db) => {
      // Minimal timeline_events rows to satisfy the FK.
      const evtStmt = db.prepare(
        `insert into timeline_events
           (id, timeline_key, provider, role, sender_id, body, timestamp,
            received_at, event_json, enrichment_status, created_at, updated_at)
         values (?, ?, 'matrix', 'user', '@bot:hs', '', ?, ?, '{}', 'complete', ?, ?)`,
      );
      evtStmt.run("e1", "matrix:a_ice:t:!room:hs", 1000, 1000, 1000, 1000);
      evtStmt.run("e2", "matrix:alice:t:!room:hs", 2000, 2000, 2000, 2000);
      // Minimal chat_index rows with all required non-null columns.
      const idxStmt = db.prepare(
        `insert into chat_index
           (event_id, timeline_key, sender_id, role, timestamp, content_sig, indexed_at)
         values (?, ?, '@bot:hs', 'user', ?, ?, ?)`,
      );
      idxStmt.run("e1", "matrix:a_ice:t:!room:hs", 1000, "sig1", 1000);
      idxStmt.run("e2", "matrix:alice:t:!room:hs", 2000, "sig2", 2000);
    });

    // Querying for "matrix:a_ice:" prefix (with trailing colon) must return only
    // the a_ice key, not alice's.
    const keys = storage.getDistinctTimelineKeysForAccountPrefixes(["matrix:a_ice:"]);
    assert.deepEqual(keys, ["matrix:a_ice:t:!room:hs"], "underscore must not match 'l' in alice's key");

    // Querying for "matrix:alice:" must return only alice's key.
    const aliceKeys = storage.getDistinctTimelineKeysForAccountPrefixes(["matrix:alice:"]);
    assert.deepEqual(aliceKeys, ["matrix:alice:t:!room:hs"], "alice prefix must not match a_ice");
  });
});

// `insertUsageEvent` must use `||` (not `??`) so an explicit empty-string
// logicalModelId falls back to the upstream modelId. A stored `''` would
// mis-scope budget (§8e) and mis-group the ledger/console (§7).
test("insertUsageEvent: empty-string logicalModelId falls back to upstream modelId (issue #10)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Empty string: must NOT be stored as '' — falls back to model_id.
    await storage.insertUsageEvent({ class: "agent_loop", modelId: "wire-model-a", logicalModelId: "", costUsd: 0.1 });
    // Omitted (undefined): existing behavior — also falls back to model_id.
    await storage.insertUsageEvent({ class: "agent_loop", modelId: "wire-model-b", costUsd: 0.2 });
    // Explicit non-empty logical id: preserved verbatim.
    await storage.insertUsageEvent({ class: "agent_loop", modelId: "wire-model-c", logicalModelId: "logical-c", costUsd: 0.3 });
    await storage.waitForIdle();

    const rows = storage.read((db) =>
      db
        .prepare(`select model_id, logical_model_id from usage_events order by model_id`)
        .all() as Array<{ model_id: string; logical_model_id: string }>,
    );
    assert.deepEqual(rows, [
      { model_id: "wire-model-a", logical_model_id: "wire-model-a" }, // '' → fell back
      { model_id: "wire-model-b", logical_model_id: "wire-model-b" }, // undefined → fell back
      { model_id: "wire-model-c", logical_model_id: "logical-c" }, // explicit preserved
    ]);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
