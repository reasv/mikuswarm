import { describe, it, expect } from 'vitest';
import {
	assistantBlocks,
	contentText,
	collectToolResults,
	coerceContextMessage,
	isInjectedUserTurn
} from './rollout';

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
});
