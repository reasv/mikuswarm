import { describe, it, expect } from 'vitest';
import {
	assistantBlocks,
	contentText,
	collectToolResults,
	coerceContextMessage,
	isDuplicateInjectedTurn,
	isInjectedUserTurn,
	getHarness,
	isHarnessMessage,
	buildRolloutPlan,
	extractRecordsGiven
} from './rollout';
import type { DecisionEvaluation } from '$lib/schemas';

describe('rollout helpers', () => {
	it('extracts assistant content blocks', () => {
		const blocks = assistantBlocks([
			{ type: 'text', text: 'hi' },
			{ type: 'thinking', thinking: 'hmm' },
			{ type: 'toolCall', id: 't1', name: 'send', arguments: { a: 1 } },
			null,
			'garbage'
		]);
		expect(blocks.map((b) => b.type)).toEqual(['text', 'thinking', 'toolCall']);
	});

	it('flattens content to text (string and block array)', () => {
		expect(contentText('plain')).toBe('plain');
		expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
		expect(contentText(undefined)).toBe('');
	});

	it('maps toolCallId → tool result', () => {
		const map = collectToolResults([
			{ role: 'assistant', content: [] },
			{ role: 'toolResult', toolCallId: 't1', toolName: 'send', content: [{ type: 'text', text: 'ok' }], isError: false }
		]);
		expect(map.get('t1')?.toolName).toBe('send');
		expect(contentText(map.get('t1')?.content)).toBe('ok');
	});

	it('classifies injected user turns (interjections + forced-completion prompts)', () => {
		// Interjections carry NO role — they must still route to InterjectionCard (issue #3).
		expect(isInjectedUserTurn({ type: 'interjection', content: 'oi' })).toBe(true);
		// Forced-completion prompts arrive as plain role:'user'.
		expect(isInjectedUserTurn({ role: 'user', content: 'finish up' })).toBe(true);
		// Assistant / tool-result / raw turns are not injected user turns.
		expect(isInjectedUserTurn({ role: 'assistant', content: [] })).toBe(false);
		expect(isInjectedUserTurn({ role: 'toolResult', toolCallId: 't1' })).toBe(false);
		expect(isInjectedUserTurn({ type: 'something', content: 'x' })).toBe(false);
	});

	it('coerces a transcript head turn into a context message', () => {
		const cm = coerceContextMessage({
			type: 'triggerGroup',
			role: 'user',
			content: 'hello',
			tier: 'trigger',
			tokenEstimate: 7,
			timestamp: 99,
			imageBlocks: [{ __imageRef: true, attachmentId: 'a1', sizeBytes: 10 }]
		});
		expect(cm).toMatchObject({ type: 'triggerGroup', role: 'user', content: 'hello', tokenEstimate: 7 });
		expect(cm.imageRefs).toHaveLength(1);
	});

	it('externalizes RAW context imageBlocks into ImageRefs (no dataBase64 leak)', () => {
		// Persisted head keeps raw context blocks: { eventId, attachmentId, mediaType, dataBase64 }.
		const cm = coerceContextMessage({
			type: 'triggerGroup',
			role: 'user',
			content: 'see pic',
			imageBlocks: [
				{ eventId: '$e:m', attachmentId: 'a1', mediaType: 'image/png', dataBase64: 'AAAA' }
			]
		});
		expect(cm.imageRefs).toHaveLength(1);
		const ref = cm.imageRefs![0] as Record<string, unknown>;
		expect(ref.mimeType).toBe('image/png');
		expect(ref.attachmentId).toBe('a1');
		expect(ref.sizeBytes).toBe(3); // 'AAAA' = 3 bytes
		// raw base64 must not survive into the wire ref
		expect('dataBase64' in ref).toBe(false);
	});

	it('passes through already-externalized imageRefs', () => {
		const cm = coerceContextMessage({
			type: 'triggerGroup',
			content: 'x',
			imageRefs: [{ __imageRef: true, attachmentId: 'a2', mimeType: 'image/jpeg', sizeBytes: 42 }]
		});
		expect(cm.imageRefs).toHaveLength(1);
		expect((cm.imageRefs![0] as Record<string, unknown>).sizeBytes).toBe(42);
	});

	it('coerces defensively when fields are missing (legacy records → null, not 0)', () => {
		// A genuinely-legacy head turn (persisted before the producer threaded the
		// real tier/tokenEstimate, issue #9) must surface null so the renderer shows
		// an em-dash — never a misleading 0 / hardcoded `trigger`.
		const cm = coerceContextMessage({});
		expect(cm.content).toBe('');
		expect(cm.tokenEstimate).toBe(null);
		expect(cm.tier).toBe(null);
	});

	it('prefers the real persisted tier/tokenEstimate on the head turn (issue #9)', () => {
		const cm = coerceContextMessage({
			type: 'triggerGroup',
			role: 'user',
			content: 'go',
			tier: 'trigger',
			tokenEstimate: 123
		});
		expect(cm.tokenEstimate).toBe(123);
		expect(cm.tier).toBe('trigger');
	});

	it('detects an injected user turn already present (seed/message_start dedup)', () => {
		const seed = [
			{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
			{ type: 'interjection', content: 'ping' },
			{ role: 'user', content: [{ type: 'text', text: 'continue' }] }
		];
		// A re-delivered interjection (distinct object, same content) is a duplicate.
		expect(isDuplicateInjectedTurn(seed, { type: 'interjection', content: 'ping' })).toBe(true);
		// A forced-completion `role:'user'` prompt matched by flattened text.
		expect(
			isDuplicateInjectedTurn(seed, { role: 'user', content: [{ type: 'text', text: 'continue' }] })
		).toBe(true);
		// A genuinely new interjection is NOT a duplicate.
		expect(isDuplicateInjectedTurn(seed, { type: 'interjection', content: 'pong' })).toBe(false);
		// Assistant messages are never matched (not injected user turns).
		expect(
			isDuplicateInjectedTurn(seed, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
		).toBe(false);
	});
});

// ── Session-records helpers (spec SESSION-RECORDS §4, §8) ────────────────────

describe('harness marker helpers', () => {
	it('detects an injection marker with decisionGroup', () => {
		const m = { role: 'assistant', content: [], harness: { kind: 'injection', decisionGroup: 'grp-1' } };
		const h = getHarness(m);
		expect(h?.kind).toBe('injection');
		expect((h as { decisionGroup?: string })?.decisionGroup).toBe('grp-1');
		expect(isHarnessMessage(m)).toBe(true);
	});

	it('detects injection without decisionGroup (routing preload)', () => {
		const m = { role: 'assistant', content: [], harness: { kind: 'injection' } };
		const h = getHarness(m);
		expect(h?.kind).toBe('injection');
		expect((h as { decisionGroup?: string })?.decisionGroup).toBeUndefined();
	});

	it('detects record_turn and record_load markers', () => {
		expect(getHarness({ role: 'user', content: 'x', harness: { kind: 'record_turn' } })?.kind).toBe('record_turn');
		expect(getHarness({ role: 'assistant', content: [], harness: { kind: 'record_load' } })?.kind).toBe('record_load');
	});

	it('returns null for model-made messages (no harness field)', () => {
		expect(getHarness({ role: 'assistant', content: [] })).toBeNull();
		expect(isHarnessMessage({ role: 'assistant', content: [] })).toBe(false);
	});

	it('ignores malformed harness fields', () => {
		expect(getHarness({ harness: null })).toBeNull();
		expect(getHarness({ harness: 'injection' })).toBeNull();
		expect(getHarness({ harness: { kind: 'unknown' } })).toBeNull();
	});
});

describe('buildRolloutPlan', () => {
	// Minimal evaluation fixture factory.
	const ev = (dg: string, id = 1): DecisionEvaluation => ({
		id,
		ts: 0,
		decisionGroup: dg,
		point: 'records',
		agent: null,
		timelineKey: null,
		agentSessionId: 'ses_x',
		triggerEventId: null,
		candidateSessionId: null,
		source: 'model',
		reason: null,
		verdictJson: null,
		answersJson: null,
		stateJson: null,
		questionsJson: null,
		servedModel: null,
		servedVersion: null,
		latencyMs: null,
		inputTokens: null,
		costUsd: null
	});

	it('places a matched decision card before the first injection with that decisionGroup', () => {
		const messages = [
			{ role: 'assistant', content: [], harness: { kind: 'injection', decisionGroup: 'grp-A' } },
			{ role: 'toolResult', toolCallId: 't1', harness: { kind: 'injection', decisionGroup: 'grp-A' } },
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
		];
		const plan = buildRolloutPlan(messages, [ev('grp-A')]);
		// First item must be the decision card for grp-A, then the injection messages, then the real turn.
		expect(plan[0]).toMatchObject({ type: 'decision', decisionGroup: 'grp-A' });
		expect(plan[1]).toMatchObject({ type: 'message', index: 0 });
		expect(plan[2]).toMatchObject({ type: 'message', index: 1 });
		expect(plan[3]).toMatchObject({ type: 'message', index: 2 });
	});

	it('places an unmatched decision card before turn 1', () => {
		// A heuristic fallback group injects nothing: its card still appears before turn 1.
		const messages = [
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
		];
		const plan = buildRolloutPlan(messages, [ev('grp-B')]);
		expect(plan[0]).toMatchObject({ type: 'decision', decisionGroup: 'grp-B' });
		expect(plan[1]).toMatchObject({ type: 'message', index: 0 });
	});

	it('handles two groups: routing unmatched + records matched', () => {
		const messages = [
			{ role: 'assistant', content: [], harness: { kind: 'injection', decisionGroup: 'grp-R' } },
			{ role: 'toolResult', toolCallId: 'c1', harness: { kind: 'injection', decisionGroup: 'grp-R' } },
			{ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
		];
		const evals = [ev('grp-ROUTING', 1), ev('grp-R', 2)];
		const plan = buildRolloutPlan(messages, evals);
		// grp-ROUTING has no matching injection → placed before turn 1 (= before grp-R card)
		expect(plan[0]).toMatchObject({ type: 'decision', decisionGroup: 'grp-ROUTING' });
		// grp-R is matched by messages[0] → card before that message
		expect(plan[1]).toMatchObject({ type: 'decision', decisionGroup: 'grp-R' });
		expect(plan[2]).toMatchObject({ type: 'message', index: 0 });
	});

	it('returns all messages unchanged when there are no evaluations', () => {
		const messages = [
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
			{ role: 'toolResult', toolCallId: 't1' }
		];
		const plan = buildRolloutPlan(messages, []);
		expect(plan).toHaveLength(2);
		expect(plan.every((item) => item.type === 'message')).toBe(true);
	});
});

describe('extractRecordsGiven', () => {
	it('extracts session ids and text from harness-injection read_session_record calls', () => {
		const transcript = [
			// head turn (excluded from rollout but present in transcript)
			{ type: 'triggerGroup', role: 'user', content: 'do the thing' },
			// harness injection: assistant calls read_session_record
			{
				role: 'assistant',
				content: [
					{ type: 'toolCall', id: 'tc1', name: 'read_session_record', arguments: { session_id: 'ses_ABC' } }
				],
				harness: { kind: 'injection', decisionGroup: 'grp-1' }
			},
			{
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'read_session_record',
				content: [{ type: 'text', text: 'Record text here.' }],
				isError: false,
				harness: { kind: 'injection', decisionGroup: 'grp-1' }
			},
			// harness injection: load_skill (NOT a record read — must be ignored)
			{
				role: 'assistant',
				content: [
					{ type: 'toolCall', id: 'tc2', name: 'load_skill', arguments: { name: 'contacts' } }
				],
				harness: { kind: 'injection' }
			},
			{
				role: 'toolResult',
				toolCallId: 'tc2',
				toolName: 'load_skill',
				content: [{ type: 'text', text: 'Loaded.' }],
				isError: false,
				harness: { kind: 'injection' }
			},
			// model turn (NOT a harness message)
			{ role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] }
		];
		const records = extractRecordsGiven(transcript);
		expect(records).toHaveLength(1);
		expect(records[0].sessionId).toBe('ses_ABC');
		expect(records[0].text).toBe('Record text here.');
	});

	it('returns empty array when there are no harness injections', () => {
		const transcript = [
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
		];
		expect(extractRecordsGiven(transcript)).toHaveLength(0);
	});
});
