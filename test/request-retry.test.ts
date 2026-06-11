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
