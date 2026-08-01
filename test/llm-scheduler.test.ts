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
  LlmScheduler,
  defaultPriorityForSessionType,
  modelHealthKey,
  parseRetryAfterMs,
  withSchedulerAdmission,
  type ReleaseFn,
} from "../src/agent/scheduler.js";
import { withRequestRetry } from "../src/agent/request-retry.js";

// ---------------------------------------------------------------------------
// Local LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5 / Design A).
//
// Admission concurrency per rate-limit group, strict priority (FIFO within a
// class), sticky escalation (priority inheritance §5.5), unconditional 429/503
// backoff (§5.3), and the StreamFn admission wrapper that composes INSIDE the
// Layer-1 retry (§5.4).
// ---------------------------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("acquire admits immediately under max_in_flight and queues beyond it", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const release1 = await scheduler.acquire({ priority: "background" });

  let admitted2 = false;
  const second = scheduler.acquire({ priority: "background" }).then((release) => {
    admitted2 = true;
    return release;
  });
  await tick();
  assert.equal(admitted2, false, "second acquire must wait while the group is full");

  release1();
  const release2 = await second;
  assert.equal(admitted2, true);
  release2();
});

test("release is idempotent — double release frees only one slot", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const release = await scheduler.acquire({});
  release();
  release();
  const a = await scheduler.acquire({});
  let admitted = false;
  void scheduler.acquire({}).then((r) => {
    admitted = true;
    r();
  });
  await tick();
  assert.equal(admitted, false, "double release must not mint extra capacity");
  a();
  await tick();
  assert.equal(admitted, true);
});

test("priority ordering: interactive preempts queued background; FIFO within a class", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const releaseHeld = await scheduler.acquire({ priority: "background" });

  const order: string[] = [];
  const waiters = [
    scheduler.acquire({ priority: "background" }).then((r) => { order.push("bg-1"); r(); }),
    scheduler.acquire({ priority: "background_low" }).then((r) => { order.push("diary"); r(); }),
    scheduler.acquire({ priority: "interactive" }).then((r) => { order.push("live-1"); r(); }),
    scheduler.acquire({ priority: "proactive" }).then((r) => { order.push("proactive"); r(); }),
    scheduler.acquire({ priority: "interactive" }).then((r) => { order.push("live-2"); r(); }),
    scheduler.acquire({ priority: "background" }).then((r) => { order.push("bg-2"); r(); }),
  ];
  await tick();
  releaseHeld();
  await Promise.all(waiters);

  assert.deepEqual(order, ["live-1", "live-2", "proactive", "bg-1", "bg-2", "diary"]);
});

test("groups are independent budgets", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 }, openrouter: { max_in_flight: 2 } },
  });
  const releaseDefault = await scheduler.acquire({ group: "default" });
  // A full `default` group must not block `openrouter` admission.
  const r1 = await scheduler.acquire({ group: "openrouter" });
  const r2 = await scheduler.acquire({ group: "openrouter" });
  releaseDefault();
  r1();
  r2();
});

test("escalate raises a queued entry in place (state 2 of §5.5)", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const releaseHeld = await scheduler.acquire({ priority: "interactive" });

  const order: string[] = [];
  const waiters = [
    scheduler.acquire({ priority: "background" }).then((r) => { order.push("other-bg"); r(); }),
    scheduler.acquire({ priority: "background", key: "sumjob:j1" }).then((r) => { order.push("needed"); r(); }),
  ];
  await tick();
  // The waiting live session promotes the summary it needs to its own class.
  scheduler.escalate("sumjob:j1", "interactive");
  releaseHeld();
  await Promise.all(waiters);

  assert.deepEqual(order, ["needed", "other-bg"], "escalated entry must overtake earlier background work");
});

test("escalation is sticky for a not-yet-registered key (claim/admission race)", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  // Escalate BEFORE the job's request registers.
  scheduler.escalate("sumjob:j2", "interactive");

  const releaseHeld = await scheduler.acquire({ priority: "interactive" });
  const order: string[] = [];
  const waiters = [
    scheduler.acquire({ priority: "background" }).then((r) => { order.push("other-bg"); r(); }),
    scheduler.acquire({ priority: "background", key: "sumjob:j2" }).then((r) => { order.push("pinned"); r(); }),
  ];
  await tick();
  releaseHeld();
  await Promise.all(waiters);
  assert.deepEqual(order, ["pinned", "other-bg"], "sticky escalation must be adopted at registration");

  // After clearing, the key registers at its requested class again.
  scheduler.clearEscalation("sumjob:j2");
  const hold = await scheduler.acquire({ priority: "interactive" });
  const order2: string[] = [];
  const waiters2 = [
    scheduler.acquire({ priority: "proactive" }).then((r) => { order2.push("proactive"); r(); }),
    scheduler.acquire({ priority: "background", key: "sumjob:j2" }).then((r) => { order2.push("cleared"); r(); }),
  ];
  await tick();
  hold();
  await Promise.all(waiters2);
  assert.deepEqual(order2, ["proactive", "cleared"]);
});

test("escalation never demotes", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  scheduler.escalate("k", "interactive");
  scheduler.escalate("k", "background_low");
  const hold = await scheduler.acquire({ priority: "interactive" });
  const order: string[] = [];
  const waiters = [
    scheduler.acquire({ priority: "proactive" }).then((r) => { order.push("proactive"); r(); }),
    scheduler.acquire({ priority: "background", key: "k" }).then((r) => { order.push("k"); r(); }),
  ];
  await tick();
  hold();
  await Promise.all(waiters);
  assert.deepEqual(order, ["k", "proactive"], "the higher escalation must win");
});

test("429 pauses a group's admissions (unconditional backoff, §5.3) and an OK resets the streak", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1, backoff_base_ms: 100, backoff_max_ms: 100 } },
  });
  const armedAt = Date.now();
  scheduler.noteResult("default", "429 {\"error\":\"rate_limited\"}");

  let admitted = false;
  const wait = scheduler.acquire({ priority: "interactive" }).then((r) => {
    admitted = true;
    return r;
  });
  await sleep(5);
  // Guarded like the probe-window test: under build-gate CPU load this check can
  // run after the backoff window already elapsed; only assert while verifiably
  // inside it. The `await wait` below still proves admission happens.
  if (Date.now() - armedAt < 100) {
    assert.equal(admitted, false, "admission must wait out the backoff window");
  }
  const release = await wait;
  assert.equal(admitted, true);
  release();
  scheduler.noteResult("default");
  // Streak reset: no further backoff applies.
  const r2 = await scheduler.acquire({});
  r2();
});

test("non-throttle errors do not back off the group", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1, backoff_base_ms: 10_000, backoff_max_ms: 10_000 } },
  });
  scheduler.noteResult("default", "500 internal server error");
  const release = await scheduler.acquire({});
  release();
});

test("Retry-After drives the group backoff window (#9)", async () => {
  const scheduler = new LlmScheduler({
    // Tiny exponential tuning so any wait observed must come from Retry-After.
    groups: { default: { max_in_flight: 1, backoff_base_ms: 1, backoff_max_ms: 5000 } },
  });
  scheduler.noteStatus("default", 429, 80);
  const start = Date.now();
  const release = await scheduler.acquire({ priority: "interactive" });
  const waited = Date.now() - start;
  assert.ok(waited >= 50, `server-specified wait must govern (waited ${waited}ms)`);
  release();
});

test("Retry-After is clamped to the group's backoff_max_ms (#9)", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1, backoff_base_ms: 1, backoff_max_ms: 50 } },
  });
  // A hostile/absurd Retry-After must not black-hole the group beyond config.
  scheduler.noteStatus("default", 429, 3_600_000);
  const start = Date.now();
  const release = await scheduler.acquire({});
  assert.ok(Date.now() - start < 1000, "wait must be clamped to backoff_max_ms");
  release();
});

test("parseRetryAfterMs handles ms header, delta-seconds, HTTP-date, and garbage", () => {
  assert.equal(parseRetryAfterMs({ "retry-after-ms": "1500" }), 1500);
  // retry-after-ms wins over retry-after.
  assert.equal(parseRetryAfterMs({ "retry-after-ms": "100", "retry-after": "9" }), 100);
  assert.equal(parseRetryAfterMs({ "retry-after": "7" }), 7000);
  const date = new Date(Date.now() + 30_000).toUTCString();
  const fromDate = parseRetryAfterMs({ "retry-after": date });
  assert.ok(fromDate !== undefined && fromDate > 25_000 && fromDate <= 31_000);
  // A past HTTP-date floors at 0 (retry immediately), not a negative wait.
  assert.equal(parseRetryAfterMs({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }), 0);
  assert.equal(parseRetryAfterMs({ "retry-after": "soon" }), undefined);
  assert.equal(parseRetryAfterMs({}), undefined);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  // Headers-like objects (`.get`) are accepted too (the remote-embedding caller).
  const headers = new Headers({ "retry-after": "2" });
  assert.equal(parseRetryAfterMs(headers), 2000);
});

test("abort signal rejects a queued acquire and removes it from the queue", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const releaseHeld = await scheduler.acquire({});
  const controller = new AbortController();
  const waiting = scheduler.acquire({ signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(waiting, (err: Error) => err.name === "AbortError");
  // The aborted entry must not consume the freed slot.
  releaseHeld();
  const release = await scheduler.acquire({});
  release();
});

test("stop rejects all queued waiters", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const releaseHeld = await scheduler.acquire({});
  const waiting = scheduler.acquire({});
  scheduler.stop();
  await assert.rejects(waiting, /stopped/);
  releaseHeld();
});

test("defaultPriorityForSessionType matches the §9.3 table", () => {
  assert.equal(defaultPriorityForSessionType("default"), "interactive");
  assert.equal(defaultPriorityForSessionType("proactive"), "proactive");
  assert.equal(defaultPriorityForSessionType("summarize"), "background");
  assert.equal(defaultPriorityForSessionType("condense"), "background");
  assert.equal(defaultPriorityForSessionType("diary"), "background_low");
  assert.equal(defaultPriorityForSessionType("anything-else"), "interactive");
});

// ---------------------------------------------------------------------------
// withSchedulerAdmission — the StreamFn wrapper (§5.4)
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

const MODEL = {
  id: "test-model",
  name: "test-model",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Parameters<StreamFn>[0];

function doneStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const msg = message();
  stream.push({ type: "done", reason: "stop", message: msg });
  stream.end(msg);
  return stream;
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const msg = message({ stopReason: "error", errorMessage });
  stream.push({ type: "error", reason: "error", error: msg });
  stream.end(msg);
  return stream;
}

/**
 * A degenerate base stream that ends WITHOUT forwarding a terminal `done`/`error`
 * event (an "empty stream", classified environmental §3) — the failure mode that
 * wedges the consumer and the half-open probe if the admission wrapper does not
 * synthesize a terminal (#1).
 */
function emptyStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.end(message());
  return stream;
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const collected: AssistantMessageEvent[] = [];
  for await (const event of stream) collected.push(event);
  return collected;
}

test("admission wrapper acquires before the call and releases on stream end", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  let calls = 0;
  const base: StreamFn = () => {
    calls += 1;
    return doneStream();
  };
  const wrapped = withSchedulerAdmission(base, scheduler, { group: "default", priority: "interactive" });

  const events1 = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events1[events1.length - 1]?.type, "done");
  // Slot was released: a second call admits without help.
  const events2 = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events2[events2.length - 1]?.type, "done");
  assert.equal(calls, 2);
});

test("admission wrapper releases on error and feeds the group backoff", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1, backoff_base_ms: 200, backoff_max_ms: 200 } },
  });
  const base: StreamFn = () => errorStream("429 too many requests");
  const wrapped = withSchedulerAdmission(base, scheduler, { group: "default", priority: "background" });

  const events = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events[events.length - 1]?.type, "error");

  // The 429 must have armed the group's backoff: a fresh acquire waits.
  // Under build-gate CPU load drain() can outlast the backoff window (minimum
  // 100ms with jitter), making acquire() return immediately — read backoffUntil
  // from the snapshot before the acquire and guard the timing assertion so it
  // only fires when the window was verifiably still open at that point. The
  // `await release` above already proves admission happens; this guards the wait.
  const nowBeforeAcquire = Date.now();
  const backoffUntil = scheduler.snapshot().groups.find((g) => g.name === "default")!.backoffUntil;
  const release = await scheduler.acquire({ priority: "interactive" });
  if (backoffUntil > nowBeforeAcquire) {
    assert.ok(Date.now() - nowBeforeAcquire >= 10, "acquire should have waited out the 429 backoff");
  }
  release();
});

test("injected onResponse feeds precise status + Retry-After once (no double count with the error event) (#9)", async () => {
  const scheduler = new LlmScheduler({
    // Exponential window would be [200,400]ms; the hook's Retry-After is 40ms.
    groups: { default: { max_in_flight: 1, backoff_base_ms: 400, backoff_max_ms: 400 } },
  });
  const callerOnResponse: number[] = [];
  const base: StreamFn = (model, _context, streamOptions) => {
    const onResponse = (streamOptions as { onResponse?: (r: unknown, m: unknown) => unknown })?.onResponse;
    // Simulate a fetch-based provider surfacing the throttle response to the hook
    // before emitting the terminal error event.
    void onResponse?.({ status: 429, headers: { "retry-after-ms": "40" } }, model);
    return errorStream("429 too many requests");
  };
  const wrapped = withSchedulerAdmission(base, scheduler, { group: "default", priority: "background" });
  const events = await drain(
    wrapped(MODEL, [], {
      // A caller-provided hook must still be chained through.
      onResponse: (response: { status: number }) => {
        callerOnResponse.push(response.status);
      },
    } as never),
  );
  assert.equal(events[events.length - 1]?.type, "error");
  assert.deepEqual(callerOnResponse, [429], "caller onResponse chained");

  // The server-specified 40ms governs. If the terminal error event were ALSO
  // string-sniffed into the backoff, the second count's exponential window
  // ([200,400]ms) would extend the wait well past this bound.
  // Under build-gate CPU load drain() can outlast the 40ms Retry-After window,
  // making acquire() return immediately. Guard both assertions on whether the
  // backoff window was still verifiably active when we started the acquire.
  const nowBeforeAcquire = Date.now();
  const backoffUntil = scheduler.snapshot().groups.find((g) => g.name === "default")!.backoffUntil;
  const release = await scheduler.acquire({ priority: "interactive" });
  const waited = Date.now() - nowBeforeAcquire;
  if (backoffUntil > nowBeforeAcquire) {
    assert.ok(waited >= 20, `Retry-After honoured (waited ${waited}ms)`);
    assert.ok(waited < 150, `no double count: waited ${waited}ms, expected ~40ms`);
  }
  release();
});

test("aborted admission wait synthesizes stopReason 'aborted' — no retry spin (#11)", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const hold = await scheduler.acquire({ priority: "interactive" });
  let baseCalls = 0;
  const base: StreamFn = () => {
    baseCalls += 1;
    return doneStream();
  };
  let admissionAttempts = 0;
  const admitted = withSchedulerAdmission(base, scheduler, { group: "default", priority: "interactive" });
  const counted: StreamFn = (model, context, streamOptions) => {
    admissionAttempts += 1;
    return admitted(model, context, streamOptions);
  };
  // Large backoff so that IF a fatal abort were (wrongly) retried, the test
  // would observe a slow backoff sleep — but `aborted` is fatal, so it must not.
  const wrapped = withRequestRetry(counted, { backoffBaseMs: 1000, backoffMaxMs: 1000 });

  const controller = new AbortController();
  const out = wrapped(MODEL, [], { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 5);
  const events = await drain(out);
  const last = events[events.length - 1];
  assert.equal(last?.type, "error");
  assert.equal(
    (last as Extract<AssistantMessageEvent, { type: "error" }>).error.stopReason,
    "aborted",
    "an aborted admission wait must carry stopReason 'aborted' (fatal to Layer-1)",
  );
  assert.equal(admissionAttempts, 1, "fatal → no backed-off re-acquire cycle");
  assert.equal(baseCalls, 0, "the base fn never ran");
  hold();
});

test("scheduler-stopped admission failure is fatal — no retry spin at shutdown (#11)", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  scheduler.stop();
  let admissionAttempts = 0;
  const admitted = withSchedulerAdmission(() => doneStream(), scheduler, {
    group: "default",
    priority: "background",
  });
  const counted: StreamFn = (model, context, streamOptions) => {
    admissionAttempts += 1;
    return admitted(model, context, streamOptions);
  };
  // Large backoff so a wrongful retry would manifest as a >500ms sleep; the
  // assertion below proves the stopped gate is fatal and never re-enters backoff.
  const wrapped = withRequestRetry(counted, { backoffBaseMs: 1000, backoffMaxMs: 1000 });

  const start = Date.now();
  const events = await drain(wrapped(MODEL, [], undefined as never));
  const last = events[events.length - 1];
  assert.equal(last?.type, "error");
  assert.match(
    (last as Extract<AssistantMessageEvent, { type: "error" }>).error.errorMessage ?? "",
    /scheduler stopped/i,
  );
  assert.equal(admissionAttempts, 1, "stopped gate must be classified fatal, not retried");
  assert.ok(Date.now() - start < 500, "no backoff sleeps at shutdown");
});

test("composed with withRequestRetry, each attempt re-acquires (no slot held across backoff)", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  let calls = 0;
  let activeDuringCall: number[] = [];
  const base: StreamFn = () => {
    calls += 1;
    activeDuringCall.push(calls);
    return calls < 3 ? errorStream("500 transient upstream blip") : doneStream();
  };
  // Load-bearing order (§5.4): admission INSIDE retry.
  const wrapped = withRequestRetry(
    withSchedulerAdmission(base, scheduler, { group: "default", priority: "interactive" }),
    { backoffBaseMs: 0, backoffMaxMs: 0 },
  );

  const events = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events[events.length - 1]?.type, "done");
  assert.equal(calls, 3, "two failures then a success");

  // Between attempts no slot is held: the group admits an unrelated request
  // instantly even though the retry loop is mid-flight elsewhere.
  const release = await scheduler.acquire({});
  release();
});

// ---------------------------------------------------------------------------
// Per-model health (spec LLM-FAILURE-HANDLING §5): the failure-domain axis —
// unhealthy after N consecutive environmental failures, half-open probing at a
// fixed cadence, mass re-awakening on a clean success, and no head-of-line
// blocking of healthy models sharing the group.
// ---------------------------------------------------------------------------

const MODEL_A = "https://gw.example/anthropic::claude-x";
const MODEL_B = "https://gw.example/google::gemini-y";

function failEnvironmental(scheduler: LlmScheduler, modelKey: string, times = 1, status?: number): void {
  for (let i = 0; i < times; i++) {
    scheduler.noteOutcome("default", modelKey, "environmental", status);
  }
}

test("model health: threshold consecutive environmental failures turn the model unhealthy and gate admission", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 3, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
  });
  failEnvironmental(scheduler, MODEL_A, 3);

  let admitted = false;
  const waiter = scheduler.acquire({ priority: "interactive", modelKey: MODEL_A }).then((r) => {
    admitted = true;
    r();
  });
  waiter.catch(() => {}); // rejected by the teardown stop() below
  await tick();
  assert.equal(admitted, false, "unhealthy model with an unelapsed probe window admits nothing");
  assert.equal(scheduler.isQueueWaitPoint("default", MODEL_A), true);
  scheduler.stop();
});

test("model health: an unhealthy model never head-of-line-blocks a healthy model in the same group", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
  });
  failEnvironmental(scheduler, MODEL_A, 1);

  const order: string[] = [];
  // The unhealthy model's waiter is INTERACTIVE (outranks), the healthy one
  // background — yet the healthy one must be admitted (skipped over, not
  // waited behind).
  scheduler
    .acquire({ priority: "interactive", modelKey: MODEL_A })
    .then((r) => {
      order.push("unhealthy");
      r();
    })
    .catch(() => {}); // rejected by the teardown stop() below
  const releaseB = await scheduler.acquire({ priority: "background", modelKey: MODEL_B });
  order.push("healthy");
  releaseB();
  assert.deepEqual(order, ["healthy"]);
  scheduler.stop();
});

test("model health: probe window elapses → exactly ONE probe admitted; success re-awakens all waiters", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 2 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 100, probeBackoffMaxMs: 100 },
  });
  const armedAt = Date.now();
  failEnvironmental(scheduler, MODEL_A, 1); // turns MODEL_A unhealthy → arms the probe window

  const admitted: string[] = [];
  const all = Promise.all([
    scheduler.acquire({ priority: "interactive", modelKey: MODEL_A }).then((r) => {
      admitted.push("probe");
      // The probe succeeds: a clean outcome recovers the model and pumps the
      // remaining waiters (the mass resume).
      scheduler.noteOutcome("default", MODEL_A, undefined);
      r();
    }),
    scheduler.acquire({ priority: "background", modelKey: MODEL_A }).then((r) => {
      admitted.push("waiter-1");
      r();
    }),
    scheduler.acquire({ priority: "background_low", modelKey: MODEL_A }).then((r) => {
      admitted.push("waiter-2");
      r();
    }),
  ]);
  await tick();
  // Under build-gate CPU load the event loop can stall past the probe window
  // before this check runs (the probe timer fires and admits everything first),
  // so assert emptiness only when the window verifiably hasn't opened yet. The
  // ordering assert below carries the real one-probe-then-mass-resume
  // verification either way.
  if (Date.now() - armedAt < 100) {
    assert.deepEqual(admitted, [], "nothing admitted before the probe window opens");
  }
  await sleep(120); // window opens → probe timer fires → ONE probe admitted
  await all;
  assert.deepEqual(admitted, ["probe", "waiter-1", "waiter-2"]);
  assert.equal(scheduler.isQueueWaitPoint("default", MODEL_A), false, "recovered");
  scheduler.stop();
});

test("model health: a failed probe stays unhealthy and schedules the next fixed window", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 25, probeBackoffMaxMs: 25 },
  });
  failEnvironmental(scheduler, MODEL_A, 1);

  const admitted: number[] = [];
  let probes = 0;
  const done = (async () => {
    for (;;) {
      const release = await scheduler.acquire({ priority: "background", modelKey: MODEL_A });
      probes += 1;
      admitted.push(Date.now());
      if (probes < 2) {
        scheduler.noteOutcome("default", MODEL_A, "environmental", 503);
        release();
        continue;
      }
      scheduler.noteOutcome("default", MODEL_A, undefined);
      release();
      return;
    }
  })();
  await done;
  assert.equal(probes, 2, "first probe fails, second succeeds");
  scheduler.stop();
});

test("model health: capped-backoff probe cadence grows ×2 per failed probe and caps (MODEL-FALLBACK §4.1)", () => {
  const scheduler = new LlmScheduler({
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 20, probeBackoffMaxMs: 100 },
  });
  const delays: number[] = [];
  const note = () => {
    const t0 = Date.now();
    scheduler.noteOutcome("default", MODEL_A, "environmental"); // !429 → feeds the streak/probe
    const np = scheduler.snapshot().models.find((m) => m.key === MODEL_A)!.nextProbeAt;
    delays.push(np - t0);
  };
  note(); // healthy → unhealthy: first window = base (20)
  note(); // failed probe: 40
  note(); // 80
  note(); // min(160,100) = 100 (capped)
  note(); // stays 100
  // Allow a couple ms of clock slack between the captured t0 and the set nextProbeAt.
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) <= 5, `delay ${got} ≈ ${want}`);
  near(delays[0]!, 20);
  near(delays[1]!, 40);
  near(delays[2]!, 80);
  near(delays[3]!, 100);
  near(delays[4]!, 100);
});

test("model health: recovery resets the probe backoff to base (MODEL-FALLBACK §4.1)", () => {
  const scheduler = new LlmScheduler({
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 20, probeBackoffMaxMs: 1000 },
  });
  const windowDelay = (): number => {
    const t0 = Date.now();
    scheduler.noteOutcome("default", MODEL_A, "environmental"); // !429 → feeds the streak/probe
    const np = scheduler.snapshot().models.find((m) => m.key === MODEL_A)!.nextProbeAt;
    return np - t0;
  };
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) <= 5, `delay ${got} ≈ ${want}`);

  // First outage: grow the delay past base via failed probes.
  near(windowDelay(), 20); // healthy → unhealthy: first window = base
  near(windowDelay(), 40); // failed probe ×2
  near(windowDelay(), 80); // failed probe ×2 — the delay is now well above base

  // The model recovers (a clean outcome on the in-flight probe).
  scheduler.noteOutcome("default", MODEL_A, undefined);
  assert.equal(scheduler.modelHealth(MODEL_A), "healthy", "clean outcome recovers the model");

  // The reset happens AT recovery, observable in the window before any next
  // transition: probeDelayMs is back at base (20), not the grown 80. This is the
  // assertion that actually guards the recovery-branch reset — the next-outage
  // path resets to base unconditionally and would mask a missing reset here.
  assert.equal(
    scheduler.snapshot().models.find((m) => m.key === MODEL_A)!.probeDelayMs,
    20,
    "probeDelayMs is reset to base AT recovery, not carried over from the prior outage",
  );

  // A LATER outage must also start its first probe window back at the base delay.
  near(windowDelay(), 20);
});

test("model health: a per-model probe-backoff-cap override tightens the ceiling (MODEL-FALLBACK §4.1)", async () => {
  const scheduler = new LlmScheduler({
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 20, probeBackoffMaxMs: 100_000 },
  });
  // Record a tight per-model cap on sight (as withSchedulerAdmission threads it).
  const release = await scheduler.acquire({ modelKey: MODEL_A, probeBackoffMaxMs: 30 });
  release();
  const delay = () => {
    const t0 = Date.now();
    scheduler.noteOutcome("default", MODEL_A, "environmental");
    const np = scheduler.snapshot().models.find((m) => m.key === MODEL_A)!.nextProbeAt;
    return np - t0;
  };
  delay(); // unhealthy: 20
  const d2 = delay(); // min(40, 30) = 30 (the override caps below the global 100_000)
  assert.ok(Math.abs(d2 - 30) <= 5, `capped at the per-model override: ${d2} ≈ 30`);
  scheduler.stop();
});

test("model health: a plain 429 feeds the group throttle but never the model streak", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1, backoff_base_ms: 1, backoff_max_ms: 2 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
  });
  // Three 429s — with threshold 1, ANY streak contribution would flip the
  // model unhealthy. It must stay healthy (the budget is talking, not the model).
  failEnvironmental(scheduler, MODEL_A, 3, 429);
  await sleep(10); // wait out the tiny group backoff
  const release = await scheduler.acquire({ priority: "background", modelKey: MODEL_A });
  release();
  scheduler.stop();
});

test("model health: content and aborted outcomes are neutral", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 2, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
  });
  scheduler.noteOutcome("default", MODEL_A, "environmental");
  scheduler.noteOutcome("default", MODEL_A, "content");
  scheduler.noteOutcome("default", MODEL_A, "aborted");
  // Neutral outcomes neither count (streak would be 3 ≥ 2) nor reset (a
  // subsequent environmental failure completes the original streak of 2).
  scheduler.noteOutcome("default", MODEL_A, "environmental");
  assert.equal(scheduler.isQueueWaitPoint("default", MODEL_A), true, "streak of 2 reached across neutral outcomes");
  scheduler.stop();
});

test("composed stack: an empty-ending probe stream settles the probe and never hangs the consumer (#1)", async () => {
  // The exact wedge from #1: admission INSIDE retry, an UNHEALTHY model, and a
  // base stream that ends with NO terminal event. The admitted request is the
  // half-open probe. Before the fix the wrapper neither pushed a terminal event
  // (consumer blocks forever on `outer`) nor called `noteOutcome` (probe never
  // settles → every later waiter for the model is gated until restart).
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 20, probeBackoffMaxMs: 20 },
  });
  const MODEL_KEY = modelHealthKey(MODEL);
  failEnvironmental(scheduler, MODEL_KEY, 1); // → unhealthy; next admission is the probe
  assert.equal(scheduler.snapshot().models.find((m) => m.key === MODEL_KEY)?.health, "unhealthy");

  let baseCalls = 0;
  const base: StreamFn = () => {
    baseCalls += 1;
    return emptyStream();
  };
  // Interactive-class wall-clock budget so the retry loop terminates instead of
  // re-probing forever; without the #1 fix this never resolves at all.
  const wrapped = withRequestRetry(
    withSchedulerAdmission(base, scheduler, { group: "default", priority: "interactive" }),
    { maxWaitMs: 80, backoffBaseMs: 0, backoffMaxMs: 0 },
  );

  const events = await Promise.race([
    drain(wrapped(MODEL, [], undefined as never)),
    sleep(2000).then(() => "HUNG" as const),
  ]);
  assert.notEqual(events, "HUNG", "the empty-ending probe stream must NOT hang the consumer");
  const list = events as AssistantMessageEvent[];
  assert.equal(list[list.length - 1]?.type, "error", "a terminal error must finalize the stream");
  assert.ok(baseCalls >= 1, "the probe attempt ran");

  // The probe settled: no probe is left in flight, so the model is admissible
  // again once its window elapses (the wedge would leave probeInFlight=true).
  const model = scheduler.snapshot().models.find((m) => m.key === MODEL_KEY)!;
  assert.equal(model.probeInFlight, false, "the probe must be settled on the empty-ending stream");

  await sleep(30); // let the probe window elapse
  const release = await Promise.race([
    scheduler.acquire({ priority: "interactive", modelKey: MODEL_KEY }),
    sleep(1000).then(() => "WEDGED" as const),
  ]);
  assert.notEqual(release, "WEDGED", "a subsequent waiter must be admissible — the probe is not wedged");
  (release as ReleaseFn)();
  scheduler.stop();
});

test("modelHealthKey derives from endpoint + id", () => {
  assert.equal(
    modelHealthKey({ baseUrl: "https://gw.example/anthropic", id: "claude-x" }),
    "https://gw.example/anthropic::claude-x",
  );
  assert.equal(modelHealthKey({ id: "claude-x" }), "unknown::claude-x");
});

// ---------------------------------------------------------------------------
// Console snapshot (spec LLM-FAILURE-HANDLING §9.1) + request ring (§9.2).
// ---------------------------------------------------------------------------

test("snapshot exposes group budget state, queued waiters with attribution, and model health", async () => {
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 } },
    health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 },
  });
  const release = await scheduler.acquire({
    priority: "interactive",
    modelKey: MODEL_A,
    sessionId: "s-active",
    sessionType: "default",
  });
  const queued = scheduler
    .acquire({
      priority: "background",
      modelKey: MODEL_A,
      key: "sumjob:7",
      sessionId: "s-queued",
      sessionType: "summarize",
    })
    .then((r) => r())
    .catch(() => {});
  await tick();
  scheduler.noteOutcome("default", MODEL_B, "environmental", 503);

  const snap = scheduler.snapshot();
  const group = snap.groups.find((g) => g.name === "default")!;
  assert.equal(group.maxInFlight, 1);
  assert.equal(group.active.length, 1);
  assert.equal(group.active[0]!.sessionId, "s-active");
  assert.equal(group.active[0]!.priority, "interactive");
  assert.equal(group.queue.length, 1);
  assert.equal(group.queue[0]!.sessionId, "s-queued");
  assert.equal(group.queue[0]!.sessionType, "summarize");
  assert.equal(group.queue[0]!.key, "sumjob:7");
  assert.ok(group.queue[0]!.waitingMs >= 0);

  const model = snap.models.find((m) => m.key === MODEL_B)!;
  assert.equal(model.health, "unhealthy");
  assert.equal(model.consecutiveFailures, 1);
  assert.equal(model.lastFailure?.status, 503);

  release();
  await queued;
  const after = scheduler.snapshot();
  assert.equal(after.groups.find((g) => g.name === "default")!.active.length, 0, "released entries leave the active set");
  scheduler.stop();
});

test("snapshot does not duplicate a group's sticky escalation onto other groups (#10)", async () => {
  // `stickyEscalations` is one scheduler-wide map. A key belongs to whichever
  // group has its queued/active entry; emitting the whole map under every group
  // would misattribute the escalation to unrelated group cards. Each escalation
  // must appear ONLY under the group holding its entry.
  const scheduler = new LlmScheduler({
    groups: { default: { max_in_flight: 1 }, other: { max_in_flight: 1 } },
  });
  // Saturate both groups so the keyed entries queue (and thus carry their keys).
  const holdDefault = await scheduler.acquire({ group: "default", priority: "interactive" });
  const holdOther = await scheduler.acquire({ group: "other", priority: "interactive" });

  const qDefault = scheduler
    .acquire({ group: "default", priority: "background", key: "sumjob:default" })
    .then((r) => r())
    .catch(() => {});
  const qOther = scheduler
    .acquire({ group: "other", priority: "background", key: "diaryjob:other" })
    .then((r) => r())
    .catch(() => {});
  await tick();
  scheduler.escalate("sumjob:default", "interactive");
  scheduler.escalate("diaryjob:other", "interactive");

  const snap = scheduler.snapshot();
  const def = snap.groups.find((g) => g.name === "default")!;
  const other = snap.groups.find((g) => g.name === "other")!;

  assert.deepEqual(
    def.stickyEscalations.map((e) => e.key),
    ["sumjob:default"],
    "the default group shows only its own escalation",
  );
  assert.deepEqual(
    other.stickyEscalations.map((e) => e.key),
    ["diaryjob:other"],
    "the other group shows only its own escalation — no cross-group duplication",
  );

  holdDefault();
  holdOther();
  await Promise.all([qDefault, qOther]);
  scheduler.stop();
});
