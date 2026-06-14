// =============================================================================
// Per-session cost-limit pure helpers (spec SESSION-COST-LIMITS).
//
// I/O-free decision logic extracted from `app.ts` so the soft-warn one-shot
// latch (§2.1) and the resume tool-cost seed selection (§4) can be unit-tested
// without the surrounding wiring (sessions.steer / logger / storage). The
// stateful side effects (steering an interjection, logging, reading the ledger)
// stay in `app.ts`; these functions own only the arithmetic/latch decision.
// =============================================================================

/**
 * Build the one-shot soft-warn decision (spec SESSION-COST-LIMITS §2.1). Given a
 * resolved `ceiling` (USD) and a `fraction` in (0,1), returns a stateful function
 * that consumes successive `combinedCost` values (from either lane, since
 * `onBudgetChange` fires on both) and reports whether the soft `<interjection>`
 * should fire on THIS update:
 *
 * - fires exactly once, the first time `combinedCost` reaches `fraction × ceiling`;
 * - latches thereafter — never re-fires on subsequent (higher or lower) values;
 * - never fires while `combinedCost` stays below the threshold.
 *
 * Returns the precomputed `threshold` too so the caller can log it / quote it.
 * Pure: holds only the `warned` latch; no steering, no logging here.
 */
export interface CostWarnDecider {
  /** `ceiling × fraction` — the combined-cost point at which the warn fires. */
  threshold: number;
  /** Feed the latest combined cost; true exactly once at the first crossing. */
  shouldWarn(combinedCost: number): boolean;
}

export function makeCostWarnDecider(ceiling: number, fraction: number): CostWarnDecider {
  const threshold = ceiling * fraction;
  let warned = false;
  return {
    threshold,
    shouldWarn(combinedCost: number): boolean {
      if (warned || combinedCost < threshold) return false;
      warned = true;
      return true;
    },
  };
}

/**
 * Pick the tool-cost lane seed for a resumed/launched session (spec
 * SESSION-COST-LIMITS §4). A `fresh`-mode run starts the tool lane at 0 (the
 * transcript never flushed, so nothing committed and the persisted ledger must
 * NOT be replayed into the seed — that would double-count on re-run). A
 * `continue`-mode run inherits the persisted ledger sum so combined cost keeps
 * accumulating from where it left off.
 *
 * `getLedgerCost` is only invoked in continue mode, so fresh mode never even
 * consults the ledger.
 */
export function selectToolCostSeed(
  mode: "fresh" | "continue",
  getLedgerCost: () => number,
): number {
  return mode === "fresh" ? 0 : getLedgerCost();
}
