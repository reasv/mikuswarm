import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	MemoryFilterHitsResponse,
	MemoryStatsResponse,
	SessionMemoryRetrievalsResponse,
	type MemoryFilterHit
} from '$lib/schemas';
import { DEMO_FEATURED_SESSION, DEMO_LATE_INPUT_SESSION, resolveFixture } from '$lib/server/api/demo/fixtures';
import {
	formatMs,
	formatRate,
	groupFilterHits,
	groupReportItems,
	hiddenByLabel,
	hitCitation,
	hitMatchLabel,
	judgeLabel,
	parseHiddenBy,
	parseRetrievalReport,
	retrievalCountsLabel,
	scoresLabel,
	selectionLabel,
	sourceLabel,
	sourceMix,
	stageLabel,
	stageTimings
} from '$lib/memory-retrieval';

const retrievals = (id: string) =>
	Schema.decodeUnknownSync(SessionMemoryRetrievalsResponse)(
		resolveFixture(`/api/sessions/${id}/memory-retrievals`, new URLSearchParams())
	).retrievals;

describe('parseRetrievalReport', () => {
	it('reads the demo build: counts, stages and every item', () => {
		const [row] = retrievals(DEMO_FEATURED_SESSION);
		const report = parseRetrievalReport(row!.reportJson)!;
		expect(report.source).toBe('model');
		expect(report.decisionGroup).toBe(row!.decisionGroup);
		expect(report.items).toHaveLength(row!.candidates);
		expect(report.stages.late).toEqual({
			status: 'ok',
			backend: 'onnx',
			ms: 96,
			windowSize: 200,
			missing: 0,
			queryModel: 'demo-late-encoder'
		});
		expect(stageTimings(report)).toEqual([
			'recall 38ms',
			'index primary',
			'late ok 96ms (onnx, window 200)',
			'rerank ok 142ms (local)',
			'judge 1.1s'
		]);
	});

	it('degrades malformed input to null, never throws', () => {
		expect(parseRetrievalReport(null)).toBeNull();
		expect(parseRetrievalReport('')).toBeNull();
		expect(parseRetrievalReport('{not json')).toBeNull();
		expect(parseRetrievalReport('[1,2]')).toBeNull();
		expect(parseRetrievalReport('"text"')).toBeNull();
	});

	it('skips malformed items and fills missing fields', () => {
		const report = parseRetrievalReport(
			JSON.stringify({
				source: 'fallback',
				reason: 'timeout',
				stages: 'oops',
				items: [
					null,
					{ citation: 'a.md:1-2' },
					{ stage: 'kept' },
					{ stage: 'kept', citation: 'b.md:3-4', hybrid: 'x', lanes: ['trigger', 3], late: null },
					{ stage: 'future_stage', contentHash: 'abcdef0123456789', hiddenBy: { kind: 'judged' } }
				]
			})
		)!;
		expect(report.source).toBe('fallback');
		expect(report.reason).toBe('timeout');
		expect(report.candidates).toBe(0);
		expect(report.stages).toEqual({ recallMs: null });
		expect(stageTimings(report)).toEqual([]);
		expect(report.items).toEqual([
			{
				contentHash: '',
				citation: 'b.md:3-4',
				lanes: ['trigger'],
				hybrid: null,
				late: null,
				relevant: null,
				aboutParticipant: null,
				presence: false,
				stage: 'kept'
			},
			{
				contentHash: 'abcdef0123456789',
				citation: 'abcdef012345',
				lanes: [],
				hybrid: null,
				relevant: null,
				aboutParticipant: null,
				presence: false,
				stage: 'future_stage'
			}
		]);
	});
});

describe('fallback markers', () => {
	it('reads judged, selectedBy, unjudged, fellBack and aborted', () => {
		const r = parseRetrievalReport(
			JSON.stringify({
				source: 'model',
				candidates: 3,
				judged: 1,
				unjudged: 2,
				fellBack: 1,
				aborted: true,
				kept: 2,
				hidden: 0,
				tokens: 10,
				ms: 1,
				stages: { recallMs: 1 },
				items: [
					{ contentHash: 'a', citation: 'c', lanes: [], hybrid: 0.7, presence: false, stage: 'kept', judged: false, selectedBy: 'fallback' },
					{ contentHash: 'b', citation: 'd', lanes: [], hybrid: 0.7, presence: false, stage: 'kept', judged: true, selectedBy: 'judge' },
					{ contentHash: 'e', citation: 'f', lanes: [], hybrid: 0.7, presence: false, stage: 'aborted' }
				]
			})
		)!;
		expect([r.unjudged, r.fellBack, r.aborted]).toEqual([2, 1, true]);
		expect(r.items[0]).toMatchObject({ judged: false, selectedBy: 'fallback' });
		expect(r.items[1]).toMatchObject({ judged: true, selectedBy: 'judge' });
		expect(r.items.map(selectionLabel)).toEqual(['fallback', null, null]);
		expect(selectionLabel({ stage: 'kept', selectedBy: 'unjudged' })).toBe('unjudged');
		expect(selectionLabel({ stage: 'kept', selectedBy: 'order' })).toBe('ordered');
		expect(stageLabel('aborted')).toBe('plan aborted, not shown');
		const old = parseRetrievalReport(JSON.stringify({ source: 'model', items: [{ contentHash: 'a', citation: 'c', stage: 'kept' }] }))!;
		expect(old.fellBack).toBeUndefined();
		expect(old.items[0]!.judged).toBeUndefined();
	});
});

describe('groupReportItems', () => {
	it('groups kept, dropped, hidden and cut, by relevance and stage', () => {
		const [row] = retrievals(DEMO_FEATURED_SESSION);
		const groups = groupReportItems(parseRetrievalReport(row!.reportJson)!.items);
		expect(groups.kept.map((i) => i.relevant)).toEqual([0.91, 0.78]);
		expect(groups.dropped).toHaveLength(1);
		expect(groups.hidden.map((i) => i.hiddenBy?.key)).toEqual(['old_running_joke', 'old_nickname']);
		expect(groups.cut.map((i) => i.stage)).toEqual(['recency', 'cut_late', 'cut_rerank', 'not_selected']);
	});

	it('puts unknown stages last in cut', () => {
		const items = [
			{ stage: 'zzz', citation: 'z' },
			{ stage: 'budget', citation: 'b' },
			{ stage: 'not_judged', citation: 'n' }
		].map((i) => ({ ...i, contentHash: '', lanes: [], hybrid: null, relevant: null, aboutParticipant: null, presence: false }));
		expect(groupReportItems(items).cut.map((i) => i.citation)).toEqual(['n', 'b', 'z']);
	});
});

describe('labels', () => {
	it('hidden by: keyword, pattern, judged, pending', () => {
		expect(hiddenByLabel({ key: 'nick', kind: 'keyword', detail: 'captain' })).toBe('hidden by nick (keyword "captain")');
		expect(hiddenByLabel({ key: 'habit', kind: 'judged', probability: 0.912 })).toBe('hidden by habit (judged p=0.91)');
		expect(hiddenByLabel({ key: 'habit', kind: 'judged', pending: true })).toBe('hidden by habit (judged, pending)');
		expect(parseHiddenBy({ key: 'k', kind: 'pattern', detail: '\\bx\\b', pending: true })).toEqual({
			key: 'k',
			kind: 'pattern',
			detail: '\\bx\\b',
			pending: true
		});
		expect(parseHiddenBy({ kind: 'judged' })).toBeUndefined();
		expect(parseHiddenBy('nope')).toBeUndefined();
	});

	it('scores and judge answers', () => {
		const base = { contentHash: '', citation: 'c', lanes: [], presence: false, stage: 'kept' };
		expect(scoresLabel({ ...base, hybrid: 0.6, late: 0.71, rerank: 0.444, relevant: null, aboutParticipant: null })).toBe(
			'hybrid 0.60 · late 0.71 · rerank 0.44'
		);
		expect(scoresLabel({ ...base, hybrid: 0.6, late: null, relevant: null, aboutParticipant: null })).toBe(
			'hybrid 0.60 · late n/a'
		);
		expect(judgeLabel({ ...base, hybrid: null, relevant: 0.82, aboutParticipant: 0.1 })).toBe(
			'relevant 0.82 · about participant 0.10'
		);
		expect(judgeLabel({ ...base, hybrid: null, relevant: null, aboutParticipant: null })).toBeNull();
		expect(stageLabel('cut_late')).toBe('cut at late stage');
		expect(stageLabel('something_new')).toBe('something_new');
		expect(formatMs(null)).toBe('?');
		expect(formatMs(1380)).toBe('1.4s');
		expect(retrievalCountsLabel({ kept: 2, candidates: 9, hidden: 0 })).toBe('kept 2 of 9');
		expect(retrievalCountsLabel({ kept: 2, candidates: 9, hidden: 3 })).toBe('kept 2 of 9, 3 hidden');
	});

	it('the fallback demo build carries its reason', () => {
		const [row] = retrievals(DEMO_LATE_INPUT_SESSION);
		expect(row!.decisionGroup).toBeNull();
		const report = parseRetrievalReport(row!.reportJson)!;
		expect(report.reason).toBe('timeout');
		expect(groupReportItems(report.items).cut.map((i) => stageLabel(i.stage))).toEqual(['not judged', 'not judged']);
	});
});

describe('filters audit', () => {
	const hits = Schema.decodeUnknownSync(MemoryFilterHitsResponse)(
		resolveFixture('/api/memory/filter-hits', new URLSearchParams())
	).hits;

	it('groups hits per filter, most recently active first', () => {
		const groups = groupFilterHits(hits);
		expect(groups.map((g) => g.filterKey)).toEqual(['old_running_joke', 'old_nickname', 'old_bit']);
		const joke = groups[0]!;
		expect(joke.kinds).toEqual(['judged']);
		expect(joke.blocks).toBe(3);
		expect(joke.hides).toBe(20);
		expect(joke.versions).toBe(1);
		expect(joke.hits.map((h) => h.lastHiddenAt)).toEqual([...joke.hits.map((h) => h.lastHiddenAt)].sort((a, b) => b - a));
		expect(joke.firstHiddenAt).toBe(Math.min(...joke.hits.map((h) => h.firstHiddenAt)));
	});

	it('citation and match labels', () => {
		const hit: MemoryFilterHit = hits.find((h) => h.kind === 'keyword')!;
		expect(hitCitation(hit)).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md:\d+-\d+$/);
		expect(hitMatchLabel(hit)).toMatch(/^"cap/);
		expect(hitMatchLabel({ kind: 'judged', detail: null, probability: 0.876 })).toBe('p=0.88');
		expect(hitMatchLabel({ kind: 'judged', detail: null, probability: null })).toBe('—');
		expect(hitCitation({ path: null, startLine: null, endLine: null, contentHash: '0123456789abcdef' })).toBe('0123456789ab');
		expect(hitCitation({ path: 'memory/notes.md', startLine: null, endLine: null, contentHash: 'x' })).toBe('memory/notes.md');
		expect(groupFilterHits([])).toEqual([]);
	});
});

describe('stats', () => {
	it('source mix lists the known sources first, with shares', () => {
		const { windows } = Schema.decodeUnknownSync(MemoryStatsResponse)(
			resolveFixture('/api/memory/stats', new URLSearchParams())
		);
		expect(windows.map((w) => w.days)).toEqual([7, 30]);
		const mix = sourceMix(windows[0]!);
		expect(mix.map((m) => m.source)).toEqual(['model', 'model_fallback', 'fallback', 'unjudged', 'none']);
		expect(mix.reduce((a, m) => a + m.count, 0)).toBe(windows[0]!.builds);
		expect(sourceMix({ sources: { none: 2, experimental: 2 } })).toEqual([
			{ source: 'model', count: 0, share: 0 },
			{ source: 'model_fallback', count: 0, share: 0 },
			{ source: 'fallback', count: 0, share: 0 },
			{ source: 'unjudged', count: 0, share: 0 },
			{ source: 'none', count: 2, share: 0.5 },
			{ source: 'experimental', count: 2, share: 0.5 }
		]);
		expect(sourceMix({ sources: {} }).every((m) => m.share === null)).toBe(true);
		expect(sourceLabel('model_fallback')).toBe('model + fallback');
		expect(sourceLabel('model')).toBe('model');
	});

	it('formats the rate', () => {
		expect(formatRate(null)).toBe('—');
		expect(formatRate(23 / 184)).toBe('12.5%');
		expect(formatRate(Number.NaN)).toBe('—');
	});
});
