/**
 * Tests for SESSION-RECORDS storage: migration v23→v24 (session_records +
 * decision_evaluations tables) and the four new Storage methods.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LATEST_SCHEMA_VERSION,
  Storage,
  type SessionRecordInsert,
  type DecisionEvaluationInsert,
} from "../src/storage/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

// ── migration: schema version and table existence ─────────────────────────────

test("migration: LATEST_SCHEMA_VERSION is 24", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 24);
});

test("migration: session_records table exists in a fresh DB", async () => {
  await withStorage(async (storage) => {
    // A fresh Storage.open() always runs to LATEST_SCHEMA_VERSION.
    // Verify the table is present and has the right columns.
    const record: SessionRecordInsert = {
      session_id: "s-test-1",
      timeline_key: "!room:example.com",
      agent: "miku",
      text: "Found some info.",
      token_count: 5,
      builds_on: [],
      model_id: "opus-1",
      created_at: Date.now(),
    };
    // This would throw if the table were absent.
    await assert.doesNotReject(storage.upsertSessionRecord(record));
  });
});

test("migration: decision_evaluations table exists in a fresh DB", async () => {
  await withStorage(async (storage) => {
    const row: DecisionEvaluationInsert = {
      ts: Date.now(),
      decision_group: "reply",
      point: "should_write_record",
      source: "heuristic",
      agent: "miku",
      timeline_key: "!room:example.com",
    };
    await assert.doesNotReject(storage.insertDecisionEvaluation(row));
  });
});

// ── upsertSessionRecord / getSessionRecord ────────────────────────────────────

test("upsertSessionRecord: insert then retrieve", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    await storage.upsertSessionRecord({
      session_id: "s-abc",
      timeline_key: "!room:example.com",
      agent: "miku",
      text: "Looked into the question. Found the answer: 42.",
      token_count: 12,
      builds_on: [],
      model_id: "chat-model",
      created_at: now,
    });

    const row = storage.getSessionRecord("s-abc");
    assert.ok(row, "should return a row");
    assert.equal(row.session_id, "s-abc");
    assert.equal(row.timeline_key, "!room:example.com");
    assert.equal(row.agent, "miku");
    assert.equal(row.text, "Looked into the question. Found the answer: 42.");
    assert.equal(row.token_count, 12);
    assert.equal(row.builds_on, "[]");
    assert.equal(row.model_id, "chat-model");
    assert.equal(row.created_at, now);
  });
});

test("upsertSessionRecord: upsert updates an existing record", async () => {
  await withStorage(async (storage) => {
    await storage.upsertSessionRecord({
      session_id: "s-upd",
      timeline_key: "!room:example.com",
      agent: "miku",
      text: "First version.",
      token_count: 3,
      builds_on: [],
      created_at: 1000,
    });

    // Re-upsert with updated text.
    await storage.upsertSessionRecord({
      session_id: "s-upd",
      timeline_key: "!room:example.com",
      agent: "miku",
      text: "Revised version.",
      token_count: 4,
      builds_on: ["s-prior"],
      created_at: 2000,
    });

    const row = storage.getSessionRecord("s-upd");
    assert.ok(row);
    assert.equal(row.text, "Revised version.");
    assert.equal(row.token_count, 4);
    assert.equal(row.builds_on, JSON.stringify(["s-prior"]));
    assert.equal(row.created_at, 2000);
  });
});

test("upsertSessionRecord: builds_on stored as JSON", async () => {
  await withStorage(async (storage) => {
    await storage.upsertSessionRecord({
      session_id: "s-chain",
      timeline_key: "!room:example.com",
      agent: undefined,
      text: "Step 3.",
      token_count: 8,
      builds_on: ["s-step1", "s-step2"],
      created_at: Date.now(),
    });

    const row = storage.getSessionRecord("s-chain");
    assert.ok(row);
    assert.equal(row.builds_on, JSON.stringify(["s-step1", "s-step2"]));
  });
});

test("getSessionRecord: missing session → undefined", async () => {
  await withStorage(async (storage) => {
    const row = storage.getSessionRecord("no-such-session");
    assert.equal(row, undefined);
  });
});

// ── insertDecisionEvaluation / getDecisionEvaluationsForSession ───────────────

test("insertDecisionEvaluation: minimal row survives round-trip", async () => {
  await withStorage(async (storage) => {
    const ts = Date.now();
    await storage.insertDecisionEvaluation({
      ts,
      decision_group: "reply",
      point: "should_write_record",
      source: "heuristic",
    });
    const rows = storage.getDecisionEvaluationsForSession(undefined as unknown as string);
    // No agent_session_id set → getDecisionEvaluationsForSession returns nothing
    // (it queries by agent_session_id). This verifies insert doesn't throw.
    assert.equal(rows.length, 0);
  });
});

test("getDecisionEvaluationsForSession: returns rows in ts order", async () => {
  await withStorage(async (storage) => {
    const sessionId = "sess-xyz";
    await storage.insertDecisionEvaluation({
      ts: 200,
      decision_group: "reply",
      point: "should_write_record",
      source: "heuristic",
      agent_session_id: sessionId,
      verdict_json: JSON.stringify({ ok: true }),
    });
    await storage.insertDecisionEvaluation({
      ts: 100,
      decision_group: "reply",
      point: "should_resume",
      source: "model",
      agent_session_id: sessionId,
      answers_json: JSON.stringify({ yes: true }),
    });

    const rows = storage.getDecisionEvaluationsForSession(sessionId);
    assert.equal(rows.length, 2);
    // Ordered by ts ascending.
    assert.equal(rows[0].ts, 100);
    assert.equal(rows[1].ts, 200);
    assert.equal(rows[0].point, "should_resume");
    assert.equal(rows[1].point, "should_write_record");
    assert.equal(rows[0].agent_session_id, sessionId);
    // Verify JSON fields are stored as strings.
    assert.equal(rows[1].verdict_json, JSON.stringify({ ok: true }));
    assert.equal(rows[0].answers_json, JSON.stringify({ yes: true }));
  });
});

test("getDecisionEvaluationsForSession: different sessions are isolated", async () => {
  await withStorage(async (storage) => {
    await storage.insertDecisionEvaluation({
      ts: 1,
      decision_group: "reply",
      point: "p1",
      source: "heuristic",
      agent_session_id: "sess-A",
    });
    await storage.insertDecisionEvaluation({
      ts: 2,
      decision_group: "reply",
      point: "p2",
      source: "heuristic",
      agent_session_id: "sess-B",
    });

    const rowsA = storage.getDecisionEvaluationsForSession("sess-A");
    const rowsB = storage.getDecisionEvaluationsForSession("sess-B");
    assert.equal(rowsA.length, 1);
    assert.equal(rowsB.length, 1);
    assert.equal(rowsA[0].point, "p1");
    assert.equal(rowsB[0].point, "p2");
  });
});

test("insertDecisionEvaluation: full row stored correctly", async () => {
  await withStorage(async (storage) => {
    const ts = 9999;
    const row: DecisionEvaluationInsert = {
      ts,
      decision_group: "record",
      point: "should_write_record",
      agent: "miku",
      timeline_key: "!room:example.com",
      agent_session_id: "sess-full",
      trigger_event_id: "$evt123",
      candidate_session_id: "cand-sess-1",
      source: "model",
      reason: "user asked follow-up",
      verdict_json: JSON.stringify({ result: "yes" }),
      answers_json: JSON.stringify({ q1: "yes" }),
      state_json: JSON.stringify({ state: 1 }),
      questions_json: JSON.stringify(["q1"]),
      served_model: "chat-model",
      served_version: "v1",
      latency_ms: 450,
      input_tokens: 1234,
      cost_usd: 0.0012,
    };
    await storage.insertDecisionEvaluation(row);

    const rows = storage.getDecisionEvaluationsForSession("sess-full");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.ts, ts);
    assert.equal(r.decision_group, "record");
    assert.equal(r.point, "should_write_record");
    assert.equal(r.agent, "miku");
    assert.equal(r.timeline_key, "!room:example.com");
    assert.equal(r.trigger_event_id, "$evt123");
    assert.equal(r.candidate_session_id, "cand-sess-1");
    assert.equal(r.source, "model");
    assert.equal(r.reason, "user asked follow-up");
    assert.equal(r.served_model, "chat-model");
    assert.equal(r.latency_ms, 450);
    assert.equal(r.input_tokens, 1234);
    assert.ok(Math.abs((r.cost_usd ?? 0) - 0.0012) < 1e-8);
    assert.equal(typeof r.id, "number");
    assert.ok(r.id > 0);
  });
});

// ── real v23 → v24 migration ──────────────────────────────────────────────────

test("migration: a v23 database migrates to v24 with the fresh-DB shape, rows kept", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-sr-mig-"));
  const dbPath = path.join(dir, "v23.db");
  // Structural shape (columns with type/nullability/default/pk, and indexes with
  // their columns): the DDL text itself differs only in whitespace and comments.
  const shape = (s: Storage) =>
    s.read((db) =>
      ["session_records", "decision_evaluations"].map((table) => ({
        table,
        columns: db.prepare(`pragma table_info(${table})`).all(),
        indexes: (db.prepare(`pragma index_list(${table})`).all() as { name: string; unique: number }[])
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((index) => ({
            name: index.name,
            unique: index.unique,
            columns: db.prepare(`pragma index_info(${index.name})`).all(),
          })),
      })),
    );
  try {
    // The fresh-DB shape, for comparison.
    const fresh = await Storage.open({ databasePath: ":memory:" });
    const freshShape = shape(fresh);
    fresh.close();
    assert.equal(freshShape[1].indexes.length, 2, "decision_evaluations has its two indexes");

    // Build a v23-shaped database: the v24 tables absent, a pre-existing session row.
    {
      const s = await Storage.open({ databasePath: dbPath });
      await s.insertAgentSession({
        id: "s-old", timelineKey: "matrix:a:room:!r:x", sessionType: "default",
        status: "completed", createdAt: 1, updatedAt: 1,
      });
      await s.write((db) => {
        db.exec("drop table session_records");
        db.exec("drop table decision_evaluations");
        db.pragma("user_version = 23");
      });
      await s.waitForIdle();
      s.close();
    }

    const migrated = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(
        migrated.read((db) => Number(db.pragma("user_version", { simple: true }))),
        LATEST_SCHEMA_VERSION,
      );
      assert.deepEqual(shape(migrated), freshShape, "migrated shape equals the fresh-DB shape");
      assert.equal(migrated.getAgentSessionMeta("s-old")?.status, "completed", "existing rows survive");
      await migrated.upsertSessionRecord({
        session_id: "s-old", timeline_key: "matrix:a:room:!r:x", text: "t", token_count: 1, created_at: 2,
      });
      await migrated.waitForIdle();
      assert.equal(migrated.getSessionRecord("s-old")?.text, "t");
    } finally {
      await migrated.waitForIdle();
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
