/**
 * Stacked spend-over-time chart model (spec USAGE-COST-LIMITS §7.1 #4).
 *
 * Extracted from `usage-cost/+page.svelte`'s `chart` $derived as a pure function
 * so the column/segment build and — crucially — the "is this window empty?"
 * decision are unit-testable. The component imports `buildSpendChart` and keeps
 * its rendering identical.
 *
 * Why a dedicated empty predicate (issue #8): a window with activity but only
 * **zero-cost** (free-model) events still produces one column per time bucket,
 * but every column's `segments` is empty (the build drops groups whose cost is
 * ≤ 0) and `max` is 0. Guarding on `columns.length === 0` alone is then false,
 * so the page would draw a bordered chart frame with axis labels and no bars —
 * looking broken. `isSpendChartEmpty` treats `max === 0` (no positive segment
 * anywhere) as empty too, so the caller shows the "No spend in this window."
 * panel instead.
 */

/** One (bucket, group, cost) sample from `/api/usage/timeseries`. */
export interface SpendSeriesRow {
	bucket: number;
	grp: string;
	cost: number;
}

/** A stacked segment within one bucket column. */
export interface SpendSegment {
	group: string;
	cost: number;
	color: string;
}

/** One time-bucket column: its stacked segments and their summed cost. */
export interface SpendColumn {
	bucket: number;
	segments: SpendSegment[];
	sum: number;
}

/** The full chart model the SVG renders from. */
export interface SpendChart {
	columns: SpendColumn[];
	/** Distinct groups across the whole series, in first-seen order. */
	groups: string[];
	/** group → color, for the legend and segment fills. */
	groupColor: Map<string, string>;
	/** Busiest column's summed cost — the y-axis scale. 0 ⇒ no positive spend. */
	max: number;
	bucketMs: number;
}

/**
 * Fold the flat (bucket, group, cost) series into a stacked-bar model: one
 * column per time bucket, segments stacked per group (only groups with positive
 * cost in that bucket), height scaled to the busiest bucket. `colorFor(group,
 * index)` supplies a stable color per group.
 */
export function buildSpendChart(
	series: readonly SpendSeriesRow[],
	bucketMs: number,
	colorFor: (group: string, index: number) => string
): SpendChart {
	const buckets = new Map<number, Map<string, number>>();
	const groups = new Set<string>();
	for (const row of series) {
		groups.add(row.grp);
		let b = buckets.get(row.bucket);
		if (!b) {
			b = new Map();
			buckets.set(row.bucket, b);
		}
		b.set(row.grp, (b.get(row.grp) ?? 0) + row.cost);
	}
	const orderedGroups = [...groups];
	const groupColor = new Map(orderedGroups.map((g, i) => [g, colorFor(g, i)]));
	const orderedBuckets = [...buckets.keys()].sort((a, b) => a - b);
	let max = 0;
	for (const b of buckets.values()) {
		let sum = 0;
		for (const v of b.values()) sum += v;
		if (sum > max) max = sum;
	}
	const columns = orderedBuckets.map((bucket) => {
		const b = buckets.get(bucket)!;
		const segments = orderedGroups
			.filter((g) => (b.get(g) ?? 0) > 0)
			.map((g) => ({ group: g, cost: b.get(g) ?? 0, color: groupColor.get(g)! }));
		const sum = segments.reduce((s, seg) => s + seg.cost, 0);
		return { bucket, segments, sum };
	});
	return { columns, groups: orderedGroups, groupColor, max, bucketMs };
}

/**
 * True when there is nothing to plot — either no buckets at all, or buckets
 * exist but no column carries any positive spend (`max === 0`, the zero-cost-only
 * case, issue #8). The caller shows the "No spend in this window." panel and
 * suppresses the legend (which would otherwise show dangling swatches for the
 * zero-cost groups).
 */
export function isSpendChartEmpty(chart: Pick<SpendChart, 'columns' | 'max'>): boolean {
	return chart.columns.length === 0 || chart.max === 0;
}
