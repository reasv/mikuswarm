import assert from "node:assert/strict";
import test from "node:test";

import { validateToolArguments } from "@earendil-works/pi-ai";
import { DynamicToolRegistry } from "../src/agent/dynamic-tools.js";
import { applyPrefillToParams, wrapToolWithAnalysisStripping } from "../src/agent/openai-prefill.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import {
  OBSERVE_POLICY,
  OutputGate,
  wrapToolsWithOutputGate,
  type GateCallInfo,
  type GatePolicy,
  type GateVerdict,
} from "../src/checks/gate.js";
import type { RevisePolicyPart } from "../src/checks/policy-parts.js";
import {
  OVERRIDE_CHECKS_ARG,
  createRevisePolicyPart,
  priorRejections,
  readOverrideChecks,
  withoutOverrideArgument,
  type RevisePart,
} from "../src/checks/revise.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";
import { createNoReplyTool } from "../src/tools/no-reply.js";
import { createSendMessageTool } from "../src/tools/send-message.js";

// ---------------------------------------------------------------------------
// The revise remedy (spec REFUSAL-HANDLING §6.4, §5.4): the revise policy part
// on its own and inside a minimal stand-in acting policy (the composition W4's
// acting policy does), through a real OutputGate, evaluator and in-memory
// storage: the tool error, the bounds, the override argument, the
// `no_reply_contradiction` path, refusal precedence, and the recorded
// consequences.
// ---------------------------------------------------------------------------

const SESSION = "s-revise0001";
const TIMELINE = "matrix:acct:room:!r:example.org";

function decider(): any {
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
  };
}

interface SetupOpts {
  checks?: Record<string, unknown>;
  knobs?: Record<string, unknown>;
  judged?: boolean;
  answer?: (id: string) => unknown;
  /** The stand-in refusal half: true = a rule acts on the fired refusal. */
  refusalActs?: boolean;
  priorRejections?: number;
  sessionId?: string;
}

const STYLE = { style_em_dash: { enabled: true }, style_llm_vocabulary: { enabled: true } };

/**
 * A minimal acting policy composing a refusal half with the revise part, the
 * way the session's acting policy must (CONTRACT A2): an acting refusal wins;
 * otherwise the part holds, decides and records; delivery is forwarded.
 */
function standInPolicy(revise: RevisePolicyPart, refusalActs: boolean, redo: string[]): GatePolicy {
  const refusalWins = (verdict: GateVerdict) => refusalActs && verdict.refusal !== undefined;
  return {
    shouldHold: (info, checks) =>
      (refusalActs && checks.some((c) => c.kind === "refusal" && c.remedy === "redo")) || revise.shouldHold(info, checks),
    consequence: (info, verdict, opts) => {
      if (refusalWins(verdict)) return "redo";
      if (verdict.revise.length > 0) {
        const decision = revise.decide(info, verdict);
        if (decision.consequence) return decision.consequence;
      }
      return OBSERVE_POLICY.consequence(info, verdict, opts);
    },
    refusalOutcome: (info, fired) => OBSERVE_POLICY.refusalOutcome(info, fired),
    act: (info, verdict) => {
      if (refusalWins(verdict)) {
        redo.push(verdict.refusal!.code);
        return { kind: "block", message: "redo requested" };
      }
      const decision = revise.decide(info, verdict);
      return decision.kind === "block" ? { kind: "block", message: decision.message } : { kind: "proceed" };
    },
    onDelivered: () => revise.onDelivered(),
  };
}

async function setup(opts: SetupOpts = {}) {
  const sessionId = opts.sessionId ?? SESSION;
  const config: any = {
    models: { decider: decider() },
    decisions: {
      enabled: opts.judged ?? false,
      model: "decider",
      checks: { enabled: opts.judged ?? false, timeout_ms: 60_000, ...(opts.knobs ?? {}) },
    },
    checks: opts.checks ?? STYLE,
    agents: {},
  };
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.insertAgentSession({
    id: sessionId, timelineKey: TIMELINE, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
  });
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
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = opts.answer?.(id) ?? { noul: 0.1 };
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1, cost: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl, logger: l }),
    record: () => {},
    logger: l,
  });
  const catalogue = buildCheckCatalogue(config);
  const evaluator = new CheckEvaluator({ catalogue, engine, config, storage, logger: l });
  const revise = createRevisePolicyPart({
    evaluator,
    logger: l,
    ...(opts.priorRejections !== undefined ? { priorRejections: opts.priorRejections } : {}),
  });
  const redo: string[] = [];
  const messages: any[] = [{ role: "user", content: "hello", timestamp: 1 }];
  const gate = new OutputGate({
    evaluator,
    scope: { agent: null, site: "default", sessionId, sessionType: "default", timelineKey: TIMELINE, tasks: null },
    getMessages: () => messages,
    chat: () => ({ request: [{ from: "Alice", text: "hello" }], recent: [] }),
    servingModel: () => "model_a",
    policy: standInPolicy(revise, opts.refusalActs ?? false, redo),
    logger: l,
  });
  const sent: any[] = [];
  const send: any = {
    name: "send_message",
    label: "send",
    description: "send",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    execute: async (_id: string, params: any) => {
      sent.push(params);
      return { content: [{ type: "text", text: "sent: $e1" }], details: {} };
    },
  };
  const [wrappedSend, wrappedNoReply] = wrapToolsWithOutputGate([send, createNoReplyTool()], gate);
  let seq = 0;
  /** Call send_message the way the agent loop does; returns "sent" or the thrown error text. */
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const id = `call-${++seq}`;
    try {
      await wrappedSend!.execute(id, args as any, undefined, undefined);
      return "sent";
    } catch (error) {
      return (error as Error).message;
    }
  };
  const noReply = async (args: Record<string, unknown>): Promise<{ result?: any; error?: string; id: string }> => {
    const id = `call-${++seq}`;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "no_reply", arguments: args }], timestamp: 2 });
    try {
      return { result: await wrappedNoReply!.execute(id, args as any, undefined, undefined), id };
    } catch (error) {
      return { error: (error as Error).message, id };
    }
  };
  const consequences = async () => {
    await storage.waitForIdle();
    return storage
      .getDecisionEvaluationsForSession(sessionId)
      .map((r) => [r.tool_call_id, r.consequence] as const);
  };
  return { storage, gate, revise, call, noReply, sent, lines, redo, consequences, wrappedSend: wrappedSend!, wrappedNoReply: wrappedNoReply!, evaluator };
}

const DASH = "it works — mostly";

test("revise: a flagged send is not sent; the error lists code, explanation and how to override", async () => {
  const t = await setup();
  const error = await t.call({ message: "We should delve in — now." });
  assert.equal(t.sent.length, 0, "nothing sent");
  assert.equal(
    error,
    [
      "Blocked: nothing was sent. Output checks flagged this send_message call:",
      "- style_em_dash: Contains an em-dash. Use a comma, period, colon or parentheses instead.",
      '- style_llm_vocabulary: Uses stock LLM vocabulary ("delve"). Use a plain word.',
      "Revise it and call send_message again. If a flag is a clear false positive, or the text deliberately shows it " +
        '(a quotation, an example), call send_message again with override_checks listing those codes ' +
        '(accepted: ["style_em_dash","style_llm_vocabulary"]).',
    ].join("\n"),
  );
  assert.deepEqual(await t.consequences(), [["call-1", "revise"], ["call-1", "revise"]], "one pattern row per hit, both `revise`");
  const blocked = t.lines.find(([e]) => e === "check_revise_blocked")![1];
  assert.deepEqual(blocked.codes, ["style_em_dash", "style_llm_vocabulary"]);
  assert.equal(blocked.consecutive, 1);
  assert.equal(blocked.sessionTotal, 1);

  // The same agent revises: the clean retry is sent, and the counter restarts.
  assert.equal(await t.call({ message: "We should look at it now." }), "sent");
  assert.deepEqual(t.revise.state(), { consecutive: 0, sessionTotal: 1, lastRejected: [] });
  t.storage.close();
});

test("bounds: after revise_max_consecutive rejections the next call goes through, recorded `sent`", async () => {
  const t = await setup({ knobs: { revise_max_consecutive: 2 } });
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.equal(await t.call({ message: DASH }), "sent", "the third attempt goes through regardless");
  assert.deepEqual(await t.consequences(), [["call-1", "revise"], ["call-2", "revise"], ["call-3", "sent"]]);
  assert.ok(t.lines.some(([e, f]) => e === "check_revise_bound_passed" && f.bound === "consecutive"));
  assert.equal(t.revise.state().consecutive, 0, "the delivery restarts the consecutive count");
  // A fresh message is gated again.
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  t.storage.close();
});

test("bounds: after revise_max_per_session rejections revisable checks stop blocking for the session", async () => {
  const t = await setup({ knobs: { revise_max_consecutive: 5, revise_max_per_session: 3 } });
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.equal(await t.call({ message: "fixed" }), "sent");
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.equal(t.revise.state().sessionTotal, 3);
  for (let i = 0; i < 3; i++) assert.equal(await t.call({ message: DASH }), "sent");
  const rows = await t.consequences();
  assert.deepEqual(rows.slice(-3).map(([, c]) => c), ["sent", "sent", "sent"], "still recorded, as `sent`");
  assert.ok(t.lines.some(([e, f]) => e === "check_revise_bound_passed" && f.bound === "session"));
  t.storage.close();
});

test("bounds persist across a refusal redo and seed from the session's rows on resume", async () => {
  const t = await setup({ knobs: { revise_max_consecutive: 2, revise_max_per_session: 3 } });
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  // A refusal redo forks the session: the branch changes, the session (and its counters) do not.
  t.gate.branchNo = 1;
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.equal(await t.call({ message: DASH }), "sent", "the consecutive bound counted the pre-fork rejection");
  assert.equal(t.revise.state().sessionTotal, 2);

  // A resumed session (a new gate and part) starts from the rows already recorded.
  const rows = t.storage.getDecisionEvaluationsForSession(SESSION);
  assert.equal(priorRejections(rows), 2);
  const resumed = await setup({ knobs: { revise_max_consecutive: 2, revise_max_per_session: 3 }, priorRejections: priorRejections(rows) });
  assert.match(await resumed.call({ message: DASH }), /^Blocked/);
  assert.equal(await resumed.call({ message: DASH }), "sent", "the session bound (3) is reached");
  t.storage.close();
  resumed.storage.close();
});

test("override: only codes fired in the immediately preceding rejection are honoured; the tool never sees the argument", async () => {
  const t = await setup();
  // No preceding rejection: the override is ignored.
  const first = await t.call({ message: DASH, override_checks: ["style_em_dash"] });
  assert.match(first, /^Blocked/);
  assert.ok(t.lines.some(([e, f]) => e === "check_revise_blocked" && f.overrideRejected?.includes("style_em_dash")));

  // Partial override: the other flag still blocks, and both stay overridable.
  const text = "a — b, let's delve";
  const partial = await t.call({ message: text, override_checks: ["style_em_dash"] });
  assert.match(partial, /- style_llm_vocabulary:/);
  assert.doesNotMatch(partial, /- style_em_dash:/);
  assert.match(partial, /accepted: \["style_em_dash","style_llm_vocabulary"\]/);

  assert.equal(await t.call({ message: text, override_checks: ["style_em_dash", "style_llm_vocabulary"] }), "sent");
  assert.deepEqual(t.sent, [{ message: text }], `${OVERRIDE_CHECKS_ARG} is stripped before the tool runs`);
  const rows = await t.consequences();
  assert.deepEqual([...new Set(rows.filter(([id]) => id === "call-3").map(([, c]) => c))], ["overridden"]);
  const overridden = t.lines.find(([e]) => e === "check_revise_overridden")![1];
  assert.deepEqual(overridden.codes, ["style_em_dash", "style_llm_vocabulary"]);

  // After a delivered message the earlier rejection no longer counts.
  const stale = await t.call({ message: DASH, override_checks: ["style_em_dash"] });
  assert.match(stale, /^Blocked/);
  t.storage.close();
});

test("refusal + style in one evaluation: the refusal wins and can never be overridden", async () => {
  const checks = {
    ...STYLE,
    op_refusal: { kind: "refusal", reason: "safety", patterns: ["(?i)\\bwon't help\\b"] },
  };
  const t = await setup({ checks, refusalActs: true });
  const text = "I won't help — sorry.";
  assert.equal(await t.call({ message: text }), "redo requested");
  assert.deepEqual(t.redo, ["op_refusal"]);
  assert.deepEqual(t.revise.state(), { consecutive: 0, sessionTotal: 0, lastRejected: [] }, "revise never counted it");
  const rows = await t.consequences();
  assert.deepEqual([...new Set(rows.map(([, c]) => c))], ["redo"]);

  // After a style rejection, naming the refusal code in override_checks changes nothing.
  assert.match(await t.call({ message: DASH }), /^Blocked/);
  assert.equal(await t.call({ message: text, override_checks: ["op_refusal", "style_em_dash"] }), "redo requested");
  assert.equal(t.sent.length, 0);
  t.storage.close();
});

test("no_reply_contradiction: a hit blocks no_reply with the spec's error; the override ends the turn", async () => {
  const t = await setup({
    judged: true,
    checks: { no_reply_contradiction: { enabled: true } },
    answer: (id) => ({ noul: id.startsWith("no_reply_contradiction__analysis") ? 0.95 : 0.1 }),
  });
  const first = await t.noReply({ analysis: "I should answer Alice's question." });
  assert.equal(first.result, undefined);
  assert.equal(
    first.error,
    [
      "Blocked: no_reply did not end your turn. Output checks flagged it:",
      "- no_reply_contradiction: Your reasoning concluded you should reply, or you wrote a reply without sending it. Send it with send_message.",
      'If not replying is intended, call no_reply again with override_checks: ["no_reply_contradiction"].',
    ].join("\n"),
  );
  const second = await t.noReply({ analysis: "I should answer Alice's question.", override_checks: ["no_reply_contradiction"] });
  assert.equal(second.error, undefined);
  assert.equal(second.result.terminate, true, "the accepted no_reply ends the turn");
  const rows = await t.consequences();
  assert.deepEqual(rows, [[first.id, "revise"], [second.id, "overridden"]]);
  assert.deepEqual(t.revise.state().lastRejected, [], "an accepted no_reply restarts the per-message state");
  t.storage.close();
});

test("schema: override_checks appears only where a revisable check can fire, survives prefill and dynamic loading", async () => {
  const props = (tool: any) => Object.keys(tool.parameters.properties ?? {});
  const realSend = createSendMessageTool({} as never);

  // No revisable check enabled: definitions untouched (the same schema object).
  const none = await setup({ checks: {} });
  const [send0, noReply0] = wrapToolsWithOutputGate([realSend, createNoReplyTool()], none.gate);
  assert.equal(send0!.parameters, realSend.parameters);
  assert.ok(!props(noReply0).includes(OVERRIDE_CHECKS_ARG));

  // A send-checkpoint style check: the posting tool gains it, no_reply does not.
  const style = await setup();
  const [send1, noReply1] = wrapToolsWithOutputGate([realSend, createNoReplyTool()], style.gate);
  assert.ok(props(send1).includes(OVERRIDE_CHECKS_ARG));
  assert.deepEqual((send1!.parameters as any).required, (realSend.parameters as any).required, "optional");
  assert.ok(!props(noReply1).includes(OVERRIDE_CHECKS_ARG));

  // no_reply_contradiction is judged only: without judged checks it cannot fire, so no argument.
  const unjudged = await setup({ checks: { no_reply_contradiction: { enabled: true } } });
  assert.ok(!props(wrapToolsWithOutputGate([createNoReplyTool()], unjudged.gate)[0]).includes(OVERRIDE_CHECKS_ARG));
  const judged = await setup({ judged: true, checks: { no_reply_contradiction: { enabled: true } } });
  const [noReply2] = wrapToolsWithOutputGate([createNoReplyTool()], judged.gate);
  assert.ok(props(noReply2).includes(OVERRIDE_CHECKS_ARG));

  // Prefill: the analysis stripping inside, the gate outside (the factory's order).
  const [prefilled] = wrapToolsWithOutputGate([wrapToolWithAnalysisStripping(realSend)], style.gate);
  assert.ok(props(prefilled).includes("analysis") && props(prefilled).includes(OVERRIDE_CHECKS_ARG));
  const wire = applyPrefillToParams(
    { tools: [{ type: "function", name: "send_message", parameters: prefilled!.parameters }] },
    "Plan:",
  ) as any;
  const wireParams = wire.tools[0].parameters;
  assert.deepEqual(wireParams.properties[OVERRIDE_CHECKS_ARG].type, ["array", "null"], "strict mode: nullable");
  assert.ok(wireParams.required.includes(OVERRIDE_CHECKS_ARG));
  assert.equal(Object.keys(wireParams.properties)[0], "analysis");
  // pi's validation drops the strict-mode null and keeps a real list.
  const base = { analysis: "Plan: reply", message: "hi", is_reply: false, final: true };
  const withNull = validateToolArguments(prefilled as any, { type: "toolCall", id: "c", name: "send_message", arguments: { ...base, [OVERRIDE_CHECKS_ARG]: null } } as any);
  assert.ok(!(OVERRIDE_CHECKS_ARG in withNull));
  const withList = validateToolArguments(prefilled as any, { type: "toolCall", id: "c", name: "send_message", arguments: { ...base, [OVERRIDE_CHECKS_ARG]: ["style_em_dash"] } } as any);
  assert.deepEqual(withList[OVERRIDE_CHECKS_ARG], ["style_em_dash"]);

  // Dynamic tool loading: a deferred posting tool carries the argument once loaded.
  const registry = new DynamicToolRegistry([send1!, noReply1!], ["no_reply"]);
  assert.ok(!registry.current.some((t) => t.name === "send_message"));
  registry.load(["send_message"]);
  assert.ok(props(registry.current.find((t) => t.name === "send_message")).includes(OVERRIDE_CHECKS_ARG));
  for (const t of [none, style, unjudged, judged]) t.storage.close();
});

test("the part alone: one decision per call, text endings never held, unheld calls never blocked", () => {
  const knobs = { reviseMaxConsecutive: 1, reviseMaxPerSession: 6 };
  const part: RevisePart = createRevisePolicyPart({
    evaluator: {
      knobs: () => knobs as any,
      catalogue: { get: () => ({ agentExplanation: "Fix {matched}." }) } as any,
    },
  });
  const scope = { agent: null, site: "default", sessionId: "s", sessionType: "default", timelineKey: null };
  const info = (id?: string): GateCallInfo => ({ checkpoint: "send", action: "send_message", scope, ...(id ? { toolCallId: id } : {}) });
  const revisable: any = [{ code: "style_x", kind: "style", remedy: "revise" }];
  const verdict: GateVerdict = {
    evaluationIds: [],
    fired: [{ code: "style_x", kind: "style", remedy: "revise", method: "pattern", matched: "y" }],
    revise: [{ code: "style_x", kind: "style", remedy: "revise", method: "pattern", matched: "y" }],
    unjudged: false,
    latencyMs: 0,
  };

  assert.equal(part.shouldHold(info(), revisable), false, "a NO_REPLY text ending has no tool call to reject");
  assert.deepEqual(part.decide(info(), verdict), { kind: "pass" });
  assert.equal(part.shouldHold(info("a"), []), false, "no revise check took part");

  assert.equal(part.shouldHold(info("a"), revisable), true);
  const once = part.decide(info("a"), verdict);
  assert.equal(once.kind, "block");
  assert.match((once as any).message, /- style_x: Fix y\./);
  assert.deepEqual(part.decide(info("a"), verdict), once, "consequence() and act() see the same decision");
  assert.equal(part.state().sessionTotal, 1, "counted once");

  // The consecutive bound (1) is reached: not held, and never blocked later.
  assert.equal(part.shouldHold(info("b"), revisable), false);
  assert.deepEqual(part.decide(info("b"), verdict), { kind: "pass", consequence: "sent" });
  part.onDelivered();
  assert.equal(part.shouldHold(info("c"), revisable), true);
});

test("readOverrideChecks tolerates the naive forms; withoutOverrideArgument strips only it", () => {
  assert.deepEqual(readOverrideChecks({ override_checks: ["a", " b ", "a", 3] }), ["a", "b"]);
  assert.deepEqual(readOverrideChecks({ override_checks: "a, `b` \"c\"" }), ["a", "b", "c"]);
  assert.deepEqual(readOverrideChecks({ override_checks: null }), []);
  assert.deepEqual(readOverrideChecks(undefined), []);
  assert.deepEqual(withoutOverrideArgument({ message: "x", override_checks: ["a"] }), { message: "x" });
  const untouched = { message: "x" };
  assert.equal(withoutOverrideArgument(untouched), untouched);
});
