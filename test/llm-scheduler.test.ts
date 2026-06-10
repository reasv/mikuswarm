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
  withSchedulerAdmission,
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
    groups: { default: { max_in_flight: 1, backoff_base_ms: 40, backoff_max_ms: 40 } },
  });
  scheduler.noteResult("default", "429 {\"error\":\"rate_limited\"}");

  let admitted = false;
  const wait = scheduler.acquire({ priority: "interactive" }).then((r) => {
    admitted = true;
    return r;
  });
  await sleep(5);
  assert.equal(admitted, false, "admission must wait out the backoff window");
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
    groups: { default: { max_in_flight: 1, backoff_base_ms: 30, backoff_max_ms: 30 } },
  });
  const base: StreamFn = () => errorStream("429 too many requests");
  const wrapped = withSchedulerAdmission(base, scheduler, { group: "default", priority: "background" });

  const events = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events[events.length - 1]?.type, "error");

  // The 429 must have armed the group's backoff: a fresh acquire waits.
  const start = Date.now();
  const release = await scheduler.acquire({ priority: "interactive" });
  assert.ok(Date.now() - start >= 10, "acquire should have waited out the 429 backoff");
  release();
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
    { retries: 3, backoffBaseMs: 0, backoffMaxMs: 0 },
  );

  const events = await drain(wrapped(MODEL, [], undefined as never));
  assert.equal(events[events.length - 1]?.type, "done");
  assert.equal(calls, 3, "two failures then a success");

  // Between attempts no slot is held: the group admits an unrelated request
  // instantly even though the retry loop is mid-flight elsewhere.
  const release = await scheduler.acquire({});
  release();
});
