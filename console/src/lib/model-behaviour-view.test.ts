import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	behaviourFiltersToParams,
	behaviourQueryArg,
	buildBehaviourChart,
	chartX,
	formatChange,
	formatRate,
	incidentHref,
	parseBehaviourFilters,
	rateFamily
} from './model-behaviour-view';
import { modelsHref } from './nav';
import { ModelBehaviourResponse } from './schemas';
import sample from '$lib/server/api/demo/model-behaviour.json';

const data = Schema.decodeUnknownSync(ModelBehaviourResponse)(sample);
const round = (qs: string) => {
	const f = parseBehaviourFilters(new URLSearchParams(qs));
	return { f, href: modelsHref(behaviourFiltersToParams(f)) };
};

describe('URL filters (spec REFUSAL-HANDLING §12.3: every filter in the URL)', () => {
	it('defaults: a bare /models', () => {
		const { f, href } = round('');
		expect(f).toEqual({
			window: '24h', groupBy: 'model', family: false, agent: null, site: null, task: null,
			selected: null, metric: null, type: null
		});
		expect(href).toBe('/models');
	});

	it('round-trips every filter', () => {
		const qs = 'window=7d&family=1&agent=agent_a&site=default&task=coding&selected=fam_x&metric=nudged_per_session&type=redo';
		const { f, href } = round(qs);
		expect(f).toMatchObject({ window: '7d', groupBy: 'model', family: true, agent: 'agent_a', site: 'default', task: 'coding', selected: 'fam_x', metric: 'nudged_per_session', type: 'redo' });
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
		expect(rateFamily(null)).toBeNull();
	});
});

describe('chart model', () => {
	it('one line per group over the window buckets, markers kept', () => {
		const m = buildBehaviourChart(data.series.points, data.since, data.until, data.series.bucketMs, data.markers);
		expect(m.lines.map((l) => l.group)).toEqual(['cap_model', 'model_a', 'model_b']);
		expect(m.max).toBe(1);
		expect(m.buckets.length).toBe(Math.floor(data.until / 3_600_000) - Math.floor(data.since / 3_600_000) + 1);
		expect(m.markers).toHaveLength(1);
		const x = chartX(m, data.markers[0]!.ts, data.series.bucketMs);
		expect(x).toBeGreaterThan(0);
		expect(x).toBeLessThan(1);
	});

	it('buckets without a rate draw nothing; an empty series has no lines', () => {
		const m = buildBehaviourChart([{ bucket: 0, group: 'g', count: 0, denominator: 0, rate: null }], 0, 3_600_000, 3_600_000, []);
		expect(m.lines).toEqual([]);
		expect(m.max).toBe(0);
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
