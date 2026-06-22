/**
 * Per-sub-period spend averages for the "Total spend" card (spec USAGE-COST-LIMITS §7.1).
 *
 * The window total alone ("$12 in the last 30d") hides the spend *rate*. This folds the
 * timeseries into one or more sub-period breakdowns — per hour for day-scale windows, per
 * day / per week for larger ones — each with an average plus a min/max/σ spread.
 *
 * The denominator is the crux. Averages divide by the **actual elapsed data range**, never
 * the nominal window width:
 *
 *   - Calendar windows (today/month, UTC) that are only partway through: a month view on the
 *     15th divides by ~15 days of elapsed time, not 31.
 *   - Rolling windows (24h/30d) whose data started after the window opened: a 30d view a week
 *     into the ledger's history divides by ~7 days, not 30 — we don't pretend to have data we
 *     never collected.
 *
 * Both fall out of one rule: the range start is `firstTs` (the earliest event *within* the
 * window, supplied by the summary endpoint), and the range end is the server's `now`.
 *
 * `avg` is the true rate: total spend ÷ (now − firstTs) expressed in periods, so a partial
 * leading or trailing period is accounted for exactly. `min`/`max`/`stdev` describe the
 * distribution across the **fully-elapsed** periods from the data-start period onward (the
 * still-running current period is excluded — mid-period it always reads artificially low).
 * Periods with no spend count as 0 (a real elapsed period that happened to cost nothing).
 *
 * Pure + unit-tested, mirroring `spend-chart.ts`.
 */
import type { SpendSeriesRow } from './spend-chart';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
// Approximate, fixed-width "month" (30 days) — epoch-aligned bins, not calendar months,
// matching how `per week` already approximates with 7-day bins. Good enough for an
// all-time spend *rate* without dragging calendar arithmetic into a pure helper.
const MONTH = 30 * DAY;

/** One sub-period breakdown (e.g. "per day") over the window's actual data range. */
export interface SubPeriodStat {
	/** Human label, e.g. `per hour` / `per day` / `per week`. */
	label: string;
	/** Sub-period width in ms. */
	periodMs: number;
	/** Average spend per period = total ÷ elapsed-periods over the real range. */
	avg: number;
	/** Lowest fully-elapsed period's spend (0 if some period had none); null when n = 0. */
	min: number | null;
	/** Highest fully-elapsed period's spend; null when n = 0. */
	max: number | null;
	/** Sample standard deviation across fully-elapsed periods; null when n < 2. */
	stdev: number | null;
	/** Count of fully-elapsed periods the spread is computed over. */
	n: number;
}

export interface SpendAverages {
	/** Range start = earliest event in window (the average denominator's anchor); null = no data. */
	rangeStart: number | null;
	/** Range end = server `now`. */
	rangeEnd: number;
	/** One entry per sub-period configured for the window (empty when there's no data). */
	stats: SubPeriodStat[];
}

/** Which sub-periods to break a window into (the "one or multiple sub-timesteps" choice). */
function subPeriodsFor(window: string): Array<{ label: string; periodMs: number }> {
	switch (window) {
		case 'today':
		case '24h':
			return [{ label: 'per hour', periodMs: HOUR }];
		case '7d':
			return [{ label: 'per day', periodMs: DAY }];
		case '30d':
		case 'month':
			return [
				{ label: 'per day', periodMs: DAY },
				{ label: 'per week', periodMs: WEEK }
			];
		case 'all':
			// All-time uses daily buckets, so per-hour is unresolvable (and skipped by the
			// granularity guard). Break it down per day / week / month instead. Each finer
			// period is dropped automatically when the data range can't cover it once.
			return [
				{ label: 'per day', periodMs: DAY },
				{ label: 'per week', periodMs: WEEK },
				{ label: 'per month', periodMs: MONTH }
			];
		default:
			return [{ label: 'per hour', periodMs: HOUR }];
	}
}

/** Sum the (bucket, grp) series into one total per bucket-start. */
function bucketTotals(series: readonly SpendSeriesRow[]): Map<number, number> {
	const totals = new Map<number, number>();
	for (const row of series) totals.set(row.bucket, (totals.get(row.bucket) ?? 0) + row.cost);
	return totals;
}

/** Spend in each fully-elapsed period from the data-start period up to (not incl.) the current one. */
function elapsedPeriodSpend(
	totals: Map<number, number>,
	periodMs: number,
	firstTs: number,
	now: number
): number[] {
	// Re-bin the (already bucket-aligned) totals into period-sized, epoch-aligned bins.
	const perBin = new Map<number, number>();
	for (const [bucket, cost] of totals) {
		const bin = Math.floor(bucket / periodMs) * periodMs;
		perBin.set(bin, (perBin.get(bin) ?? 0) + cost);
	}
	// From the period containing firstTs, take every period whose end has passed (excludes the
	// still-running current period). The data-start period is kept even if firstTs lands mid-period:
	// its spend is a real observation, and dropping it would discard data whenever collection began
	// a moment after a period boundary.
	const firstBin = Math.floor(firstTs / periodMs) * periodMs;
	const values: number[] = [];
	for (let bin = firstBin; bin + periodMs <= now; bin += periodMs) {
		values.push(perBin.get(bin) ?? 0);
	}
	return values;
}

/**
 * Build the per-sub-period averages for a window. `total`/`firstTs`/`now` come from the
 * summary endpoint; `series`/`bucketMs` from the timeseries (the per-bucket totals are
 * group-independent, so the class⇄model toggle doesn't change these numbers).
 */
export function buildSpendAverages(params: {
	total: number;
	firstTs: number | null;
	now: number;
	series: readonly SpendSeriesRow[];
	bucketMs: number;
	window: string;
}): SpendAverages {
	const { total, firstTs, now, series, bucketMs, window } = params;
	const rangeEnd = now;
	// No events in the window, or a degenerate/empty range → nothing to average.
	if (firstTs == null || now <= firstTs) return { rangeStart: firstTs, rangeEnd, stats: [] };

	const totals = bucketTotals(series);
	const elapsedMs = now - firstTs;
	const stats: SubPeriodStat[] = [];
	for (const { label, periodMs } of subPeriodsFor(window)) {
		// Can't resolve a sub-period finer than the timeseries granularity (shouldn't happen for
		// the configured windows, but guard rather than emit a bogus single-bucket "average").
		if (periodMs < bucketMs) continue;
		// Don't extrapolate a period longer than the data we actually have: with under a week of
		// history, a "per week" average would just be the daily rate × 7 dressed up as a real
		// weekly figure. Skip any sub-period the elapsed range can't cover even once.
		if (elapsedMs < periodMs) continue;

		const avg = total / (elapsedMs / periodMs);
		const values = elapsedPeriodSpend(totals, periodMs, firstTs, now);
		const n = values.length;
		let min: number | null = null;
		let max: number | null = null;
		let stdev: number | null = null;
		if (n > 0) {
			min = Math.min(...values);
			max = Math.max(...values);
			if (n >= 2) {
				const mean = values.reduce((s, v) => s + v, 0) / n;
				const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
				stdev = Math.sqrt(variance);
			}
		}
		stats.push({ label, periodMs, avg, min, max, stdev, n });
	}
	return { rangeStart: firstTs, rangeEnd, stats };
}
