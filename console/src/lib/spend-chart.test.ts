import { describe, it, expect } from 'vitest';
import { buildSpendChart, isSpendChartEmpty, type SpendSeriesRow } from './spend-chart';

// Deterministic color stub so assertions don't depend on the page's palette.
const color = (g: string) => `c:${g}`;
const colorFor = (g: string) => color(g);

describe('buildSpendChart', () => {
	it('folds (bucket, group, cost) rows into stacked columns, scaled to the busiest bucket', () => {
		const series: SpendSeriesRow[] = [
			{ bucket: 2000, grp: 'tool', cost: 0.2 },
			{ bucket: 1000, grp: 'agent_loop', cost: 0.5 },
			{ bucket: 1000, grp: 'tool', cost: 0.1 },
			{ bucket: 2000, grp: 'agent_loop', cost: 0.3 }
		];
		const chart = buildSpendChart(series, 3_600_000, colorFor);

		// Columns sorted by bucket ascending.
		expect(chart.columns.map((c) => c.bucket)).toEqual([1000, 2000]);
		// Bucket 1000 sum = 0.6, bucket 2000 sum = 0.5 → max = 0.6.
		expect(chart.columns[0].sum).toBeCloseTo(0.6, 10);
		expect(chart.columns[1].sum).toBeCloseTo(0.5, 10);
		expect(chart.max).toBeCloseTo(0.6, 10);
		expect(chart.bucketMs).toBe(3_600_000);
	});

	it('keeps groups in first-seen order with stable colors', () => {
		const series: SpendSeriesRow[] = [
			{ bucket: 1, grp: 'tool', cost: 0.1 },
			{ bucket: 1, grp: 'agent_loop', cost: 0.1 }
		];
		const chart = buildSpendChart(series, 1, colorFor);
		expect(chart.groups).toEqual(['tool', 'agent_loop']);
		expect(chart.groupColor.get('tool')).toBe('c:tool');
		expect(chart.groupColor.get('agent_loop')).toBe('c:agent_loop');
	});

	it('drops non-positive groups from a column’s segments but keeps the column', () => {
		const series: SpendSeriesRow[] = [
			{ bucket: 1, grp: 'tool', cost: 0 },
			{ bucket: 1, grp: 'agent_loop', cost: 0.4 }
		];
		const chart = buildSpendChart(series, 1, colorFor);
		expect(chart.columns).toHaveLength(1);
		expect(chart.columns[0].segments.map((s) => s.group)).toEqual(['agent_loop']);
		expect(chart.columns[0].sum).toBeCloseTo(0.4, 10);
	});

	it('returns an empty model for an empty series', () => {
		const chart = buildSpendChart([], 1, colorFor);
		expect(chart.columns).toEqual([]);
		expect(chart.groups).toEqual([]);
		expect(chart.max).toBe(0);
	});
});

describe('isSpendChartEmpty', () => {
	it('is true when there are no columns', () => {
		expect(isSpendChartEmpty({ columns: [], max: 0 })).toBe(true);
	});

	// Issue #8: a window with activity but only zero-cost (free-model) events has
	// one column per bucket yet every column's segments is empty and max === 0.
	it('is true when columns exist but no column carries positive spend (zero-cost-only window)', () => {
		const series: SpendSeriesRow[] = [
			{ bucket: 1, grp: 'tool', cost: 0 },
			{ bucket: 2, grp: 'tool', cost: 0 }
		];
		const chart = buildSpendChart(series, 1, colorFor);
		expect(chart.columns.length).toBeGreaterThan(0); // columns DO exist…
		expect(chart.max).toBe(0); // …but nothing to plot
		expect(isSpendChartEmpty(chart)).toBe(true);
	});

	it('is false once any column has positive spend', () => {
		const chart = buildSpendChart([{ bucket: 1, grp: 'tool', cost: 0.01 }], 1, colorFor);
		expect(isSpendChartEmpty(chart)).toBe(false);
	});
});
