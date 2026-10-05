import assert from "node:assert/strict";
import test from "node:test";

import {
  assignItemIds,
  checksPoint,
  memberMisfit,
  planCheckCalls,
  requestShapeOf,
  type CheckItem,
  type ChecksCallInput,
} from "../src/decisions/index.js";
import type { CheckQuestion } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// The checks decision point (spec REFUSAL-HANDLING §6.2): question building per
// member shape, per-question thresholds, and the fits-driven call plan.
// ---------------------------------------------------------------------------

const settings: any = {
  point: "checks",
  model: "decider",
  timeoutMs: 3000,
  stateMaxTokens: 8000,
  minStateTokens: 1000,
  minConfidence: 0.6,
  calibration: {},
  persona: "",
};

function q(source: CheckQuestion["source"], threshold = 0.8, extra: Partial<CheckQuestion> = {}): CheckQuestion {
  return {
    source,
    instructions: `\`${source}\` declines what \`request\` asks{persona}.`,
    criteria: { true: `\`${source}\` declines`, false: `\`${source}\` helps` },
    threshold,
    ...extra,
  };
}

function items(spec: Array<[string, "refusal" | "style" | "contract", CheckQuestion]>): CheckItem[] {
  return assignItemIds(spec.map(([code, kind, question]) => ({ code, kind, source: question.source, question })));
}

function input(list: CheckItem[], over: Partial<ChecksCallInput> = {}): ChecksCallInput {
  return {
    items: list,
    shape: "object",
    scope: "full",
    context: { checkpoint: "send", action: "send_message", request: [{ from: "Alice", text: "please" }] },
    sources: { message: "no.", analysis: "decline" },
    thinkingTailTokens: 800,
    ...over,
  };
}

const kinds = (list: CheckItem[]) => new Map(list.map((i) => [i.code, { kind: i.kind }]));

function member(decision: Record<string, unknown> | undefined): any {
  return { logicalId: "decider", config: { id: "x", api: "system-one", context_window: 32000, decision } };
}

test("item ids: <code>__<source>, suffixed when repeated", () => {
  const list = items([
    ["refusal_safety", "refusal", q("message")],
    ["refusal_safety", "refusal", q("message")],
    ["refusal_safety", "refusal", q("text")],
  ]);
  assert.deepEqual(list.map((i) => i.id), ["refusal_safety__message", "refusal_safety__message_2", "refusal_safety__text"]);
});

test("questions: noul with criteria, choice with options; persona filled or dropped", () => {
  const list = items([
    ["refusal_persona", "refusal", q("message")],
    [
      "no_reply_intent",
      "contract",
      q("text", 0.6, { type: "choice", options: { a: "first", b: "second" }, fireOption: "b", instructions: "why?" }),
    ],
  ]);
  const plain = checksPoint.questions(input(list), settings);
  assert.equal(plain["refusal_persona__message"]!.type, "noul");
  assert.equal((plain["refusal_persona__message"] as any).instructions, "`message` declines what `request` asks.");
  assert.deepEqual(plain["no_reply_intent__text"], { type: "choice", instructions: "why?", criteria: { a: "first", b: "second" } });

  const withPersona = checksPoint.questions(input(list), { ...settings, persona: "A cheerful   idol." });
  assert.match((withPersona["refusal_persona__message"] as any).instructions, /\(the persona: A cheerful idol\.\)/);
});

test("questions: the judge shape rewrites field paths into plain strings", () => {
  const list = items([["refusal_safety", "refusal", q("message")]]);
  const out = checksPoint.questions(input(list, { shape: "conversation" }), settings) as any;
  assert.equal(out["refusal_safety__message"].instructions, "the assistant's output declines what the user's input asks.");
  assert.ok(!JSON.stringify(out).includes("`"));
});

test("resolve: each question against its own threshold; calibrated per check code", () => {
  const list = items([
    ["refusal_safety", "refusal", q("message", 0.8)],
    ["refusal_safety", "refusal", q("thinking", 0.9)],
    ["refusal_privacy", "refusal", q("message", 0.8)],
  ]);
  const answers: any = {
    refusal_safety__message: { type: "noul", noul: 0.75 },
    refusal_safety__thinking: { type: "noul", noul: 0.85 },
    refusal_privacy__message: { type: "noul", noul: 0.82 },
  };
  const plain = checksPoint.resolve(answers, input(list), (_n, v) => v, settings)!;
  assert.deepEqual(plain.results.map((r) => [r.id, r.fired]), [
    ["refusal_safety__message", false],
    ["refusal_safety__thinking", false],
    ["refusal_privacy__message", true],
  ]);
  // A calibration override names the check: it replaces that check's thresholds.
  const calibrated = checksPoint.resolve(answers, input(list), (name, v) => (name === "refusal_safety" ? 0.7 : v), settings)!;
  assert.deepEqual(calibrated.results.filter((r) => r.fired).map((r) => r.id).sort(), [
    "refusal_privacy__message",
    "refusal_safety__message",
    "refusal_safety__thinking",
  ]);
});

test("resolve: a choice fires on its fire option at the confidence threshold", () => {
  const list = items([
    ["no_reply_intent", "contract", q("text", 0.6, { type: "choice", options: { keep: "k", gave_up: "g" }, fireOption: "gave_up" })],
  ]);
  const fired = checksPoint.resolve(
    { no_reply_intent__text: { type: "choice", choice: "gave_up", confidence: 0.7, probabilities: { gave_up: 0.8, keep: 0.2 } } } as any,
    input(list),
    (_n, v) => v,
    settings,
  )!;
  assert.deepEqual(fired.results[0], { id: "no_reply_intent__text", code: "no_reply_intent", source: "text", probability: 0.8, threshold: 0.6, fired: true, choice: "gave_up" });
  const unsure = checksPoint.resolve(
    { no_reply_intent__text: { type: "choice", choice: "gave_up", confidence: 0.4, probabilities: {} } } as any,
    input(list),
    (_n, v) => v,
    settings,
  )!;
  assert.equal(unsure.results[0]!.fired, false);
});

test("plan: one call by default (no fits declared, or everything fits)", () => {
  const list = items([
    ["refusal_safety", "refusal", q("message")],
    ["style_x", "style", q("message")],
    ["refusal_safety", "refusal", q("analysis")],
  ]);
  assert.equal(planCheckCalls(list, undefined, "send", {}, kinds(list)).length, 1);
  assert.equal(planCheckCalls(list, member(undefined), "send", {}, kinds(list)).length, 1);
  const one = planCheckCalls(list, member({ max_questions: 3 }), "send", {}, kinds(list));
  assert.equal(one.length, 1);
  assert.equal(one[0]!.scope, "full");
});

test("plan: split by state shape and chunked to max_questions when the member requires it", () => {
  const list = items([
    ["style_a", "style", q("message")],
    ["style_b", "style", q("message")],
    ["refusal_safety", "refusal", q("message")],
    ["refusal_safety", "refusal", q("analysis")],
    ["refusal_privacy", "refusal", q("message")],
  ]);
  const calls = planCheckCalls(list, member({ max_questions: 2 }), "send", {}, kinds(list));
  assert.deepEqual(
    calls.map((c) => [c.scope, c.items.map((i) => i.id)]),
    [
      ["message_only", ["style_a__message", "style_b__message"]],
      ["full", ["refusal_safety__message", "refusal_safety__analysis"]],
      ["full", ["refusal_privacy__message"]],
    ],
  );
});

test("plan: per-question billing puts style questions on the message alone", () => {
  const list = items([
    ["style_a", "style", q("message")],
    ["refusal_safety", "refusal", q("message")],
  ]);
  const calls = planCheckCalls(list, member({ billing: "per_question" }), "send", {}, kinds(list));
  assert.deepEqual(calls.map((c) => c.scope), ["message_only", "full"]);
});

test("plan: a question type the member does not answer gets its own call", () => {
  const list = items([
    ["refusal_safety", "refusal", q("text")],
    ["no_reply_intent", "contract", q("text", 0.6, { type: "choice", options: { a: "a", b: "b" }, fireOption: "b" })],
  ]);
  const calls = planCheckCalls(list, member({ question_types: ["noul"] }), "ending", {}, kinds(list));
  assert.deepEqual(calls.map((c) => c.items.map((i) => i.code)), [["refusal_safety"], ["no_reply_intent"]]);
});

test("plan: a judge-only member gets { input, output } for its output sources; the rest go elsewhere", () => {
  const list = items([
    ["refusal_safety", "refusal", q("analysis")],
    ["refusal_safety", "refusal", q("text")],
    ["refusal_safety", "refusal", q("thinking")],
  ]);
  const calls = planCheckCalls(
    list,
    member({ state_shapes: "text_or_conversation" }),
    "ending",
    { analysis: "skip it", text: "I'd rather not." },
    kinds(list),
  );
  assert.deepEqual(calls.map((c) => [c.shape, c.items.map((i) => i.source)]), [
    ["conversation", ["analysis", "text"]],
    ["object", ["thinking"]],
  ]);
  assert.equal(calls[0]!.judgeOutput, "skip it\n\nI'd rather not.");
  const state = checksPoint.state(input(calls[0]!.items, { shape: "conversation", judgeOutput: calls[0]!.judgeOutput }), 2000) as any;
  assert.deepEqual(Object.keys(state), ["input", "output"]);
  assert.equal(checksPoint.stateShape!(input([], { shape: "conversation" })), "conversation");
});

test("fits: a judge-only member takes a conversation of noul questions, never an object state", () => {
  const judge: any = { id: "j", api: "system-one", decision: { state_shapes: "text_or_conversation" } };
  const noul = requestShapeOf({ a: { type: "noul", instructions: "x" } });
  const choice = requestShapeOf({ a: { type: "choice", instructions: "x", criteria: { y: "y", n: "n" } } });
  assert.equal(memberMisfit(judge, noul, 4000, 1000), "state_shape");
  assert.equal(memberMisfit(judge, noul, 4000, 1000, "conversation"), undefined);
  assert.equal(memberMisfit(judge, choice, 4000, 1000, "conversation"), "question_type:choice");
});
