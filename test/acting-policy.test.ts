import assert from "node:assert/strict";
import test from "node:test";

import { SessionRedoControl } from "../src/agent/redo-signal.js";
import { REFUSAL_BLOCK_MESSAGE, createActingPolicy, refusalCouldAct } from "../src/checks/acting-policy.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator, type FiredCheck } from "../src/checks/evaluator.js";
import { OutputGate, wrapToolsWithOutputGate, type GateCallInfo, type GateVerdict } from "../src/checks/gate.js";
import { createRevisePolicyPart } from "../src/checks/revise.js";
import type { RefusalRule } from "../src/checks/types.js";
import type { SessionRefusalHandle } from "../src/refusals/session.js";
import { Storage } from "../src/storage/index.js";
import { sendMessagePrecheck } from "../src/tools/send-message.js";

// ---------------------------------------------------------------------------
// The session's acting gate policy (spec REFUSAL-HANDLING §6.3–§6.4): the
// refusal half composed with the real revise part, through a real OutputGate,
// evaluator (pattern checks) and in-memory storage. The refusal rules are a
// stand-in handle (the real one is covered end to end in
// refusal-handling-soft.test.ts).
// ---------------------------------------------------------------------------

const SESSION = "s-acting0001";
const TIMELINE = "matrix:acct:room:!r:example.org";
const RULE: RefusalRule = {
  name: "capability_redo",
  models: [{ model: "model_b", tries: 1 }],
  soft: "redo",
  onExhausted: "send_last",
  index: 0,
};

function fakeRefusal(o: { rule?: RefusalRule; next?: Array<string | undefined>; site?: string } = {}) {
  const advanced: string[] = [];
  const next = [...(o.next ?? ["model_b"])];
  const handle: SessionRefusalHandle = {
    site: o.site ?? "default",
    agent: null,
    tasks: () => null,
    servingModel: () => "model_a",
    pinnedModel: () => undefined,
    matchRule: (input) => (input.kind === "soft" ? o.rule : undefined),
    softRuleCouldMatch: () => o.rule !== undefined,
    advance: (rule) => {
      advanced.push(rule.name);
      return next.shift();
    },
    record: async () => 0,
    pin: () => undefined,
    lastHardOutcome: () => undefined,
  };
  return { handle, advanced };
}

async function setup(o: { rule?: RefusalRule; next?: Array<string | undefined>; refusalRemedy?: "redo" | "observe" } = {}) {
  const config: any = {
    models: {},
    checks: {
      style_em_dash: { enabled: true },
      refusal_canned: { kind: "refusal", reason: "capability", patterns: ["(?i)can't help"], ...(o.refusalRemedy ? { remedy: o.refusalRemedy } : {}) },
    },
    agents: {},
  };
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.insertAgentSession({ id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1 });
  const lines: Array<[string, any]> = [];
  const logger: any = {
    info: (e: string, f: any) => lines.push([e, f]),
    warn: (e: string, f: any) => lines.push([e, f]),
    error: (e: string, f: any) => lines.push([e, f]),
    debug() {},
    child: () => logger,
  };
  const evaluator = new CheckEvaluator({ catalogue: buildCheckCatalogue(config), config, storage, logger });
  const revise = createRevisePolicyPart({ evaluator, logger });
  const refusal = fakeRefusal(o);
  const redoControl = new SessionRedoControl();
  const policy = createActingPolicy({ refusal: refusal.handle, redoControl, revise, logger });
  const messages: any[] = [{ role: "user", content: "hello", timestamp: 1 }];
  const gate = new OutputGate({
    evaluator,
    scope: { agent: null, site: "default", sessionId: SESSION, sessionType: "default", timelineKey: TIMELINE, tasks: null },
    getMessages: () => messages,
    servingModel: () => "model_a",
    policy,
    logger,
  });
  const sent: string[] = [];
  const tool: any = {
    name: "send_message",
    label: "send",
    description: "send",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    execute: async (_id: string, params: any) => {
      sent.push(params.message);
      return { content: [{ type: "text", text: "sent: $e1" }], details: {} };
    },
  };
  const [wrapped] = wrapToolsWithOutputGate([tool], gate);
  let seq = 0;
  const call = async (message: string): Promise<string> => {
    const id = `call-${++seq}`;
    try {
      await wrapped!.execute(id, { message } as any, undefined, undefined);
      return "sent";
    } catch (error) {
      return (error as Error).message;
    }
  };
  const rows = async () => {
    await storage.waitForIdle();
    return storage.getDecisionEvaluationsForSession(SESSION).map((r) => [r.tool_call_id, r.consequence] as const);
  };
  return { storage, gate, policy, revise, refusal, redoControl, call, sent, rows, lines, messages };
}

test("hold policy: a send is held only when a redo refusal check could act (a soft rule) or a revise check took part", () => {
  const info = { checkpoint: "send", action: "send_message", scope: {} } as unknown as GateCallInfo;
  const refusalCheck: any = { kind: "refusal", remedy: "redo" };
  const observed: any = { kind: "refusal", remedy: "observe" };
  assert.equal(refusalCouldAct(info, [refusalCheck], { softRuleCouldMatch: () => true }), true);
  assert.equal(refusalCouldAct(info, [refusalCheck], { softRuleCouldMatch: () => false }), false, "no rule can match");
  assert.equal(refusalCouldAct(info, [observed], { softRuleCouldMatch: () => true }), false, "observe remedy never holds");
  assert.equal(refusalCouldAct(info, [], { softRuleCouldMatch: () => true }), false, "no refusal check took part");
  const artifact = { ...info, checkpoint: "artifact" } as GateCallInfo;
  assert.equal(refusalCouldAct(artifact, [refusalCheck], { softRuleCouldMatch: () => true }), false, "jobs judge artifacts themselves");
});

test("composed with the revise part: refusal + style in one message → refusal wins, revise counters untouched", async () => {
  const t = await setup({ rule: RULE });
  assert.equal(await t.call("Sorry, I can't help — really."), REFUSAL_BLOCK_MESSAGE);
  assert.deepEqual(t.sent, []);
  const req = t.redoControl.peek()!;
  assert.equal(req.kind, "refusal");
  assert.equal(req.toolCallId, "call-1");
  assert.equal(req.checkCode, "refusal_canned");
  assert.equal(req.toModel, "model_b");
  assert.equal(req.refusedModel, "model_a");
  assert.equal(req.ruleName, "capability_redo");
  assert.ok(req.evaluationIds && req.evaluationIds.length === 2 && req.decisionEvaluationId === req.evaluationIds[0]);
  assert.deepEqual(t.revise.state(), { consecutive: 0, sessionTotal: 0, lastRejected: [] }, "decide never ran");
  assert.deepEqual(await t.rows(), [["call-1", "redo"], ["call-1", "redo"]]);
  await t.storage.waitForIdle();
  const events = t.storage.listRefusalEvents(SESSION);
  assert.deepEqual(events.map((e) => [e.outcome, e.rule_name, e.to_model]), [["redo", "capability_redo", "model_b"]]);
  assert.deepEqual([...t.policy.blockedRefusals()], ["call-1"]);
  t.storage.close();
});

test("composed with the revise part: style alone → revise blocks; a clean retry is sent and restarts the count", async () => {
  const t = await setup({ rule: RULE });
  assert.match(await t.call("It works — mostly."), /^Blocked: nothing was sent/);
  assert.equal(t.redoControl.peek(), undefined);
  assert.equal(t.revise.state().consecutive, 1);
  assert.equal(await t.call("It works, mostly."), "sent");
  assert.equal(t.revise.state().consecutive, 0, "the gate's delivery hook reached the revise part");
  assert.deepEqual(await t.rows(), [["call-1", "revise"]]);
  t.storage.close();
});

test("no rule can act: the refusal is recorded `observed`; style still revises; a clean refusal is sent unheld", async () => {
  const t = await setup();
  assert.match(await t.call("I can't help — sorry."), /^Blocked/, "the revise part holds and blocks");
  assert.equal(t.redoControl.peek(), undefined);
  assert.equal(await t.call("I can't help, sorry."), "sent", "nothing could act: not held");
  await new Promise((resolve) => setTimeout(resolve, 20)); // the unheld evaluation records when it completes
  await t.storage.waitForIdle();
  assert.deepEqual(t.storage.listRefusalEvents(SESSION).map((e) => e.outcome), ["observed", "observed"]);
  assert.deepEqual(await t.rows(), [["call-1", "revise"], ["call-1", "revise"], ["call-2", "observed"]]);
  t.storage.close();
});

test("a refusal check lowered to observe never holds or acts, even with a rule", async () => {
  const t = await setup({ rule: RULE, refusalRemedy: "observe" });
  assert.equal(await t.call("I can't help, sorry."), "sent");
  assert.equal(t.redoControl.peek(), undefined);
  t.storage.close();
});

test("exhausted rule at a send: send_last lets the last attempt through (`sent`), withhold and park block", async () => {
  const sendLast = await setup({ rule: RULE, next: [undefined] });
  assert.equal(await sendLast.call("I can't help, sorry."), "sent");
  assert.equal(sendLast.redoControl.peek(), undefined);
  assert.deepEqual(await sendLast.rows(), [["call-1", "sent"]]);
  assert.deepEqual(sendLast.storage.listRefusalEvents(SESSION).map((e) => e.outcome), ["exhausted_send_last"]);
  sendLast.storage.close();

  const withhold = await setup({ rule: { ...RULE, onExhausted: "withhold" }, next: [undefined] });
  assert.equal(await withhold.call("I can't help, sorry."), REFUSAL_BLOCK_MESSAGE);
  assert.equal(withhold.redoControl.peek()?.exhausted, "withhold");
  assert.deepEqual(await withhold.rows(), [["call-1", "withheld"]]);
  assert.deepEqual(withhold.storage.listRefusalEvents(SESSION).map((e) => e.outcome), ["exhausted_withheld"]);
  withhold.storage.close();

  const park = await setup({ rule: { ...RULE, onExhausted: "park" }, next: [undefined] });
  assert.equal(await park.call("I can't help, sorry."), REFUSAL_BLOCK_MESSAGE);
  assert.equal(park.redoControl.peek()?.exhausted, "park");
  assert.deepEqual(park.storage.listRefusalEvents(SESSION).map((e) => e.outcome), ["exhausted_parked"]);
  park.storage.close();
});

test("past the deadline: a judged refusal never blocks (sent unjudged); a pattern hit still acts", async () => {
  const { handle } = fakeRefusal({ rule: RULE });
  const redoControl = new SessionRedoControl();
  const policy = createActingPolicy({ refusal: handle, redoControl });
  const fired = (method: "judged" | "pattern"): FiredCheck => ({
    code: "refusal_capability", kind: "refusal", remedy: "redo", reason: "capability", method, probability: 0.97,
  });
  const verdict = (f: FiredCheck): GateVerdict => ({ evaluationIds: [], fired: [f], refusal: f, revise: [], unjudged: true, latencyMs: 5000 });
  const info = (id: string) => ({ checkpoint: "send", action: "send_message", toolCallId: id, scope: {} }) as unknown as GateCallInfo;
  // The deadline's verdict reaches `act` first (no consequence was recorded yet).
  const late = info("c1");
  assert.deepEqual(policy.act(late, verdict(fired("judged"))), { kind: "proceed" });
  assert.equal(redoControl.peek(), undefined);
  // The late recording keeps that decision.
  assert.equal(policy.consequence(late, verdict(fired("judged")), { held: true, late: true }), "sent_unjudged");
  assert.deepEqual(policy.refusalOutcome(late, fired("judged")), { outcome: "observed" });
  const pattern = info("c2");
  assert.equal(policy.act(pattern, verdict(fired("pattern"))).kind, "block");
  assert.equal(redoControl.peek()?.toModel, "model_b");
});

test("ending hold: the runner's ending hook waits for the verdict and files the redo (no tool call to block)", async () => {
  const t = await setup({ rule: RULE });
  t.messages.push({ role: "assistant", content: [{ type: "text", text: "I can't help with that one." }], timestamp: 2, stopReason: "stop" });
  await t.gate.onEnding({ kind: "exhausted", nudges: 1 });
  const req = t.redoControl.peek()!;
  assert.equal(req.kind, "refusal");
  assert.equal(req.toolCallId, undefined);
  assert.equal(req.checkCode, "refusal_canned");
  assert.ok((req.evaluationIds ?? []).length > 0, "the ending's rows are re-anchored by id after the fork");
  t.storage.close();
});

test("claim guard before evaluation (§6.2): a send the tool refuses is never held, judged or recorded", async () => {
  const t = await setup({ rule: RULE });
  const sends: string[] = [];
  const tool: any = {
    name: "send_message",
    label: "send",
    description: "send",
    parameters: { type: "object", properties: {} },
    gatePrecheck: (params: any) =>
      sendMessagePrecheck({ isClaimedByOther: () => ({ sessionId: "s-other" }) }, params),
    execute: async (_id: string, params: any) => {
      sends.push(params.message);
      return { content: [{ type: "text", text: "sent" }], details: {} };
    },
  };
  const [wrapped] = wrapToolsWithOutputGate([tool], t.gate);
  const result: any = await wrapped!.execute("c-claimed", { message: "I can't help.", is_reply: true, reply_to_id: "$x" } as any, undefined, undefined);
  assert.match(result.content[0].text, /currently being handled by another session \(s-other\)/);
  assert.deepEqual(sends, []);
  assert.equal(t.redoControl.peek(), undefined, "no verdict, no redo");
  assert.deepEqual(await t.rows(), []);
  t.storage.close();
});
