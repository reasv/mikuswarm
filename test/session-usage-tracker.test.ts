import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  SessionUsageTracker,
  emptyUsageTotals,
  type SessionUsageTotals,
} from "../src/agent/usage.js";

function usage(partial: Partial<Usage>): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: partial.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: partial.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("empty tracker reports zeroed totals with null context", () => {
  const tracker = new SessionUsageTracker();
  assert.deepEqual(tracker.snapshot(), emptyUsageTotals());
  assert.equal(tracker.snapshot().contextTokens, null);
});

test("record accumulates all four consumption values + cost", () => {
  const tracker = new SessionUsageTracker();
  tracker.record(
    usage({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0.01 } }),
  );
  tracker.record(
    usage({ input: 5, output: 7, cacheRead: 2000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } }),
  );
  const s = tracker.snapshot();
  assert.equal(s.llmRequests, 2);
  assert.equal(s.inputTokens, 105);
  assert.equal(s.outputTokens, 57);
  assert.equal(s.cacheReadTokens, 3000);
  assert.equal(s.cacheWriteTokens, 10);
  assert.ok(Math.abs(s.cost - 0.03) < 1e-9);
});

test("contextTokens tracks the LAST committed request's totalTokens (not monotonic)", () => {
  const tracker = new SessionUsageTracker();
  tracker.record(usage({ input: 100, output: 50, totalTokens: 150 }));
  assert.equal(tracker.snapshot().contextTokens, 150);
  // A later request observed smaller (e.g. provider stripped prior thinking) —
  // we always report the last observation, never the max.
  tracker.record(usage({ input: 40, output: 20, totalTokens: 60 }));
  assert.equal(tracker.snapshot().contextTokens, 60);
});

test("seed continues accumulation from persisted totals (resume)", () => {
  const seed: SessionUsageTotals = {
    llmRequests: 3,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 100,
    cost: 0.5,
    contextTokens: 42_000,
  };
  const tracker = new SessionUsageTracker(seed);
  assert.equal(tracker.snapshot().contextTokens, 42_000);
  tracker.record(usage({ input: 10, output: 5, totalTokens: 43_000 }));
  const s = tracker.snapshot();
  assert.equal(s.llmRequests, 4);
  assert.equal(s.inputTokens, 1010);
  assert.equal(s.contextTokens, 43_000);
  // The seed object is copied, not aliased.
  assert.equal(seed.llmRequests, 3);
});

test("onUpdate fires per record with a snapshot and unsubscribes cleanly", () => {
  const tracker = new SessionUsageTracker();
  const seen: SessionUsageTotals[] = [];
  const off = tracker.onUpdate((t) => seen.push(t));
  tracker.record(usage({ input: 1, totalTokens: 1 }));
  tracker.record(usage({ input: 2, totalTokens: 3 }));
  off();
  tracker.record(usage({ input: 4, totalTokens: 7 }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.llmRequests, 1);
  assert.equal(seen[1]!.contextTokens, 3);
  // The final record (post-unsubscribe) still mutated the tracker but notified nobody.
  assert.equal(tracker.snapshot().llmRequests, 3);
});

test("a throwing listener never breaks the accounting path", () => {
  const tracker = new SessionUsageTracker();
  tracker.onUpdate(() => {
    throw new Error("boom");
  });
  let ok = false;
  tracker.onUpdate(() => {
    ok = true;
  });
  assert.doesNotThrow(() => tracker.record(usage({ input: 1, totalTokens: 1 })));
  assert.ok(ok);
  assert.equal(tracker.snapshot().llmRequests, 1);
});
