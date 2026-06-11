import assert from "node:assert/strict";
import test from "node:test";

import { LlmRequestRing } from "../src/agent/request-ring.js";

// In-memory Layer-0 attempt ring (spec LLM-FAILURE-HANDLING §9.2): fixed
// capacity, newest-first listing, oldest entries overwritten.

function entry(n: number) {
  return {
    ts: n,
    model: "m",
    attempt: 1,
    durationMs: n,
    outcome: "done" as const,
  };
}

test("ring lists newest-first and wraps at capacity", () => {
  const ring = new LlmRequestRing(3);
  assert.deepEqual(ring.list(), []);
  ring.record(entry(1));
  ring.record(entry(2));
  assert.deepEqual(ring.list().map((e) => e.ts), [2, 1]);
  ring.record(entry(3));
  ring.record(entry(4)); // overwrites 1
  assert.deepEqual(ring.list().map((e) => e.ts), [4, 3, 2]);
  ring.record(entry(5));
  ring.record(entry(6));
  ring.record(entry(7));
  assert.deepEqual(ring.list().map((e) => e.ts), [7, 6, 5]);
});
