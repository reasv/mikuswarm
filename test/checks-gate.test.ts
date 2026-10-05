import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import {
  OBSERVE_POLICY,
  OutputGate,
  createBackgroundChecks,
  wrapToolsWithOutputGate,
  type GatePolicy,
} from "../src/checks/gate.js";
import { SessionRunner } from "../src/agent/runner.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// The output gate, observe-only (spec REFUSAL-HANDLING §5–§6, §10.1): patterns
// before questions, the style floor, max-probability verdicts and calibration,
// deadlines, the payee budget skip, early start from the attempt tap, the
// wrapper never delaying a send, endings, artifacts and rollouts, anchored
// decision rows and refusal events.
// ---------------------------------------------------------------------------

const SESSION = "s-gate000001";
const TIMELINE = "matrix:acct:room:!r:example.org";

function decider(over: Record<string, unknown> = {}): any {
  return {
    id: "vendor/decider-1",
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

const opRefusal = (over: Record<string, unknown> = {}) => ({
  kind: "refusal",
  reason: "safety",
  questions: [
    { source: "message", instructions: "`message` declines.", criteria: { true: "declines", false: "helps" }, threshold: 0.8 },
    { source: "analysis", instructions: "`analysis` declines.", criteria: { true: "declines", false: "helps" }, threshold: 0.8 },
  ],
  ...over,
});

interface ConfigOpts {
  decisions?: boolean;
  checksPoint?: boolean;
  checks?: Record<string, unknown>;
  knobs?: Record<string, unknown>;
  calibration?: Record<string, Record<string, number>>;
  models?: Record<string, unknown>;
}

function makeConfig(opts: ConfigOpts = {}): any {
  return {
    models: { decider: decider(), ...(opts.models ?? {}) },
    decisions: {
      enabled: opts.decisions ?? true,
      model: "decider",
      ...(opts.calibration ? { calibration: opts.calibration } : {}),
      checks: { enabled: opts.checksPoint ?? true, timeout_ms: 60_000, ...(opts.knobs ?? {}) },
    },
    checks: opts.checks ?? { op_refusal: opRefusal() },
    agents: {},
  };
}

/** A decision endpoint whose answers the test controls; honours abort. */
function decisionServer(answer: (id: string, question: any) => unknown = () => ({ noul: 0.1 })) {
  const calls: Array<{ body: any }> = [];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body });
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        gate!.then(resolve);
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) answers[id] = answer(id, q);
    return new Response(
      JSON.stringify({ model: "vendor/decider-1-20261001", answers, usage: { input_tokens: 100, output_tokens: 1, cost: 0.00001 } }),
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

function logger() {
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
  return { l, lines };
}

async function setup(opts: ConfigOpts & {
  answer?: (id: string, q: any) => unknown;
  builtins?: boolean;
  overBudget?: boolean;
  policy?: GatePolicy;
  messages?: any[];
  now?: () => number;
} = {}) {
  const config = makeConfig(opts);
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.insertAgentSession({
    id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
  });
  const server = decisionServer(opts.answer);
  const { l, lines } = logger();
  const usage: any[] = [];
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: server.fetchImpl, logger: l }),
    record: (e) => usage.push(e),
    logger: l,
  });
  const catalogue = buildCheckCatalogue(config, opts.builtins ? undefined : []);
  const evaluator = new CheckEvaluator({
    catalogue,
    engine,
    config,
    storage,
    isPayeeOverBudget: () => opts.overBudget ?? false,
    logger: l,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const messages: any[] = opts.messages ?? [{ role: "user", content: "please help", timestamp: 1 }];
  const gate = new OutputGate({
    evaluator,
    scope: { agent: null, site: "default", sessionId: SESSION, sessionType: "default", timelineKey: TIMELINE, tasks: null },
    getMessages: () => messages,
    chat: () => ({ request: [{ from: "Alice", text: "please help" }], recent: [{ from: "Bob", text: "hi" }] }),
    servingModel: () => "model_a",
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    logger: l,
  });
  return { config, storage, server, lines, usage, evaluator, gate, messages };
}

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const rows = (storage: Storage) => storage.getDecisionEvaluationsForSession(SESSION);

function sendTool(log: string[]): any {
  return {
    name: "send_message",
    label: "send",
    description: "send",
    parameters: {},
    execute: async (_id: string, params: any) => {
      log.push(`sent:${params.message}`);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

test("send, observe-only: the send runs at once, the verdict is recorded beside it", async () => {
  const t = await setup({ answer: (id) => ({ noul: id.endsWith("analysis") ? 0.95 : 0.85 }) });
  t.server.hold();
  const log: string[] = [];
  const [wrapped] = wrapToolsWithOutputGate([sendTool(log)], t.gate);
  t.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "send_message", arguments: {} }], timestamp: 2 });
  await wrapped!.execute("call-1", { message: "I won't help with that.", analysis: "Decline: unsafe." } as any, undefined, undefined);
  assert.deepEqual(log, ["sent:I won't help with that."], "sent before any verdict");
  await until(() => t.server.calls.length === 1, "the decision call");
  assert.equal(rows(t.storage).length, 0, "nothing recorded while judging");

  t.server.release();
  await until(() => rows(t.storage).length === 1, "the decision row");
  await t.storage.waitForIdle();
  const [row] = rows(t.storage);
  assert.equal(row!.point, "checks");
  assert.equal(row!.source, "model");
  assert.equal(row!.checkpoint, "send");
  assert.equal(row!.tool_call_id, "call-1");
  assert.equal(row!.branch_no, 0);
  assert.equal(row!.attempt_no, null);
  assert.equal(row!.consequence, "observed");
  const state = JSON.parse(row!.state_json!);
  assert.deepEqual(state.request, [{ from: "Alice", text: "please help" }]);
  assert.equal(state.message, "I won't help with that.");
  assert.equal(state.analysis, "Decline: unsafe.");
  assert.equal(state.action, "send_message");
  // Max probability among the check's questions: analysis 0.95 beats message 0.85.
  await until(() => t.storage.listRefusalEvents(SESSION).length === 1, "the refusal event");
  const [event] = t.storage.listRefusalEvents(SESSION);
  assert.equal(event!.kind, "soft");
  assert.equal(event!.check_code, "op_refusal");
  assert.equal(event!.reason, "safety");
  assert.equal(event!.method, "judged");
  assert.equal(event!.source, "analysis");
  assert.equal(event!.probability, 0.95);
  assert.equal(event!.outcome, "observed");
  assert.equal(event!.checkpoint, "send");
  assert.equal(event!.site, "default");
  assert.equal(event!.served_model, "model_a");
  assert.equal(event!.decision_evaluation_id, row!.id);
  const logged = t.lines.find(([e]) => e === "check_gate_evaluated")![1];
  assert.deepEqual(logged.fired, ["op_refusal"]);
  assert.equal(logged.heldMs, 0);
  assert.equal(logged.unjudged, false);
  assert.equal(t.usage.length, 1, "billed in the decision class");
  assert.equal(t.usage[0].class, "decision");
  assert.equal(t.usage[0].toolName, "checks");
  t.storage.close();
});

test("a clean send is recorded `sent`; nothing fires below every threshold", async () => {
  const t = await setup({ answer: () => ({ noul: 0.2 }) });
  const log: string[] = [];
  const [wrapped] = wrapToolsWithOutputGate([sendTool(log)], t.gate);
  await wrapped!.execute("call-2", { message: "Sure, here it is." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  assert.equal(rows(t.storage)[0]!.consequence, "sent");
  assert.equal(t.storage.listRefusalEvents(SESSION).length, 0);
  t.storage.close();
});

test("patterns before questions: a hit decides its check without a model call", async () => {
  const t = await setup({
    checks: { op_refusal: opRefusal({ patterns: ["(?i)as an ai\\b"] }) },
  });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("call-3", { message: "As an AI I cannot do that." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  assert.equal(t.server.calls.length, 0, "no decision call: the pattern decided the only check");
  const [row] = rows(t.storage);
  assert.equal(row!.source, "pattern");
  assert.equal(row!.served_model, null);
  assert.deepEqual(JSON.parse(row!.verdict_json!), { fired: ["op_refusal"], source: "message", matched: "As an AI" });
  await until(() => t.storage.listRefusalEvents(SESSION).length === 1);
  assert.equal(t.storage.listRefusalEvents(SESSION)[0]!.method, "pattern");
  assert.equal(t.storage.listRefusalEvents(SESSION)[0]!.decision_evaluation_id, row!.id);
  t.storage.close();
});

test("judged checks are inert without both enables; pattern checks still run", async () => {
  for (const opts of [{ decisions: false }, { checksPoint: false }]) {
    const t = await setup(opts);
    const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
    await wrapped!.execute("c", { message: "I refuse." } as any, undefined, undefined);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(t.server.calls.length, 0);
    assert.equal(rows(t.storage).length, 0, "nothing to judge, nothing recorded");
    assert.equal(t.gate.evaluation("c"), undefined, "no evaluation started at all");
    t.storage.close();
  }
  const t = await setup({ decisions: false, checks: { op_refusal: opRefusal({ patterns: ["refuse"] }) } });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c2", { message: "I refuse." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  assert.equal(rows(t.storage)[0]!.source, "pattern");
  assert.equal(t.server.calls.length, 0);
  t.storage.close();
});

test("style floor: style checks skip short messages; pattern-only style checks and refusal checks do not", async () => {
  const styleQ = { source: "message", instructions: "`message` is flowery.", criteria: { true: "t", false: "f" }, threshold: 0.8 };
  const t = await setup({
    answer: () => ({ noul: 0.1 }),
    checks: {
      op_refusal: opRefusal(),
      style_q: { kind: "style", questions: [styleQ] },
      style_dash: { kind: "style", patterns: ["—"] },
    },
  });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "nah — no." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 2, "pattern row + call row");
  const asked = Object.keys(t.server.calls[0]!.body.questions);
  assert.deepEqual(asked, ["op_refusal__message"], "the short message skips the style question, not the refusal one");
  const pattern = rows(t.storage).find((r) => r.source === "pattern")!;
  assert.deepEqual(JSON.parse(pattern.verdict_json!).fired, ["style_dash"]);

  const long = await setup({
    answer: () => ({ noul: 0.1 }),
    checks: { style_q: { kind: "style", min_chars: 10, questions: [styleQ] } },
  });
  const [w2] = wrapToolsWithOutputGate([sendTool([])], long.gate);
  await w2!.execute("d", { message: "long enough message" } as any, undefined, undefined);
  await until(() => long.server.calls.length === 1);
  assert.deepEqual(Object.keys(long.server.calls[0]!.body.questions), ["style_q__message"]);
  t.storage.close();
  long.storage.close();
});

test("calibration: [decisions.calibration.<member>] \"checks.<code>\" overrides the check's thresholds", async () => {
  const t = await setup({
    answer: () => ({ noul: 0.9 }),
    calibration: { decider: { "checks.op_refusal": 0.95 } },
  });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "no." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  assert.equal(rows(t.storage)[0]!.consequence, "sent", "0.9 is below the calibrated 0.95");
  const verdict = JSON.parse(rows(t.storage)[0]!.verdict_json!);
  assert.deepEqual(verdict.results.map((r: any) => r.t), [0.95]);
  t.storage.close();
});

test("payee over budget: no gate call, the output proceeds unjudged and the miss is recorded", async () => {
  const t = await setup({ overBudget: true });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "no." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  assert.equal(t.server.calls.length, 0);
  const [row] = rows(t.storage);
  assert.equal(row!.source, "heuristic");
  assert.equal(row!.reason, "payee_budget");
  assert.equal(row!.consequence, "sent_unjudged");
  assert.equal(t.lines.find(([e]) => e === "check_gate_evaluated")![1].unjudged, true);
  t.storage.close();
});

test("deadline (fake timers): a held output proceeds unjudged; the late completion is recorded", async () => {
  let clock = 1_000_000;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const holding: GatePolicy = { ...OBSERVE_POLICY, shouldHold: () => true };
    const t = await setup({ policy: holding, now: () => clock, knobs: { send_deadline_ms: 5000 }, answer: () => ({ noul: 0.9 }) });
    t.server.hold();
    const log: string[] = [];
    const [wrapped] = wrapToolsWithOutputGate([sendTool(log)], t.gate);
    const pending = wrapped!.execute("c", { message: "no." } as any, undefined, undefined);
    await until(() => t.server.calls.length === 1);
    assert.deepEqual(log, [], "held while judged");
    clock += 5000;
    mock.timers.tick(5000);
    await pending;
    assert.deepEqual(log, ["sent:no."], "sent unjudged at the deadline");
    assert.equal(rows(t.storage).length, 0, "the evaluation is still running");

    clock += 2000;
    t.server.release();
    await until(() => rows(t.storage).length === 1);
    const [row] = rows(t.storage);
    assert.equal(row!.consequence, "sent_unjudged");
    const logged = t.lines.find(([e]) => e === "check_gate_evaluated")![1];
    assert.equal(logged.late, true);
    assert.equal(logged.unjudged, true);
    assert.equal(logged.heldMs, 5000, "the actual added delay");
    assert.deepEqual(logged.fired, ["op_refusal"], "the late verdict is still recorded");
    t.storage.close();
  } finally {
    mock.timers.reset();
  }
});

test("deadline, observe mode: completion past the deadline is recorded sent_unjudged", async () => {
  let clock = 0;
  const t = await setup({ now: () => clock, knobs: { send_deadline_ms: 100 }, answer: () => ({ noul: 0.1 }) });
  t.server.hold();
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "fine" } as any, undefined, undefined);
  await until(() => t.server.calls.length === 1);
  clock = 250;
  t.server.release();
  await until(() => rows(t.storage).length === 1);
  assert.equal(rows(t.storage)[0]!.consequence, "sent_unjudged");
  t.storage.close();
});

test("hold path: a holding policy records first, then acts (block = the tool error)", async () => {
  const acted: any[] = [];
  const blocking: GatePolicy = {
    ...OBSERVE_POLICY,
    shouldHold: () => true,
    consequence: () => "revise",
    act: (_info, verdict) => {
      acted.push(verdict);
      return verdict.fired.length > 0 ? { kind: "block", message: "revise it" } : { kind: "proceed" };
    },
  };
  const t = await setup({ policy: blocking, answer: () => ({ noul: 0.9 }) });
  const log: string[] = [];
  const [wrapped] = wrapToolsWithOutputGate([sendTool(log)], t.gate);
  await assert.rejects(wrapped!.execute("c", { message: "no." } as any, undefined, undefined), /revise it/);
  assert.deepEqual(log, []);
  assert.equal(acted[0].evaluationIds.length, 1, "ids are known when the policy acts");
  assert.equal(acted[0].refusal.code, "op_refusal");
  assert.equal(rows(t.storage)[0]!.consequence, "revise");
  t.storage.close();
});

test("early start: the tap begins at toolcall_end, execute reuses it; a discarded attempt cancels its evaluation", async () => {
  const t = await setup({ answer: () => ({ noul: 0.1 }) });
  t.server.hold();
  const partial = (id: string, message: string) => ({
    role: "assistant",
    content: [{ type: "text", text: "thinking aloud" }, { type: "toolCall", id, name: "send_message", arguments: { message } }],
  });
  // Attempt 1 streams a send, then is discarded (Layer-0 retry).
  t.gate.onAttemptEvent(1, { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "a1", name: "send_message", arguments: { message: "first try" } }, partial: partial("a1", "first try") } as any);
  const first = t.gate.evaluation("a1")!;
  assert.ok(first, "started before execute");
  t.gate.onAttemptDiscarded(1);
  assert.equal(first.canceled, true);
  assert.equal(t.gate.evaluation("a1"), undefined);

  // Attempt 2 streams and commits; execute reuses the started evaluation.
  t.gate.onAttemptEvent(2, { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "a2", name: "send_message", arguments: { message: "second try" } }, partial: partial("a2", "second try") } as any);
  t.gate.onAttemptEvent(2, { type: "done", reason: "toolUse", message: partial("a2", "second try") } as any);
  t.gate.onAttemptDiscarded(2);
  assert.ok(t.gate.evaluation("a2"), "a committed attempt keeps its evaluation");
  const started = t.gate.evaluation("a2")!;
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("a2", { message: "second try" } as any, undefined, undefined);
  t.server.release();
  await until(() => rows(t.storage).length === 1);
  assert.equal(t.server.calls.length, 2, "one call per started evaluation, none from execute");
  const [row] = rows(t.storage);
  assert.equal(row!.tool_call_id, "a2");
  assert.equal(row!.decision_group, started.decisionGroup);
  assert.equal(JSON.parse(row!.state_json!).text, "thinking aloud", "text taken from the streaming partial");
  t.storage.close();
});

test("ending: no_reply is judged from analysis, text and thinking; no_reply_intent only after a nudge", async () => {
  const t = await setup({ builtins: true, checks: {}, answer: (_id, q) => (q.type === "choice" ? { choice: "intended_no_reply", confidence: 0.9, probabilities: { intended_no_reply: 0.9 } } : { noul: 0.05 }) });
  const noReply: any = {
    name: "no_reply",
    label: "No reply",
    description: "",
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "NO_REPLY_CALLED" }], details: {}, terminate: true }),
  };
  const [wrapped] = wrapToolsWithOutputGate([noReply], t.gate);
  t.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "not for me" }, { type: "text", text: "Nothing to add." }, { type: "toolCall", id: "n1", name: "no_reply", arguments: { analysis: "Not addressed to me." } }] });
  await wrapped!.execute("n1", { analysis: "Not addressed to me." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  const asked = Object.keys(t.server.calls[0]!.body.questions);
  assert.ok(asked.includes("refusal_safety__analysis") && asked.includes("refusal_safety__text") && asked.includes("refusal_safety__thinking"));
  assert.ok(!asked.some((id) => id.startsWith("refusal_safety__message")), "no message at an ending");
  assert.ok(!asked.includes("no_reply_intent__text"), "no nudge, no intent question");
  assert.ok(!asked.some((id) => id.startsWith("no_reply_contradiction")), "disabled by default");
  const [row] = rows(t.storage);
  assert.equal(row!.checkpoint, "ending");
  assert.equal(row!.tool_call_id, "n1");
  assert.equal(row!.attempt_no, 0);
  assert.equal(row!.consequence, "observed");

  // After a nudge: the intent question joins, with the pre-nudge text in state.
  t.messages.push(
    { role: "user", content: "next question" },
    { role: "assistant", content: [{ type: "text", text: "Here is a full reply for you." }] },
    { role: "user", content: "Your turn ended without sending a message. You must end every turn by either: ..." },
    { role: "assistant", content: [{ type: "toolCall", id: "n2", name: "no_reply", arguments: {} }] },
  );
  await wrapped!.execute("n2", {} as any, undefined, undefined);
  await until(() => rows(t.storage).length === 2);
  const second = t.server.calls[1]!.body;
  assert.ok(Object.keys(second.questions).includes("no_reply_intent__text"));
  assert.equal(second.questions["no_reply_intent__text"].type, "choice");
  assert.equal(second.state.first_attempt, "Here is a full reply for you.");
  assert.equal(second.state.nudges, 1);
  assert.equal(rows(t.storage)[1]!.attempt_no, 1);
  t.storage.close();
});

function fakeAgent(messages: any[], onPrompt: (messages: any[], prompt: any) => void): any {
  return {
    state: { messages },
    async prompt(message: any) {
      const list = Array.isArray(message) ? message : [message];
      messages.push(...list);
      onPrompt(messages, message);
    },
    async continue() {},
    async waitForIdle() {},
  };
}

test("ending via the runner: the NO_REPLY text and forced-completion exhaustion", async () => {
  const t = await setup({ builtins: true, checks: {}, answer: () => ({ noul: 0.05 }) });
  const runner = new SessionRunner({ endings: t.gate });
  const session: any = { id: SESSION };
  // NO_REPLY text: sources come from the previous assistant turn of this request.
  const agent = fakeAgent(t.messages, (messages) => {
    messages.push({ role: "assistant", content: [{ type: "text", text: "I would rather stay out of this." }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] });
  });
  const result = await runner.run(agent, session, 3, { role: "user", content: "hello?", timestamp: 3 });
  assert.equal(result.noReply, true);
  await until(() => rows(t.storage).length === 1);
  let row = rows(t.storage)[0]!;
  assert.equal(row.checkpoint, "ending");
  assert.equal(row.tool_call_id, null);
  assert.equal(row.attempt_no, 0);
  const body = t.server.calls[0]!.body;
  assert.equal(body.state.action, "NO_REPLY");
  assert.equal(body.state.text, "I would rather stay out of this.");
  assert.ok(!Object.keys(body.questions).includes("no_reply_intent__text"));

  // Exhaustion: bare text every time, two nudges.
  const messages2: any[] = [];
  const t2 = await setup({ builtins: true, checks: {}, answer: () => ({ noul: 0.05 }), messages: messages2 });
  const agent2 = fakeAgent(messages2, (messages) => {
    messages.push({ role: "assistant", content: [{ type: "text", text: "I cannot answer that." }] });
  });
  const r2 = await new SessionRunner({ endings: t2.gate }).run(agent2, session, 2, { role: "user", content: "q", timestamp: 1 });
  assert.equal(r2.retries, 2);
  await until(() => rows(t2.storage).length === 1);
  row = rows(t2.storage)[0]!;
  assert.equal(row.attempt_no, 2);
  const body2 = t2.server.calls[0]!.body;
  assert.equal(body2.state.action, "exhausted");
  assert.ok(!Object.keys(body2.questions).some((id) => id.startsWith("no_reply_")), "contract checks judge no_reply endings only");
  t.storage.close();
  t2.storage.close();
});

test("artifacts and rollouts: background checks and the session record", async () => {
  const t = await setup({ builtins: true, checks: {}, answer: (id) => ({ noul: id.startsWith("refusal_capability") ? 0.95 : 0.05 }) });
  const background = createBackgroundChecks(t.evaluator);
  await background.artifact({ site: "caption", kind: "caption", text: "I can't see images.", timelineKey: TIMELINE, sessionId: SESSION, servedModel: "caption_model" });
  let [row] = rows(t.storage);
  assert.equal(row!.checkpoint, "artifact");
  assert.equal(row!.consequence, "observed");
  const artifactBody = t.server.calls[0]!.body;
  assert.equal(artifactBody.state.artifact, "I can't see images.");
  assert.ok(Object.keys(artifactBody.questions).every((id) => id.endsWith("__artifact")));
  let events = t.storage.listRefusalEvents(SESSION);
  assert.equal(events[0]!.site, "caption");
  assert.equal(events[0]!.check_code, "refusal_capability");
  assert.equal(events[0]!.checkpoint, "artifact");
  assert.equal(events[0]!.served_model, "caption_model");

  await background.rollout({
    site: "summarize",
    kind: "summary",
    timelineKey: TIMELINE,
    sessionId: SESSION,
    messages: [
      { role: "user", content: "SOURCE CHAT that must not be sent" },
      { role: "assistant", content: [{ type: "text", text: "I won't summarize this conversation." }] },
    ],
  });
  const rolloutBody = t.server.calls[1]!.body;
  assert.deepEqual(rolloutBody.state.rollout, ["I won't summarize this conversation."]);
  assert.ok(!JSON.stringify(rolloutBody.state).includes("SOURCE"));
  assert.equal(rows(t.storage)[1]!.checkpoint, "rollout");

  await t.gate.judgeArtifact("session_record", "Searched for X, found Y.", { site: "record_turn" });
  events = t.storage.listRefusalEvents(SESSION);
  assert.equal(events.at(-1)!.site, "record_turn");
  [row] = rows(t.storage).slice(-1);
  assert.equal(row!.checkpoint, "artifact");
  t.storage.close();
});

test("one evaluation, several calls: they share a decisionGroup", async () => {
  const t = await setup({
    models: { decider: decider({ decision: { max_questions: 1 } }) },
    answer: () => ({ noul: 0.1 }),
  });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "no.", analysis: "decline" } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 2);
  assert.equal(t.server.calls.length, 2);
  const groups = new Set(rows(t.storage).map((r) => r.decision_group));
  assert.equal(groups.size, 1);
  assert.equal(t.lines.filter(([e]) => e === "check_gate_evaluated").length, 1, "one logical evaluation");
  t.storage.close();
});

test("updateDecisionEvaluationConsequence rewrites what a recorded verdict did", async () => {
  const t = await setup({ answer: () => ({ noul: 0.9 }) });
  const [wrapped] = wrapToolsWithOutputGate([sendTool([])], t.gate);
  await wrapped!.execute("c", { message: "no." } as any, undefined, undefined);
  await until(() => rows(t.storage).length === 1);
  await t.storage.updateDecisionEvaluationConsequence([rows(t.storage)[0]!.id], "redo");
  assert.equal(rows(t.storage)[0]!.consequence, "redo");
  await t.storage.updateDecisionEvaluationConsequence([], "sent");
  t.storage.close();
});
