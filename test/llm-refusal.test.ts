import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { LlmScheduler } from "../src/agent/scheduler.js";
import { buildModelFallback, chooseChainMember, type ModelChainEntry } from "../src/agent/model-fallback.js";
import {
  classifyLlmError,
  extractLlmRequestClass,
  isRefusalSignal,
  withRequestRetry,
} from "../src/agent/request-retry.js";
import { classifyUnfinalizedRecordTurn } from "../src/agent/session-records.js";
import type { Logger } from "../src/observability/logger.js";

// ---------------------------------------------------------------------------
// Provider refusals (ARCHITECTURE.md §8a "Refusals"): class `refusal`, no health
// strike, never re-sent to the member that refused, fallover to another chain
// member, terminal when none is left or the request opted out.
// ---------------------------------------------------------------------------

// ── Classification ───────────────────────────────────────────────────────────

test("classify: Anthropic refusal — raw stop reason, with or without stop_details explanation", () => {
  assert.equal(classifyLlmError("I can't help with writing that.", "error", "refusal"), "refusal");
  assert.equal(classifyLlmError("The model refused to complete the request", "error", "refusal"), "refusal");
  // The default text alone (raw stop reason lost, e.g. re-classified from the string).
  assert.equal(classifyLlmError("The model refused to complete the request", "error"), "refusal");
  assert.equal(classifyLlmError("Provider stopped with: sensitive", "error", "sensitive"), "refusal");
  assert.equal(classifyLlmError("Provider stopped with: sensitive", "error"), "refusal");
});

test("classify: OpenAI completions content_filter and Responses incomplete content_filter", () => {
  assert.equal(classifyLlmError("Provider finish_reason: content_filter", "error", "content_filter"), "refusal");
  assert.equal(classifyLlmError("Provider finish_reason: content_filter", "error"), "refusal");
  assert.equal(
    classifyLlmError("Response incomplete: content_filter", "error", "incomplete.content_filter"),
    "refusal",
  );
  assert.equal(classifyLlmError("Response incomplete: content_filter", "error"), "refusal");
});

test("classify: Bedrock Converse and Google safety stops", () => {
  assert.equal(classifyLlmError("Provider stopped with: content_filtered", "error", "content_filtered"), "refusal");
  assert.equal(classifyLlmError("Provider stopped with: guardrail_intervened", "error", "guardrail_intervened"), "refusal");
  assert.equal(classifyLlmError("Provider stopped with: SAFETY", "error", "SAFETY"), "refusal");
  assert.equal(classifyLlmError("Provider stopped with: PROHIBITED_CONTENT", "error"), "refusal");
});

test("classify: tagged messages keep the refusal class", () => {
  const tagged = "Provider finish_reason: content_filter [llm-request] [llm-request:refusal]";
  assert.equal(extractLlmRequestClass(tagged), "refusal");
  assert.equal(classifyLlmError(tagged, "error"), "refusal");
});

test("classify negatives: errors that merely mention refusal or a filter are not refusals", () => {
  assert.equal(classifyLlmError("connect ECONNREFUSED 127.0.0.1:443", "error"), "environmental");
  assert.equal(classifyLlmError("Connection refused", "error"), "environmental");
  assert.equal(classifyLlmError("upstream refused the connection: 502 bad gateway", "error"), "environmental");
  assert.equal(classifyLlmError("Provider finish_reason: network_error", "error", "network_error"), "environmental");
  assert.equal(classifyLlmError("Response incomplete: max_output_tokens_exceeded", "error"), "environmental");
  // A content filter inside an HTTP 400 body is this request's content (status wins), not a stop.
  assert.equal(
    classifyLlmError('400 {"error":{"code":"content_filter","message":"The response was filtered"}}', "error"),
    "content",
  );
  // A sentence ABOUT a refusal is not pi-ai's refusal text.
  assert.equal(classifyLlmError("500 The model refused to complete the request due to overload", "error"), "environmental");
  assert.equal(classifyLlmError("Provider stopped with: OTHER", "error", "OTHER"), "environmental");
  // An abort wins over a refusal stop.
  assert.equal(classifyLlmError("Request was aborted", "aborted", "refusal"), "aborted");
  assert.equal(isRefusalSignal("end_turn", "500 server error"), false);
  assert.equal(isRefusalSignal(undefined, undefined), false);
});

test("record-turn classification: the refusal class marker or the provider signal, nothing looser", () => {
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "I won't do that. [llm-request] [llm-request:refusal]"), "refusal");
  assert.equal(classifyUnfinalizedRecordTurn("refusal", "I won't do that."), "refusal");
  assert.equal(classifyUnfinalizedRecordTurn("content_filter", "Provider finish_reason: content_filter [llm-request]"), "refusal");
  // Mentions of "refused" in an ordinary error are LLM errors.
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "connect ECONNREFUSED [llm-request] [llm-request:environmental]"), "llm_error");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "connection refused by peer"), "llm_error");
});

// ── Layer 0 + the fallback resolver ──────────────────────────────────────────

function modelCfg(id: string, endpoint: string): any {
  return { id, provider: "test", endpoint, api_key: "k", input_modalities: ["text"], max_tokens: 1000, context_window: 100_000 };
}

function makeModel(cfg: any, cw: number): Model<Api> {
  return {
    id: cfg.id,
    name: cfg.id,
    api: "anthropic-messages",
    provider: cfg.provider,
    baseUrl: cfg.endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cw,
    maxTokens: cfg.max_tokens,
  } as Model<Api>;
}

const X: ModelChainEntry = { logicalId: "X", config: modelCfg("wire-X", "https://gw/x") };
const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg("wire-Y", "https://gw/y") };
const Z: ModelChainEntry = { logicalId: "Z", config: modelCfg("wire-Z", "https://gw/z") };
const X_KEY = "https://gw/x::wire-X";
const Y_KEY = "https://gw/y::wire-Y";

type Behaviour = "ok" | "refuse" | "filter" | "down";

function message(model: { id: string; api: string; provider?: string }, stopReason: string, extra: Record<string, unknown> = {}): any {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider ?? "test",
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
    ...extra,
  };
}

/** makeBase whose answer per wire id comes from `behaviour`; records every dispatch. */
function scriptedBase(calls: string[], behaviour: Record<string, Behaviour>): (cfg: any) => StreamFn {
  return () =>
    ((model) => {
      calls.push(model.id);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const b = behaviour[model.id] ?? "ok";
        let terminal: any;
        if (b === "refuse") {
          // Anthropic: a refusal with a stop_details explanation (free text).
          terminal = message(model, "error", { rawStopReason: "refusal", errorMessage: "I can't help with that request." });
        } else if (b === "filter") {
          terminal = message(model, "error", { rawStopReason: "content_filter", errorMessage: "Provider finish_reason: content_filter" });
        } else if (b === "down") {
          terminal = message(model, "error", { errorMessage: "OpenAI API error (502): 502 status code (no body)" });
        }
        if (terminal) {
          stream.push({ type: "error", reason: "error", error: terminal });
          stream.end(terminal);
        } else {
          const done = message(model, "stop");
          stream.push({ type: "done", reason: "stop", message: done });
          stream.end(done);
        }
      });
      return stream;
    }) as StreamFn;
}

function captureLogger(lines: Array<{ message: string; fields?: Record<string, unknown> }>): Logger {
  const log = (message: string, fields?: Record<string, unknown>) => {
    lines.push({ message, fields });
  };
  const logger: Logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
  return logger;
}

async function run(streamFn: StreamFn): Promise<any> {
  const stream = streamFn(makeModel(X.config, 100_000), { messages: [] } as never, {} as never);
  let last: any = { type: "none" };
  for await (const event of stream) last = event;
  return last;
}

function composite(
  chain: ModelChainEntry[],
  calls: string[],
  behaviour: Record<string, Behaviour>,
  scheduler: LlmScheduler,
  opts: { maxWaitMs?: number; refusalFallover?: () => boolean; logs?: Array<{ message: string; fields?: Record<string, unknown> }> } = {},
): StreamFn {
  const logger = opts.logs ? captureLogger(opts.logs) : undefined;
  const fb = buildModelFallback(chain, {
    consumer: "test",
    makeBase: scriptedBase(calls, behaviour),
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
    logger,
  });
  return withRequestRetry(
    fb.streamFn,
    { maxWaitMs: "maxWaitMs" in opts ? opts.maxWaitMs : 60_000, backoffBaseMs: 2_000, backoffMaxMs: 10_000 },
    { logger, refusalFallover: opts.refusalFallover, getServedModel: () => undefined },
  );
}

function freshScheduler(): LlmScheduler {
  // Threshold 1: a single strike would make the member unhealthy at once.
  return new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 60_000, probeBackoffMaxMs: 60_000 } });
}

test("a refused head falls over to the next member at once — no strike, no same-member retry", async () => {
  const scheduler = freshScheduler();
  const calls: string[] = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const started = Date.now();
  const last = await run(composite([X, Y], calls, { "wire-X": "refuse" }, scheduler, { logs }));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-Y"], "the head is not re-hit (it would get 2 attempts on an environmental failure)");
  assert.ok(Date.now() - started < 1_000, "fallover never waits out the local backoff");
  assert.equal(scheduler.modelHealth(X_KEY), "healthy", "a refusal is not a health strike");
  assert.equal(scheduler.snapshot().models.find((m) => m.key === X_KEY)?.consecutiveFailures ?? 0, 0);
  assert.equal(scheduler.snapshot().groups.find((g) => g.name === "default")?.backoffUntil ?? 0, 0, "no group throttle");
  const refusal = logs.find((l) => l.message === "llm_refusal");
  assert.ok(refusal, "llm_refusal logged");
  assert.equal(refusal!.fields!.model, "wire-X");
  assert.equal(refusal!.fields!.rawStopReason, "refusal");
  assert.equal(refusal!.fields!.explanation, "I can't help with that request.");
  assert.equal(refusal!.fields!.fallover, true);
  assert.ok(!logs.some((l) => l.message === "llm_request_attempt_failed"), "not logged as an environmental failure");
  const resolved = logs.find((l) => l.message === "model_fallback_resolved");
  assert.equal(resolved?.fields?.reason, "refusal-fallback");
});

test("every member refuses → terminal refusal, one attempt each, no wall-clock loop", async () => {
  const scheduler = freshScheduler();
  const calls: string[] = [];
  const started = Date.now();
  const last = await run(composite([X, Y, Z], calls, { "wire-X": "refuse", "wire-Y": "filter", "wire-Z": "refuse" }, scheduler));
  assert.equal(last.type, "error");
  assert.deepEqual(calls, ["wire-X", "wire-Y", "wire-Z"]);
  assert.equal(extractLlmRequestClass(last.error.errorMessage), "refusal");
  assert.equal(last.error.rawStopReason, "refusal", "the raw stop reason survives tagging");
  assert.ok(Date.now() - started < 1_000);
  for (const key of [X_KEY, Y_KEY]) assert.equal(scheduler.modelHealth(key), "healthy");
});

test("background-class (unbounded) requests also end on an exhausted refusal", async () => {
  const scheduler = freshScheduler();
  const calls: string[] = [];
  const last = await run(composite([X, Y], calls, { "wire-X": "refuse", "wire-Y": "refuse" }, scheduler, { maxWaitMs: undefined }));
  assert.equal(last.type, "error");
  assert.equal(extractLlmRequestClass(last.error.errorMessage), "refusal");
  assert.deepEqual(calls, ["wire-X", "wire-Y"]);
});

test("a single-member chain fails terminally on the first refusal", async () => {
  const scheduler = freshScheduler();
  const calls: string[] = [];
  const last = await run(composite([X], calls, { "wire-X": "filter" }, scheduler, { maxWaitMs: undefined }));
  assert.equal(last.type, "error");
  assert.equal(extractLlmRequestClass(last.error.errorMessage), "refusal");
  assert.deepEqual(calls, ["wire-X"]);
});

test("opt-out: refusalFallover false fails the request on the first refusal", async () => {
  const scheduler = freshScheduler();
  const calls: string[] = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const last = await run(composite([X, Y], calls, { "wire-X": "refuse" }, scheduler, { refusalFallover: () => false, logs }));
  assert.equal(last.type, "error");
  assert.equal(extractLlmRequestClass(last.error.errorMessage), "refusal");
  assert.deepEqual(calls, ["wire-X"], "the fallback member is never tried");
  assert.equal(logs.find((l) => l.message === "llm_refusal")?.fields?.fallover, false);
});

test("no fallover to a member that cannot serve now (unhealthy) — the refusal is terminal", async () => {
  const scheduler = freshScheduler();
  // Y is down: one strike (threshold 1) makes it unhealthy.
  scheduler.noteOutcome("default", Y_KEY, "environmental", 502);
  assert.equal(scheduler.modelHealth(Y_KEY), "unhealthy");
  const calls: string[] = [];
  const last = await run(composite([X, Y], calls, { "wire-X": "refuse" }, scheduler));
  assert.equal(last.type, "error");
  assert.equal(extractLlmRequestClass(last.error.errorMessage), "refusal");
  assert.deepEqual(calls, ["wire-X"]);
});

test("an environmental failure after a refusal never returns to the refusing member", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  const behaviour: Record<string, Behaviour> = { "wire-X": "refuse", "wire-Y": "down" };
  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: (cfg) => {
      const inner = scriptedBase(calls, behaviour)(cfg);
      return ((model, ctx, o) => {
        // Y recovers after its first failure.
        if (calls.length >= 2) behaviour["wire-Y"] = "ok";
        return inner(model, ctx, o);
      }) as StreamFn;
    },
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
  });
  const last = await run(withRequestRetry(fb.streamFn, { maxWaitMs: 60_000, backoffBaseMs: 10, backoffMaxMs: 20 }));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-Y", "wire-Y"], "the new pass skips the refusing head");
});

test("chooseChainMember: refused members are never viable, never the canary, never the all-unhealthy target", () => {
  const members = [
    { logicalId: "X", healthKey: X_KEY, operativeWindow: 100_000 },
    { logicalId: "Y", healthKey: Y_KEY, operativeWindow: 100_000 },
  ];
  assert.deepEqual(chooseChainMember(members, { refused: new Set([X_KEY]) }), { index: 1, reason: "refusal-fallback" });
  const scheduler = freshScheduler();
  scheduler.noteOutcome("default", Y_KEY, "environmental", 502);
  assert.deepEqual(chooseChainMember(members, { scheduler, refused: new Set([X_KEY]) }), { index: 1, reason: "all-unhealthy" });
});
