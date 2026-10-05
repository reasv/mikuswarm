import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import sample from '$lib/server/api/demo/model-behaviour.json';
import { BehaviourIncidentPage, ModelBehaviourResponse } from './schemas';

// `model-behaviour.json` is a real `GET /api/models/behaviour` body, produced by
// the agent's read API (src/behaviour/read.ts) over synthetic rows (two sessions
// and a caption job), so a backend wire-shape drift fails here (fidelity guard).
const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) => Schema.decodeUnknownSync(s)(v);

describe('model behaviour schemas', () => {
	it('decodes a real /api/models/behaviour response', () => {
		const out = decode(ModelBehaviourResponse, sample);
		expect(out.groupBy).toBe('model');
		expect(out.scorecard.map((r) => r.group)).toContain('model_a');
		expect(out.scorecard[0].cells['refusals_hard_per_request'].count).toBeTypeOf('number');
		expect(out.rates.map((r) => r.id)).toContain('style_hits_per_1k_tokens');
		expect(out.markers[0].events[0].kind).toBe('prompt_changed');
		expect(out.incidents.rows[0].link.sessionId).toBe('s1');
		expect(out.breakdown.contract.untilRecovery).toHaveLength(6);
	});

	it('decodes an incident page and rejects a drifted row', () => {
		const page = decode(BehaviourIncidentPage, sample.incidents);
		expect(page.nextCursor).toBeNull();
		const drifted = { ...sample.incidents, rows: [{ ...sample.incidents.rows[0], chips: undefined }] };
		expect(() => decode(BehaviourIncidentPage, drifted)).toThrow();
	});
});
