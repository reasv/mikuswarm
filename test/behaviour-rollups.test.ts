/**
 * Model behaviour hourly rollups (spec REFUSAL-HANDLING §12.3 "Storage"):
 * dirty-hour triggers, the per-hour computation and attribution, maintenance vs
 * rebuild equivalence, and the v25→v26 migration seed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelBehaviourRollups, computeHourRollups, firedChecks, sessionTasks } from "../src/behaviour/rollups.js";
import { LATEST_SCHEMA_VERSION, Storage } from "../src/storage/index.js";
import { H, HOUR, KEY_A, addRequest, agentFor, seedScenario } from "./behaviour-fixtures.js";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

const rollups = (storage: Storage) =>
  new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor, countTokens: words, hoursPerJob: 2 });

type Row = { hour: number; agent: string; site: string; model: string; metric: string; value: number };

function table(storage: Storage, name = "model_behaviour_rollups"): Row[] {
  return storage.read(
    (db) => db.prepare(`select * from ${name} order by hour, ${name.includes("task") ? "task, " : ""}agent, site, model, metric`).all() as Row[],
  );
}

function value(rows: Row[], match: Partial<Row>): number {
  return rows
    .filter((r) => Object.entries(match).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
    .reduce((n, r) => n + r.value, 0);
}

function dirtyHours(storage: Storage): number[] {
  return storage.read((db) => (db.prepare(`select hour from model_behaviour_dirty_hours order by hour`).all() as Array<{ hour: number }>).map((r) => r.hour));
}

test("triggers mark the session's hour dirty for every raw write; sessionless rows their own hour", async () => {
  await withStorage(async (storage) => {
    await seedScenario(storage);
    assert.deepEqual(dirtyHours(storage), [H]);
    await rollups(storage).flush();
    assert.deepEqual(dirtyHours(storage), []);
    // A later request of s1 (next hour) still belongs to the session's creation hour.
    await addRequest(storage, "s1", H + HOUR + 10, "model_b", { key: KEY_A, type: "default" });
    assert.deepEqual(dirtyHours(storage), [H]);
    // A sessionless caption row marks its own hour.
    await addRequest(storage, null, H + 5 * HOUR, "cap_model", { key: KEY_A, cls: "caption" });
    assert.deepEqual(dirtyHours(storage), [H, H + 5 * HOUR]);
    // Upserting contract attempts (ON CONFLICT DO UPDATE) through the trigger works.
    await storage.insertContractAttempts([
      { agentSessionId: "s1", attemptNo: 1, ts: H + 6_500, servedModel: "model_b", variant: "not_sent", failureTypes: [] },
    ]);
  });
});

test("computeHourRollups: attribution to the serving model, sites, agents, tasks", async () => {
  await withStorage(async (storage) => {
    await seedScenario(storage);
    await rollups(storage).flush();
    const rows = table(storage);
    const v = (m: Partial<Row>) => value(rows, { hour: H, ...m });

    // Requests and sessions per serving model.
    assert.equal(v({ agent: "agent_a", site: "default", model: "model_a", metric: "requests" }), 1);
    assert.equal(v({ agent: "agent_a", site: "default", model: "model_b", metric: "requests" }), 1);
    assert.equal(v({ agent: "agent_a", site: "default", model: "model_a", metric: "sessions" }), 1);
    assert.equal(v({ agent: "agent_a", site: "default", model: "model_b", metric: "sessions" }), 1);
    assert.equal(v({ agent: "agent_a", site: "caption", model: "cap_model", metric: "requests" }), 1);

    // Refusals on the refusing model, with reason/method/outcome families.
    assert.equal(v({ model: "model_a", metric: "refusals_hard" }), 1);
    assert.equal(v({ model: "model_a", metric: "refusal_redos" }), 1);
    assert.equal(v({ model: "model_a", metric: "refusal_reason:distillation" }), 1);
    assert.equal(v({ model: "model_a", metric: "refusal_method:provider_category" }), 1);
    assert.equal(v({ model: "model_a", metric: "refusal_outcome:redo" }), 1);
    assert.equal(v({ model: "model_a", metric: "refusal_branch_cost_usd" }), 0.05);
    assert.equal(v({ agent: "agent_a", site: "caption", model: "cap_model", metric: "refusals_hard" }), 1);
    assert.equal(v({ model: "cap_model", metric: "refusal_outcome:exhausted_no_output" }), 1);

    // Send contract: s1 on model_b recovered after 1 nudge; s2 on model_a exhausted after a redo.
    assert.equal(v({ model: "model_b", metric: "sessions_nudged" }), 1);
    assert.equal(v({ model: "model_b", metric: "contract_recovered_1" }), 1);
    assert.equal(v({ model: "model_b", metric: "contract_failed_attempts" }), 1);
    assert.equal(v({ model: "model_b", metric: "failure_type:text_only" }), 1);
    assert.equal(v({ agent: "agent_b", site: "proactive", model: "model_a", metric: "sessions_nudged" }), 1);
    assert.equal(v({ model: "model_a", metric: "contract_exhausted" }), 1);
    assert.equal(v({ model: "model_a", metric: "contract_redos" }), 1);
    assert.equal(v({ model: "model_a", metric: "contract_failed_attempts" }), 4);
    assert.equal(v({ model: "model_a", metric: "failure_type:empty" }), 4);
    assert.equal(v({ model: "model_a", metric: "contract_branch_cost_usd" }), 0.02);

    // Checks: three rows of one judged call count once.
    assert.equal(v({ model: "model_b", metric: "style_hits" }), 1);
    assert.equal(v({ model: "model_b", metric: "messages_with_style_hit" }), 1);
    assert.equal(v({ model: "model_b", metric: "check_hits:style_x" }), 1);
    assert.equal(v({ model: "model_b", metric: "revisions" }), 1);
    assert.equal(v({ model: "model_b", metric: "check_revisions:style_x" }), 1);

    // Messages: the split message counts once, its tokens fully.
    assert.equal(v({ model: "model_b", metric: "messages_sent" }), 2);
    assert.equal(v({ model: "model_b", metric: "message_tokens" }), 3 + 2 + 2);

    // Task dimension: only s1 (task coding) contributes.
    const tasks = table(storage, "model_behaviour_task_rollups") as Array<Row & { task: string }>;
    assert.ok(tasks.every((r) => r.task === "coding" && r.agent === "agent_a"));
    assert.equal(value(tasks, { metric: "refusals_hard", model: "model_a" }), 1);
    assert.equal(value(tasks, { metric: "requests" }), 2);
    assert.equal(value(tasks, { metric: "contract_exhausted" }), 0);
  });
});

test("maintained rollups equal a full rebuild, after incremental writes and deletions", async () => {
  await withStorage(async (storage) => {
    const svc = rollups(storage);
    await seedScenario(storage);
    await svc.flush();
    await addRequest(storage, "s2", H + 9_000, "model_b", { key: "matrix:acc_b:room:!r2:x", type: "proactive" });
    await addRequest(storage, null, H + 3 * HOUR, "cap_model", { key: KEY_A, cls: "caption" });
    await svc.flush();
    const maintained = { main: table(storage), task: table(storage, "model_behaviour_task_rollups") };

    await svc.rebuild();
    assert.deepEqual(table(storage), maintained.main);
    assert.deepEqual(table(storage, "model_behaviour_task_rollups"), maintained.task);

    // From empty tables (a history backfill on a fresh rollup store) too.
    await storage.write((db) => db.exec("delete from model_behaviour_rollups; delete from model_behaviour_task_rollups;"));
    await svc.rebuild();
    assert.deepEqual(table(storage), maintained.main);

    // Deleting a session's sources empties its contribution on the next flush.
    await storage.write((db) => db.exec("delete from usage_events where class = 'caption'"));
    await svc.flush();
    assert.equal(value(table(storage), { site: "caption", metric: "requests" }), 0);
    assert.equal(value(table(storage), { hour: H + 3 * HOUR }), 0);
  });
});

test("flush drains newest hours first in bounded jobs; pendingHours reports the backlog", async () => {
  await withStorage(async (storage) => {
    for (let i = 0; i < 5; i++) await addRequest(storage, null, H + i * HOUR, "cap_model", { key: KEY_A, cls: "caption" });
    const svc = rollups(storage);
    assert.equal(svc.pendingHours(), 5);
    assert.equal(await svc.flush(2), 2);
    assert.deepEqual(dirtyHours(storage), [H, H + HOUR, H + 2 * HOUR]);
    assert.equal(await svc.flush(), 3);
    assert.equal(svc.pendingHours(), 0);
  });
});

test("computeHourRollups is deterministic and side-effect free", async () => {
  await withStorage(async (storage) => {
    await seedScenario(storage);
    const ctx = { agentForTimelineKey: agentFor, countTokens: words };
    const a = storage.read((db) => computeHourRollups(db, H, ctx));
    const b = storage.read((db) => computeHourRollups(db, H, ctx));
    assert.deepEqual(a, b);
    assert.equal(table(storage).length, 0);
  });
});

test("firedChecks / sessionTasks parse tolerant shapes", () => {
  assert.deepEqual(firedChecks(JSON.stringify({ fired: [{ code: "a", kind: "style" }, { code: "b" }, { nope: 1 }] })), [
    { code: "a", kind: "style" },
    { code: "b" },
  ]);
  assert.deepEqual(firedChecks(JSON.stringify(["c"])), [{ code: "c" }]);
  assert.deepEqual(firedChecks("not json"), []);
  assert.deepEqual(firedChecks(null), []);
  assert.deepEqual(sessionTasks(JSON.stringify({ skills: [], tasks: ["x", 3, "y"] })), ["x", "y"]);
  assert.equal(sessionTasks(JSON.stringify({ skills: [] })), null);
  assert.equal(sessionTasks(null), null);
});

test("checkKind from the catalogue classifies style hits when the verdict omits the kind", async () => {
  await withStorage(async (storage) => {
    await addRequest(storage, null, H, "x", { cls: "caption" });
    await storage.insertAgentSession({ id: "s9", timelineKey: KEY_A, sessionType: "default", status: "completed", createdAt: H, updatedAt: H });
    await addRequest(storage, "s9", H + 1, "model_a", { key: KEY_A });
    await storage.insertDecisionEvaluation({
      ts: H + 2, decision_group: "g", point: "checks", agent_session_id: "s9", source: "pattern",
      verdict_json: JSON.stringify({ fired: [{ code: "style_y" }, { code: "refusal_z" }] }), checkpoint: "send", tool_call_id: "t", branch_no: 0,
    });
    const svc = new ModelBehaviourRollups({
      storage, agentForTimelineKey: agentFor, checkKind: (code) => (code.startsWith("style_") ? "style" : "refusal"),
    });
    await svc.flush();
    const rows = table(storage);
    assert.equal(value(rows, { metric: "style_hits" }), 1);
    assert.equal(value(rows, { metric: "check_hits:refusal_z" }), 1);
  });
});

test("migration v25→v26: creates the tables and triggers, marks history dirty, matches a fresh DB", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-mb-mig-"));
  try {
    const objects = (s: Storage) =>
      s.read((db) =>
        db
          .prepare(
            `select type, name, sql from sqlite_master
              where name like 'mbr_%' or name like '%behaviour%' or name in ('idx_agent_sessions_created', 'idx_timeline_events_session')
              order by name`,
          )
          .all(),
      );
    const fresh = await Storage.open({ databasePath: ":memory:" });
    const freshObjects = objects(fresh);
    fresh.close();
    assert.ok(freshObjects.length > 20);

    const dbPath = path.join(dir, "v25.db");
    {
      const s = await Storage.open({ databasePath: dbPath });
      await seedScenario(s);
      await s.write((db) => {
        for (const o of objects(s) as Array<{ type: string; name: string }>) {
          if (o.type === "trigger") db.exec(`drop trigger ${o.name}`);
        }
        for (const o of objects(s) as Array<{ type: string; name: string }>) {
          if (o.type === "table") db.exec(`drop table ${o.name}`);
          if (o.type === "index" && !o.name.startsWith("sqlite_")) db.exec(`drop index if exists ${o.name}`);
        }
        db.pragma("user_version = 25");
      });
      await s.waitForIdle();
      s.close();
    }
    const migrated = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(migrated.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
      assert.deepEqual(objects(migrated), freshObjects);
      assert.deepEqual(dirtyHours(migrated), [H], "history is queued for the rollups");
      await rollups(migrated).flush();
      assert.equal(value(table(migrated), { metric: "requests" }), 4);
    } finally {
      await migrated.waitForIdle();
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
