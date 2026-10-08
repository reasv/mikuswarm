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
    await rollups(storage).flush();
    // A running session's status/usage updates leave its rollups alone; the contract outcome does not.
    await storage.write((db) => db.exec(`update agent_sessions set status = 'running', updated_at = 9, usage_cost = 1 where id = 's1'`));
    assert.deepEqual(dirtyHours(storage), []);
    await storage.setAgentSessionContract("s1", { outcome: "clean", nudges: 0, version: 1 });
    assert.deepEqual(dirtyHours(storage), [H]);
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

test("late-input branches and aborted requests are no behaviour samples", async () => {
  await withStorage(async (storage) => {
    // s9: one served request, one aborted (estimated) request, and a redo from
    // scratch (branch 1, edit_redo) whose refusal and check verdict were
    // re-anchored to that branch; a turn_aborted branch (2) with a verdict too.
    await storage.insertAgentSession({ id: "s9", timelineKey: KEY_A, sessionType: "default", status: "completed", createdAt: H + 1_000, updatedAt: H + 1_000 });
    await addRequest(storage, "s9", H + 2_000, "model_a", { key: KEY_A, type: "default" });
    await storage.insertUsageEvent({
      ts: H + 2_100, class: "agent_loop", agentSessionId: "s9", sessionType: "default", timelineKey: KEY_A,
      modelId: "wire-model_a", logicalModelId: "model_a", costUsd: 0.01, estimated: true,
    });
    for (const reason of ["edit_redo", "turn_aborted"] as const) {
      await storage.insertSessionBranch({ sessionId: "s9", forkIndex: 0, reason, messagesJson: "[]", createdAt: H + 2_200 });
    }
    await storage.insertRefusalEvent({
      ts: H + 2_050, agentSessionId: "s9", branchNo: 1, site: "default", agent: "agent_a", timelineKey: KEY_A,
      servedModel: "model_a", kind: "hard", checkCode: "refusal_safety", reason: "safety", method: "stop_reason",
      checkpoint: "request", outcome: "observed",
    });
    const verdict = JSON.stringify({ fired: [{ code: "style_x", kind: "style" }] });
    for (const branch_no of [1, 2]) {
      await storage.insertDecisionEvaluation({
        ts: H + 2_060, decision_group: "g9", point: "checks", agent_session_id: "s9", source: "model",
        verdict_json: verdict, checkpoint: "send", branch_no, tool_call_id: `tc${branch_no}`, consequence: "revise",
      });
    }
    // A live (branch 0) refusal still counts.
    await storage.insertRefusalEvent({
      ts: H + 2_070, agentSessionId: "s9", site: "default", agent: "agent_a", timelineKey: KEY_A,
      servedModel: "model_a", kind: "hard", checkCode: "refusal_safety", reason: "safety", method: "stop_reason",
      checkpoint: "request", outcome: "observed",
    });
    await rollups(storage).flush();
    const rows = table(storage);
    const v = (metric: string) => value(rows, { hour: H, model: "model_a", metric });
    assert.equal(v("requests"), 1, "the estimated (aborted) row is billed, not a behaviour sample");
    assert.equal(v("refusals_hard"), 1, "only the live refusal");
    assert.equal(v("style_hits"), 0);
    assert.equal(v("revisions"), 0);
  });
});

test("a refusal branch cut inside a later late-input redo's span is excluded too (as in the contract derivation)", async () => {
  await withStorage(async (storage) => {
    // s10: a refusal redo (branch 1, forked at 3 of the first rollout), then an
    // edit redo from scratch (branch 2, forked at 0) that discarded that rollout.
    await storage.insertAgentSession({ id: "s10", timelineKey: KEY_A, sessionType: "default", status: "completed", createdAt: H + 1_000, updatedAt: H + 1_000 });
    await addRequest(storage, "s10", H + 2_000, "model_a", { key: KEY_A, type: "default" });
    const msgs = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ role: "assistant", content: [], i })));
    await storage.insertSessionBranch({
      sessionId: "s10", forkIndex: 3, reason: "refusal_redo", fromModel: "model_a", toModel: "model_b",
      messagesJson: msgs(2), costUsd: 0.05, createdAt: H + 2_100,
    });
    await storage.insertSessionBranch({ sessionId: "s10", forkIndex: 0, reason: "edit_redo", messagesJson: msgs(5), createdAt: H + 2_200 });
    await storage.insertRefusalEvent({
      ts: H + 2_050, agentSessionId: "s10", branchNo: 1, site: "default", agent: "agent_a", timelineKey: KEY_A,
      servedModel: "model_a", kind: "hard", checkCode: "refusal_safety", reason: "safety", method: "stop_reason",
      checkpoint: "request", outcome: "observed",
    });
    await rollups(storage).flush();
    const rows = table(storage);
    const v = (metric: string) => value(rows, { hour: H, model: "model_a", metric });
    assert.equal(v("refusals_hard"), 0, "the nested refusal is part of the discarded rollout");
    assert.equal(v("refusal_branch_cost_usd"), 0);
  });
});

test("a duplicate block is no style revision: it counts apart", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession({ id: "s9", timelineKey: KEY_A, sessionType: "default", status: "completed", createdAt: H, updatedAt: H });
    await addRequest(storage, "s9", H + 1, "model_a", { key: KEY_A });
    const row = (tool_call_id: string, fired: string[], consequence: string, ts = H + 2) =>
      storage.insertDecisionEvaluation({
        ts, decision_group: "g", point: "checks", agent_session_id: "s9", source: "model",
        verdict_json: JSON.stringify({ fired }), checkpoint: "send", tool_call_id, branch_no: 0, consequence,
      });
    await row("dup", ["duplicate"], "revise"); // the duplicate stage alone
    await row("dup", [], "revise"); // the checks call of the same send: nothing fired
    await row("style", ["style_x"], "revise");
    await row("both", ["style_x"], "revise");
    await row("both", ["duplicate"], "revise");
    await row("over", ["duplicate"], "overridden");
    // No catalogue: the duplicate check is still recognized by its code.
    await rollups(storage).flush();
    const rows = table(storage);
    const v = (metric: string) => value(rows, { hour: H, model: "model_a", metric });
    assert.equal(v("revisions"), 2, "the style send and the send both fired on");
    assert.equal(v("duplicate_revisions"), 2);
    assert.equal(v("overrides"), 0);
    assert.equal(v("duplicate_overrides"), 1);
    assert.equal(v("check_revisions:duplicate"), 2);
    assert.equal(v("check_revisions:style_x"), 2);
  });
});
