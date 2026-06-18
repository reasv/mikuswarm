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

/** A "nice" linear y-axis: a rounded ceiling ≥ data max, and the tick values up to it. */
export interface AxisTicks {
	/** Axis ceiling (≥ max), a round multiple of `step`. Bars scale to this, not raw max. */
	niceMax: number;
	/** Spacing between adjacent ticks (round 1/2/5 × 10ⁿ). 0 when there's nothing to scale. */
	step: number;
	/** Tick values `[0, step, 2·step, …, niceMax]` — gridlines + labels. */
	ticks: number[];
}

/** Nearest "nice" number (1/2/5 × 10ⁿ) to `x`: round to nearest, or `ceil` toward nicer. */
function niceNum(x: number, round: boolean): number {
	const exp = Math.floor(Math.log10(x));
	const mag = Math.pow(10, exp);
	const f = x / mag; // 1 ≤ f < 10
	const nf = round
		? f < 1.5
			? 1
			: f < 3
				? 2
				: f < 7
					? 5
					: 10
		: f <= 1
			? 1
			: f <= 2
				? 2
				: f <= 5
					? 5
					: 10;
	return nf * mag;
}

/**
 * Build a small set of human-round y-axis ticks spanning `[0, max]` (Heckbert's
 * "nice numbers" algorithm): a nice range, then a nice step near
 * `range / targetCount`, then a ceiling that is a whole number of steps ≥ `max`.
 * Gives the chart an actual, readable y-scale instead of bars at heights
 * meaningful only relative to one another. Pure so the tick math is
 * unit-testable; `max ≤ 0` ⇒ a single 0 tick.
 */
export function niceTicks(max: number, targetCount = 4): AxisTicks {
	if (!(max > 0) || !Number.isFinite(max)) return { niceMax: 0, step: 0, ticks: [0] };
	const range = niceNum(max, false);
	const step = niceNum(range / Math.max(1, targetCount), true);
	const count = Math.ceil(max / step); // whole steps needed to cover max
	const niceMax = count * step;
	// Build by integer index so floating drift never yields a stray near-duplicate tick.
	const ticks = Array.from({ length: count + 1 }, (_, i) => i * step);
	return { niceMax, step, ticks };
}
