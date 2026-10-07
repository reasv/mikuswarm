import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	behaviourFiltersToParams,
	behaviourQueryArg,
	buildBehaviourChart,
	chartX,
	formatChange,
	formatRate,
	emptyChartReason,
	incidentHref,
	modelLabel,
	nextSort,
	parseBehaviourFilters,
	rateFamily,
	sortScorecard
} from './model-behaviour-view';
import { modelsHref } from './nav';
import { ModelBehaviourResponse } from './schemas';
import sample from '$lib/server/api/demo/model-behaviour.json';

const data = Schema.decodeUnknownSync(ModelBehaviourResponse)(sample);
/** The per-metric series the generator stored beside the overview body (demo mode's chart picks). */
const seriesOf = (metric: string) =>
	(sample as unknown as { demoSeries: Record<string, { bucketMs: number; points: typeof data.series.points }> }).demoSeries[metric]!;
const round = (qs: string) => {
	const f = parseBehaviourFilters(new URLSearchParams(qs));
	return { f, href: modelsHref(behaviourFiltersToParams(f)) };
};

describe('URL filters (spec REFUSAL-HANDLING §12.3: every filter in the URL)', () => {
	it('defaults: a bare /models', () => {
		const { f, href } = round('');
		expect(f).toEqual({
			window: '24h', groupBy: 'model', family: false, agent: null, site: null, task: null,
			selected: null, metric: null, type: null, sort: null, dir: 'desc', label: 'key'
		});
		expect(href).toBe('/models');
	});

	it('round-trips every filter', () => {
		const qs =
			'window=7d&family=1&agent=agent_a&site=default&task=coding&selected=fam_x&metric=nudged_per_session&type=redo&sort=volume&dir=asc&label=both';
		const { f, href } = round(qs);
		expect(f).toMatchObject({ window: '7d', groupBy: 'model', family: true, agent: 'agent_a', site: 'default', task: 'coding', selected: 'fam_x', metric: 'nudged_per_session', type: 'redo', sort: 'volume', dir: 'asc', label: 'both' });
		expect(parseBehaviourFilters(new URL(href, 'http://x').searchParams)).toEqual(f);
		expect(round(new URL(href, 'http://x').search.slice(1)).href).toBe(href);
	});

	it('hand-edited values fall back; the family toggle needs group-by model', () => {
		const { f } = round('window=year&group=planet&type=bogus&family=1');
		expect(f.window).toBe('24h');
		expect(f.groupBy).toBe('model');
		expect(f.type).toBeNull();
		expect(f.family).toBe(true);
		expect(round('group=site&family=1').f.family).toBe(false);
		expect(round('group=site').href).toBe('/models?group=site');
	});

	it('the remote query argument carries only what is set', () => {
		expect(behaviourQueryArg(round('').f)).toEqual({ window: '24h', groupBy: 'model' });
		// Sort and model names are client-side: no refetch.
		expect(behaviourQueryArg(round('sort=group&dir=asc&label=id').f)).toEqual({ window: '24h', groupBy: 'model' });
		expect(behaviourQueryArg(round('family=1&selected=m&type=nudge').f)).toEqual({
			window: '24h', groupBy: 'model', family: true, selected: 'm', type: 'nudge'
		});
	});
});

describe('rates', () => {
	it('shares as percentages, per-1k rates in their unit', () => {
		expect(formatRate(0.5, { scale: 1 })).toBe('50%');
		expect(formatRate(0.034, { scale: 1 })).toBe('3.4%');
		expect(formatRate(0, { scale: 1 })).toBe('0%');
		expect(formatRate(null, { scale: 1 })).toBe('—');
		expect(formatRate(142.857, { scale: 1000 })).toBe('142.9 /1k');
		expect(formatRate(1.5, { scale: 1000 })).toBe('1.50 /1k');
	});

	it('change against the previous window', () => {
		expect(formatChange({ change: 0.021 }, { scale: 1 })).toEqual({ text: '+2.1pp', direction: 'up' });
		expect(formatChange({ change: -0.5 }, { scale: 1 })).toEqual({ text: '−50pp', direction: 'down' });
		expect(formatChange({ change: 0 }, { scale: 1 })).toEqual({ text: '±0', direction: 'flat' });
		expect(formatChange({ change: null }, { scale: 1 })).toEqual({ text: '—', direction: 'none' });
		expect(formatChange({ change: 1.25 }, { scale: 1000 }).text).toBe('+1.25');
	});

	it('the breakdown family of a metric', () => {
		expect(rateFamily('refusals_hard_per_request')).toBe('refusals');
		expect(rateFamily('refusal_redos_per_session')).toBe('refusals');
		expect(rateFamily('messages_with_style_hit')).toBe('style');
		expect(rateFamily('recovered_per_nudged')).toBe('contract');
		expect(rateFamily('mix:judged_refusal_reason')).toBe('refusals');
		expect(rateFamily('mix:failure_type')).toBe('contract');
		expect(rateFamily(null)).toBeNull();
	});
});

describe('chart model', () => {
	it('one line per group over the window buckets, markers kept', () => {
		const series = seriesOf('refusals_hard_per_request');
		const m = buildBehaviourChart(series.points, data.since, data.until, series.bucketMs, data.markers);
		expect(m.lines.map((l) => l.group)).toEqual(['cap_model', 'model_a', 'model_b']);
		expect(m.max).toBe(1);
		expect(m.buckets.length).toBe(Math.floor(data.until / 3_600_000) - Math.floor(data.since / 3_600_000) + 1);
		expect(m.markers).toHaveLength(1);
		const x = chartX(m, data.markers[0]!.ts, series.bucketMs);
		expect(x).toBeGreaterThan(0);
		expect(x).toBeLessThan(1);
	});

	it('a missing bucket splits the line into runs; small samples are flagged', () => {
		const H = 3_600_000;
		const pt = (bucket: number, denominator: number, group = 'g') => ({ bucket: bucket * H, group, count: 1, denominator, rate: 1 / denominator });
		const m = buildBehaviourChart([pt(0, 30), pt(1, 2), pt(3, 25), pt(0, 5, 'a')], 0, 4 * H, H, [], 20);
		expect(m.lines.map((l) => l.group)).toEqual(['a', 'g']);
		const g = m.lines[1]!;
		expect(g.runs.map((r) => r.map((p) => p.bucket / H))).toEqual([[0, 1], [3]]);
		expect(g.points.map((p) => p.low)).toEqual([false, true, false]);
	});

	it('buckets without a rate draw nothing; an empty series has no lines', () => {
		const m = buildBehaviourChart([{ bucket: 0, group: 'g', count: 0, denominator: 0, rate: null }], 0, 3_600_000, 3_600_000, []);
		expect(m.lines).toEqual([]);
		expect(m.max).toBe(0);
	});
});

describe('scorecard sort and model names (URL state)', () => {
	it('a header click sorts, the same header again flips the direction', () => {
		expect(nextSort({ sort: null, dir: 'desc' }, 'refusals_hard_per_request')).toEqual({ sort: 'refusals_hard_per_request', dir: 'desc' });
		expect(nextSort({ sort: 'refusals_hard_per_request', dir: 'desc' }, 'refusals_hard_per_request')).toEqual({ sort: 'refusals_hard_per_request', dir: 'asc' });
		expect(nextSort({ sort: 'volume', dir: 'asc' }, 'group')).toEqual({ sort: 'group', dir: 'asc' });
	});

	it('sorts by group, volume and any rate; rows without a rate go last', () => {
		const groups = (sort: string | null, dir: 'asc' | 'desc', labelOf?: (g: string) => string) =>
			sortScorecard(data.scorecard, sort, dir, labelOf).map((r) => r.group);
		expect(groups(null, 'desc')).toEqual(data.scorecard.map((r) => r.group));
		expect(groups('group', 'asc')).toEqual(['cap_model', 'model_a', 'model_b']);
		expect(groups('group', 'desc')).toEqual(['model_b', 'model_a', 'cap_model']);
		expect(groups('volume', 'asc')).toEqual(['cap_model', 'model_b', 'model_a']);
		// cap_model has no sessions: no nudge rate, last in both directions.
		expect(groups('nudged_per_session', 'desc')).toEqual(['model_b', 'model_a', 'cap_model']);
		expect(groups('nudged_per_session', 'asc')).toEqual(['model_a', 'model_b', 'cap_model']);
		// By the displayed label (wire ids under the switch).
		expect(groups('group', 'asc', (g) => ({ model_a: 'z', model_b: 'a', cap_model: 'm' })[g]!)).toEqual(['model_b', 'cap_model', 'model_a']);
	});

	it('names a model by config key, wire id, or both', () => {
		expect(modelLabel('model_a', data.models, 'key')).toBe('model_a');
		expect(modelLabel('model_a', data.models, 'id')).toBe('vendor/model-a');
		expect(modelLabel('model_a', data.models, 'both')).toBe('model_a · vendor/model-a');
		expect(modelLabel('unknown_key', data.models, 'id')).toBe('unknown_key');
		expect(modelLabel('', data.models, 'id')).toBe('(unknown)');
	});

	it('an empty chart says why', () => {
		expect(emptyChartReason({ label: 'Judged refusals per request', kind: 'rate', count: 0, denominator: 412 }, 'requests')).toBe(
			'None recorded in this window: 0 of 412 requests.'
		);
		expect(emptyChartReason({ label: 'Sessions nudged', kind: 'rate', count: 0, denominator: 0 }, 'sessions')).toBe(
			'No sessions in this window, so no sessions nudged to show.'
		);
		expect(emptyChartReason({ label: 'no_reply intent after a nudge', kind: 'count', count: 0, denominator: null })).toBe(
			'No no_reply intent after a nudge recorded in this window.'
		);
	});
});

describe('incident deep links', () => {
	it('to the session at the branch and tool call', () => {
		const row = { timelineKey: 'matrix:a:room:!r:x', link: { sessionId: 's1', branchNo: 2, toolCallId: 'call-9', attemptNo: null } };
		expect(incidentHref(row)).toBe('/?room=matrix%3Aa%3Aroom%3A%21r%3Ax&session=s1&branch=2&call=call-9');
		expect(incidentHref({ ...row, link: { sessionId: 's1', branchNo: 0, toolCallId: null, attemptNo: 1 } })).toBe(
			'/?room=matrix%3Aa%3Aroom%3A%21r%3Ax&session=s1&attempt=1'
		);
	});
});
