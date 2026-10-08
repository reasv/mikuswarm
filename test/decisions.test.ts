import assert from "node:assert/strict";
import test from "node:test";

import { LlmScheduler } from "../src/agent/scheduler.js";
import { runFetchWithFallback, resolveModelChain } from "../src/agent/model-fallback.js";
import {
  DecisionClient,
  DecisionEngine,
  NoFittingMemberError,
  applyDecisionRateLimitGroups,
  attemptSlot,
  calibratedThreshold,
  decisionsFor,
  memberMisfit,
  packNewest,
  parseAnswers,
  pointSettings,
  requestShapeOf,
  unwrapEnvelope,
  validateDecisionsConfig,
  type DecisionPoint,
  type DecisionQuestion,
} from "../src/decisions/index.js";
import type { UsageEventInput } from "../src/storage/database.js";

// ---------------------------------------------------------------------------
// Decision-model foundation (ARCHITECTURE.md §8h): client over the fallback
// chain, fits, state clamping, envelope, usage/cost, config, engine fallback.
// ---------------------------------------------------------------------------

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

function chatModel(over: Record<string, unknown> = {}): any {
  return {
    id: "chat-1",
    provider: "anthropic",
    endpoint: "https://chat.example",
    api_key: "k",
    input_modalities: ["text", "image"],
    max_tokens: 1000,
    context_window: 100000,
    ...over,
  };
}

const QUESTIONS: Record<string, DecisionQuestion> = {
  task: { type: "choice", instructions: "Which task?", criteria: { coding: "code", other: "anything else" } },
  open: { type: "noul", instructions: "Still going?" },
};

function okBody(over: Record<string, unknown> = {}) {
  return {
    model: "vendor/decider-1-20261001",
    answers: {
      task: { choice: "coding", probabilities: { coding: 0.9, other: 0.1 }, confidence: 0.88 },
      open: { noul: 0.7 },
    },
    usage: { input_tokens: 300, output_tokens: 5, cost: 0.0000126 },
    ...over,
  };
}

interface FakeCall {
  url: string;
  body: any;
}

/** A scripted fetch: one handler per call, in order (the last repeats). */
function fakeFetch(handlers: Array<(call: FakeCall, signal?: AbortSignal) => Promise<Response> | Response>) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)) };
    calls.push(call);
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i += 1;
    return handler(call, init.signal ?? undefined);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function request(over: Partial<Parameters<DecisionClient["decide"]>[1]> = {}) {
  return {
    questions: QUESTIONS,
    state: () => ({ recent: [{ from: "a", text: "hello" }] }),
    stateMaxTokens: 8000,
    minStateTokens: 10,
    ...over,
  };
}

const callOpts = { consumer: "decision:test", priority: "interactive" as const, timeoutMs: 2000 };

// --- wire parsing ------------------------------------------------------------

test("parseAnswers: typed answers; a missing or malformed answer fails the whole map", () => {
  const ok = parseAnswers(okBody().answers, QUESTIONS);
  assert.equal(ok?.task?.type, "choice");
  assert.equal((ok?.task as any).choice, "coding");
  assert.equal((ok?.open as any).noul, 0.7);
  assert.equal(parseAnswers({ task: okBody().answers.task }, QUESTIONS), undefined, "missing answer");
  assert.equal(
    parseAnswers({ ...okBody().answers, task: { choice: "nope", confidence: 0.9 } }, QUESTIONS),
    undefined,
    "unknown option",
  );
  assert.equal(parseAnswers({ ...okBody().answers, open: { noul: 1.4 } }, QUESTIONS), undefined, "not a probability");
  const score: Record<string, DecisionQuestion> = { d: { type: "score", instructions: "x", criteria: ["a", "b", "c"] } };
  assert.equal((parseAnswers({ d: { score: "2", confidence: 0.5 } }, score)?.d as any).score, 2);
  assert.equal(parseAnswers({ d: { score: 3, confidence: 0.5 } }, score), undefined, "score out of range");
});

test("unwrapEnvelope accepts the bare body and Cloudflare's { result } envelope", () => {
  assert.deepEqual(unwrapEnvelope({ answers: {}, model: "m" }), { answers: {}, model: "m" });
  assert.deepEqual(unwrapEnvelope({ result: { answers: { a: 1 } }, success: true }), { answers: { a: 1 } });
});

// --- client ------------------------------------------------------------------

test("client: success records served version, provider cost, and sends the provider routing object", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const models = {
    decider: decider({ compat: { openrouter_routing: { zdr: true } } }),
  };
  const billed: any[] = [];
  const client = new DecisionClient({ models, fetchImpl: fn });
  const result = await client.decide("decider", request(), { ...callOpts, onBilled: (b) => billed.push(b) });
  assert.equal(result.logicalId, "decider");
  assert.equal(result.servedVersion, "vendor/decider-1-20261001");
  assert.equal(result.costUsd, 0.0000126, "usage.cost wins over the cost block");
  assert.equal(calls[0]!.url, "https://gw.example/decisions");
  assert.deepEqual(calls[0]!.body.provider, { zdr: true });
  assert.equal(calls[0]!.body.model, "vendor/decider-1");
  assert.equal(billed.length, 1);
  assert.equal(billed[0].providerCost, true);
});

test("client: without usage.cost the member's cost block prices input tokens", async () => {
  const body = okBody({ usage: { input_tokens: 1_000_000, output_tokens: 3 } });
  const { fn } = fakeFetch([() => json(200, body)]);
  const client = new DecisionClient({ models: { decider: decider() }, fetchImpl: fn });
  const result = await client.decide("decider", request(), callOpts);
  assert.ok(Math.abs(result.costUsd - 0.04) < 1e-12);
});

test("client: Cloudflare-style envelope is unwrapped", async () => {
  const { fn } = fakeFetch([() => json(200, { result: okBody(), success: true })]);
  const client = new DecisionClient({ models: { decider: decider() }, fetchImpl: fn });
  const result = await client.decide("decider", request(), callOpts);
  assert.equal((result.answers.task as any).choice, "coding");
});

for (const status of [429, 503, 529]) {
  test(`client: ${status} falls over to the next member and feeds the scheduler`, async () => {
    const { fn, calls } = fakeFetch([() => json(status, { error: "busy" }, { "retry-after": "1" }), () => json(200, okBody())]);
    const scheduler = new LlmScheduler({ groups: { "decision:a": {}, "decision:b": {} } } as any);
    const models: any = {
      a: decider({ id: "vendor/a", fallback: ["b"], rate_limit_group: "decision:a" }),
      b: decider({ id: "vendor/b", rate_limit_group: "decision:b" }),
    };
    const client = new DecisionClient({ models, fetchImpl: fn, scheduler });
    const result = await client.decide("a", request(), callOpts);
    assert.equal(result.logicalId, "b");
    assert.deepEqual(calls.map((c) => c.body.model), ["vendor/a", "vendor/b"]);
    scheduler.stop?.();
  });
}

function hang(_c: FakeCall, signal?: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
}

test("client: a stalled head times out within its slot, is struck, and falls over", async () => {
  const { fn, calls } = fakeFetch([hang, () => json(200, okBody())]);
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } } as any);
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const client = new DecisionClient({ models, fetchImpl: fn, scheduler });
  const started = Date.now();
  // A wide deadline so the fallback's third (500 ms) survives a loaded host; the head's slot is 1000 ms.
  const result = await client.decide("a", request(), { ...callOpts, timeoutMs: 1500 });
  assert.equal(result.logicalId, "b");
  assert.deepEqual(calls.map((c) => c.body.model), ["vendor/a", "vendor/b"]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 950 && elapsed < 1500, "the head got two thirds of the deadline, not all of it");
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::vendor/a"), "unhealthy", "a full-slot stall is a strike");
  scheduler.stop?.();
});

test("client: attempt_timeout_ms caps a member's slot while a later member remains", async () => {
  const { fn, calls } = fakeFetch([hang, () => json(200, okBody())]);
  const models: any = {
    a: decider({ id: "vendor/a", fallback: ["b"], decision: { attempt_timeout_ms: 100 } }),
    b: decider({ id: "vendor/b" }),
  };
  const client = new DecisionClient({ models, fetchImpl: fn });
  const started = Date.now();
  assert.equal((await client.decide("a", request(), { ...callOpts, timeoutMs: 2000 })).logicalId, "b");
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 2);
});

test("client: a single member gets the whole deadline and a stall there is a strike", async () => {
  const { fn, calls } = fakeFetch([hang]);
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } } as any);
  const models: any = { a: decider({ id: "vendor/a" }) };
  const client = new DecisionClient({ models, fetchImpl: fn, scheduler });
  const started = Date.now();
  await assert.rejects(() => client.decide("a", request(), { ...callOpts, timeoutMs: 150 }));
  assert.ok(Date.now() - started >= 140, "not cut to two thirds: nothing after it");
  assert.equal(calls.length, 1);
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::vendor/a"), "unhealthy");
  scheduler.stop?.();
});

test("client: a fallback member whose slot the deadline cut short is not struck", async () => {
  const { fn, calls } = fakeFetch([hang, hang]);
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } } as any);
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const client = new DecisionClient({ models, fetchImpl: fn, scheduler });
  await assert.rejects(() => client.decide("a", request(), { ...callOpts, timeoutMs: 300 }), /AbortError|aborted/);
  assert.equal(calls.length, 2);
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::vendor/a"), "unhealthy");
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::vendor/b"), "healthy", "a third of the deadline proves nothing");
  scheduler.stop?.();
});

test("attemptSlot: cap only while a later candidate remains", () => {
  const m = (logicalId: string, decision?: any) => ({ logicalId, config: { decision } }) as any;
  assert.deepEqual(attemptSlot(m("a"), ["a", "b"], 3000, 3000), { ms: 2000, full: true });
  assert.deepEqual(attemptSlot(m("a", { attempt_timeout_ms: 500 }), ["a", "b"], 3000, 3000), { ms: 500, full: true });
  assert.deepEqual(attemptSlot(m("b"), ["a", "b"], 1000, 3000), { ms: 1000, full: false });
  assert.deepEqual(attemptSlot(m("a"), ["a"], 3000, 3000), { ms: 3000, full: true });
  assert.deepEqual(attemptSlot(m("a"), ["a", "b"], 1500, 3000), { ms: 1500, full: false }, "less than the cap left: no room to fall over anyway");
});

test("client: a malformed answer is billed and falls over", async () => {
  const bad = okBody({ answers: { task: { choice: "coding", confidence: 0.9 } } });
  const { fn } = fakeFetch([() => json(200, bad), () => json(200, okBody())]);
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const billed: string[] = [];
  const client = new DecisionClient({ models, fetchImpl: fn });
  const result = await client.decide("a", request(), { ...callOpts, onBilled: (b) => billed.push(b.logicalId) });
  assert.equal(result.logicalId, "b");
  assert.deepEqual(billed, ["a", "b"], "the discarded 2xx is still billed");
});

test("client: unparsable body is environmental", async () => {
  const { fn } = fakeFetch([() => json(200, "<html>oops"), () => json(200, okBody())]);
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const client = new DecisionClient({ models, fetchImpl: fn });
  assert.equal((await client.decide("a", request(), callOpts)).logicalId, "b");
});

test("client: 400 is a content failure and does not fall over", async () => {
  const { fn, calls } = fakeFetch([() => json(400, { error: "max_tokens_exceeded" })]);
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const client = new DecisionClient({ models, fetchImpl: fn });
  await assert.rejects(() => client.decide("a", request(), callOpts), /HTTP 400/);
  assert.equal(calls.length, 1);
});

test("client: data-policy 404 is a member configuration error — no strike, logged once, falls over", async () => {
  const policy = () => json(404, { error: { message: "No endpoints found matching your data policy (Zero data retention)" } });
  const { fn, calls } = fakeFetch([policy, () => json(200, okBody()), policy, () => json(200, okBody())]);
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } } as any);
  const errors: any[] = [];
  const logger: any = { error: (e: string, f: any) => errors.push([e, f]), info() {}, warn() {}, debug() {}, child() { return logger; } };
  const models: any = { a: decider({ id: "vendor/a", fallback: ["b"] }), b: decider({ id: "vendor/b" }) };
  const client = new DecisionClient({ models, fetchImpl: fn, scheduler, logger });
  assert.equal((await client.decide("a", request(), callOpts)).logicalId, "b");
  assert.equal((await client.decide("a", request(), callOpts)).logicalId, "b");
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::vendor/a"), "healthy", "not a health strike");
  assert.equal(errors.length, 1, "logged once per member");
  assert.equal(errors[0][1].dataPolicy, true);
  assert.equal(calls.length, 4);
});

// --- fits, clamp, skip -------------------------------------------------------

test("memberMisfit: question types, counts, options, levels, shapes, state budget", () => {
  const shape = requestShapeOf({
    ...QUESTIONS,
    lvl: { type: "score", instructions: "x", criteria: ["a", "b", "c", "d"] },
  });
  assert.equal(memberMisfit(decider(), shape, 5000, 1000), undefined);
  assert.equal(memberMisfit(decider({ decision: { question_types: ["noul"] } }), shape, 5000, 1000), "question_type:choice");
  assert.equal(memberMisfit(decider({ decision: { max_questions: 2 } }), shape, 5000, 1000), "max_questions");
  assert.equal(memberMisfit(decider({ decision: { max_choice_options: 1 + 0 } }), shape, 5000, 1000) , "max_choice_options");
  assert.equal(memberMisfit(decider({ decision: { max_score_levels: 3 } }), shape, 5000, 1000), "max_score_levels");
  assert.equal(memberMisfit(decider({ decision: { state_shapes: "text_or_conversation" } }), shape, 5000, 1000), "state_shape");
  assert.equal(memberMisfit(decider(), shape, 900, 1000), "state_budget");
});

test("client: a member that does not fit is skipped (never sent), the head included", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const models: any = {
    a: decider({ id: "vendor/a", fallback: ["b"], decision: { max_choice_options: 1 } }),
    b: decider({ id: "vendor/b" }),
  };
  const client = new DecisionClient({ models, fetchImpl: fn });
  assert.equal((await client.decide("a", request(), callOpts)).logicalId, "b");
  assert.deepEqual(calls.map((c) => c.body.model), ["vendor/b"]);
});

test("client: no fitting member → NoFittingMemberError without a request", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const models: any = { a: decider({ decision: { question_types: ["noul"] } }) };
  const client = new DecisionClient({ models, fetchImpl: fn });
  await assert.rejects(() => client.decide("a", request(), callOpts), NoFittingMemberError);
  assert.equal(calls.length, 0);
});

test("client: state is clamped per member to its own state budget; a below-minimum budget is skipped", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const models: any = {
    tiny: decider({ id: "vendor/tiny", fallback: ["small", "big"], decision: { state_budget_tokens: 200 } }),
    small: decider({ id: "vendor/small", decision: { state_budget_tokens: 2000 } }),
    big: decider({ id: "vendor/big" }),
  };
  const budgets: number[] = [];
  const items = Array.from({ length: 400 }, (_, i) => ({ from: `u${i}`, text: `message number ${i} with some words` }));
  const client = new DecisionClient({ models, fetchImpl: fn });
  const result = await client.decide(
    "tiny",
    request({
      minStateTokens: 500,
      state: (budget) => {
        budgets.push(budget);
        return { recent: packNewest(items, budget, (kept) => ({ recent: kept })) };
      },
    }),
    callOpts,
  );
  assert.equal(result.logicalId, "small", "tiny's 200-token budget is below the 500 minimum");
  assert.ok(result.stateTokens <= 2000, `state ${result.stateTokens} fits the member budget`);
  assert.ok(calls[0]!.body.state.recent.length < 400, "oldest messages dropped");
  assert.equal(calls[0]!.body.state.recent.at(-1).from, "u399", "newest kept");
  assert.ok(budgets.every((b) => b < 2000));
});

test("runFetchWithFallback: a skip outcome is neutral and falls over", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } } as any);
  const chain = resolveModelChain("a", { a: decider({ id: "x", fallback: ["b"] }), b: decider({ id: "y" }) } as any);
  const tried: string[] = [];
  const value = await runFetchWithFallback<string>(chain, { consumer: "t", priority: "background", scheduler }, async (m) => {
    tried.push(m.logicalId);
    if (m.logicalId === "a") return { ok: false, kind: "skip", status: 404, error: new Error("policy") };
    return { ok: true, value: "b" };
  });
  assert.equal(value, "b");
  assert.deepEqual(tried, ["a", "b"]);
  assert.equal(scheduler.modelHealth("https://gw.example/decisions::x"), "healthy");
});

// --- config ------------------------------------------------------------------

function baseConfig(over: Record<string, unknown> = {}): any {
  return {
    models: {
      default: chatModel(),
      big: chatModel({ id: "chat-big" }),
      decider: decider({ fallback: ["decider_alt"] }),
      decider_alt: decider({ id: "vendor/alt" }),
    },
    agent: { session_types: {} },
    ...over,
  };
}

test("applyDecisionRateLimitGroups: every system-one model without a group gets decision:<key>", () => {
  const config = baseConfig();
  config.models.decider_alt.rate_limit_group = "shared";
  const created = applyDecisionRateLimitGroups(config);
  assert.equal(config.models.decider.rate_limit_group, "decision:decider");
  assert.equal(config.models.decider_alt.rate_limit_group, "shared", "explicit group kept");
  assert.equal(config.models.default.rate_limit_group, undefined, "chat models untouched");
  assert.deepEqual(created, ["decision:decider"]);
  assert.ok(config.rate_limits.llm["decision:decider"]);
});

test("validateDecisionsConfig: system-one refused anywhere pi-ai would use it", () => {
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ agent: { session_types: { default: { model: "decider" } } } })),
    /agent\.session_types\.default\.model = "decider" names a system-one/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ user_limits: [{ models: ["big", "decider"] }] })),
    /user_limits\[0\]\.models\[1\]/,
  );
  const cfg = baseConfig();
  cfg.models.default.fallback = ["decider"];
  assert.throws(() => validateDecisionsConfig(cfg), /cannot serve a chat model/);
  const cfg2 = baseConfig();
  cfg2.models.decider.fallback = ["big"];
  assert.throws(() => validateDecisionsConfig(cfg2), /may only contain system-one/);
  const cfg3 = baseConfig();
  cfg3.models.big.decision = { billing: "per_question" };
  assert.throws(() => validateDecisionsConfig(cfg3), /requires api = "system-one"/);
  // [[limits]].models may name a decision model (a budget selector).
  validateDecisionsConfig(baseConfig({ limits: [{ name: "d", models: ["decider"] }] }));
});

test("validateDecisionsConfig: [decisions] model references and routing tasks", () => {
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ decisions: { enabled: true, model: "big" } })),
    /must name a model with api = "system-one"/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ decisions: { enabled: true, routing: { enabled: true } } })),
    /routing is enabled but neither/,
  );
  assert.throws(
    () =>
      validateDecisionsConfig(
        baseConfig({ decisions: { model: "decider", routing: { tasks: { c: { description: "x", models: ["decider"] } } } } }),
      ),
    /routing needs a chat model/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ decisions: { model: "decider", calibration: { big: { min_confidence: 0.8 } } } })),
    /calibration\.big/,
  );
  assert.throws(
    () =>
      validateDecisionsConfig(
        baseConfig({
          decisions: { model: "decider", routing: { difficulty: { levels: ["a", "b"], models: { "2": ["big"] } } } },
        }),
      ),
    /level index/,
  );
  validateDecisionsConfig(
    baseConfig({
      decisions: {
        enabled: true,
        model: "decider",
        calibration: { decider_alt: { min_confidence: 0.8 } },
        routing: { enabled: true, tasks: { coding: { description: "code", model: "big", thinking_level: "high" } } },
      },
    }),
  );
});

test("decisionsFor: agent override deep-merges, routing.tasks replaces wholesale", () => {
  const config = baseConfig({
    decisions: {
      enabled: true,
      model: "decider",
      routing: { enabled: false, min_confidence: 0.7, tasks: { a: { description: "A" }, b: { description: "B" } } },
    },
    agents: {
      miku: { workspace_root: "/w/m", decisions: { routing: { enabled: true, tasks: { c: { description: "C" } } } } },
      chen: { workspace_root: "/w/c" },
    },
  });
  const miku = decisionsFor(config, "miku");
  assert.equal(miku.routing?.enabled, true);
  assert.equal(miku.routing?.min_confidence, 0.7, "global knob inherited");
  assert.deepEqual(Object.keys(miku.routing?.tasks ?? {}), ["c"]);
  assert.equal(pointSettings(miku, "routing")?.minConfidence, 0.7);
  assert.equal(pointSettings(decisionsFor(config, "chen"), "routing"), undefined, "chen stays off");
  assert.equal(pointSettings(decisionsFor(config, null), "routing"), undefined);
});

test("calibratedThreshold: point-scoped override beats bare name beats the point's value", () => {
  const settings: any = {
    point: "routing",
    calibration: { alt: { min_confidence: 0.8, "routing.min_confidence": 0.9 }, other: { min_confidence: 0.5 } },
  };
  assert.equal(calibratedThreshold(settings, "alt", "min_confidence", 0.6), 0.9);
  assert.equal(calibratedThreshold(settings, "other", "min_confidence", 0.6), 0.5);
  assert.equal(calibratedThreshold(settings, "head", "min_confidence", 0.6), 0.6);
});

// --- engine ------------------------------------------------------------------

interface TestInput {
  text: string;
}

const testPoint: DecisionPoint<TestInput, string> = {
  name: "routing",
  questions: () => QUESTIONS,
  state: (input) => ({ request: input.text }),
  resolve: (answers, _input, threshold, settings) => {
    const a = answers.task as any;
    return a.confidence >= threshold("min_confidence", settings.minConfidence) ? a.choice : null;
  },
  fallback: () => "heuristic",
  describe: (v) => v,
};

function engineConfig(over: Record<string, unknown> = {}): any {
  return baseConfig({
    decisions: { enabled: true, model: "decider", routing: { enabled: true, min_confidence: 0.5 } },
    ...over,
  });
}

function makeEngine(config: any, fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const records: UsageEventInput[] = [];
  const logs: Array<[string, any]> = [];
  const logger: any = {
    info: (e: string, f: any) => logs.push([e, f]),
    warn: (e: string, f: any) => logs.push([e, f]),
    error: (e: string, f: any) => logs.push([e, f]),
    debug() {},
    child() {
      return logger;
    },
  };
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: fetchFn, logger }),
    record: (e) => records.push(e),
    logger,
    ...extra,
  });
  return { engine, records, logs };
}

const ctx = {
  agentName: null,
  attribution: { agentSessionId: "s1", sessionType: "default", timelineKey: "matrix:acc:!room", triggerSenderId: "@u:x" },
};

test("engine: model verdict, decision_evaluated log, and a session-attributed ledger row", async () => {
  const { fn } = fakeFetch([() => json(200, okBody())]);
  const { engine, records, logs } = makeEngine(engineConfig(), fn);
  const out = await engine.evaluate(testPoint, { text: "fix my code" }, { ...ctx, heuristicVerdict: "heuristic" });
  assert.equal(out.source, "model");
  assert.equal(out.verdict, "coding");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.class, "decision");
  assert.equal(records[0]!.toolName, "routing");
  assert.equal(records[0]!.agentSessionId, "s1");
  assert.equal(records[0]!.triggerSenderId, "@u:x");
  assert.equal(records[0]!.logicalModelId, "decider");
  assert.equal(records[0]!.modelId, "vendor/decider-1");
  assert.equal(records[0]!.ref, "vendor/decider-1-20261001");
  assert.equal(records[0]!.costUsd, 0.0000126);
  const log = logs.find(([e]) => e === "decision_evaluated")![1];
  assert.equal(log.source, "model");
  assert.equal(log.servedModel, "decider");
  assert.equal(log.servedVersion, "vendor/decider-1-20261001");
  assert.equal(log.heuristicVerdict, "heuristic");
  assert.deepEqual(log.answers, { task: "coding@0.88", open: 0.7 });
  assert.equal(typeof log.latencyMs, "number");
});

test("engine: disabled point returns the fallback without a call or a log", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const config = engineConfig();
  config.decisions.routing.enabled = false;
  const { engine, logs } = makeEngine(config, fn);
  const out = await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.deepEqual([out.verdict, out.reason], ["heuristic", "disabled"]);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 0);
});

test("engine: low confidence falls back but the billed call is still recorded", async () => {
  const body = okBody();
  (body.answers.task as any).confidence = 0.2;
  const { fn } = fakeFetch([() => json(200, body)]);
  const { engine, records, logs } = makeEngine(engineConfig(), fn);
  const out = await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.deepEqual([out.verdict, out.source, out.reason], ["heuristic", "heuristic", "low_confidence"]);
  assert.equal(records.length, 1);
  assert.equal(logs.find(([e]) => e === "decision_evaluated")![1].reason, "low_confidence");
});

test("engine: per-member calibration applies to the member that served", async () => {
  const body = okBody({ model: "vendor/alt-x" });
  (body.answers.task as any).confidence = 0.7;
  const { fn } = fakeFetch([() => json(503, {}), () => json(200, body)]);
  const config = engineConfig();
  config.decisions.calibration = { decider_alt: { "routing.min_confidence": 0.8 } };
  const { engine } = makeEngine(config, fn);
  const out = await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.equal(out.reason, "low_confidence", "0.7 passes the head's 0.5 but not decider_alt's 0.8");
});

test("engine: budget blocked → fallback without a call", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const seen: any[] = [];
  const { engine } = makeEngine(engineConfig(), fn, {
    budget: () => ({ check: (d: any) => (seen.push(d), { allowed: false }) }),
  });
  const out = await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.equal(out.reason, "budget");
  assert.equal(calls.length, 0);
  assert.equal(seen[0].class, "decision");
  assert.equal(seen[0].tool, "routing");
});

test("engine: a blocked head is skipped, an in-budget fallback serves", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const { engine } = makeEngine(engineConfig(), fn, {
    budget: () => ({ check: (d: any) => ({ allowed: d.logicalModelId !== "decider" }) }),
  });
  const out = await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.equal(out.servedModel, "decider_alt");
  assert.equal(calls[0]!.body.model, "vendor/alt");
});

test("engine: whole chain failing → heuristic with reason error; timeout → reason timeout", async () => {
  const { fn } = fakeFetch([() => json(503, {})]);
  const { engine } = makeEngine(engineConfig(), fn);
  assert.equal((await engine.evaluate(testPoint, { text: "x" }, ctx)).reason, "error");

  const hang = (_c: FakeCall, signal?: AbortSignal) =>
    new Promise<Response>((_r, reject) =>
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
    );
  const config = engineConfig();
  config.decisions.timeout_ms = 120;
  const { engine: slow } = makeEngine(config, fakeFetch([hang]).fn);
  assert.equal((await slow.evaluate(testPoint, { text: "x" }, ctx)).reason, "timeout");
});

test("engine: every member unhealthy → no call, decision_model_unavailable logged once per minute", async () => {
  const { fn, calls } = fakeFetch([() => json(200, okBody())]);
  const scheduler: any = { modelHealth: () => "unhealthy", isProbeDue: () => false };
  const { engine, logs } = makeEngine(engineConfig(), fn, { scheduler });
  await engine.evaluate(testPoint, { text: "x" }, ctx);
  await engine.evaluate(testPoint, { text: "x" }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(logs.filter(([e]) => e === "decision_model_unavailable").length, 1);
});

test("engine: no fitting member → reason no_fitting_member", async () => {
  const config = engineConfig();
  config.models.decider.decision = { question_types: ["noul"] };
  config.models.decider_alt.decision = { max_choice_options: 1 };
  const { engine } = makeEngine(config, fakeFetch([() => json(200, okBody())]).fn);
  assert.equal((await engine.evaluate(testPoint, { text: "x" }, ctx)).reason, "no_fitting_member");
});
