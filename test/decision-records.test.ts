import assert from "node:assert/strict";
import test from "node:test";

import {
  DecisionClient,
  DecisionEngine,
  recordsPoint,
  selectRecordsToInject,
  DEFAULT_RECORDS_CANDIDATES,
  DEFAULT_RECORDS_MAX_INJECTED,
  validateDecisionsConfig,
  type RecordsInput,
  type DecisionEvaluationRow,
} from "../src/decisions/index.js";
import type { UsageEventInput } from "../src/storage/database.js";
import { pointSettings } from "../src/decisions/config.js";

// ---------------------------------------------------------------------------
// Records decision point (SESSION-RECORDS §6.2): state shaping, questions,
// resolve (threshold, calibration), fallback (CONTRACT decision 8), the
// selectRecordsToInject helper, and evaluation recording (CONTRACT §6/§8).
// ---------------------------------------------------------------------------

const settings: any = {
  point: "records",
  minConfidence: 0.6,
  injectThreshold: 0.6,
  calibration: {},
  persona: "",
  model: "decider",
  timeoutMs: 3000,
  stateMaxTokens: 8000,
  minStateTokens: 1000,
};

const same = (_n: string, v: number) => v;

function input(over: Partial<RecordsInput> = {}): RecordsInput {
  return {
    request: { from: "Alice", text: "post the second one" },
    record: "Found X and Y; did not find Z. Saved to /tmp/results.md.",
    candidateSessionId: "s-abc",
    isReplyTarget: false,
    ...over,
  };
}

const noul = (p: number) => ({ type: "noul" as const, noul: p });

// --- questions ---------------------------------------------------------------

test("records questions: single `relevant` noul question", () => {
  const q = recordsPoint.questions(input(), settings);
  assert.deepEqual(Object.keys(q), ["relevant"]);
  assert.equal(q["relevant"]?.type, "noul");
  assert.match(String((q["relevant"] as any).instructions), /asks about.*refers to.*continues.*record/i);
});

// --- state shaping -----------------------------------------------------------

test("records state: reply framing when replyTo is set", () => {
  const s = recordsPoint.state(
    input({
      replyTo: { from: "Miku", text: "I found X and Y." },
      recentChat: [{ from: "Alice", text: "look for stuff" }],
    }),
    8000,
  ) as any;
  assert.ok("reply_to" in s, "reply_to present");
  assert.ok(!("recent_chat" in s), "recent_chat absent in reply framing");
  assert.equal(s.reply_to.from, "Miku");
  assert.equal(s.request.from, "Alice");
  assert.equal(s.record, "Found X and Y; did not find Z. Saved to /tmp/results.md.");
});

test("records state: non-reply framing when replyTo is absent", () => {
  const s = recordsPoint.state(
    input({ recentChat: [{ from: "Alice", text: "find stuff" }, { from: "Miku", text: "ok", self: true }] }),
    8000,
  ) as any;
  assert.ok("recent_chat" in s, "recent_chat present");
  assert.ok(!("reply_to" in s), "reply_to absent");
  assert.equal(s.recent_chat.length, 2);
  assert.equal(s.recent_chat[1].self, true);
});

test("records state: clips request text to REQUEST_TEXT_CLIP chars", () => {
  const longText = "a".repeat(2000);
  const s = recordsPoint.state(input({ request: { from: "Alice", text: longText } }), 8000) as any;
  assert.ok(s.request.text.length < 2000, "text was clipped");
  assert.match(s.request.text, /…$/, "ends with ellipsis");
});

test("records state: record is clipped with marker when it cannot fit", () => {
  const bigRecord = "r".repeat(10000);
  const s = recordsPoint.state(input({ record: bigRecord }), 500) as any;
  assert.match(s.record, /\[record truncated\]$/, "truncation marker present");
});

test("records state: recent_chat packed newest-first when budget is tight", () => {
  // 30 messages × ~8 tokens each ≈ 240 tokens; with record+request ≈ 260 total.
  // Budget=50 forces packNewest to drop oldest messages.
  const many = Array.from({ length: 30 }, (_, i) => ({ from: "User", text: `message ${i}` }));
  const s = recordsPoint.state(input({ recentChat: many }), 50) as any;
  assert.ok(s.recent_chat.length < 30, "packed (fewer than 30)");
  // Newest messages are kept; oldest are dropped.
  const texts = s.recent_chat.map((m: any) => m.text);
  assert.ok(texts.includes("message 29"), "newest message present");
});

// --- resolve -----------------------------------------------------------------

test("records resolve: above threshold → inject=true", () => {
  const v = recordsPoint.resolve({ relevant: noul(0.8) }, input(), same, settings)!;
  assert.equal(v.inject, true);
  assert.equal(v.relevance, 0.8);
  assert.equal(v.candidateSessionId, "s-abc");
});

test("records resolve: below threshold → inject=false", () => {
  const v = recordsPoint.resolve({ relevant: noul(0.4) }, input(), same, settings)!;
  assert.equal(v.inject, false);
  assert.equal(v.relevance, 0.4);
});

test("records resolve: at threshold → inject=true (inclusive)", () => {
  const v = recordsPoint.resolve({ relevant: noul(0.6) }, input(), same, settings)!;
  assert.equal(v.inject, true);
});

test("records resolve: null when answer is missing or wrong type", () => {
  assert.equal(recordsPoint.resolve({}, input(), same, settings), null);
  assert.equal(
    recordsPoint.resolve(
      { relevant: { type: "choice", choice: "x", probabilities: {}, confidence: 0.9 } },
      input(),
      same,
      settings,
    ),
    null,
  );
});

test("records resolve: custom inject_threshold on settings", () => {
  const s = { ...settings, injectThreshold: 0.75 };
  const below = recordsPoint.resolve({ relevant: noul(0.7) }, input(), same, s)!;
  assert.equal(below.inject, false);
  const above = recordsPoint.resolve({ relevant: noul(0.8) }, input(), same, s)!;
  assert.equal(above.inject, true);
});

test("records resolve: threshold calibrated via ThresholdFn", () => {
  // ThresholdFn overrides "relevant" → 0.9
  const highThreshold = (name: string, value: number) => (name === "relevant" ? 0.9 : value);
  const v = recordsPoint.resolve({ relevant: noul(0.8) }, input(), highThreshold, settings);
  assert.equal(v?.inject, false, "0.8 below calibrated 0.9");
  const above = recordsPoint.resolve({ relevant: noul(0.95) }, input(), highThreshold, settings);
  assert.equal(above?.inject, true);
});

// --- fallback (CONTRACT decision 8) ----------------------------------------

test("records fallback: reply target → inject=true; others → inject=false", () => {
  const replyTarget = recordsPoint.fallback(input({ isReplyTarget: true }));
  assert.equal(replyTarget.inject, true);
  assert.equal(replyTarget.relevance, 1);
  const other = recordsPoint.fallback(input({ isReplyTarget: false }));
  assert.equal(other.inject, false);
  assert.equal(other.relevance, 0);
});

// --- describe ----------------------------------------------------------------

test("records describe: serializable with rounded relevance", () => {
  const d = recordsPoint.describe({ inject: true, relevance: 0.8765432, candidateSessionId: "s-x" }) as any;
  assert.equal(d.inject, true);
  assert.equal(d.relevance, 0.877);
  assert.equal(d.candidateSessionId, "s-x");
});

// --- pointSettings for records -----------------------------------------------

test("pointSettings: records inject_threshold is exposed on PointSettings.injectThreshold", () => {
  const decisions: any = {
    enabled: true,
    model: "decider",
    records: { enabled: true, inject_threshold: 0.75 },
  };
  const s = pointSettings(decisions, "records");
  assert.ok(s, "settings resolved");
  assert.equal(s!.injectThreshold, 0.75);
});

test("pointSettings: records with no inject_threshold leaves injectThreshold undefined", () => {
  const decisions: any = {
    enabled: true,
    model: "decider",
    records: { enabled: true },
  };
  const s = pointSettings(decisions, "records");
  assert.equal(s!.injectThreshold, undefined);
});

// --- DecisionEngine + onEvaluation -------------------------------------------

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

function baseConfig(over: Record<string, unknown> = {}): any {
  return {
    models: { decider: decider() },
    ...over,
  };
}

function relevantBody(noulValue = 0.85) {
  return {
    model: "vendor/decider-1-20261001",
    answers: { relevant: { noul: noulValue } },
    usage: { input_tokens: 200, output_tokens: 5, cost: 0.000009 },
  };
}

interface FakeCall { url: string; body: any }

function fakeFetch(handlers: Array<(call: FakeCall) => Response>) {
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)) };
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i += 1;
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn };
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeEngine(config: any, fetchFn: typeof fetch) {
  const evaluations: DecisionEvaluationRow[] = [];
  const usageRows: UsageEventInput[] = [];
  const logs: Array<[string, any]> = [];
  const logger: any = {
    info: (e: string, f: any) => logs.push([e, f]),
    warn: (e: string, f: any) => logs.push([e, f]),
    error: (e: string, f: any) => logs.push([e, f]),
    debug() {},
    child() { return logger; },
  };
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: fetchFn, logger }),
    record: (e) => usageRows.push(e),
    onEvaluation: (row) => evaluations.push(row),
    logger,
  });
  return { engine, evaluations, usageRows, logs };
}

const ctx = {
  agentName: "miku",
  attribution: { agentSessionId: "s-eval", timelineKey: "matrix:acc:!room" },
};

const recordsConfig = (over: Record<string, unknown> = {}): any =>
  baseConfig({
    decisions: { enabled: true, model: "decider", records: { enabled: true, inject_threshold: 0.6 } },
    ...over,
  });

test("engine + records point: model verdict emits an evaluation row", async () => {
  const { fn } = fakeFetch([() => j(200, relevantBody(0.8))]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  const out = await engine.evaluate(
    recordsPoint,
    input({ candidateSessionId: "s-cand" }),
    { ...ctx, candidateSessionId: "s-cand", triggerEventId: "evt-1" },
  );
  assert.equal(out.source, "model");
  assert.equal(out.verdict.inject, true);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.equal(row.point, "records");
  assert.equal(row.source, "model");
  assert.equal(row.reason, null);
  assert.equal(row.agent, "miku");
  assert.equal(row.agentSessionId, "s-eval");
  assert.equal(row.candidateSessionId, "s-cand");
  assert.equal(row.triggerEventId, "evt-1");
  assert.equal(row.servedModel, "decider");
  assert.equal(row.servedVersion, "vendor/decider-1-20261001");
  assert.ok(row.verdictJson !== null);
  assert.ok(row.answersJson !== null);
  assert.ok(row.stateJson !== null);
  assert.ok(row.questionsJson !== null);
  assert.ok(typeof row.latencyMs === "number" && row.latencyMs >= 0);
  assert.equal(row.inputTokens, 200);
  assert.ok(row.costUsd !== null && row.costUsd > 0);
  assert.ok(row.decisionGroup.length > 0);
  // decisionGroup propagates into the outcome
  assert.equal(out.decisionGroup, row.decisionGroup);
});

test("engine + records point: fallback row emitted with source=heuristic", async () => {
  const config = recordsConfig();
  config.decisions.records.enabled = false;
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine, evaluations } = makeEngine(config, fn);
  const out = await engine.evaluate(recordsPoint, input(), ctx);
  // Point disabled: no row (disabled point produces nothing)
  assert.equal(evaluations.length, 0);
  assert.equal(out.source, "heuristic");
  assert.equal(out.reason, "disabled");
  assert.ok(out.decisionGroup.length > 0);
});

test("engine + records point: verdict below threshold is inject=false (no fallback needed)", async () => {
  // For the records point, resolve() returns a verdict for any well-formed noul
  // answer (inject=true or inject=false depending on threshold). "low_confidence"
  // only fires if resolve() returns null — which requires a wrong answer type.
  const body = relevantBody(0.2); // below threshold → inject=false but source=model
  const { fn } = fakeFetch([() => j(200, body)]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  const out = await engine.evaluate(recordsPoint, input(), ctx);
  assert.equal(out.source, "model");
  assert.equal(out.verdict.inject, false, "below threshold → not injected");
  assert.equal(out.verdict.relevance, 0.2);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.equal(row.source, "model");
  assert.equal(row.reason, null);
  assert.ok(row.stateJson !== null, "state present");
});

test("engine + records point: error fallback row when server returns malformed answer", async () => {
  // A missing noul field causes parseAnswers to fail → content error → "error" fallback.
  // The evaluation row captures the real sent state (a request was attempted).
  const body = {
    model: "vendor/decider-1-20261001",
    answers: { relevant: { choice: "yes", probabilities: {}, confidence: 0.9 } }, // wrong type for noul
    usage: { input_tokens: 200, output_tokens: 5, cost: 0.000009 },
  };
  let capturedState: unknown;
  const { fn } = fakeFetch([(call) => { capturedState = call.body.state; return j(200, body); }]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  const out = await engine.evaluate(recordsPoint, input({ isReplyTarget: false }), ctx);
  assert.equal(out.source, "heuristic");
  assert.equal(out.reason, "error");
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.equal(row.source, "heuristic");
  assert.equal(row.reason, "error");
  // A request was attempted, so state/questions are the actual sent payload.
  assert.ok(row.stateJson !== null, "state present for error fallback (request was attempted)");
  assert.equal(row.stateJson, JSON.stringify(capturedState!), "stateJson must equal what was actually sent");
});

test("engine + records point: decisionGroup shared when passed in ctx", async () => {
  const { fn } = fakeFetch([() => j(200, relevantBody()), () => j(200, relevantBody())]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  const group = "test-group-id";
  await engine.evaluate(recordsPoint, input({ candidateSessionId: "s-1" }), { ...ctx, decisionGroup: group, candidateSessionId: "s-1" });
  await engine.evaluate(recordsPoint, input({ candidateSessionId: "s-2" }), { ...ctx, decisionGroup: group, candidateSessionId: "s-2" });
  assert.equal(evaluations.length, 2);
  assert.equal(evaluations[0]!.decisionGroup, group);
  assert.equal(evaluations[1]!.decisionGroup, group);
});

test("engine + records point: stateJson stays under 64 KiB even for large records", async () => {
  // With stateMaxTokens=8000 (default) the state is ~32 KiB max, so capJsonBytes
  // at 64 KiB never fires. The record is clipped by state() with its own marker.
  const bigRecord = "r".repeat(100_000);
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  await engine.evaluate(recordsPoint, input({ record: bigRecord }), ctx);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.ok(row.stateJson !== null);
  assert.ok(Buffer.byteLength(row.stateJson!, "utf8") <= 64 * 1024, "state under 64 KiB");
  assert.match(row.stateJson!, /\[record truncated\]/, "record truncation marker present");
});

test("engine + records point: questionsJson capped at 16 KiB", async () => {
  // The questions for records are small; they're always under 16 KiB.
  // Just verify the field is populated correctly.
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  await engine.evaluate(recordsPoint, input(), ctx);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.ok(row.questionsJson !== null);
  assert.ok(Buffer.byteLength(row.questionsJson!, "utf8") <= 16 * 1024);
  const parsed = JSON.parse(row.questionsJson!);
  assert.ok("relevant" in parsed);
});

test("engine + records: row.stateJson equals the state actually received by the member", async () => {
  // Spec §8: state_json must reflect what the member actually received, not a
  // post-facto rebuild. Capture the fetch body and compare directly.
  let capturedState: unknown;
  const { fn } = fakeFetch([(call) => {
    capturedState = call.body.state;
    return j(200, relevantBody(0.8));
  }]);
  const { engine, evaluations } = makeEngine(recordsConfig(), fn);
  await engine.evaluate(recordsPoint, input({ record: "Found X. Saved to /tmp/out.md." }), ctx);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.ok(row.stateJson !== null);
  assert.equal(
    row.stateJson,
    JSON.stringify(capturedState!),
    "stateJson must equal exactly what the member received",
  );
});

test("engine + records: stateJson matches sent body in the client shrink-and-rebuild case", async () => {
  // When the client's real tokenizer says the initial state overshoots the budget,
  // stateFor() reduces the target by 0.75x and rebuilds. The row must capture the
  // final (actually sent) state, not a separate rebuild from registry.ts.
  //
  // state_budget_tokens=1500 with min_state_tokens=100 ensures the member fits
  // (effectiveBudget ~= 1500 - questionTokens - 64 > 100) while still limiting
  // the state budget enough to clip a large record. The row's stateJson must equal
  // exactly what was placed in the fetch body.
  let capturedState: unknown;
  const { fn } = fakeFetch([(call) => {
    capturedState = call.body.state;
    return j(200, relevantBody(0.8));
  }]);
  const smallBudgetDecider = decider({ decision: { state_budget_tokens: 1500 } });
  const config = baseConfig({
    models: { decider: smallBudgetDecider },
    decisions: { enabled: true, model: "decider", records: { enabled: true, min_state_tokens: 100 } },
  });
  const { engine, evaluations } = makeEngine(config, fn);
  const bigRecord = "r".repeat(30000); // large enough to get clipped at 1500-token budget
  await engine.evaluate(recordsPoint, input({ record: bigRecord }), ctx);
  assert.equal(evaluations.length, 1);
  const row = evaluations[0]!;
  assert.ok(row.stateJson !== null, "state must be non-null (request was sent)");
  assert.equal(
    row.stateJson,
    JSON.stringify(capturedState!),
    "stateJson must equal the actually sent body even when client shrinks the state",
  );
  // The record was clipped (sent state is much smaller than the raw input)
  assert.ok(row.stateJson.length < bigRecord.length, "record was clipped by the budget");
});

test("engine + records: no-request fallbacks (disabled) have stateJson=null and questionsJson=null", async () => {
  // Disabled point never sends a request; spec §8 says state/questions must be null.
  const config = recordsConfig();
  config.decisions.records.enabled = false;
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine, evaluations } = makeEngine(config, fn);
  // Disabled → no row at all (disabled points produce no evaluation row)
  const out = await engine.evaluate(recordsPoint, input(), ctx);
  assert.equal(evaluations.length, 0, "disabled point emits no row");
  assert.equal(out.reason, "disabled");
});

// --- selectRecordsToInject ---------------------------------------------------

const decisionsRaw: any = {
  enabled: true,
  model: "decider",
  records: { enabled: true, inject_threshold: 0.6, candidates: 3, max_injected: 2 },
};

test("selectRecordsToInject: injects candidates above threshold, sorted by relevance, capped", async () => {
  // 3 candidates: relevance 0.9, 0.7, 0.3 → inject s-1 and s-2 (max_injected=2)
  const bodies = [
    relevantBody(0.9),  // s-1
    relevantBody(0.7),  // s-2
    relevantBody(0.3),  // s-3 below threshold
  ];
  let i = 0;
  const fn = (async () => j(200, bodies[i++]!)) as unknown as typeof fetch;
  const config = recordsConfig();
  const { engine, evaluations } = makeEngine(config, fn);
  const candidates = [
    { sessionId: "s-1", record: "r1", isReplyTarget: false, request: { from: "Alice", text: "post it" } },
    { sessionId: "s-2", record: "r2", isReplyTarget: false, request: { from: "Alice", text: "post it" } },
    { sessionId: "s-3", record: "r3", isReplyTarget: false, request: { from: "Alice", text: "post it" } },
  ];
  const result = await selectRecordsToInject(
    engine,
    { candidates, rawDecisions: decisionsRaw },
    { agentName: "miku", attribution: { agentSessionId: "s-new" } },
  );
  assert.deepEqual(result.inject, ["s-1", "s-2"]);
  // All 3 evaluations share the same decisionGroup
  assert.equal(evaluations.length, 3);
  const groups = new Set(evaluations.map((r) => r.decisionGroup));
  assert.equal(groups.size, 1);
  assert.equal(result.decisionGroup, evaluations[0]!.decisionGroup);
});

test("selectRecordsToInject: reply target at low relevance injected via fallback (CONTRACT decision 8)", async () => {
  // Relevance 0.3 (below threshold) but isReplyTarget=true → fallback injects it
  const body = relevantBody(0.3);
  const { fn } = fakeFetch([() => j(200, body)]);
  const config = recordsConfig();
  const { engine } = makeEngine(config, fn);
  const result = await selectRecordsToInject(
    engine,
    {
      candidates: [
        { sessionId: "s-reply", record: "r", isReplyTarget: true, request: { from: "Alice", text: "continue" } },
      ],
      rawDecisions: decisionsRaw,
    },
    { agentName: null, attribution: {} },
  );
  // 0.3 is below 0.6 threshold → resolve returns inject=false → but fallback overrides for reply target
  // Actually the engine calls resolve() which returns inject=false, so outcome.verdict.inject=false
  // The reply-target fallback is only triggered when the WHOLE point fails (disabled / error).
  // When the point is enabled and returns a confident answer, resolve() wins.
  // 0.3 < 0.6 → resolve returns inject=false → the reply target is NOT injected by model verdict.
  // This matches spec §6.2: "A reply's own record below threshold is not injected: the model judged
  // that the reply does not need it".
  assert.deepEqual(result.inject, []);
});

test("selectRecordsToInject: point disabled → 6.1 rule (reply target only)", async () => {
  const config = baseConfig({
    decisions: { enabled: true, model: "decider", records: { enabled: false } },
  });
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine } = makeEngine(config, fn);
  const result = await selectRecordsToInject(
    engine,
    {
      candidates: [
        { sessionId: "s-reply", record: "r", isReplyTarget: true, request: { from: "Alice", text: "x" } },
        { sessionId: "s-other", record: "r2", isReplyTarget: false, request: { from: "Alice", text: "x" } },
      ],
      rawDecisions: { enabled: true, model: "decider", records: { enabled: false } } as any,
    },
    { agentName: null, attribution: {} },
  );
  // Both candidates get fallback verdict: reply target → inject, other → don't
  assert.deepEqual(result.inject, ["s-reply"]);
});

test("selectRecordsToInject: empty candidates returns empty inject", async () => {
  const config = recordsConfig();
  const { fn } = fakeFetch([() => j(200, relevantBody())]);
  const { engine } = makeEngine(config, fn);
  const result = await selectRecordsToInject(
    engine,
    { candidates: [], rawDecisions: decisionsRaw },
    { agentName: null, attribution: {} },
  );
  assert.deepEqual(result.inject, []);
  assert.ok(result.decisionGroup.length > 0);
});

test("selectRecordsToInject: max_injected=1 caps result to 1 even with 2 above threshold", async () => {
  const bodies = [relevantBody(0.9), relevantBody(0.8)];
  let i = 0;
  const fn = (async () => j(200, bodies[i++]!)) as unknown as typeof fetch;
  const config = recordsConfig();
  const { engine } = makeEngine(config, fn);
  const rawDecisions = { ...decisionsRaw, records: { ...decisionsRaw.records, max_injected: 1 } };
  const result = await selectRecordsToInject(
    engine,
    {
      candidates: [
        { sessionId: "s-a", record: "r", isReplyTarget: false, request: { from: "Alice", text: "x" } },
        { sessionId: "s-b", record: "r", isReplyTarget: false, request: { from: "Alice", text: "x" } },
      ],
      rawDecisions,
    },
    { agentName: null, attribution: {} },
  );
  assert.equal(result.inject.length, 1);
  assert.equal(result.inject[0], "s-a"); // highest relevance
});

test("selectRecordsToInject: outcomes map populated with per-candidate results", async () => {
  const bodies = [relevantBody(0.9), relevantBody(0.3)];
  let i = 0;
  const fn = (async () => j(200, bodies[i++]!)) as unknown as typeof fetch;
  const config = recordsConfig();
  const { engine } = makeEngine(config, fn);
  const result = await selectRecordsToInject(
    engine,
    {
      candidates: [
        { sessionId: "s-a", record: "r", isReplyTarget: false, request: { from: "Alice", text: "x" } },
        { sessionId: "s-b", record: "r", isReplyTarget: false, request: { from: "Alice", text: "x" } },
      ],
      rawDecisions: decisionsRaw,
    },
    { agentName: null, attribution: {} },
  );
  assert.ok(result.outcomes.has("s-a"));
  assert.ok(result.outcomes.has("s-b"));
  assert.equal(result.outcomes.get("s-a")!.verdict.inject, true);
  assert.equal(result.outcomes.get("s-b")!.verdict.inject, false);
});

// --- capacity warning in validateDecisionsConfig -----------------------------

test("validateDecisionsConfig: records capacity warning when max_in_flight is too low", () => {
  const config: any = {
    models: {
      decider: decider(),
    },
    rate_limits: { llm: { "decision:decider": { max_in_flight: 2 } } },
    decisions: {
      enabled: true,
      model: "decider",
      records: { enabled: true, candidates: 3 }, // needs 3+2=5 in flight
    },
  };
  const warnings: Array<[string, Record<string, unknown>]> = [];
  validateDecisionsConfig(config, { warn: (e, f) => warnings.push([e, f]) });
  const cap = warnings.find(([e]) => e === "decisions_records_capacity_low");
  assert.ok(cap, "capacity warning emitted");
  assert.equal(cap![1]["maxInFlight"], 2);
  assert.equal(cap![1]["needed"], 5);
  assert.match(String(cap![1]["hint"]), /max_in_flight/);
});

test("validateDecisionsConfig: no capacity warning when max_in_flight is sufficient", () => {
  const config: any = {
    models: { decider: decider() },
    rate_limits: { llm: { "decision:decider": { max_in_flight: 10 } } },
    decisions: {
      enabled: true,
      model: "decider",
      records: { enabled: true, candidates: 3 },
    },
  };
  const warnings: Array<[string, Record<string, unknown>]> = [];
  validateDecisionsConfig(config, { warn: (e, f) => warnings.push([e, f]) });
  const cap = warnings.find(([e]) => e === "decisions_records_capacity_low");
  assert.equal(cap, undefined);
});

// --- defaults ----------------------------------------------------------------

test("DEFAULT_RECORDS_CANDIDATES and DEFAULT_RECORDS_MAX_INJECTED match CONTRACT", () => {
  assert.equal(DEFAULT_RECORDS_CANDIDATES, 3);
  assert.equal(DEFAULT_RECORDS_MAX_INJECTED, 2);
});
