/**
 * Presentation of one `[[limits]]` rule status (spec USAGE-COST-LIMITS §7.1 #3).
 *
 * Extracted from `usage-cost/+page.svelte` as a pure function so the cap-0
 * special-case is unit-testable. The component imports `presentRule` and renders
 * either a fill bar (`kind:"bar"`) or a "$0 cap" badge (`kind:"disabled"`).
 *
 * Why the cap-0 branch (issue #10b): a `max_usd = 0` rule is an intentional hard
 * disable of paid spend for a scope. The engine correctly reports it as
 * `{ capUsd: 0, fraction: 1, state: "blocked" }` (cap-0 is always at/over cap;
 * that engine semantic is issue #10a and is *not* changed here). But rendering it
 * as a 100% / over-budget bar reads as "money was spent and we maxed out", which
 * is misleading — no spend occurred, paid spend is simply forbidden. So we render
 * it distinctly (a badge) instead of a fill bar. This is presentation only.
 */

/** Minimal structural slice of `RuleStatus` this derivation reads. */
export interface RuleStatusLike {
	capUsd: number;
	fraction: number;
	state: string;
}

/** A cap-0 rule: paid spend disabled for the scope — render a badge, not a bar. */
export interface DisabledRulePresentation {
	kind: 'disabled';
	label: string;
}

/** A normal capped rule: render a fill bar at `fillPct`% with a `percentLabel`. */
export interface BarRulePresentation {
	kind: 'bar';
	/** Bar width %, clamped to [0,100] (the over-budget overflow is shown via color/label, not width). */
	fillPct: number;
	/** Unclamped percent for the trailing number (can read ≥100% when over cap). */
	percentLabel: string;
}

export type RulePresentation = DisabledRulePresentation | BarRulePresentation;

/**
 * Decide how to present a rule's fill. A `capUsd === 0` rule becomes a
 * `disabled` badge; every other rule becomes a `bar` with a clamped width and an
 * (unclamped) percent label, matching the prior inline behavior exactly.
 */
export function presentRule(rule: RuleStatusLike): RulePresentation {
	if (rule.capUsd === 0) {
		return { kind: 'disabled', label: '$0 cap — paid spend disabled' };
	}
	return {
		kind: 'bar',
		fillPct: Math.min(100, rule.fraction * 100),
		percentLabel: `${(rule.fraction * 100).toFixed(0)}%`
	};
}
