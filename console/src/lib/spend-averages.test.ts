import { describe, it, expect } from 'vitest';
import { buildSpendAverages } from './spend-averages';
import type { SpendSeriesRow } from './spend-chart';

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('buildSpendAverages', () => {
	it('averages per hour over the elapsed range, with a min/max/σ spread (zero-filled gaps)', () => {
		// firstTs = 0, now = 3h → 3 fully-elapsed hourly periods (the 4th has not started).
		const series: SpendSeriesRow[] = [
			{ bucket: 0, grp: 'agent_loop', cost: 1.0 },
			{ bucket: 0, grp: 'tool', cost: 0.5 }, // hour 0 total = 1.5
			{ bucket: HOUR, grp: 'agent_loop', cost: 0.5 } // hour 1 total = 0.5; hour 2 = 0
		];
		const out = buildSpendAverages({
			total: 2.0,
			firstTs: 0,
			now: 3 * HOUR,
			series,
			bucketMs: HOUR,
			window: '24h'
		});
		expect(out.rangeStart).toBe(0);
		expect(out.rangeEnd).toBe(3 * HOUR);
		expect(out.stats).toHaveLength(1);
		const hr = out.stats[0];
		expect(hr.label).toBe('per hour');
		expect(hr.avg).toBeCloseTo(2.0 / 3, 10); // total ÷ 3 elapsed hours
		expect(hr.n).toBe(3);
		expect(hr.min).toBe(0); // the empty third hour counts as $0
		expect(hr.max).toBeCloseTo(1.5, 10);
		// sample σ of [1.5, 0.5, 0], mean 2/3
		expect(hr.stdev).toBeCloseTo(0.76376, 4);
	});

	it('divides by the ACTUAL data range, not the nominal window (30d view, ~3d of data)', () => {
		// A 30d window but the ledger only goes back 3 days: the per-day average must divide by 3,
		// not 30 — and "per week" is dropped entirely (under one week of real data).
		const series: SpendSeriesRow[] = [
			{ bucket: 0, grp: 'agent_loop', cost: 3.0 },
			{ bucket: 2 * DAY, grp: 'agent_loop', cost: 3.0 } // day 1 = 0
		];
		const out = buildSpendAverages({
			total: 6.0,
			firstTs: 0,
			now: 3 * DAY,
			series,
			bucketMs: DAY,
			window: '30d'
		});
		expect(out.stats.map((s) => s.label)).toEqual(['per day']); // no "per week" — < 7d elapsed
		const day = out.stats[0];
		expect(day.avg).toBeCloseTo(2.0, 10); // 6 ÷ 3 days, NOT 6 ÷ 30
		expect(day.n).toBe(3);
		expect(day.min).toBe(0);
		expect(day.max).toBeCloseTo(3.0, 10);
		expect(day.stdev).toBeCloseTo(Math.sqrt(3), 10); // [3,0,3], mean 2, sample var = 3
	});

	it('honours a partway calendar window: month-on-the-15th divides by elapsed days, not 31', () => {
		// 15 days into the window; $30 all spent on day 0. firstTs = 0 (day- and week-aligned) so
		// the week-bin count is deterministic rather than dependent on the calendar phase.
		const series: SpendSeriesRow[] = [{ bucket: 0, grp: 'agent_loop', cost: 30 }];
		const out = buildSpendAverages({
			total: 30,
			firstTs: 0,
			now: 15 * DAY,
			series,
			bucketMs: DAY,
			window: 'month'
		});
		const day = out.stats.find((s) => s.label === 'per day')!;
		expect(day.avg).toBeCloseTo(30 / 15, 10); // ÷ 15 elapsed days, not ÷ 31
		expect(day.n).toBe(15);
		const week = out.stats.find((s) => s.label === 'per week')!;
		expect(week.avg).toBeCloseTo(30 / (15 / 7), 6); // 15d / 7 ≈ 2.14 weeks elapsed
		expect(week.n).toBe(2); // two fully-elapsed 7-day periods within 15 days
	});

	it('keeps the data-start period even when collection began mid-period', () => {
		// firstTs 30m into hour 0; now 2h later. Hour 0 (partial coverage) is still a real elapsed
		// hour and must be counted — dropping it would discard data for a half-minute-late start.
		const series: SpendSeriesRow[] = [{ bucket: 0, grp: 'agent_loop', cost: 1 }];
		const out = buildSpendAverages({
			total: 1,
			firstTs: HOUR / 2,
			now: HOUR / 2 + 2 * HOUR,
			series,
			bucketMs: HOUR,
			window: '24h'
		});
		const hr = out.stats[0];
		expect(hr.n).toBe(2); // hour 0 (the start period) + hour 1; the current hour is excluded
		expect(hr.avg).toBeCloseTo(0.5, 10); // 1 ÷ 2 elapsed hours
	});

	it('returns no stats when the window has no data', () => {
		const out = buildSpendAverages({
			total: 0,
			firstTs: null,
			now: 5 * HOUR,
			series: [],
			bucketMs: HOUR,
			window: '24h'
		});
		expect(out.rangeStart).toBeNull();
		expect(out.stats).toEqual([]);
	});

	it('reports σ = null for a single elapsed period (n < 2)', () => {
		const series: SpendSeriesRow[] = [{ bucket: 0, grp: 'tool', cost: 0.4 }];
		const out = buildSpendAverages({
			total: 0.4,
			firstTs: 0,
			now: 1.5 * HOUR, // one full hour elapsed + a partial current one
			series,
			bucketMs: HOUR,
			window: '24h'
		});
		const hr = out.stats[0];
		expect(hr.n).toBe(1);
		expect(hr.min).toBeCloseTo(0.4, 10);
		expect(hr.max).toBeCloseTo(0.4, 10);
		expect(hr.stdev).toBeNull();
		expect(hr.avg).toBeCloseTo(0.4 / 1.5, 10); // rate still divides by the true 1.5h elapsed
	});

	it('aggregates per-week from daily buckets (30d window, 16 days of data)', () => {
		// $7 spent each of 16 days → 2 full weeks (14d) of $49, then 2 leftover days.
		const series: SpendSeriesRow[] = Array.from({ length: 16 }, (_, i) => ({
			bucket: i * DAY,
			grp: 'agent_loop',
			cost: 7
		}));
		const out = buildSpendAverages({
			total: 16 * 7,
			firstTs: 0,
			now: 16 * DAY,
			series,
			bucketMs: DAY,
			window: '30d'
		});
		const week = out.stats.find((s) => s.label === 'per week')!;
		expect(week.n).toBe(2); // floor(16 / 7) fully-elapsed weeks
		expect(week.min).toBeCloseTo(49, 10);
		expect(week.max).toBeCloseTo(49, 10);
		expect(week.avg).toBeCloseTo((16 * 7) / (16 / 7), 6); // total ÷ (16d / 7d)
	});

	it('all-time breaks down per day / week / month (daily buckets, ~75 days of data)', () => {
		// 75 days of $2/day over daily buckets. per-hour is unresolvable at daily granularity
		// (skipped); per-day/week/month all fit (>30d elapsed) and report in that order.
		const days = 75;
		const series: SpendSeriesRow[] = Array.from({ length: days }, (_, i) => ({
			bucket: i * DAY,
			grp: 'agent_loop',
			cost: 2
		}));
		const out = buildSpendAverages({
			total: days * 2,
			firstTs: 0,
			now: days * DAY,
			series,
			bucketMs: DAY,
			window: 'all'
		});
		expect(out.stats.map((s) => s.label)).toEqual(['per day', 'per week', 'per month']);
		const month = out.stats.find((s) => s.label === 'per month')!;
		expect(month.n).toBe(2); // floor(75 / 30) fully-elapsed 30-day months
		expect(month.avg).toBeCloseTo((days * 2) / (days / 30), 6); // total ÷ (75d / 30d)
	});

	it('all-time drops per-week / per-month when the data range is too short', () => {
		// Only ~3 days of data: per-day fits, but per-week/month can't elapse once → dropped.
		const out = buildSpendAverages({
			total: 6,
			firstTs: 0,
			now: 3 * DAY,
			series: [
				{ bucket: 0, grp: 'agent_loop', cost: 2 },
				{ bucket: DAY, grp: 'agent_loop', cost: 2 },
				{ bucket: 2 * DAY, grp: 'agent_loop', cost: 2 }
			],
			bucketMs: DAY,
			window: 'all'
		});
		expect(out.stats.map((s) => s.label)).toEqual(['per day']);
	});
});
