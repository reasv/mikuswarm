import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import rows from '$lib/server/api/demo/decision-evaluations.json';
import { DecisionEvaluation } from '$lib/schemas';
import {
	fallbackReasonsLabel,
	groupDecisions,
	parseAnswers,
	parseRecordsVerdict,
	parseRoutingVerdict,
	routingLabelAnswers,
	rowTopConfidence,
	rowVerdictLabel,
	summarizeDecisionGroup
} from '$lib/decisions';

// `decision-evaluations.json` is written by the real DecisionEngine
// (test/decision-evaluation-fixture.test.ts), so these tests read the shapes the
// agent actually stores, not hand-made ones.
const evaluations: DecisionEvaluation[] = rows.map((row, i) =>
	Schema.decodeUnknownSync(DecisionEvaluation)({ ...row, id: i + 1, ts: 1000 + i, latencyMs: 100 })
);
const routing = evaluations.find((r) => r.point === 'routing')!;
const records = evaluations.filter((r) => r.point === 'records');

describe('decision rows as the engine writes them', () => {
	it('parses the routing verdict (the point describe output)', () => {
		expect(parseRoutingVerdict(routing.verdictJson)).toEqual({
			task: 'image',
			tasks: ['image'],
			models: ['image-chat'],
			skills: ['image-generation'],
			tailFiles: []
		});
		expect(rowVerdictLabel(routing)).toBe('image · image-chat · +image-generation');
	});

	it('reads multi-label routing: every selected task, and the per-label answers', () => {
		const multi = {
			...routing,
			verdictJson: JSON.stringify({ task: 'image', tasks: ['image', 'research'], models: ['image-chat'] }),
			answersJson: JSON.stringify({
				task__research: { type: 'noul', noul: 0.7 },
				task__image: { type: 'noul', noul: 0.91 },
				task__coding: { type: 'noul', noul: 0.05 },
				'skill__web-research': { type: 'noul', noul: 0.2 },
				difficulty: { type: 'score', score: 2, probabilities: { '2': 0.8 }, confidence: 0.8 }
			})
		};
		expect(parseRoutingVerdict(multi.verdictJson)?.tasks).toEqual(['image', 'research']);
		expect(rowVerdictLabel(multi)).toBe('image + research · image-chat');
		expect(routingLabelAnswers(multi)).toEqual({
			tasks: [
				{ key: 'image', probability: 0.91, selected: true },
				{ key: 'research', probability: 0.7, selected: true },
				{ key: 'coding', probability: 0.05, selected: false }
			],
			skills: [{ key: 'web-research', probability: 0.2, selected: false }]
		});
		// A row written before multi-label routing: `tasks` falls back to its single task.
		expect(parseRoutingVerdict('{"task":"other"}')?.tasks).toEqual(['other']);
		expect(routingLabelAnswers(routing).tasks.map((t) => [t.key, t.selected])).toEqual([
			['image', true],
			['research', false]
		]);
	});

	it('parses the answer map keyed by question name', () => {
		const answers = parseAnswers(routing.answersJson);
		expect(Object.keys(answers)).toEqual([
			'task__image',
			'task__research',
			'skill__image-generation',
			'skill__web-research'
		]);
		expect(answers.task__image).toEqual({ type: 'noul', noul: 0.91 });
		expect(rowTopConfidence(routing)).toBe(0.91);

		const injectedRow = records.find((r) => r.candidateSessionId === 'ses_v8n2ke')!;
		expect(parseAnswers(injectedRow.answersJson)).toEqual({ relevant: { type: 'noul', noul: 0.83 } });
		expect(parseRecordsVerdict(injectedRow.verdictJson)).toEqual({
			inject: true,
			relevance: 0.83,
			candidateSessionId: 'ses_v8n2ke'
		});
	});

	it('summarizes a records group over every candidate, with mixed sources', () => {
		const s = summarizeDecisionGroup(records, ['ses_v8n2ke']);
		expect(s.point).toBe('records');
		expect(s.verdict).toBe('injected ses_v8n2ke');
		expect(s.candidates).toBe(3);
		expect(s.topConfidence).toBe(0.83);
		expect(s.sources).toEqual({ model: 2, heuristic: 1 });
		expect(fallbackReasonsLabel(s)).toBe('error');
	});

	it('says "nothing injected" when the rollout shows no injection', () => {
		expect(summarizeDecisionGroup(records, []).verdict).toBe('nothing injected');
	});

	it('falls back to the rows own verdicts when the rollout is unknown', () => {
		expect(summarizeDecisionGroup(records).injected).toEqual(['ses_v8n2ke']);
	});

	it('groups rows by decision group in order', () => {
		expect([...groupDecisions(evaluations).keys()]).toEqual(['dg-routing-demo', 'dg-records-demo']);
	});
});

describe('defensive parsing', () => {
	it('returns empty/null for missing or malformed columns', () => {
		expect(parseAnswers(null)).toEqual({});
		expect(parseAnswers('not json')).toEqual({});
		expect(parseAnswers('[{"label":"x","probability":0.9}]')).toEqual({});
		expect(parseRoutingVerdict('{"model":"x"}')).toBeNull();
		expect(parseRecordsVerdict(null)).toBeNull();
	});

	it('labels a heuristic routing fallback and counts repeated reasons', () => {
		const base = { ...routing, source: 'heuristic', answersJson: null, verdictJson: '{"task":"other"}' };
		const s = summarizeDecisionGroup([
			{ ...base, reason: 'timeout' },
			{ ...base, id: 99, reason: 'timeout' }
		]);
		expect(s.verdict).toBe('other | other');
		expect(s.topConfidence).toBeNull();
		expect(fallbackReasonsLabel(s)).toBe('timeout ×2');
	});
});
