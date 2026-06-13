/**
 * Token + cost formatting helpers (spec TOKEN-USAGE-TRACKING §7.2/§7.3).
 * Shared by the session-level usage line, the per-block rollout annotation, and
 * the scheduler request table so the rendering can't drift between them.
 */

/** Compact token count: `<1000` verbatim, else `N.Nk` (e.g. 46_300 → "46.3k"). */
export function formatTokens(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (n < 1000) return String(n);
	const k = n / 1000;
	// One decimal under 100k, none above (keeps the chip narrow for large contexts).
	return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * USD cost. Returns '—' when zero (an unconfigured model's cost factors are all
 * zero — don't render a misleading $0.00; spec §5). Small values keep 4 decimals
 * so a fraction-of-a-cent request is still visible.
 */
export function formatUsd(n: number | null | undefined): string {
	if (n === null || n === undefined || n === 0) return '—';
	return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
