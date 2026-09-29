/**
 * Tests for src/net/paced-limiter.ts
 *
 * Covers the core pacing and slot-accounting invariants originally tested on
 * DanbooruRateLimiter, plus the new priority-class behaviour added in the
 * extraction: interactive waiters are served before background waiters when
 * both are queued.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PacedLimiter } from "../src/net/paced-limiter.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pacing + slot accounting (ported from danbooru.test.ts)
// ---------------------------------------------------------------------------

test("limiter: two concurrent runs start at least minIntervalMs apart", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 80, maxInFlight: 4 });
  // Take the baseline BEFORE enqueueing. Under load the first callback can
  // execute late while the second's pacing timer stays on schedule, making the
  // callback-to-callback gap misleadingly small. `max(starts) - t0` is immune
  // to that because timers never fire early.
  const t0 = Date.now();
  const starts: number[] = [];
  await Promise.all(
    [0, 1].map(() =>
      limiter.run(async () => {
        starts.push(Date.now());
      }),
    ),
  );
  assert.equal(starts.length, 2);
  const gap = Math.max(...starts) - t0;
  assert.ok(gap >= 70, `concurrent starts must be paced >= minIntervalMs apart, got ${gap}ms`);
});

test("limiter: third run waits while maxInFlight runs are in flight", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 2 });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));

  let thirdStarted = false;
  const first = limiter.run(() => firstGate);
  const second = limiter.run(() => secondGate);
  const third = limiter.run(async () => {
    thirdStarted = true;
  });

  await sleep(20);
  assert.equal(thirdStarted, false, "third run must wait at maxInFlight=2");
  releaseFirst();
  await first;
  await third;
  assert.equal(thirdStarted, true, "a release admits the queued third run");
  releaseSecond();
  await second;
});

test("limiter: released slot is handed to the queued waiter FIFO — never double-granted", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 1 });
  let inFlight = 0;
  let maxObserved = 0;
  const startOrder: number[] = [];
  const tasks = [0, 1, 2, 3, 4].map((id) =>
    limiter.run(async () => {
      startOrder.push(id);
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await sleep(5);
      inFlight -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(maxObserved, 1, `maxInFlight=1 must never be exceeded, observed ${maxObserved}`);
  assert.deepEqual(startOrder, [0, 1, 2, 3, 4], "waiters are admitted FIFO");
});

// ---------------------------------------------------------------------------
// Priority classes
// ---------------------------------------------------------------------------

test("limiter: interactive waiters are served before background waiters", async () => {
  // Set up: one slot, already held. Enqueue a background waiter first, then an
  // interactive waiter. When the slot is released, the interactive waiter should
  // be served first despite arriving later.
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 1 });

  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => (releaseHolder = resolve));

  // Occupy the single slot.
  const holder = limiter.run(() => holderGate);

  // Give the holder a moment to actually be in-flight.
  await sleep(5);

  const order: string[] = [];

  // Enqueue background first, interactive second.
  const bgTask = limiter.run(async () => { order.push("background"); }, "background");
  const itTask = limiter.run(async () => { order.push("interactive"); }, "interactive");

  // Release the holder. The interactive waiter should fire first.
  releaseHolder();
  await holder;
  await Promise.all([bgTask, itTask]);

  assert.deepEqual(order, ["interactive", "background"],
    "interactive must be served before background regardless of enqueue order");
});

test("limiter: unclassed run behaves like background (drained last)", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 1 });

  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => (releaseHolder = resolve));
  const holder = limiter.run(() => holderGate);
  await sleep(5);

  const order: string[] = [];
  // Unclassed first, interactive second.
  const unclassedTask = limiter.run(async () => { order.push("unclassed"); });
  const itTask = limiter.run(async () => { order.push("interactive"); }, "interactive");

  releaseHolder();
  await holder;
  await Promise.all([unclassedTask, itTask]);

  assert.deepEqual(order, ["interactive", "unclassed"],
    "unclassed must be drained after interactive");
});

test("limiter: multiple interactive waiters maintain FIFO within the class", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 1 });

  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => (releaseHolder = resolve));
  const holder = limiter.run(() => holderGate);
  await sleep(5);

  const order: number[] = [];
  const tasks = [0, 1, 2].map((id) =>
    limiter.run(async () => { order.push(id); }, "interactive"),
  );

  releaseHolder();
  await holder;
  await Promise.all(tasks);

  assert.deepEqual(order, [0, 1, 2], "interactive waiters are FIFO within the class");
});

test("limiter: run propagates thrown errors without corrupting slot state", async () => {
  const limiter = new PacedLimiter({ minIntervalMs: 0, maxInFlight: 1 });

  await assert.rejects(
    () => limiter.run(async () => { throw new Error("boom"); }),
    /boom/,
  );

  // The slot should be released. A subsequent run must proceed without hanging.
  let ran = false;
  await limiter.run(async () => { ran = true; });
  assert.ok(ran, "slot must be released after a thrown error");
});
