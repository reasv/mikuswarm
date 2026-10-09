import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import type { DuplicateContext } from "../src/checks/duplicate.js";
import { CheckEvaluator, type CheckEvaluation } from "../src/checks/evaluator.js";
import { loadConfig } from "../src/config/index.js";
import { DecisionClient, DecisionEngine, validateDecisionsConfig } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// Per-check judge model (`[checks.<code>].model`, ARCHITECTURE.md §8j): a
// check naming its own decision chain is asked in a call of its own, beside
// the point's, in the same evaluation and decision group; verdicts merge;
// calibration follows the member that served; failover within its chain; a
// failing check chain leaves the rest judged; unset changes nothing.
// ---------------------------------------------------------------------------

const SESSION = "s-chkmodel01";
const TIMELINE = "matrix:acct:room:!r:example.org";

function decider(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    provider: "openrouter",
    api: "system-one",
    endpoint: "https://gw.example/decisions",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1,
    context_window: 32000,
    cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
    ...over,
  };
}

const question = (source: string, threshold = 0.8) => ({
  source,
  instructions: `\`${source}\` is bad.`,
  criteria: { true: "bad", false: "fine" },
  threshold,
});

const refusal = (over: Record<string, unknown> = {}) => ({
  kind: "refusal",
  reason: "safety",
  questions: [question("message")],
  ...over,
});
const style = (over: Record<string, unknown> = {}) => ({ kind: "style", questions: [question("message")], ...over });

interface Call {
  model: string;
  questions: string[];
  state: any;
}

/** A decision endpoint routed on the request's model id; `down` ids answer 404 (skip to the next member). */
function decisionServer(opts: { answer?: (model: string, id: string) => number; down?: Set<string> } = {}) {
  const calls: Call[] = [];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ model: body.model, questions: Object.keys(body.questions), state: body.state });
    if (gate) await gate;
    if (opts.down?.has(body.model)) return new Response("no such model", { status: 404 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { noul: opts.answer?.(body.model, id) ?? 0.1 };
    return new Response(
      JSON.stringify({ model: `${body.model}-v1`, answers, usage: { input_tokens: 100, output_tokens: 1, cost: 0.00001 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      gate = undefined;
    },
  };
}

interface SetupOpts {
  checks: Record<string, unknown>;
  models?: Record<string, unknown>;
  calibration?: Record<string, Record<string, number>>;
  answer?: (model: string, id: string) => number;
  down?: Set<string>;
  audit?: boolean;
  duplicateModel?: string;
  agents?: Record<string, unknown>;
}

async function setup(opts: SetupOpts) {
  const config: any = {
    models: {
      decider: decider("vendor/decider-1"),
      other: decider("vendor/other-1"),
      ...(opts.models ?? {}),
    },
    decisions: {
      enabled: true,
      model: "decider",
      ...(opts.calibration ? { calibration: opts.calibration } : {}),
      checks: {
        enabled: true,
        timeout_ms: 60_000,
        ...(opts.duplicateModel ? { duplicate: { model: opts.duplicateModel } } : {}),
      },
      ...(opts.audit ? { audit: { enabled: true, model: "auditor" } } : {}),
    },
    checks: opts.checks,
    agents: opts.agents ?? {},
  };
  validateDecisionsConfig(config);
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.insertAgentSession({
    id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
  });
  const server = decisionServer({ ...(opts.answer ? { answer: opts.answer } : {}), ...(opts.down ? { down: opts.down } : {}) });
  const lines: Array<[string, any]> = [];
  const l: any = {
    info: (e: string, f: any) => lines.push([e, f]),
    warn: (e: string, f: any) => lines.push([e, f]),
    error: (e: string, f: any) => lines.push([e, f]),
    debug() {},
    child() {
      return l;
    },
  };
  const usage: any[] = [];
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: server.fetchImpl, logger: l }),
    record: (e) => usage.push(e),
    logger: l,
  });
  const catalogue = buildCheckCatalogue(config, []);
  const evaluator = new CheckEvaluator({
    catalogue,
    engine,
    config,
    storage,
    logger: l,
    ...(opts.audit
      ? { judging: { point: "audit" as const, usageClass: "audit" as const, priority: "background" as const, groupPrefix: "audit:" } }
      : {}),
  });
  return { config, storage, server, evaluator, usage, lines };
}

function start(evaluator: CheckEvaluator, message = "I will not help with that request, sorry."): CheckEvaluation {
  return evaluator.start(
    { agent: null, site: "default", sessionId: SESSION, sessionType: "default", timelineKey: TIMELINE },
    { context: { action: "send_message", request: [{ from: "Alice", text: "please help" }] }, sources: { message } },
    { checkpoint: "send", toolCallId: "call-1" },
  );
}

async function recorded(t: Awaited<ReturnType<typeof setup>>, evaluation: CheckEvaluation) {
  await evaluation.done;
  await t.evaluator.record(evaluation, { consequence: "observed", late: false, heldMs: 0 });
  await t.storage.waitForIdle();
  return t.storage.getDecisionEvaluationsForSession(SESSION);
}

test("unset: one call to the point's chain, as before", async () => {
  const t = await setup({ checks: { op_refusal: refusal(), op_style: style() } });
  const evaluation = start(t.evaluator);
  const result = await evaluation.done;
  assert.equal(t.server.calls.length, 1);
  assert.equal(t.server.calls[0]!.model, "vendor/decider-1");
  assert.deepEqual(t.server.calls[0]!.questions, ["op_refusal__message", "op_style__message"]);
  assert.equal(result.judgedQuestions, 2);
  const rows = await recorded(t, evaluation);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.served_model, "decider");
  t.storage.close();
});

test("a check naming the point's own chain shares its call", async () => {
  const t = await setup({ checks: { op_refusal: refusal(), op_style: style({ model: "decider" }) } });
  await start(t.evaluator).done;
  assert.equal(t.server.calls.length, 1);
  assert.deepEqual(t.server.calls[0]!.questions, ["op_refusal__message", "op_style__message"]);
  t.storage.close();
});

test("a check with its own model: a separate parallel call to that member, one group, merged verdicts", async () => {
  const t = await setup({
    checks: { op_refusal: refusal(), op_style: style({ model: "other" }) },
    answer: () => 0.9,
  });
  t.server.hold();
  const evaluation = start(t.evaluator);
  // Both calls are in flight before either answers: they run in parallel.
  for (let i = 0; i < 200 && t.server.calls.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.server.calls.length, 2);
  const byModel = new Map(t.server.calls.map((c) => [c.model, c.questions]));
  assert.deepEqual(byModel.get("vendor/decider-1"), ["op_refusal__message"]);
  assert.deepEqual(byModel.get("vendor/other-1"), ["op_style__message"]);
  t.server.release();
  const result = await evaluation.done;
  assert.deepEqual(result.fired.map((f) => f.code).sort(), ["op_refusal", "op_style"]);
  assert.equal(result.judgedQuestions, 2);
  assert.equal(result.unjudgedReason, undefined);
  const rows = await recorded(t, evaluation);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.decision_group)).size, 1, "one decision group");
  assert.equal(rows[0]!.decision_group, evaluation.decisionGroup);
  assert.deepEqual(rows.map((r) => r.served_model).sort(), ["decider", "other"]);
  assert.ok(rows.every((r) => r.point === "checks" && r.tool_call_id === "call-1"));
  // The refusal event links to the row of the call that fired it.
  const [event] = t.storage.listRefusalEvents(SESSION);
  const deciderRow = rows.find((r) => r.served_model === "decider")!;
  assert.equal(event!.decision_evaluation_id, deciderRow.id);
  assert.deepEqual(t.usage.map((u) => u.logicalModelId).sort(), ["decider", "other"]);
  const logged = t.lines.find(([e]) => e === "check_gate_evaluated")![1];
  assert.equal(logged.calls, 2);
  assert.equal(logged.questions, 2);
  t.storage.close();
});

test("per-member calibration: a check's own model uses its member's thresholds", async () => {
  const t = await setup({
    checks: { op_refusal: refusal(), op_style: style({ model: "other" }) },
    calibration: { other: { "checks.op_style": 0.95 }, decider: { "checks.op_style": 0.5 } },
    answer: () => 0.9,
  });
  const evaluation = start(t.evaluator);
  const result = await evaluation.done;
  assert.deepEqual(result.fired.map((f) => f.code), ["op_refusal"], "0.9 is below other's calibrated 0.95");
  const rows = await recorded(t, evaluation);
  const otherRow = rows.find((r) => r.served_model === "other")!;
  assert.deepEqual(JSON.parse(otherRow.verdict_json!).results.map((r: any) => r.t), [0.95]);
  t.storage.close();

  // The same check on a fallback member of its chain uses that member's calibration.
  const f = await setup({
    models: { other: decider("vendor/other-1", { fallback: ["other2"] }), other2: decider("vendor/other-2") },
    checks: { op_style: style({ model: "other" }) },
    calibration: { other: { "checks.op_style": 0.95 }, other2: { "checks.op_style": 0.5 } },
    answer: () => 0.6,
    down: new Set(["vendor/other-1"]),
  });
  const fallback = start(f.evaluator);
  const fallen = await fallback.done;
  assert.deepEqual(fallen.fired.map((x) => x.code), ["op_style"], "0.6 fires at other2's 0.5");
  const [row] = await recorded(f, fallback);
  assert.equal(row!.served_model, "other2");
  assert.deepEqual(JSON.parse(row!.verdict_json!).results.map((r: any) => r.t), [0.5]);
  f.storage.close();
});

test("failover within the check's chain", async () => {
  const t = await setup({
    models: { other: decider("vendor/other-1", { fallback: ["other2"] }), other2: decider("vendor/other-2") },
    checks: { op_refusal: refusal(), op_style: style({ model: "other" }) },
    down: new Set(["vendor/other-1"]),
    answer: () => 0.9,
  });
  const evaluation = start(t.evaluator);
  const result = await evaluation.done;
  assert.deepEqual(t.server.calls.map((c) => c.model).sort(), ["vendor/decider-1", "vendor/other-1", "vendor/other-2"]);
  assert.deepEqual(t.server.calls.filter((c) => c.model !== "vendor/decider-1").map((c) => c.questions), [
    ["op_style__message"],
    ["op_style__message"],
  ]);
  assert.deepEqual(result.fired.map((f) => f.code).sort(), ["op_refusal", "op_style"]);
  const rows = await recorded(t, evaluation);
  assert.deepEqual(rows.map((r) => r.served_model).sort(), ["decider", "other2"]);
  t.storage.close();
});

test("a failing check chain leaves its questions unjudged; the point's call is unaffected", async () => {
  const t = await setup({
    checks: { op_refusal: refusal(), op_style: style({ model: "other" }) },
    down: new Set(["vendor/other-1"]),
    answer: () => 0.9,
  });
  const evaluation = start(t.evaluator);
  const result = await evaluation.done;
  assert.deepEqual(result.fired.map((f) => f.code), ["op_refusal"]);
  assert.ok(result.unjudgedReason, "the failed chain is reported unjudged");
  assert.equal(result.judgedQuestions, 2);
  const rows = await recorded(t, evaluation);
  const model = rows.find((r) => r.source === "model")!;
  assert.equal(model.served_model, "decider");
  const fallback = rows.find((r) => r.source === "heuristic")!;
  assert.equal(fallback.decision_group, model.decision_group);
  t.storage.close();
});

test("only checks with a model: every call goes to their chains, none to the point's", async () => {
  const t = await setup({
    checks: { op_style: style({ model: "other" }) },
  });
  await start(t.evaluator).done;
  assert.deepEqual(t.server.calls.map((c) => c.model), ["vendor/other-1"]);
  t.storage.close();
});

test("per-agent override: [agents.<name>.checks.<code>].model applies to that agent only", async () => {
  const t = await setup({
    checks: { op_refusal: refusal(), op_style: style() },
    agents: { agent_b: { checks: { op_style: { model: "other" } } } },
  });
  await start(t.evaluator).done;
  assert.deepEqual(t.server.calls.map((c) => c.model), ["vendor/decider-1"], "global: one call");
  t.server.calls.length = 0;
  await t.evaluator.start(
    { agent: "agent_b", site: "default", sessionId: SESSION, sessionType: "default", timelineKey: TIMELINE },
    { context: { action: "send_message" }, sources: { message: "I will not help with that request, sorry." } },
    { checkpoint: "send" },
  ).done;
  assert.deepEqual(t.server.calls.map((c) => c.model).sort(), ["vendor/decider-1", "vendor/other-1"]);
  t.storage.close();
});

test("offline audit: a check's own model wins over the audit point's chain", async () => {
  const t = await setup({
    models: { auditor: decider("vendor/auditor-1") },
    checks: { op_refusal: refusal(), op_style: style({ model: "other" }) },
    calibration: { other: { "audit.checks.op_style": 0.95 } },
    audit: true,
    answer: () => 0.9,
  });
  const evaluation = start(t.evaluator);
  const result = await evaluation.done;
  const byModel = new Map(t.server.calls.map((c) => [c.model, c.questions]));
  assert.deepEqual(byModel.get("vendor/auditor-1"), ["op_refusal__message"]);
  assert.deepEqual(byModel.get("vendor/other-1"), ["op_style__message"]);
  assert.deepEqual(result.fired.map((f) => f.code), ["op_refusal"], "other's audit calibration (0.95) applies");
  assert.ok(evaluation.decisionGroup.startsWith("audit:"));
  assert.ok(t.usage.every((u) => u.class === "audit" && u.toolName === "audit"));
  t.storage.close();
});

test("duplicate stage: a duplicate check's own model wins over the duplicate chain", async () => {
  const duplicate = {
    kind: "duplicate",
    questions: [{ name: "repeats", ...question("message") }],
  };
  const ctx: DuplicateContext = {
    targetTimelineKey: TIMELINE,
    ownTimelineKey: TIMELINE,
    draftAt: 10_000,
    earlier: [
      { eventIds: ["e1"], sessionId: "s-other", receivedAt: 9_000, text: "It is 42.", answering: { from: "bob", text: "6*7?" } },
    ],
    draftAnswering: { from: "bob", text: "6*7?" },
    earlierMaxTokens: 1500,
  };
  for (const [checkModel, expected] of [
    [undefined, "vendor/decider-1"],
    ["other", "vendor/other-1"],
  ] as const) {
    const t = await setup({
      checks: { dup: { ...duplicate, ...(checkModel ? { model: checkModel } : {}) } },
      answer: () => 0.9,
    });
    const evaluation = start(t.evaluator, "The answer is 42.");
    assert.equal(t.evaluator.extendDuplicate(evaluation, ctx), true);
    const result = await evaluation.done;
    assert.deepEqual(t.server.calls.map((c) => c.model), [expected]);
    assert.deepEqual(t.server.calls[0]!.questions, ["dup__repeats"]);
    assert.deepEqual(result.fired.map((f) => f.code), ["dup"]);
    t.storage.close();
  }
});

// ----------------------------------------------------------------- validation

const BASE_CONFIG = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug/context"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[models.decider]
id = "vendor/decider"
provider = "openrouter"
api = "system-one"
endpoint = "https://gw.example/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1
context_window = 32000

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"

[summarization]
enabled = false
`;

async function load(extra: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-check-model-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), BASE_CONFIG, "utf8");
    await writeFile(path.join(dir, "90-test.toml"), extra, "utf8");
    return await loadConfig(dir, { env: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validation: [checks.<code>].model must name a system-one decision model", async () => {
  const ok = await load(`
[checks.op]
kind = "style"
model = "decider"
  [[checks.op.questions]]
  source = "message"
  instructions = "x"
  criteria = { true = "a", false = "b" }
  threshold = 0.8
`);
  validateDecisionsConfig(ok);
  assert.equal(buildCheckCatalogue(ok, []).get("op")!.model, "decider");

  const unknown = await load(`[checks.safety]\nmodel = "nope"\n`);
  assert.throws(() => validateDecisionsConfig(unknown), /checks\.safety\.model = "nope" does not name a \[models\.\*\] block/);
  const chat = await load(`[checks.safety]\nmodel = "default"\n`);
  assert.throws(() => validateDecisionsConfig(chat), /checks\.safety\.model = "default" must name a model with api = "system-one"/);
  const agent = await load(`[agents.agent_b]\nworkspace_root = "./workspaces/b"\n[agents.agent_b.checks.safety]\nmodel = "default"\n`);
  assert.throws(
    () => validateDecisionsConfig(agent),
    /agents\.agent_b\.checks\.safety\.model = "default" must name a model with api = "system-one"/,
  );
  const agentOk = await load(`[agents.agent_b]\nworkspace_root = "./workspaces/b"\n[agents.agent_b.checks.safety]\nmodel = "decider"\n`);
  validateDecisionsConfig(agentOk);

  // Calibration of a member reached only through a check's chain is in use.
  const warnings: string[] = [];
  const calibrated = await load(`
[models.other]
id = "vendor/other"
provider = "openrouter"
api = "system-one"
endpoint = "https://gw.example/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1
context_window = 32000

[decisions.calibration.other]
"checks.safety" = 0.9

[checks.safety]
model = "other"
`);
  validateDecisionsConfig(calibrated, { warn: (event) => warnings.push(event) });
  assert.ok(!warnings.includes("decisions_calibration_unused"), warnings.join(","));
});

test("validation: a check without questions cannot set model", () => {
  assert.throws(
    () => buildCheckCatalogue({ checks: { op: { kind: "style", patterns: ["x"], model: "decider" } }, agents: {} } as any, []),
    /\[checks\.op\]: model judges the check's questions; a check without questions cannot have one/,
  );
});
