/**
 * Shared formatting for the Usage & Cost page and its cards (spec USAGE-COST-LIMITS §7.1).
 * Extracted so the page and the reusable `SpendSummaryCard` render money/counts/elapsed
 * spans identically — the per-user leaderboard cards must match the Total-spend card exactly.
 */

/** USD: `$0`, `<$0.01`, four decimals under $1, two above. */
export function fmtUsd(n: number): string {
	if (n === 0) return '$0';
	if (n < 0.01) return '<$0.01';
	return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * USD for tight, repeated cells (the sub-period averages table): `$0`, `<$0.001`, three
 * decimals under $1, two above. Lower precision than {@link fmtUsd} — those columns are
 * narrow and four decimals read as false precision for a per-period rate.
 */
export function fmtUsdAvg(n: number): string {
	if (n === 0) return '$0';
	if (n < 0.001) return '<$0.001';
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** Integer with thousands separators; `—` for null. */
export function fmtInt(n: number | null): string {
	return n == null ? '—' : n.toLocaleString();
}

/** Compact elapsed span: `42m` / `5h 3m` / `2.4d` — the per-period averaging basis. */
export function fmtElapsed(ms: number): string {
	if (ms <= 0) return '0m';
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 48) return `${hrs}h ${mins % 60}m`;
	const days = ms / 86_400_000;
	return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

/** Percent of total, rounded to whole percent (`<1%` for tiny non-zero shares). */
export function fmtPct(fraction: number): string {
	if (fraction <= 0) return '0%';
	if (fraction < 0.01) return '<1%';
	return `${Math.round(fraction * 100)}%`;
}
