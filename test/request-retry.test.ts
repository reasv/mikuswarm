import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
  classifyLlmError,
  extractLlmRequestClass,
  isLlmRequestError,
  stripLlmRequestTag,
  tagLlmRequestError,
  withRequestRetry,
  LLM_REQUEST_FAILURE_MARKER,
} from "../src/agent/request-retry.js";
import { LlmRequestRing } from "../src/agent/request-ring.js";

// ---------------------------------------------------------------------------
// Layer-1 transparent request retry (spec CONCURRENCY-AND-RATE-LIMITING §6.1).
//
// `classifyLlmError` decides retryable-vs-fatal from the flattened error string +
// stopReason. `withRequestRetry` re-issues the exact stream call on a retryable
// pre-commit failure, but never replays once content has been forwarded.
// ---------------------------------------------------------------------------

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

const errorEvent = (errorMessage: string, stopReason: "error" | "aborted" = "error"): AssistantMessageEvent => ({
  type: "error",
  reason: stopReason,
  error: message({ stopReason, errorMessage }),
});

const doneEvent = (): AssistantMessageEvent => ({ type: "done", reason: "stop", message: message() });
const startEvent = (): AssistantMessageEvent => ({ type: "start", partial: message() });
const textDeltaEvent = (delta: string): AssistantMessageEvent => ({
  type: "text_delta",
  contentIndex: 0,
  delta,
  partial: message(),
});

/** A scripted stream: pushes the given events (in order) then ends. */
function scriptedStream(events: AssistantMessageEvent[], endWithoutTerminal = false): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  // Push synchronously; the queue buffers until the consumer iterates.
  for (const event of events) stream.push(event);
  if (endWithoutTerminal) stream.end();
  return stream;
}

/** Build a StreamFn that plays one script per successive call, recording call count. */
function scriptedBase(scripts: Array<{ events: AssistantMessageEvent[]; endWithoutTerminal?: boolean }>): {
  fn: StreamFn;
  calls: () => number;
} {
  let calls = 0;
  const fn: StreamFn = () => {
    const script = scripts[Math.min(calls, scripts.length - 1)];
    calls += 1;
    return scriptedStream(script.events, script.endWithoutTerminal);
  };
  return { fn, calls: () => calls };
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const collected: AssistantMessageEvent[] = [];
  for await (const event of stream) collected.push(event);
  return collected;
}

const FAST = { backoffBaseMs: 0, backoffMaxMs: 0 } as const;
// A fake model + empty context satisfy the StreamFn signature; the scripted base ignores them.
const MODEL = message() as never;
const CONTEXT = { messages: [] } as never;

test("classifyLlmError: aborted stop reason is class aborted", () => {
  assert.equal(classifyLlmError("Request was aborted", "aborted"), "aborted");
});

test("classifyLlmError: content statuses (400/413/422) are class content", () => {
  assert.equal(classifyLlmError("400 invalid request", "error"), "content");
  assert.equal(classifyLlmError("413 payload too large", "error"), "content");
  assert.equal(classifyLlmError("422 unprocessable", "error"), "content");
});

test("classifyLlmError: context-length keywords are class content", () => {
  assert.equal(classifyLlmError("prompt is too long: 250000 tokens", "error"), "content");
  assert.equal(classifyLlmError("context_length_exceeded", "error"), "content");
});

test("classifyLlmError: endpoint-level 4xx (auth/grant/not-found) are environmental (spec §3)", () => {
  // 401/403/404/405 are endpoint-level, operator-fixable out-of-band; the
  // model-health probe detects recovery automatically, so they retry.
  assert.equal(classifyLlmError("401 {\"type\":\"error\"}", "error"), "environmental");
  assert.equal(classifyLlmError("403 forbidden", "error"), "environmental");
  assert.equal(classifyLlmError("404 not found", "error"), "environmental");
});

test("classifyLlmError: rate-limit and 5xx are environmental", () => {
  assert.equal(classifyLlmError("429 {\"type\":\"rate_limit_error\"}", "error"), "environmental");
  assert.equal(classifyLlmError("500 internal", "error"), "environmental");
  assert.equal(classifyLlmError("502 bad gateway", "error"), "environmental");
  assert.equal(classifyLlmError("503 unavailable", "error"), "environmental");
  assert.equal(classifyLlmError("529 overloaded_error", "error"), "environmental");
});

test("classifyLlmError: network/timeout/unknown/auth-keyword default to environmental", () => {
  assert.equal(classifyLlmError("Connection error.", "error"), "environmental");
  assert.equal(classifyLlmError("Request timed out.", "error"), "environmental");
  assert.equal(classifyLlmError("An unknown error occurred", "error"), "environmental");
  assert.equal(classifyLlmError("Anthropic stream ended before message_stop", "error"), "environmental");
  assert.equal(classifyLlmError(undefined, "error"), "environmental");
  assert.equal(classifyLlmError("invalid api key provided", "error"), "environmental");
  assert.equal(classifyLlmError("authentication failed", "error"), "environmental");
});

test("classifyLlmError: the scheduler-stopped marker is class aborted (#11)", () => {
  assert.equal(classifyLlmError("LLM scheduler stopped", "error"), "aborted");
});

test("classifyLlmError: a 3-digit token inside a body is not mistaken for a status", () => {
  // No leading/labelled status → falls through to keyword/default. "after 404
  // strikes" must NOT be read as HTTP 404; either way the verdict here is the
  // environmental default, but the point is the embedded value is ignored.
  assert.equal(classifyLlmError("error: account suspended, terminated after 422 strikes", "error"), "environmental");
});

test("withRequestRetry: retries a pre-commit retryable failure then succeeds", async () => {
  const { fn, calls } = scriptedBase([
    { events: [errorEvent("503 unavailable")] },
    { events: [startEvent(), textDeltaEvent("hi"), doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { ...FAST });
  const out = wrapped(MODEL, CONTEXT, undefined);
  const events = await drain(out);
  assert.equal(calls(), 2, "base re-issued exactly once");
  // The failed attempt is invisible: no error event, content + done forwarded.
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
  const final = await out.result();
  assert.equal(final.stopReason, "stop");
});

test("withRequestRetry: a content error is forwarded without retrying", async () => {
  const { fn, calls } = scriptedBase([
    { events: [errorEvent("413 prompt is too long")] },
    { events: [doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "no retry on content");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
});

test("withRequestRetry: an exhausted wall-clock budget forwards the last error (spec §6)", async () => {
  // maxWaitMs 0: the budget is already exhausted when the first failure
  // settles, so exactly one attempt is made and the error surfaces tagged.
  const { fn, calls } = scriptedBase([{ events: [errorEvent("500 internal")] }]);
  const wrapped = withRequestRetry(fn, { maxWaitMs: 0, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "budget exhausted after the first failure");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(extractLlmRequestClass(err.errorMessage), "environmental");
});

test("withRequestRetry: no maxWaitMs = unbounded — keeps retrying until success (spec §6)", async () => {
  // Background-class budget: five straight failures, then success. A fixed
  // attempt count would have given up; the unbounded budget never does.
  const failures = Array.from({ length: 5 }, () => ({ events: [errorEvent("503 unavailable")] }));
  const { fn, calls } = scriptedBase([...failures, { events: [startEvent(), textDeltaEvent("ok"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, FAST);
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 6, "retried through all five failures");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

test("withRequestRetry: budget expiry mid-wait is re-labelled environmental, not aborted (spec §6)", async () => {
  // The budget signal aborts an in-flight attempt (or admission wait). The
  // caller did not abort — the clock did — so the surfaced failure must be
  // environmental wait-exhaustion (parks), never an intentional abort.
  let calls = 0;
  const fn: StreamFn = (_model, _context, streamOptions) => {
    calls += 1;
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
    return (async function* () {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      const err = new Error("LLM scheduler wait aborted");
      err.name = "AbortError";
      throw err;
    })() as unknown as AssistantMessageEventStream;
  };
  const wrapped = withRequestRetry(fn, { maxWaitMs: 25, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "error", "not an abort");
  assert.equal(extractLlmRequestClass(err.errorMessage), "environmental");
  assert.match(err.errorMessage ?? "", /wall-clock budget/);
});

test("withRequestRetry: a mid-stream failure IS retried — partial discarded (spec §4.1)", async () => {
  // Tokens streamed, THEN the stream died in an error event. The commit point is
  // the terminal event, so the partial is discarded and the request re-issued;
  // the consumer sees ONLY the clean second attempt — byte-equivalent to a
  // first-attempt success (P1).
  const { fn, calls } = scriptedBase([
    { events: [startEvent(), textDeltaEvent("partial"), errorEvent("Connection error.")] },
    { events: [startEvent(), textDeltaEvent("clean"), doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 2, "mid-stream death → retried");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
  assert.equal(
    (events[1] as Extract<AssistantMessageEvent, { type: "text_delta" }>).delta,
    "clean",
    "the failed attempt's partial never reaches the consumer",
  );
});

test("withRequestRetry: tap sees every attempt's raw events + the discard notice (spec §4.2)", async () => {
  const { fn } = scriptedBase([
    { events: [startEvent(), textDeltaEvent("partial"), errorEvent("Connection error.")] },
    { events: [startEvent(), textDeltaEvent("clean"), doneEvent()] },
  ]);
  const tapped: Array<{ attempt: number; type: string }> = [];
  const discarded: Array<{ attempt: number; reason: string }> = [];
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    onAttemptEvent: (attempt, event) => tapped.push({ attempt, type: event.type }),
    onAttemptDiscarded: (attempt, reason) => discarded.push({ attempt, reason }),
  });
  await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.deepEqual(tapped, [
    { attempt: 1, type: "start" },
    { attempt: 1, type: "text_delta" },
    { attempt: 1, type: "error" },
    { attempt: 2, type: "start" },
    { attempt: 2, type: "text_delta" },
    { attempt: 2, type: "done" },
  ]);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0]!.attempt, 1);
  assert.match(discarded[0]!.reason, /Connection error/);
});

test("withRequestRetry: a throwing tap never affects the run", async () => {
  const { fn } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    onAttemptEvent: () => {
      throw new Error("tap exploded");
    },
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

test("withRequestRetry: maxWaitMs=0 still wraps — single attempt, error tagged (#14)", async () => {
  // The wrapper must ALWAYS apply because it owns the Layer-0 origin tag the
  // runner's phase-llm rejection depends on. Behaviour: exactly one attempt.
  const { fn, calls } = scriptedBase([{ events: [errorEvent("503 unavailable")] }]);
  const wrapped = withRequestRetry(fn, { maxWaitMs: 0, ...FAST });
  assert.notEqual(wrapped, fn, "wrapper applies even at maxWaitMs=0");
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "maxWaitMs=0 → single attempt");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.ok(isLlmRequestError(err.errorMessage), "terminal error carries the Layer-1 tag");
});

// ---------------------------------------------------------------------------
// Layer-1 origin tagging (Decision C / #14): every terminal error surfaced by
// the wrapper marks "originated in the LLM request layer"; the runner treats
// only tagged errors as mechanical (resume candidates).
// ---------------------------------------------------------------------------

test("tagLlmRequestError/isLlmRequestError/stripLlmRequestTag round-trip (#14)", () => {
  const tagged = tagLlmRequestError("529 overloaded");
  assert.ok(tagged.includes(LLM_REQUEST_FAILURE_MARKER));
  assert.ok(isLlmRequestError(tagged));
  assert.equal(isLlmRequestError("529 overloaded"), false);
  assert.equal(isLlmRequestError(undefined), false);
  assert.equal(stripLlmRequestTag(tagged), "529 overloaded");
  // Idempotent: re-tagging (e.g. an admission error flowing through the retry
  // wrapper after being synthesized below it) does not stack markers.
  assert.equal(tagLlmRequestError(tagged), tagged);
  // An empty/undefined message still gains the marker (the tag IS the signal).
  assert.equal(tagLlmRequestError(undefined), LLM_REQUEST_FAILURE_MARKER);
});

test("tag does not change classification: status prefix and keywords still parse (#14)", () => {
  // Marker is a suffix, so extractStatus's leading-status parse is unaffected,
  // and its text matches no classification keyword.
  assert.equal(classifyLlmError(tagLlmRequestError("429 rate limited"), "error"), "environmental");
  assert.equal(classifyLlmError(tagLlmRequestError("400 invalid request"), "error"), "content");
  assert.equal(classifyLlmError(tagLlmRequestError("LLM scheduler stopped"), "error"), "aborted");
  assert.equal(classifyLlmError(LLM_REQUEST_FAILURE_MARKER, "error"), "environmental");
});

test("class marker round-trip: tagged errors carry a parseable class (spec §4.3)", () => {
  const tagged = tagLlmRequestError("503 unavailable", "environmental");
  assert.ok(isLlmRequestError(tagged));
  assert.equal(extractLlmRequestClass(tagged), "environmental");
  assert.equal(stripLlmRequestTag(tagged), "503 unavailable");
  const content = tagLlmRequestError("413 prompt is too long", "content");
  assert.equal(extractLlmRequestClass(content), "content");
  // Re-tagging never stacks or rewrites the class: first surfacing wins.
  assert.equal(tagLlmRequestError(content, "environmental"), content);
  // Class-less legacy tags parse as undefined.
  assert.equal(extractLlmRequestClass(tagLlmRequestError("529 overloaded")), undefined);
});

test("withRequestRetry: an exhausted budget surfaces a TAGGED terminal error (#14)", async () => {
  const { fn } = scriptedBase([{ events: [errorEvent("500 internal")] }]);
  const wrapped = withRequestRetry(fn, { maxWaitMs: 0, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  const err = (events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.ok(isLlmRequestError(err.errorMessage), "exhaust path tags");
  assert.equal(stripLlmRequestTag(err.errorMessage ?? ""), "500 internal");
});

test("withRequestRetry: content and exhausted mid-stream errors are tagged with their class (#14/§4.3)", async () => {
  // Content failure: surfaced in one attempt, tagged with class.
  const content = scriptedBase([{ events: [errorEvent("413 prompt is too long")] }]);
  const contentEvents = await drain(withRequestRetry(content.fn, { ...FAST })(MODEL, CONTEXT, undefined));
  const contentErr = (contentEvents[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.ok(isLlmRequestError(contentErr.errorMessage), "content path tags");
  assert.equal(extractLlmRequestClass(contentErr.errorMessage), "content");

  // Mid-stream death on every attempt: retried to exhaustion, then ONE terminal
  // error surfaces (no partial events forwarded) carrying the class marker.
  const mid = scriptedBase([
    { events: [startEvent(), textDeltaEvent("partial"), errorEvent("Connection error.")] },
  ]);
  const midEvents = await drain(withRequestRetry(mid.fn, { maxWaitMs: 0, ...FAST })(MODEL, CONTEXT, undefined));
  assert.deepEqual(midEvents.map((e) => e.type), ["error"], "partials discarded on the exhaust path too");
  const midErr = (midEvents[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.ok(isLlmRequestError(midErr.errorMessage), "exhaust path tags");
  assert.equal(extractLlmRequestClass(midErr.errorMessage), "environmental");
});

test("withRequestRetry: a throwing base is surfaced as a terminal error and classified, not an unhandled rejection (#12)", async () => {
  // A scheduler-less composition (the documented test path) passes the raw base
  // fn straight to the retry wrapper; a synchronous throw used to escape the
  // void-IIFE as a process-fatal unhandled rejection AND leave `outer` without a
  // terminal event (hung consumer). It must instead synthesize the terminal
  // error and feed the normal classify/retry logic (retryable → bounded retries).
  let calls = 0;
  const fn: StreamFn = () => {
    calls += 1;
    throw new Error("ECONNRESET socket hang up");
  };
  const wrapped = withRequestRetry(fn, { maxWaitMs: 0, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 1, "environmental throw surfaces once the budget is exhausted");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "error");
  assert.match(err.errorMessage ?? "", /ECONNRESET/);
});

test("withRequestRetry: a thrown AbortError is fatal — single attempt, stopReason aborted (#12)", async () => {
  let calls = 0;
  const fn: StreamFn = () => {
    calls += 1;
    const err = new Error("operation aborted");
    err.name = "AbortError";
    throw err;
  };
  const wrapped = withRequestRetry(fn, { ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 1, "aborted is never retried");
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "aborted");
});

test("withRequestRetry: a mid-iteration throw is retried like any mid-stream death (#12/§4.1)", async () => {
  // Tokens buffered, then the inner stream THROWS (rather than emitting an
  // error event). The partial is discarded and the request retried; the clean
  // second attempt is all the consumer sees.
  let calls = 0;
  const fn: StreamFn = () => {
    calls += 1;
    if (calls === 1) {
      return (async function* () {
        yield startEvent();
        yield textDeltaEvent("partial");
        throw new Error("socket reset mid-stream");
      })() as unknown as AssistantMessageEventStream;
    }
    return scriptedStream([startEvent(), textDeltaEvent("clean"), doneEvent()]);
  };
  const wrapped = withRequestRetry(fn, { ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 2, "mid-iteration throw → retried");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

// ---------------------------------------------------------------------------
// Budget semantics (spec §6, maintainer decision / review issue #3): the
// wall-clock budget bounds only the WAITING (admission-queue waits +
// inter-attempt backoff sleeps) and a STUCK zero-token attempt. It must NEVER
// abort an attempt that has produced ≥1 token (incl. reasoning).
// ---------------------------------------------------------------------------

const thinkingDeltaEvent = (delta: string): AssistantMessageEvent => ({
  type: "thinking_delta",
  contentIndex: 0,
  delta,
  partial: message(),
});

/**
 * A StreamFn whose single attempt emits an opening event, then (optionally) a
 * first content event, then — only AFTER `firstTokenDelayMs` — keeps the stream
 * open until either it is aborted (resolving to a thrown AbortError) or
 * `holdMs` elapses and it emits `done`. Lets a test drive an attempt past the
 * budget deadline and observe whether the budget signal reaches it.
 */
function lateStream(opts: {
  firstEvent?: AssistantMessageEvent; // emitted ~immediately if present
  holdMs: number; // how long the stream stays open after the first event before `done`
}): { fn: StreamFn; aborted: () => boolean; calls: () => number } {
  let abortedFlag = false;
  let calls = 0;
  const fn: StreamFn = (_model, _context, streamOptions) => {
    calls += 1;
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
    return (async function* () {
      yield startEvent();
      if (opts.firstEvent) yield opts.firstEvent;
      // Stay open. If the (per-attempt) signal fires while we are open, throw an
      // AbortError exactly as a pi-ai provider would on a cancelled fetch.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.holdMs);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            abortedFlag = true;
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              abortedFlag = true;
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            },
            { once: true },
          );
        }
      });
      yield doneEvent();
    })() as unknown as AssistantMessageEventStream;
  };
  return { fn, aborted: () => abortedFlag, calls: () => calls };
}

test("withRequestRetry: a healthy stream that emits a token then runs past the deadline is NOT aborted (spec §6 / #3)", async () => {
  // First a text token arrives well within the budget, THEN the stream stays
  // open far past the deadline. The budget must not touch it — it completes.
  const stream = lateStream({ firstEvent: textDeltaEvent("hi"), holdMs: 80 });
  const wrapped = withRequestRetry(stream.fn, { maxWaitMs: 20, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(stream.aborted(), false, "the budget never aborted the token-producing attempt");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
  assert.equal(stream.calls(), 1, "no retry — the first attempt completed");
});

test("withRequestRetry: a REASONING token also makes the attempt budget-immune (first token incl. thinking) (spec §6 / #3)", async () => {
  // The only content the model emits before the deadline is a thinking delta.
  // Reasoning counts as first-token, so the attempt is immune and completes.
  const stream = lateStream({ firstEvent: thinkingDeltaEvent("let me think"), holdMs: 80 });
  const wrapped = withRequestRetry(stream.fn, { maxWaitMs: 20, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(stream.aborted(), false, "reasoning is first-token — attempt immune");
  assert.deepEqual(events.map((e) => e.type), ["start", "thinking_delta", "done"]);
});

test("withRequestRetry: a ZERO-token attempt IS aborted at the deadline and parks (environmental) (spec §6 / #3)", async () => {
  // The attempt emits only `start` (the opener — not content) and stays silent.
  // The budget aborts it; the surfaced failure is environmental wait-exhaustion
  // (parks failed-resumable), never an intentional abort.
  const stream = lateStream({ holdMs: 1000 });
  const wrapped = withRequestRetry(stream.fn, { maxWaitMs: 20, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(stream.aborted(), true, "the silent attempt was aborted by the budget");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "error", "re-labelled environmental, not an abort");
  assert.equal(extractLlmRequestClass(err.errorMessage), "environmental");
  assert.match(err.errorMessage ?? "", /wall-clock budget/);
});

test("withRequestRetry: a CALLER abort during a HEALTHY token-producing attempt still aborts it (onCallerAbort survives detachBudget) (spec §6 / drain)", async () => {
  // The dual of the immunity tests above. A token arrives first, so the budget
  // listener is DETACHED and the attempt is budget-immune. The caller (a pool
  // drain / operator Stop) then aborts mid-stream — and that MUST still reach
  // the inner stream and abort it. The fix that makes a token-producing attempt
  // budget-immune detaches ONLY the budget listener; the caller's abort listener
  // must remain wired, or a drained/stopped healthy stream would run forever.
  // A generous budget (never fires) isolates the caller-abort path.
  const stream = lateStream({ firstEvent: textDeltaEvent("streaming"), holdMs: 10_000 });
  const controller = new AbortController();
  const wrapped = withRequestRetry(stream.fn, { maxWaitMs: 10_000, ...FAST });
  const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
  // Abort well after the first token (attempt is immune) but long before holdMs.
  setTimeout(() => controller.abort(), 30);
  const events = await drain(out);
  assert.equal(stream.aborted(), true, "the caller's abort reached the immune, token-producing attempt");
  assert.equal(stream.calls(), 1, "no retry — an abort is never retried");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "aborted", "a caller abort surfaces an abort, not wait-exhaustion");
  assert.equal(
    extractLlmRequestClass(err.errorMessage),
    "aborted",
    "the class marker is `aborted` so the run is treated as a drain/Stop, not parked",
  );
});

test("withRequestRetry: budget expiry mid-ADMISSION-wait aborts the acquire (zero-token) (spec §6 / #3)", async () => {
  // Model the admission wait: `base` blocks inside `await base(...)` (before any
  // event) until the signal fires. A budget expiry here MUST abort the acquire
  // and surface environmental wait-exhaustion (the one wait the spec sanctions).
  let aborted = false;
  const fn: StreamFn = (_model, _context, streamOptions) => {
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            const e = new Error("admission acquire aborted");
            e.name = "AbortError";
            reject(e);
          },
          { once: true },
        );
      });
      yield doneEvent();
    })() as unknown as AssistantMessageEventStream;
  };
  const wrapped = withRequestRetry(fn, { maxWaitMs: 15, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(aborted, true, "the admission acquire was aborted by the budget");
  const err = (events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(extractLlmRequestClass(err.errorMessage), "environmental");
  assert.match(err.errorMessage ?? "", /wall-clock budget/);
});

test("withRequestRetry: a larger budget lets a slow-to-first-token attempt survive where a small one parks (#3 override effect)", async () => {
  // Same stream — emits its first token only after ~40ms. With a 15ms budget it
  // is aborted before the token (parks); with a 200ms budget (the per-model
  // override) the token arrives first and the attempt completes. This is exactly
  // what threading a larger per-model `maxWaitMs` buys at the deadline.
  const slow = () =>
    ((_model: never, _context: never, streamOptions: never) => {
      const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
      return (async function* () {
        yield startEvent();
        // Wait ~40ms before the first token, but bail early if aborted.
        const tokenArrived = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), 40);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(false);
            },
            { once: true },
          );
        });
        if (!tokenArrived) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        yield textDeltaEvent("late");
        yield doneEvent();
      })() as unknown as AssistantMessageEventStream;
    }) as unknown as StreamFn;

  // Small budget: aborted before the token → environmental park.
  const smallEvents = await drain(withRequestRetry(slow(), { maxWaitMs: 15, ...FAST })(MODEL, CONTEXT, undefined));
  assert.deepEqual(smallEvents.map((e) => e.type), ["error"], "small budget parks before first token");
  const smallErr = (smallEvents[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(extractLlmRequestClass(smallErr.errorMessage), "environmental");

  // Larger budget (per-model override): the token arrives first → completes.
  const largeEvents = await drain(withRequestRetry(slow(), { maxWaitMs: 200, ...FAST })(MODEL, CONTEXT, undefined));
  assert.deepEqual(largeEvents.map((e) => e.type), ["start", "text_delta", "done"], "larger budget survives to first token");
});

// ---------------------------------------------------------------------------
// Drain abort DURING the inter-attempt backoff sleep (spec §6/§7 / review issue
// #4). When a caller abort (pool drain / operator Stop) lands while the wrapper
// is sleeping between attempts, the surfaced terminal event MUST be `aborted`
// (stopReason "aborted" + the [llm-request:aborted] class marker) so that
// `wasRunAborted()` reads true in the worker pools and the drained job takes the
// §7 job-pending path — NOT the stale environmental error of the attempt that
// preceded the sleep. A BUDGET expiry of the same sleep stays environmental
// (genuine wait-exhaustion). This path is distinct from the existing drain tests,
// which fake the aborted shape directly; here the abort is genuinely delivered
// mid-sleep.
// ---------------------------------------------------------------------------

/**
 * Run `body` with `Math.random` pinned to `value`, restoring it afterwards.
 * Full-jitter backoff is `random() * ceiling`, so pinning random to ~1 makes the
 * inter-attempt sleep deterministically the full `backoffMaxMs` — a real (not
 * collapsed-to-~0) sleep window the abort can reliably land inside.
 */
async function withPinnedRandom(value: number, body: () => Promise<void>): Promise<void> {
  const original = Math.random;
  Math.random = () => value;
  try {
    await body();
  } finally {
    Math.random = original;
  }
}

test("withRequestRetry: a caller abort landing DURING the backoff sleep surfaces `aborted`, not the stale environmental error (spec §6/§7 / #4)", async () => {
  // The first attempt fails environmentally (503), so the wrapper enters the
  // local backoff sleep. While it is sleeping, the caller aborts (a pool drain).
  // The catch must surface an `aborted` event, not the 503 it was carrying.
  // Random is pinned high so the backoff is the full 200ms — a genuine sleep the
  // abort lands inside (NOT the pre-baked aborted shape the pool drain tests use).
  await withPinnedRandom(0.999, async () => {
    const controller = new AbortController();
    const { fn, calls } = scriptedBase([
      { events: [errorEvent("503 unavailable")] },
      // A clean retry IS scripted, but the abort must fire first so it is never
      // reached — proving the abort short-circuits the backoff, not the retry.
      { events: [startEvent(), textDeltaEvent("should-not-appear"), doneEvent()] },
    ]);
    const wrapped = withRequestRetry(fn, { backoffBaseMs: 200, backoffMaxMs: 200 });
    const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
    // Fire the caller abort after the first failure has settled and the wrapper
    // is sleeping (well within the ~200ms backoff window).
    setTimeout(() => controller.abort(), 40);
    const events = await drain(out);
    assert.equal(calls(), 1, "the retry attempt was never issued — abort short-circuited the backoff");
    assert.deepEqual(events.map((e) => e.type), ["error"]);
    const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
    assert.equal(err.stopReason, "aborted", "a mid-sleep caller abort surfaces an abort, not the 503");
    assert.equal(
      extractLlmRequestClass(err.errorMessage),
      "aborted",
      "the class marker is `aborted` so wasRunAborted() reads true and drain compensation fires",
    );
  });
});

test("withRequestRetry: a caller abort mid-backoff records ONE ring row for the attempt, not two (FU-B)", async () => {
  // The pre-sleep environmental result of the attempt is recorded on the ring
  // BEFORE the backoff sleep. When a caller abort then lands mid-sleep, the
  // attempt's terminal disposition changes to aborted-on-drain — but no NEW wire
  // call happened, so the ring must show ONE row for that attempt number, updated
  // in place to `aborted`, NOT a second appended row.
  await withPinnedRandom(0.999, async () => {
    const ring = new LlmRequestRing(16);
    const controller = new AbortController();
    const { fn } = scriptedBase([
      { events: [errorEvent("503 unavailable")] },
      { events: [startEvent(), textDeltaEvent("should-not-appear"), doneEvent()] },
    ]);
    const wrapped = withRequestRetry(fn, { backoffBaseMs: 200, backoffMaxMs: 200 }, { ring });
    const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
    setTimeout(() => controller.abort(), 40);
    const events = await drain(out);
    assert.equal((events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error.stopReason, "aborted");

    const rows = ring.list();
    assert.equal(rows.length, 1, "exactly one ring row for the single attempt — no duplicate");
    assert.equal(rows[0]!.attempt, 1);
    assert.equal(rows[0]!.outcome, "aborted", "the row was updated in place to the terminal aborted outcome");
    assert.equal(rows[0]!.class, "aborted");
    assert.equal(rows[0]!.status, undefined, "the stale environmental 503 status was cleared");
  });
});

test("withRequestRetry: a BUDGET expiry during the backoff sleep stays environmental (not aborted) (spec §6 / #4)", async () => {
  // Same mid-sleep abort, but driven by the wall-clock budget rather than the
  // caller. This is genuine wait-exhaustion, so it must keep environmental
  // semantics (parks failed-resumable) — only a CALLER abort surfaces `aborted`.
  await withPinnedRandom(0.999, async () => {
    const { fn, calls } = scriptedBase([{ events: [errorEvent("503 unavailable")] }]);
    // backoff (200ms) outlasts the budget (25ms): the budget aborts the sleep.
    const wrapped = withRequestRetry(fn, { maxWaitMs: 25, backoffBaseMs: 200, backoffMaxMs: 200 });
    const events = await drain(wrapped(MODEL, CONTEXT, undefined));
    // The budget-expiry catch `continue`s; the loop re-enters, the now-expired
    // budget aborts the next attempt immediately, and it exits via the
    // wait-exhausted path. (The CALLER-abort case short-circuits at calls()===1;
    // the budget case deliberately does not — that asymmetry is the fix.)
    assert.equal(calls(), 2, "budget case loops once more then exits wait-exhausted");
    assert.deepEqual(events.map((e) => e.type), ["error"]);
    const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
    assert.equal(err.stopReason, "error", "budget expiry is wait-exhaustion, not an abort");
    assert.equal(extractLlmRequestClass(err.errorMessage), "environmental");
  });
});

test("withRequestRetry: an empty inner stream is environmental — retried like any failure", async () => {
  // "Empty streams" are an explicit environmental example (spec §3): the
  // synthesized terminal error re-enters the retry loop like any other.
  const { fn, calls } = scriptedBase([
    { events: [], endWithoutTerminal: true },
    { events: [startEvent(), textDeltaEvent("ok"), doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, FAST);
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 2, "1 empty attempt + 1 clean retry");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

// ---------------------------------------------------------------------------
// Token-usage tracking (spec TOKEN-USAGE-TRACKING §3.1/§6.2/§6.3).
// ---------------------------------------------------------------------------

test("classifyLlmError: pi-ai overflow patterns beyond the keyword list are class content (§6.3)", () => {
  // Provider phrasings NOT in the hand-rolled CONTENT_KEYWORDS, recognized via
  // pi-ai's isContextOverflow pattern set.
  assert.equal(
    classifyLlmError("This endpoint's maximum context length is 8192 tokens", "error"),
    "content",
  );
  assert.equal(
    classifyLlmError("This model's maximum prompt length is 131072 but the request contains 200000 tokens", "error"),
    "content",
  );
  // But an overflow-adjacent rate-limit phrasing stays environmental (the
  // NON_OVERFLOW exclusion), so a 429 is never misread as content.
  assert.equal(classifyLlmError("429 rate limit: too many tokens, slow down", "error"), "environmental");
});

test("classifyLlmError: a 429 carrying 'too many tokens' WITHOUT a rate-limit phrasing stays environmental (#4)", () => {
  // pi-ai's NON_OVERFLOW exclusion only covers the literal "rate limit" / "too
  // many requests" wordings, so a 429 phrased "too many tokens in flight, retry
  // later" matches the generic overflow pattern. The parseable transient status
  // (429) must veto the overflow augmentation so this stays retryable — a
  // transient blip must never park the session as a content failure.
  assert.equal(
    classifyLlmError("429 too many tokens in flight, retry later", "error"),
    "environmental",
  );
  // A 5xx with overflow-adjacent body text — recognized ONLY by pi-ai's pattern
  // set, NOT by the hand-rolled CONTENT_KEYWORDS — is protected by its transient
  // status and stays environmental. (A 5xx carrying a literal CONTENT_KEYWORD
  // like "prompt is too long" still classifies content by design; that gate is
  // unchanged. This case isolates the newly-gated isContextOverflow path.)
  assert.equal(
    classifyLlmError(
      "503 this model's maximum prompt length is 131072 but the request contains 200000 tokens",
      "error",
    ),
    "environmental",
  );
});

test("classifyLlmError: a genuine overflow with NO parseable status still classifies content (#4)", () => {
  // The status gate only protects parseable transients; a no-status overflow body
  // recognized only by the pi-ai pattern set must still classify content.
  assert.equal(
    classifyLlmError(
      "This model's maximum prompt length is 131072 but the request contains 200000 tokens",
      "error",
    ),
    "content",
  );
});

test("withRequestRetry: a committed done fires onRequestCommitted with usage + records ring usage (§3.1/§3.2)", async () => {
  const committed = message({
    stopReason: "stop",
    usage: {
      input: 312,
      output: 1800,
      cacheRead: 43_100,
      cacheWrite: 0,
      totalTokens: 45_212,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0061 },
    },
  });
  const done: AssistantMessageEvent = { type: "done", reason: "stop", message: committed };
  const { fn } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), done] }]);
  const ring = new LlmRequestRing();
  const captured: AssistantMessage[] = [];
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    ring,
    onRequestCommitted: (msg) => captured.push(msg),
  });
  await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(captured.length, 1, "onRequestCommitted fires exactly once on commit");
  assert.equal(captured[0]!.usage.totalTokens, 45_212);
  const rows = ring.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "done");
  assert.deepEqual(rows[0]!.usage, {
    input: 312,
    output: 1800,
    cacheRead: 43_100,
    cacheWrite: 0,
    totalTokens: 45_212,
    cost: 0.0061,
  });
});

test("withRequestRetry: a terminal error never fires onRequestCommitted and records no ring usage (§3.1)", async () => {
  const { fn } = scriptedBase([{ events: [errorEvent("400 invalid request")] }]);
  const ring = new LlmRequestRing();
  let committedCount = 0;
  const wrapped = withRequestRetry(fn, { maxWaitMs: 0, ...FAST }, {
    ring,
    onRequestCommitted: () => committedCount++,
  });
  await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(committedCount, 0, "no commit hook on a failed attempt");
  assert.equal(ring.list()[0]!.usage, undefined, "error rows carry no usage (not a misleading zero)");
});

test("withRequestRetry: checkContextBudget pre-empts the request as a content failure without calling base (§6.2)", async () => {
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const ring = new LlmRequestRing();
  let committedCount = 0;
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    ring,
    onRequestCommitted: () => committedCount++,
    checkContextBudget: () => "context token limit exceeded: observed context 90000 tokens >= limit 80000",
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 0, "the base stream fn is never invoked — no retry budget consumed");
  assert.equal(committedCount, 0);
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.ok(isLlmRequestError(err.errorMessage), "carries the Layer-1 origin tag");
  assert.equal(extractLlmRequestClass(err.errorMessage), "content", "classified content (reuses that path)");
  assert.match(err.errorMessage ?? "", /context token limit exceeded/);
  // The pre-empted request is recorded once on the ring as a content error.
  const rows = ring.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "error");
  assert.equal(rows[0]!.class, "content");
});

test("withRequestRetry: checkContextBudget returning undefined lets the request proceed normally (§6.2)", async () => {
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    checkContextBudget: () => undefined,
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1);
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

test("withRequestRetry: a THROWING checkContextBudget does not crash/hang — degrades to no local block (#2)", async () => {
  // The factory-bound impl calls logger.warn(...), which can throw. An unguarded
  // throw would escape the void-IIFE as a process-fatal unhandled rejection and
  // leave `outer` without a terminal event (hung consumer). The pre-flight must
  // be exception-isolated: on a throw it degrades to "no local block" and the
  // request proceeds to the provider (the D3 fallback) and terminates cleanly.
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    checkContextBudget: () => {
      throw new Error("logger exploded inside the budget check");
    },
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "the request proceeded — no violation applied");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"], "run terminated cleanly");
});

test("withRequestRetry: a THROWING checkCostBudget does not crash/hang — degrades to no local block (SESSION-COST-LIMITS §2.2)", async () => {
  // Parallel to the checkContextBudget throw test above: the factory-bound cost
  // pre-flight flows through the same try/catch and must be equally
  // exception-isolated. A throw out of checkCostBudget must NOT escape the
  // void-IIFE as a process-fatal unhandled rejection or leave `outer` without a
  // terminal event; it degrades to "no local block" so the request proceeds to
  // the provider and terminates cleanly. checkContextBudget is left undefined so
  // the `??` reaches the cost check and the throw originates there.
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    checkCostBudget: () => {
      throw new Error("logger exploded inside the cost budget check");
    },
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "the request proceeded — no violation applied");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"], "run terminated cleanly");
});

test("withRequestRetry: checkCostBudget pre-empts as a content failure without calling base (SESSION-COST-LIMITS §2.2)", async () => {
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const ring = new LlmRequestRing();
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    ring,
    checkContextBudget: () => undefined,
    checkCostBudget: () => "session cost limit exceeded: observed combined cost $1.2000 >= limit $1.0000",
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 0, "base stream never invoked — no retry budget consumed");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(extractLlmRequestClass(err.errorMessage), "content", "reuses the content-class path");
  assert.match(err.errorMessage ?? "", /session cost limit exceeded/);
  const rows = ring.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.class, "content");
});

test("withRequestRetry: checkContextBudget is checked BEFORE checkCostBudget (first violation wins)", async () => {
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  let costChecked = false;
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    checkContextBudget: () => "context token limit exceeded: observed context 90000 tokens >= limit 80000",
    checkCostBudget: () => {
      costChecked = true;
      return "should not be reached";
    },
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 0);
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.match(err.errorMessage ?? "", /context token limit exceeded/, "context violation surfaced");
  assert.equal(costChecked, false, "cost check short-circuited by the context violation");
});

test("withRequestRetry: both budget checks undefined lets the request proceed normally", async () => {
  const { fn, calls } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    checkContextBudget: () => undefined,
    checkCostBudget: () => undefined,
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1);
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
});

test("withRequestRetry: a committed done LACKING usage does not call the capture hook (#3)", async () => {
  // The two capture branches must be consistent: the ring branch already gates on
  // `usage`, so the onRequestCommitted branch must too. A `done` whose message
  // carries no usage object must NOT invoke the hook (the factory-bound impl
  // dereferences usage.input and would throw, silently dropping the request from
  // the tracker — an undercount). The ring row is still recorded, with no usage.
  const noUsageMessage = { ...message({ stopReason: "stop" }), usage: undefined } as unknown as AssistantMessage;
  const done: AssistantMessageEvent = { type: "done", reason: "stop", message: noUsageMessage };
  const { fn } = scriptedBase([{ events: [startEvent(), textDeltaEvent("hi"), done] }]);
  const ring = new LlmRequestRing();
  let committedCount = 0;
  const wrapped = withRequestRetry(fn, { ...FAST }, {
    ring,
    onRequestCommitted: () => committedCount++,
  });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"], "the run still completes");
  assert.equal(committedCount, 0, "the capture hook is NOT called when usage is absent");
  const rows = ring.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "done");
  assert.equal(rows[0]!.usage, undefined, "no usage recorded on the ring either");
});
