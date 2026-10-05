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
			models: ['image-chat'],
			skills: ['image-generation'],
			tailFiles: []
		});
		expect(rowVerdictLabel(routing)).toBe('image · image-chat · +image-generation');
	});

	it('parses the answer map keyed by question name', () => {
		const answers = parseAnswers(routing.answersJson);
		expect(Object.keys(answers)).toEqual(['task', 'skill']);
		expect(answers.task).toMatchObject({ type: 'choice', choice: 'image', confidence: 0.91 });
		expect(answers.task.type === 'choice' && answers.task.probabilities.image).toBe(0.86);
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
