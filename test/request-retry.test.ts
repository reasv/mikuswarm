import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { classifyLlmError, withRequestRetry } from "../src/agent/request-retry.js";

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

test("classifyLlmError: aborted is fatal", () => {
  assert.equal(classifyLlmError("Request was aborted", "aborted"), "fatal");
});

test("classifyLlmError: auth/validation statuses are fatal", () => {
  assert.equal(classifyLlmError("401 {\"type\":\"error\"}", "error"), "fatal");
  assert.equal(classifyLlmError("400 invalid request", "error"), "fatal");
  assert.equal(classifyLlmError("403 forbidden", "error"), "fatal");
  assert.equal(classifyLlmError("404 not found", "error"), "fatal");
  assert.equal(classifyLlmError("422 unprocessable", "error"), "fatal");
});

test("classifyLlmError: rate-limit and 5xx are retryable", () => {
  assert.equal(classifyLlmError("429 {\"type\":\"rate_limit_error\"}", "error"), "retryable");
  assert.equal(classifyLlmError("500 internal", "error"), "retryable");
  assert.equal(classifyLlmError("502 bad gateway", "error"), "retryable");
  assert.equal(classifyLlmError("503 unavailable", "error"), "retryable");
  assert.equal(classifyLlmError("529 overloaded_error", "error"), "retryable");
});

test("classifyLlmError: network/timeout/unknown default to retryable", () => {
  assert.equal(classifyLlmError("Connection error.", "error"), "retryable");
  assert.equal(classifyLlmError("Request timed out.", "error"), "retryable");
  assert.equal(classifyLlmError("An unknown error occurred", "error"), "retryable");
  assert.equal(classifyLlmError("Anthropic stream ended before message_stop", "error"), "retryable");
  assert.equal(classifyLlmError(undefined, "error"), "retryable");
});

test("classifyLlmError: auth keywords without a status are fatal", () => {
  assert.equal(classifyLlmError("invalid api key provided", "error"), "fatal");
  assert.equal(classifyLlmError("authentication failed", "error"), "fatal");
});

test("classifyLlmError: the scheduler-stopped marker is fatal (#11)", () => {
  assert.equal(classifyLlmError("LLM scheduler stopped", "error"), "fatal");
});

test("classifyLlmError: a 3-digit token inside a body is not mistaken for a status", () => {
  // No leading/labelled status → falls through to keyword/default. "tokens: 500"
  // must NOT be read as HTTP 500 (it would be retryable anyway, but the point is
  // the value is ignored as a status). A bare body number near auth wording stays fatal.
  assert.equal(classifyLlmError("error: account suspended, unauthorized after 404 strikes", "error"), "fatal");
});

test("withRequestRetry: retries a pre-commit retryable failure then succeeds", async () => {
  const { fn, calls } = scriptedBase([
    { events: [errorEvent("503 unavailable")] },
    { events: [startEvent(), textDeltaEvent("hi"), doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { retries: 4, ...FAST });
  const out = wrapped(MODEL, CONTEXT, undefined);
  const events = await drain(out);
  assert.equal(calls(), 2, "base re-issued exactly once");
  // The failed attempt is invisible: no error event, content + done forwarded.
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
  const final = await out.result();
  assert.equal(final.stopReason, "stop");
});

test("withRequestRetry: a fatal error is forwarded without retrying", async () => {
  const { fn, calls } = scriptedBase([
    { events: [errorEvent("401 unauthorized")] },
    { events: [doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { retries: 4, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "no retry on fatal");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
});

test("withRequestRetry: exhausts attempts then forwards the last error", async () => {
  const { fn, calls } = scriptedBase([{ events: [errorEvent("500 internal")] }]);
  const wrapped = withRequestRetry(fn, { retries: 2, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 3, "1 initial + 2 retries");
  assert.deepEqual(events.map((e) => e.type), ["error"]);
});

test("withRequestRetry: a mid-stream failure after commit is NOT retried", async () => {
  // Content forwarded, THEN the stream drops. Layer 1 cannot replay; the error is
  // surfaced (Layer-2 resume territory), and the base is called only once.
  const { fn, calls } = scriptedBase([
    { events: [startEvent(), textDeltaEvent("partial"), errorEvent("Connection error.")] },
    { events: [doneEvent()] },
  ]);
  const wrapped = withRequestRetry(fn, { retries: 4, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1, "committed → no retry");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "error"]);
});

test("withRequestRetry: retries=0 returns the base fn unwrapped", () => {
  const { fn } = scriptedBase([{ events: [doneEvent()] }]);
  const wrapped = withRequestRetry(fn, { retries: 0, ...FAST });
  assert.equal(wrapped, fn);
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
  const wrapped = withRequestRetry(fn, { retries: 2, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 3, "retryable throw consumes the bounded attempts");
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
  const wrapped = withRequestRetry(fn, { retries: 4, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 1, "aborted is never retried");
  const err = (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(err.stopReason, "aborted");
});

test("withRequestRetry: a mid-iteration throw after commit terminates the stream without retrying (#12)", async () => {
  // Content forwarded, then the inner stream THROWS (rather than emitting an
  // error event). Cannot replay (committed); the consumer must still receive a
  // terminal error event instead of hanging.
  let calls = 0;
  const fn: StreamFn = () => {
    calls += 1;
    return (async function* () {
      yield startEvent();
      yield textDeltaEvent("partial");
      throw new Error("socket reset mid-stream");
    })() as unknown as AssistantMessageEventStream;
  };
  const wrapped = withRequestRetry(fn, { retries: 4, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls, 1, "committed → no retry");
  assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "error"]);
  const err = (events[2] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.match(err.errorMessage ?? "", /mid-stream/);
});

test("withRequestRetry: an empty inner stream yields a synthesized terminal error", async () => {
  const { fn, calls } = scriptedBase([{ events: [], endWithoutTerminal: true }]);
  // retries=0 would just return base; use 1 so the wrapper is active. The empty
  // stream is not an `error` event, so it is not retried — it is surfaced once.
  const wrapped = withRequestRetry(fn, { retries: 1, ...FAST });
  const events = await drain(wrapped(MODEL, CONTEXT, undefined));
  assert.equal(calls(), 1);
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  const final = await events[0] && (events[0] as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(final.stopReason, "error");
});
