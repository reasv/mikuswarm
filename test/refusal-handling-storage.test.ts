/**
 * Refusal handling storage (spec REFUSAL-HANDLING §9, §10.1): schema v25
 * (refusal_events, contract_attempts, agent_session_branches + new columns), the
 * reserved no-op steps up to v29, and the storage methods.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LATEST_SCHEMA_VERSION,
  REFUSAL_EXPLANATION_MAX_CHARS,
  Storage,
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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-rh-mig-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function addSession(storage: Storage, id: string): Promise<void> {
  await storage.insertAgentSession({
    id, timelineKey: "matrix:a:room:!r:x", sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
  });
}

const TABLES = [
  "refusal_events",
  "contract_attempts",
  "agent_session_branches",
  "agent_sessions",
  "decision_evaluations",
  "usage_events",
];

// Structural shape: columns (type/nullability/default/pk) and indexes with columns.
function shape(s: Storage) {
  return s.read((db) =>
    TABLES.map((table) => ({
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
}

// Turn a latest-shape DB back into the v24 shape.
function downgradeToV24(storage: Storage): Promise<void> {
  return storage.write((db) => {
    db.exec("drop table refusal_events");
    db.exec("drop table contract_attempts");
    db.exec("drop table agent_session_branches");
    for (const col of ["contract_outcome", "contract_nudges", "contract_version", "refusal_pin"]) {
      db.exec(`alter table agent_sessions drop column ${col}`);
    }
    for (const col of ["checkpoint", "branch_no", "tool_call_id", "attempt_no", "consequence"]) {
      db.exec(`alter table decision_evaluations drop column ${col}`);
    }
    db.exec("alter table usage_events drop column system_prompt_hash");
    db.pragma("user_version = 24");
  });
}

test("schema: LATEST_SCHEMA_VERSION is 29 (v25 + four reserved steps)", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 29);
});

test("migration: a v24 database migrates to the fresh-DB shape, rows kept", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "v24.db");
    const fresh = await Storage.open({ databasePath: ":memory:" });
    const freshShape = shape(fresh);
    fresh.close();
    const names = (t: string) =>
      (freshShape.find((x) => x.table === t)!.columns as { name: string }[]).map((c) => c.name);
    assert.ok(names("agent_sessions").includes("refusal_pin"));
    assert.ok(names("decision_evaluations").includes("consequence"));
    assert.ok(names("usage_events").includes("system_prompt_hash"));

    {
      const s = await Storage.open({ databasePath: dbPath });
      await addSession(s, "s-old");
      await downgradeToV24(s);
      await s.waitForIdle();
      s.close();
    }
    const migrated = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(migrated.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
      assert.deepEqual(shape(migrated), freshShape, "migrated shape equals the fresh-DB shape");
      assert.equal(migrated.getAgentSessionMeta("s-old")?.status, "running", "existing rows survive");
      await migrated.setAgentSessionRefusalPin("s-old", { rule: "r", model: "m", at: 5 });
      assert.deepEqual(migrated.getAgentSessionRefusalPin("s-old"), { rule: "r", model: "m", at: 5 });
    } finally {
      await migrated.waitForIdle();
      migrated.close();
    }
  });
});

test("migration: re-running the v24→v29 steps on a latest-shape DB is a no-op", async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, "rerun.db");
    let before: unknown;
    {
      const s = await Storage.open({ databasePath: dbPath });
      before = shape(s);
      await addSession(s, "s1");
      await s.insertRefusalEvent({
        ts: 1, agentSessionId: "s1", site: "default", kind: "hard", checkCode: "refusal_safety",
        reason: "safety", method: "stop_reason", checkpoint: "request", outcome: "fallover",
      });
      await s.write((db) => db.pragma("user_version = 24"));
      await s.waitForIdle();
      s.close();
    }
    const again = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(again.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
      assert.deepEqual(shape(again), before);
      assert.equal(again.listRefusalEvents("s1").length, 1, "rows survive the re-run");
    } finally {
      await again.waitForIdle();
      again.close();
    }
  });
});

test("insertRefusalEvent / listRefusalEvents: round-trip, defaults, explanation cap", async () => {
  await withStorage(async (storage) => {
    const id1 = await storage.insertRefusalEvent({
      ts: 20, agentSessionId: "s1", site: "default", agent: "agent_a", timelineKey: "k", tasks: ["coding", "other"],
      servedModel: "model_a", wireModel: "vendor/model-a", kind: "hard", checkCode: "refusal_distillation",
      reason: "distillation", subReason: "reasoning_extraction", method: "provider_category", source: "api",
      rawStopReason: "refusal", category: "reasoning_extraction", explanation: "x".repeat(500),
      checkpoint: "request", ruleName: "distill", outcome: "redo", toModel: "open_model_x",
    });
    const id2 = await storage.insertRefusalEvent({
      ts: 10, agentSessionId: "s1", site: "default", kind: "soft", checkCode: "refusal_persona", reason: "persona",
      method: "judged", probability: 0.9, checkpoint: "send", outcome: "observed", decisionEvaluationId: 7,
    });
    await storage.insertRefusalEvent({
      ts: 5, agentSessionId: null, site: "caption", kind: "hard", checkCode: "refusal_safety", reason: "safety",
      method: "stop_reason", checkpoint: "request", outcome: "exhausted_no_output",
    });
    assert.ok(id2 > id1);
    const rows = storage.listRefusalEvents("s1");
    assert.deepEqual(rows.map((r) => r.id), [id2, id1], "oldest first");
    const hard = rows[1]!;
    assert.equal(hard.tasks_json, JSON.stringify(["coding", "other"]));
    assert.equal(hard.explanation?.length, REFUSAL_EXPLANATION_MAX_CHARS);
    assert.equal(hard.branch_no, 0);
    assert.equal(hard.to_model, "open_model_x");
    const soft = rows[0]!;
    assert.equal(soft.tasks_json, null, "taskless = null");
    assert.equal(soft.probability, 0.9);
    assert.equal(soft.decision_evaluation_id, 7);
    assert.equal(soft.explanation, null);
  });
});

test("insertContractAttempts: upsert on (session, branch, redo, attempt)", async () => {
  await withStorage(async (storage) => {
    await storage.insertContractAttempts([
      { agentSessionId: "s1", attemptNo: 0, ts: 1, variant: "original", failureTypes: ["text_only"], primaryType: "text_only" },
      { agentSessionId: "s1", attemptNo: 1, ts: 2, variant: "not_sent", failureTypes: [], servedModel: "model_a" },
    ]);
    await storage.insertContractAttempts([
      { agentSessionId: "s1", attemptNo: 1, ts: 3, variant: "not_sent", failureTypes: ["empty"], primaryType: "empty" },
      { agentSessionId: "s1", redoNo: 1, attemptNo: 0, ts: 4, variant: "original", failureTypes: [] },
    ]);
    await storage.insertContractAttempts([]);
    const rows = storage.listContractAttempts("s1");
    assert.deepEqual(
      rows.map((r) => [r.redo_no, r.attempt_no, r.primary_type, r.failure_types_json, r.ts]),
      [
        [0, 0, "text_only", '["text_only"]', 1],
        [0, 1, "empty", '["empty"]', 3],
        [1, 0, null, "[]", 4],
      ],
    );
  });
});

test("setAgentSessionContract writes the per-session outcome", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s1");
    await storage.setAgentSessionContract("s1", { outcome: "recovered", nudges: 2, version: 1 });
    const row = storage.read((db) =>
      db.prepare("select contract_outcome, contract_nudges, contract_version from agent_sessions where id = 's1'").get(),
    );
    assert.deepEqual(row, { contract_outcome: "recovered", contract_nudges: 2, contract_version: 1 });
  });
});

test("insertSessionBranch allocates branch_no per session; rows cascade with the session", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s1");
    await addSession(storage, "s2");
    const [b1, b2, other] = await Promise.all([
      storage.insertSessionBranch({ sessionId: "s1", forkIndex: 4, reason: "refusal_redo", messagesJson: "[]", checkCode: "refusal_safety", fromModel: "a", toModel: "b" }),
      storage.insertSessionBranch({ sessionId: "s1", forkIndex: 4, reason: "refusal_redo", messagesJson: "[1]" }),
      storage.insertSessionBranch({ sessionId: "s2", forkIndex: 0, reason: "contract_redo", messagesJson: "[]", createdAt: 9 }),
    ]);
    assert.deepEqual([b1, b2, other], [1, 2, 1]);
    const rows = storage.listSessionBranches("s1");
    assert.deepEqual(rows.map((r) => [r.branch_no, r.parent_branch_no, r.fork_index, r.messages_json]), [
      [1, 0, 4, "[]"],
      [2, 0, 4, "[1]"],
    ]);
    assert.equal(rows[0]!.check_code, "refusal_safety");
    assert.equal(storage.listSessionBranches("s2")[0]!.created_at, 9);
    await storage.write((db) => db.prepare("delete from agent_sessions where id = 's1'").run());
    assert.equal(storage.listSessionBranches("s1").length, 0);
  });
});

test("refusal pin: set, read, clear; unreadable value reads as undefined", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s1");
    assert.equal(storage.getAgentSessionRefusalPin("s1"), undefined);
    await storage.setAgentSessionRefusalPin("s1", { rule: "distill", model: "open_model_x", at: 42 });
    assert.deepEqual(storage.getAgentSessionRefusalPin("s1"), { rule: "distill", model: "open_model_x", at: 42 });
    await storage.setAgentSessionRefusalPin("s1", null);
    assert.equal(storage.getAgentSessionRefusalPin("s1"), undefined);
    await storage.write((db) => db.prepare("update agent_sessions set refusal_pin = 'nope' where id = 's1'").run());
    assert.equal(storage.getAgentSessionRefusalPin("s1"), undefined);
    assert.equal(storage.getAgentSessionRefusalPin("missing"), undefined);
  });
});

test("insertDecisionEvaluation returns the id and stores the anchor fields", async () => {
  await withStorage(async (storage) => {
    const id = await storage.insertDecisionEvaluation({
      ts: 1, decision_group: "g", point: "checks", source: "pattern", agent_session_id: "s1",
      checkpoint: "send", branch_no: 0, tool_call_id: "call_1", consequence: "sent",
    });
    const id2 = await storage.insertDecisionEvaluation({
      ts: 2, decision_group: "g", point: "checks", source: "model", agent_session_id: "s1",
      checkpoint: "ending", attempt_no: 2, consequence: "observed",
    });
    assert.ok(id > 0 && id2 === id + 1);
    const rows = storage.getDecisionEvaluationsForSession("s1");
    assert.deepEqual(
      rows.map((r) => [r.id, r.source, r.checkpoint, r.branch_no, r.tool_call_id, r.attempt_no, r.consequence]),
      [
        [id, "pattern", "send", 0, "call_1", null, "sent"],
        [id2, "model", "ending", null, null, 2, "observed"],
      ],
    );
  });
});

test("insertUsageEvent stores system_prompt_hash and accepts the audit class", async () => {
  await withStorage(async (storage) => {
    await storage.insertUsageEvent({ class: "agent_loop", modelId: "m", costUsd: 0, systemPromptHash: "abc123" });
    await storage.insertUsageEvent({ class: "audit", modelId: "m", costUsd: 0.01 });
    const rows = storage.read((db) =>
      db.prepare("select class, system_prompt_hash from usage_events order by created_at, rowid").all(),
    );
    assert.deepEqual(rows, [
      { class: "agent_loop", system_prompt_hash: "abc123" },
      { class: "audit", system_prompt_hash: null },
    ]);
  });
});
