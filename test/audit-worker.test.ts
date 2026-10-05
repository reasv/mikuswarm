/**
 * The offline audit worker (spec REFUSAL-HANDLING §7.6, §10.2; DECISION-MODEL
 * §5.8) against a real in-memory Storage and a controllable decision endpoint:
 * queue ordering (live newest-first, backlog oldest-first), claiming, pacing,
 * the budget stop, unauditable sessions, the send-contract diagnosis and the
 * check pass with their written rows, deferral, sampling, re-audit after a
 * resume, the `audit` ledger class, and the rollups counting the backfill.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveContractEvents } from "../src/agent/contract.js";
import { AuditProgressCounter, AuditWorkerPool, type AuditStep } from "../src/audit/index.js";
import { ModelBehaviourService } from "../src/behaviour/index.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { BUILTIN_CONTRACT_CHECKS } from "../src/checks/builtin/contract.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { Storage, type UsageEventInput } from "../src/storage/index.js";
import { asst, kick, noReply, nudge, sent, text } from "./audit-fixtures.js";

const KEY = "matrix:acct:room:!r:example.org";
const T0 = 50_000_000;

function decider(): any {
  return {
    id: "vendor/decider-1",
    provider: "openrouter",
    api: "system-one",
    endpoint: "https://gw.example/decisions",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1,
    context_window: 64000,
    cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
  };
}

const opRefusal = {
  kind: "refusal",
  reason: "safety",
  questions: [
    { source: "message", instructions: "`message` declines.", criteria: { true: "declines", false: "helps" }, threshold: 0.8 },
    { source: "analysis", instructions: "`analysis` declines.", criteria: { true: "declines", false: "helps" }, threshold: 0.8 },
  ],
  patterns: ["(?i)\\bforbidden-word\\b"],
};

function makeConfig(audit: Record<string, unknown> = {}): any {
  return {
    models: { decider: decider() },
    decisions: {
      enabled: true,
      model: "decider",
      audit: { enabled: true, settle_ms: 60_000, backlog_pace_ms: 1000, ...audit },
    },
    checks: { op_refusal: opRefusal },
    agents: {},
  };
}

type Answer = (id: string, q: any, body: any) => unknown;

/** A decision endpoint whose answers (or failure) the test controls. */
function decisionServer(answer: Answer, opts: { fail?: () => boolean } = {}) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (opts.fail?.()) return new Response("boom", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) answers[id] = answer(id, q, body);
    return new Response(
      JSON.stringify({ model: "vendor/decider-1-20261001", answers, usage: { input_tokens: 100, output_tokens: 1, cost: 0.0001 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Default answers: refusal when the judged message says "cannot", self-talk, abandoned reply. */
const defaultAnswer: Answer = (id, _q, body) => {
  if (id.startsWith("op_refusal__")) {
    const state = body.state as Record<string, unknown>;
    const judged = String(state["message"] ?? state["analysis"] ?? "");
    return { noul: judged.includes("cannot") ? 0.93 : 0.05 };
  }
  if (id.endsWith("__had_user_message")) return { noul: 0.1 };
  if (id.endsWith("__textual_tool_call")) return { noul: 0.1 };
  if (id === "after_correction") return { choice: "parts_removed", confidence: 0.9, probabilities: { parts_removed: 0.9 } };
  if (id.startsWith("no_reply_intent__")) {
    return { choice: "abandoned_written_reply", confidence: 0.8, probabilities: { abandoned_written_reply: 0.8 } };
  }
  return { noul: 0.01 };
};

async function setup(opts: {
  audit?: Record<string, unknown>;
  answer?: Answer;
  fail?: () => boolean;
  budgetAllowed?: () => boolean;
  shouldPause?: () => boolean;
} = {}) {
  const config = makeConfig(opts.audit);
  const storage = await Storage.open({ databasePath: ":memory:" });
  const server = decisionServer(opts.answer ?? defaultAnswer, { fail: opts.fail });
  const usage: UsageEventInput[] = [];
  const budgetChecks: any[] = [];
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: server.fetchImpl }),
    record: (e) => usage.push(e),
    budget: () => ({
      check: (d) => {
        budgetChecks.push(d);
        return { allowed: opts.budgetAllowed?.() ?? true };
      },
    }),
    onEvaluation: (row) => {
      void storage.insertDecisionEvaluation({
        ts: row.ts, decision_group: row.decisionGroup, point: row.point, agent: row.agent,
        timeline_key: row.timelineKey, agent_session_id: row.agentSessionId, source: row.source,
        reason: row.reason, verdict_json: row.verdictJson, answers_json: row.answersJson,
        served_model: row.servedModel, cost_usd: row.costUsd,
      });
    },
  });
  const catalogue = buildCheckCatalogue(config, BUILTIN_CONTRACT_CHECKS);
  let now = T0;
  const pool = new AuditWorkerPool({
    storage,
    config,
    engine,
    catalogue,
    agentForTimelineKey: () => null,
    now: () => now,
    ...(opts.shouldPause ? { shouldPause: opts.shouldPause } : {}),
  });
  return {
    config, storage, server, usage, budgetChecks, engine, pool,
    setNow: (t: number) => {
      now = t;
    },
  };
}

async function addSession(
  storage: Storage,
  id: string,
  opts: { createdAt: number; completedAt?: number | null; type?: string; status?: string; transcript?: unknown[] | null; trigger?: string },
): Promise<void> {
  await storage.insertAgentSession({
    id,
    timelineKey: KEY,
    sessionType: opts.type ?? "default",
    status: (opts.status ?? "completed") as never,
    triggerBody: opts.trigger ?? "can you help?",
    triggerSenderId: "@u:example.org",
    triggerSenderDisplayName: "User",
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  const transcript = opts.transcript === undefined ? [kick()] : opts.transcript;
  if (transcript) await storage.saveAgentSessionTranscript(id, JSON.stringify(transcript), opts.createdAt);
  const completedAt = opts.completedAt === undefined ? opts.createdAt + 1000 : opts.completedAt;
  if (completedAt !== null) {
    await storage.updateAgentSessionStatus(id, (opts.status ?? "completed") as never, { completedAt, updatedAt: completedAt });
  }
  if (transcript) {
    const derived = deriveContractEvents(transcript);
    await storage.replaceSessionContract(id, {
      attempts: derived.attempts.map((a) => ({ ...a, failureTypes: [...a.failureTypes] })),
      outcome: derived.outcome,
      nudges: derived.nudges,
      version: 1,
    });
  }
}

const audits = (storage: Storage, id: string) => storage.listSessionAudits(id);
const audited = (step: AuditStep) => (step.kind === "audited" ? `${step.lane}:${step.sessionId}` : step.kind);

test("queue: live newest-first, then the backlog oldest-first; settle, types and running excluded; pacing", async () => {
  const { storage, pool, setNow } = await setup();
  await addSession(storage, "b2", { createdAt: 3_000_000 });
  await addSession(storage, "b1", { createdAt: 2_000_000 });
  await addSession(storage, "sum", { createdAt: 1_000_000, type: "summarize" });
  await addSession(storage, "run", { createdAt: 1_500_000, status: "running", completedAt: null });
  // Started at T0: the first step sees no live session (nothing settled since).
  assert.equal(audited(await pool.runOnce()), "backlog:b1");
  // Settled shortly before and after the start: the live lane (once settled for 60 s).
  await addSession(storage, "l1", { createdAt: T0 - 40_000, completedAt: T0 - 30_000 });
  await addSession(storage, "l2", { createdAt: T0 - 5_000, completedAt: T0 + 10_000 });
  await addSession(storage, "fresh", { createdAt: T0 + 100_000, completedAt: T0 + 110_000 });
  setNow(T0 + 120_000);
  assert.equal(audited(await pool.runOnce()), "live:l2");
  assert.equal(audited(await pool.runOnce()), "live:l1");
  assert.equal(audited(await pool.runOnce()), "backlog:b2");
  // The backlog is paced (1 s between sessions); nothing else is pending.
  assert.equal((await pool.runOnce()).kind, "paced");
  setNow(T0 + 125_000);
  assert.equal((await pool.runOnce()).kind, "idle");
  assert.deepEqual(audits(storage, "sum"), []);
  assert.deepEqual(audits(storage, "run"), []);
  assert.deepEqual(audits(storage, "fresh"), [], "not settled yet");
  setNow(T0 + 200_000);
  assert.equal(audited(await pool.runOnce()), "live:fresh");
  // Every audited session has one row per audit: a clean session's send-contract
  // audit is skipped (not nudged), its check pass done with nothing to judge.
  const rows = audits(storage, "b1");
  assert.deepEqual(rows.map((r) => [r.audit, r.status]).sort(), [["refusal", "done"], ["send_contract", "skipped"]]);
  assert.deepEqual(JSON.parse(rows.find((r) => r.audit === "send_contract")!.verdict_json!), { reason: "not_nudged" });
});

test("claiming: concurrent steps never take the same session", async () => {
  const { storage, pool } = await setup({ audit: { backlog_pace_ms: 0 } });
  for (let i = 0; i < 4; i++) await addSession(storage, `s${i}`, { createdAt: 1_000_000 + i });
  const steps = await Promise.all([pool.runOnce(), pool.runOnce(), pool.runOnce(), pool.runOnce()]);
  const ids = steps.map((s) => (s.kind === "audited" ? s.sessionId : s.kind));
  assert.equal(new Set(ids).size, 4, ids.join(","));
  assert.ok(ids.every((id) => id.startsWith("s")));
});

test("unauditable: a session without a transcript is marked once and never retried", async () => {
  const { storage, pool, server } = await setup();
  await addSession(storage, "gone", { createdAt: 1_000_000, transcript: null });
  // The send-contract audit waits for the contract record, which needs a transcript:
  // only the check pass is pending, and it is marked unauditable.
  const step = await pool.runOnce();
  assert.equal(step.kind, "audited");
  assert.deepEqual(audits(storage, "gone").map((r) => [r.audit, r.status]), [["refusal", "unauditable"]]);
  assert.notEqual((await pool.runOnce()).kind, "audited");
  assert.equal(server.calls.length, 0);
});

test("send-contract audit: self_talk on the attempt, after_correction verdict, audit ledger class", async () => {
  const { storage, pool, usage, budgetChecks, server } = await setup({ audit: { audits: ["send_contract"] } });
  const transcript = [
    kick(),
    asst([text("thinking about what to say, the answer is four and also five")]),
    nudge(1),
    ...sent("m1", "The answer is four."),
  ];
  await addSession(storage, "n1", { createdAt: 1_000_000, transcript });
  const step = await pool.runOnce();
  assert.equal(step.kind, "audited");
  assert.equal(server.calls.length, 1, "one call per nudged run");
  assert.deepEqual(Object.keys(server.calls[0].questions).sort(), ["a0__had_user_message", "after_correction"]);

  const [row] = audits(storage, "n1");
  assert.equal(row!.audit, "send_contract");
  assert.equal(row!.status, "done");
  assert.equal(row!.model_id, "decider");
  assert.equal(row!.version, 1);
  const verdict = JSON.parse(row!.verdict_json!);
  assert.equal(verdict.runs.length, 1);
  assert.equal(verdict.runs[0].afterCorrection.choice, "parts_removed");
  assert.equal(verdict.runs[0].afterCorrection.source, "model");
  assert.equal(verdict.runs[0].mechanical.normalizedEqual, false);
  assert.ok(verdict.runs[0].mechanical.similarity > 0 && verdict.runs[0].mechanical.similarity < 1);
  assert.equal(verdict.runs[0].attempts[0].selfTalk, true);

  const attempts = storage.listContractAttempts("n1");
  const first = attempts.find((a) => a.attempt_no === 0)!;
  assert.equal(first.primary_type, "self_talk");
  assert.deepEqual(JSON.parse(first.failure_types_json), ["self_talk", "text_only"]);

  // Billed to the audit class (never a payee); budget checked as audit.
  assert.ok(usage.length > 0);
  assert.ok(usage.every((u) => u.class === "audit" && u.toolName === "audit" && u.agentSessionId === "n1"));
  assert.ok(budgetChecks.every((c) => c.class === "audit"));
  // The diagnosis call's own decision row (point audit), grouped as an audit.
  const rows = storage.getDecisionEvaluationsForSession("n1");
  assert.ok(rows.some((r) => r.point === "audit" && r.decision_group.startsWith("audit:")));
});

test("check pass: judged rows anchored like the gate, refusal events, live rows respected, no_reply_intent", async () => {
  const { storage, pool, server, usage } = await setup({ audit: { audits: ["refusal"] } });
  const transcript = [
    kick(),
    ...sent("c1", "I cannot help with that request."),
    ...sent("c2", "Sure, here it is."),
    ...sent("c3", "Judged live already."),
    ...sent("c4", "A forbidden-word appears here."),
    kick("second run"),
    asst([text("Here is my written reply for you")]),
    nudge(1),
    ...noReply("n1", { analysis: "giving up" }),
  ];
  await addSession(storage, "r1", { createdAt: 1_000_000, transcript });
  // c3 was judged live (a model row at its anchor); c4 has only a live pattern hit.
  await storage.insertDecisionEvaluation({
    ts: 1_000_500, decision_group: "live1", point: "checks", agent_session_id: "r1", source: "model",
    verdict_json: JSON.stringify({ fired: [] }), checkpoint: "send", branch_no: 0, tool_call_id: "c3", consequence: "sent",
  });
  await storage.insertDecisionEvaluation({
    ts: 1_000_600, decision_group: "live2", point: "checks", agent_session_id: "r1", source: "pattern",
    verdict_json: JSON.stringify({ fired: ["op_refusal"], source: "message", matched: "forbidden-word" }),
    checkpoint: "send", branch_no: 0, tool_call_id: "c4", consequence: "observed",
  });
  await storage.insertRefusalEvent({
    ts: 1_000_600, agentSessionId: "r1", site: "default", kind: "soft", checkCode: "op_refusal", reason: "safety",
    method: "pattern", checkpoint: "send", outcome: "observed",
  });

  const step = await pool.runOnce();
  assert.equal(step.kind, "audited");
  // c1, c2, c4 and the no_reply ending were judged; c3 was not sent again.
  const judgedCalls = server.calls.filter((b) => Object.keys(b.questions).some((id) => id.startsWith("op_refusal__")));
  const messages = judgedCalls.map((b) => b.state.message).filter(Boolean).sort();
  assert.deepEqual(messages, ["A forbidden-word appears here.", "I cannot help with that request.", "Sure, here it is."]);

  const rows = storage.getDecisionEvaluationsForSession("r1").filter((r) => r.decision_group.startsWith("audit:"));
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.equal(r.point, "checks");
    assert.equal(r.consequence, "observed");
    assert.equal(r.branch_no, 0);
  }
  // c4 was judged without patterns (its hit is already recorded).
  assert.ok(!rows.some((r) => r.source === "pattern"));
  const c1 = rows.find((r) => r.tool_call_id === "c1")!;
  assert.deepEqual(JSON.parse(c1.verdict_json!).fired, ["op_refusal"]);
  const ending = rows.find((r) => r.tool_call_id === "n1")!;
  assert.equal(ending.checkpoint, "ending");
  assert.equal(ending.attempt_no, 1);
  const intent = JSON.parse(ending.verdict_json!).results.find((r: any) => r.id.startsWith("no_reply_intent__"));
  assert.equal(intent.choice, "abandoned_written_reply");

  const events = storage.listRefusalEvents("r1").filter((e) => e.method === "judged");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "soft");
  assert.equal(events[0]!.outcome, "observed");
  assert.equal(events[0]!.checkpoint, "send");
  assert.equal(events[0]!.decision_evaluation_id, c1.id);
  assert.equal(events[0]!.wire_model, "wire-a");

  const [audit] = audits(storage, "r1");
  assert.equal(audit!.status, "done");
  const verdict = JSON.parse(audit!.verdict_json!);
  assert.equal(verdict.skippedLive, 1);
  assert.deepEqual(verdict.fired, { op_refusal: 1, no_reply_intent: 1 });
  assert.ok(usage.every((u) => u.class === "audit"));
});

test("rollups count the backfill: judged refusals, after_correction, self_talk, no_reply_intent", async () => {
  const { storage, pool, config } = await setup({ audit: { backlog_pace_ms: 0 } });
  const transcript = [
    kick(),
    asst([text("notes to self, I will answer with the date")]),
    nudge(1),
    ...sent("m1", "I cannot share that."),
    kick("again"),
    asst([text("Here is a reply I never sent")]),
    nudge(1),
    ...noReply("n2"),
  ];
  const hour = 3_600_000 * 10; // before T0: settled
  await addSession(storage, "h1", { createdAt: hour + 5_000, transcript });
  // A nudged session in the backlog: the send-contract classification first, the refusal checks in a later stage.
  const first = await pool.runOnce();
  assert.deepEqual(first.kind === "audited" && first.statuses, { send_contract: "done" });
  const second = await pool.runOnce();
  assert.deepEqual(second.kind === "audited" && second.statuses, { refusal: "done" });
  const service = new ModelBehaviourService({
    storage,
    config,
    catalogue: buildCheckCatalogue(config, BUILTIN_CONTRACT_CHECKS),
    agentForTimelineKey: () => null,
  });
  await service.rebuildModelBehaviourRollups();
  const metrics = new Map(
    (storage.read((db) => db.prepare(`select metric, sum(value) as v from model_behaviour_rollups group by metric`).all()) as Array<{ metric: string; v: number }>)
      .map((r) => [r.metric, r.v]),
  );
  assert.equal(metrics.get("refusals_judged"), 1);
  assert.equal(metrics.get("after_correction:parts_removed"), 1);
  assert.equal(metrics.get("after_correction:switched_to_no_reply"), 1);
  assert.equal(metrics.get("failure_type:self_talk"), 2);
  assert.equal(metrics.get("no_reply_intent:abandoned_written_reply"), 1);

  const response = await service.read({ window: "all", groupBy: "model", family: false, now: hour + 10 * 3_600_000 });
  const ac = new Map(response.breakdown.contract.afterCorrection.map((c) => [c.key, c.count]));
  assert.equal(ac.get("parts_removed"), 1);
  assert.equal(ac.get("switched_to_no_reply"), 1);
  assert.deepEqual(response.breakdown.contract.noReplyIntent, [{ key: "abandoned_written_reply", count: 1 }]);

  // A session_audits write marks the session's hour dirty (incremental maintenance).
  await storage.write((db) => db.exec(`delete from model_behaviour_dirty_hours`));
  await storage.writeSessionAudits([{ sessionId: "h1", audit: "send_contract", status: "skipped", version: 1, createdAt: 1 }]);
  assert.equal(service.rollups.pendingHours(), 1);
});

test("deferral: a failing chain leaves no row, retries with backoff, then marks the session failed", async () => {
  let failing = true;
  const { storage, pool, setNow } = await setup({ audit: { max_retries: 1, audits: ["refusal"], backlog_pace_ms: 0 }, fail: () => failing });
  await addSession(storage, "d1", { createdAt: 1_000_000, transcript: [kick(), ...sent("c1", "I cannot.")] });
  const first = await pool.runOnce();
  assert.equal(first.kind === "audited" && first.deferred, "error");
  assert.deepEqual(audits(storage, "d1"), []);
  assert.equal((await pool.runOnce()).kind, "idle", "deferred: not claimed again before its retry time");
  setNow(T0 + 61_000);
  const second = await pool.runOnce();
  assert.equal(second.kind === "audited" && second.statuses["refusal"], "failed");
  assert.deepEqual(audits(storage, "d1").map((r) => r.status), ["failed"]);
  failing = false;
});

test("budget: shouldPause stops claiming; a budget fallback pauses the worker", async () => {
  let pause = true;
  const a = await setup({ shouldPause: () => pause });
  await addSession(a.storage, "p1", { createdAt: 1_000_000 });
  assert.equal((await a.pool.runOnce()).kind, "paused");
  pause = false;
  a.setNow(T0 + 120_000);
  assert.equal((await a.pool.runOnce()).kind, "audited");

  const b = await setup({ budgetAllowed: () => false, audit: { audits: ["refusal"] } });
  await addSession(b.storage, "p2", { createdAt: 1_000_000, transcript: [kick(), ...sent("c1", "I cannot.")] });
  const step = await b.pool.runOnce();
  assert.equal(step.kind === "audited" && step.deferred, "budget");
  assert.equal(b.server.calls.length, 0, "no call over budget");
  assert.equal((await b.pool.runOnce()).kind, "paused");
});

test("sampling: clean sessions follow sample_clean_sessions; nudged sessions are always judged", async () => {
  const { storage, pool } = await setup({ audit: { sample_clean_sessions: 0, audits: ["refusal"], backlog_pace_ms: 0 } });
  await addSession(storage, "clean", { createdAt: 1_000_000, transcript: [kick(), ...sent("c1", "hello")] });
  await addSession(storage, "nudged", {
    createdAt: 2_000_000,
    transcript: [kick(), asst([text("hm")]), nudge(1), ...sent("c2", "hello")],
  });
  await pool.runOnce();
  await pool.runOnce();
  assert.deepEqual(audits(storage, "clean").map((r) => [r.status, JSON.parse(r.verdict_json!).reason]), [["skipped", "not_sampled"]]);
  assert.equal(audits(storage, "nudged")[0]!.status, "done");
});

test("resume: a session completed again after its audit is audited again", async () => {
  const { storage, pool, setNow } = await setup({ audit: { backlog_pace_ms: 0 } });
  await addSession(storage, "re", { createdAt: 1_000_000 });
  await pool.runOnce();
  assert.equal(audits(storage, "re").length, 2);
  assert.equal((await pool.runOnce()).kind, "idle");
  // Resumed and completed again (after the audit rows were written at T0).
  await storage.updateAgentSessionStatus("re", "completed", { completedAt: T0 + 5_000, updatedAt: T0 + 5_000 });
  setNow(T0 + 120_000);
  const step = await pool.runOnce();
  assert.equal(audited(step), "live:re");
  assert.equal(audits(storage, "re").length, 2, "rows replaced, not duplicated");
  assert.ok(audits(storage, "re").every((r) => r.created_at === T0 + 120_000));
});

test("start/stop: the loop audits in the background and stops cleanly", async () => {
  const { storage, pool } = await setup({ audit: { backlog_pace_ms: 0 } });
  await addSession(storage, "bg", { createdAt: 1_000_000 });
  pool.start();
  for (let i = 0; i < 200 && audits(storage, "bg").length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  await pool.stop();
  assert.equal(audits(storage, "bg").length, 2);
});


test("backlog order: send-contract classification of nudged and no_reply sessions, their refusal checks, then the rest", async () => {
  const { storage, pool, server, setNow } = await setup({
    audit: { backlog_pace_ms: 0 },
    answer: (id, q, body) =>
      id.startsWith("no_reply_intent__")
        ? { choice: "intended_no_reply", confidence: 0.9, probabilities: { intended_no_reply: 0.9 } }
        : defaultAnswer(id, q, body),
  });
  // Oldest first by creation, but the stages reorder them.
  await addSession(storage, "c1", { createdAt: 1_000_000, transcript: [kick(), ...sent("m1", "Sure, here it is.")] });
  await addSession(storage, "p1", {
    createdAt: 2_000_000,
    transcript: [kick(), asst([text("Here is a reply I never sent")]), nudge(1), ...noReply("n1")],
  });
  await addSession(storage, "q1", { createdAt: 3_000_000, transcript: [kick(), ...noReply("n2")] });
  await storage.write((db) => db.prepare(`update agent_sessions set no_reply = 1 where id in ('p1', 'q1')`).run());
  await addSession(storage, "c2", { createdAt: 4_000_000, transcript: [kick(), ...sent("m2", "Done.")] });

  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    const step = await pool.runOnce();
    if (step.kind !== "audited") break;
    steps.push(`${step.sessionId}:${Object.entries(step.statuses).map(([a, st]) => `${a}=${st}`).sort().join(",")}`);
  }
  assert.deepEqual(steps, [
    "p1:send_contract=done",
    "q1:send_contract=skipped",
    "p1:refusal=done",
    "q1:refusal=done",
    "c1:refusal=done,send_contract=skipped",
    "c2:refusal=done,send_contract=skipped",
  ]);
  // The no_reply intent was judged once, with the send-contract classification; the
  // refusal stage did not ask it again (fired or not: the answer here did not fire).
  const intentQuestions = server.calls.flatMap((c) => Object.keys(c.questions)).filter((id) => id.startsWith("no_reply_intent__"));
  assert.equal(intentQuestions.length, 1);
  assert.ok(server.calls.some((c) => Object.keys(c.questions).some((id) => id.startsWith("op_refusal__"))), "the refusal stage judged");
  const p1 = JSON.parse(audits(storage, "p1").find((r) => r.audit === "send_contract")!.verdict_json!);
  assert.equal(p1.runs.length, 1);
  assert.deepEqual(p1.checks, { items: 1, judged: 1, skippedLive: 0, deferred: 0, fired: {} });

  // A session settling while the backlog runs is audited first (live lane, every audit).
  await addSession(storage, "c3", { createdAt: 5_000_000, transcript: [kick(), ...sent("m3", "Ok.")] });
  await addSession(storage, "live", { createdAt: T0 + 1_000, completedAt: T0 + 2_000, transcript: [kick(), ...sent("m4", "Hi.")] });
  setNow(T0 + 100_000);
  assert.equal(audited(await pool.runOnce()), "live:live");
  assert.equal(audited(await pool.runOnce()), "backlog:c3");
});

test("backlog progress: counted in the background, per stage", async () => {
  const { storage, pool } = await setup({ audit: { backlog_pace_ms: 0 } });
  await addSession(storage, "c1", { createdAt: 1_000_000, transcript: [kick(), ...sent("m1", "Sure.")] });
  await addSession(storage, "p1", { createdAt: 2_000_000, transcript: [kick(), asst([text("draft")]), nudge(1), ...sent("m2", "Sent.")] });
  await addSession(storage, "sum", { createdAt: 2_500_000, type: "summarize" });
  assert.equal(pool.backlogProgress(), null, "nothing counted before the first background count");
  // Small chunks: the walk spans several keyset chunks.
  const counter = new AuditProgressCounter({
    storage,
    audits: () => pool.queueAudits().map((a) => a.name),
    excludeSessionTypes: ["summarize", "condense", "diary"],
    knobs: () => ({ settleMs: 60_000, backlogMaxAgeMs: 0 }),
    now: () => T0,
    current: () => "contract",
    chunk: 1,
  });
  await counter.countOnce();
  const before = counter.snapshot()!;
  assert.equal(before.sessions, 2);
  assert.equal(before.prioritySessions, 1);
  assert.deepEqual(before.stages.map((s) => [s.id, s.done, s.remaining]), [["contract", 0, 1], ["priority_checks", 0, 1], ["rest", 0, 1]]);
  assert.equal(before.current, "contract");
  await pool.runOnce(); // p1: send_contract
  await pool.runOnce(); // p1: refusal
  await counter.countOnce();
  assert.deepEqual(counter.snapshot()!.stages.map((s) => [s.id, s.done, s.remaining]), [["contract", 1, 0], ["priority_checks", 1, 0], ["rest", 0, 1]]);
});
