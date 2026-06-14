/**
 * Combined cost-budget derivation (spec SESSION-COST-LIMITS §6).
 *
 * The ONLY place the two cost lanes are summed — agent-loop cost (§8b,
 * `usage.cost`) + tool cost (§8c, `toolUsage.cost`) — against the per-session
 * ceiling (`maxSessionCostUsd`). Extracted from `SessionView.svelte`'s
 * `costBudget` $derived as a pure function so the lane-sum and percentage
 * rounding are unit-testable; the component imports this and keeps its behavior
 * (including null-gating) identical.
 */

/** Minimal structural slice of `SessionMeta` this derivation reads. */
export interface CostBudgetSession {
	maxSessionCostUsd?: number | null;
	usage?: { cost: number } | null;
	toolUsage?: { cost: number } | null;
}

export interface CostBudget {
	/** Combined spend: agent-loop cost + tool cost. */
	spent: number;
	/** Resolved per-session ceiling (USD). */
	limit: number;
	/** Percentage of the ceiling spent, rounded to a whole number. */
	pct: number;
}

/**
 * Returns the combined cost-budget line, or `null` when there is no budget to
 * show. Mirrors the component gate exactly:
 *
 * - `null` when the session is absent.
 * - `null` when no ceiling resolves (`maxSessionCostUsd` null/undefined →
 *   unlimited) or the ceiling is `<= 0` (defensive guard; see issue #2 — the
 *   guard is deliberately retained).
 * - Otherwise sums both lanes (each defaulting to 0 when absent) and rounds the
 *   percentage to a whole number (`Math.round`, so .5 rounds up).
 */
export function computeCostBudget(session: CostBudgetSession | null | undefined): CostBudget | null {
	const limit = session?.maxSessionCostUsd ?? null;
	if (!session || limit == null || limit <= 0) return null;
	const spent = (session.usage?.cost ?? 0) + (session.toolUsage?.cost ?? 0);
	return { spent, limit, pct: Math.round((spent / limit) * 100) };
}
