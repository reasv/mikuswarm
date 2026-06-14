import test from "node:test";
import assert from "node:assert/strict";
import { makeCostWarnDecider, selectToolCostSeed } from "../src/agent/cost-budget.js";

// =============================================================================
// Soft-warn one-shot latch (spec SESSION-COST-LIMITS §2.1).
// =============================================================================

test("cost-warn decider exposes threshold = ceiling × fraction", () => {
  const decider = makeCostWarnDecider(1.0, 0.8);
  assert.ok(Math.abs(decider.threshold - 0.8) < 1e-9);
});

test("cost-warn decider never fires while below the threshold", () => {
  const decider = makeCostWarnDecider(1.0, 0.8);
  // Successive combined-cost values that never reach 0.8.
  assert.equal(decider.shouldWarn(0), false);
  assert.equal(decider.shouldWarn(0.5), false);
  assert.equal(decider.shouldWarn(0.79), false);
  assert.equal(decider.shouldWarn(0.799999), false);
});

test("cost-warn decider fires exactly once at the first crossing", () => {
  const decider = makeCostWarnDecider(1.0, 0.8);
  assert.equal(decider.shouldWarn(0.7), false);
  // First value at/over the threshold fires.
  assert.equal(decider.shouldWarn(0.8), true);
  // Latched: subsequent higher values do NOT re-fire.
  assert.equal(decider.shouldWarn(0.9), false);
  assert.equal(decider.shouldWarn(1.5), false);
});

test("cost-warn decider latch holds even if combined cost later dips below", () => {
  // combinedCost() is not assumed monotonic; once warned, never re-fire.
  const decider = makeCostWarnDecider(1.0, 0.8);
  assert.equal(decider.shouldWarn(0.85), true);
  assert.equal(decider.shouldWarn(0.4), false); // below threshold again
  assert.equal(decider.shouldWarn(0.95), false); // back over — still latched
});

test("cost-warn decider fires once when crossing is driven by either lane", () => {
  // Simulate onBudgetChange feeding successive combined-cost values where one
  // lane is low until the other pushes the combined sum over the threshold.
  const decider = makeCostWarnDecider(2.0, 0.5); // threshold = 1.0
  // agent-loop lane creeps up (combined = agent-loop only so far)
  assert.equal(decider.shouldWarn(0.3), false);
  assert.equal(decider.shouldWarn(0.6), false);
  // tool lane then pushes the combined sum over 1.0 — fires here.
  assert.equal(decider.shouldWarn(1.1), true);
  // any further updates from either lane do not re-fire.
  assert.equal(decider.shouldWarn(1.2), false);
  assert.equal(decider.shouldWarn(3.0), false);
});

test("cost-warn decider fires at exactly the threshold (>= not >)", () => {
  const decider = makeCostWarnDecider(1.0, 0.8);
  assert.equal(decider.shouldWarn(0.8), true);
});

// =============================================================================
// Resume tool-cost seed selection (spec SESSION-COST-LIMITS §4).
// =============================================================================

test("selectToolCostSeed: fresh mode is 0 and never consults the ledger", () => {
  let consulted = false;
  const seed = selectToolCostSeed("fresh", () => {
    consulted = true;
    return 99; // a positive ledger sum that must be ignored
  });
  assert.equal(seed, 0);
  assert.equal(consulted, false, "fresh mode must not read the persisted ledger");
});

test("selectToolCostSeed: continue mode returns the persisted ledger sum", () => {
  let consulted = false;
  const seed = selectToolCostSeed("continue", () => {
    consulted = true;
    return 0.42;
  });
  assert.ok(Math.abs(seed - 0.42) < 1e-9);
  assert.equal(consulted, true, "continue mode must read the persisted ledger");
});

test("selectToolCostSeed: continue mode with a zero ledger returns 0", () => {
  assert.equal(selectToolCostSeed("continue", () => 0), 0);
});
