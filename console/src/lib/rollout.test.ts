import { describe, it, expect } from 'vitest';
import {
	assistantBlocks,
	contentText,
	collectToolResults,
	coerceContextMessage
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

	it('coerces defensively when fields are missing', () => {
		const cm = coerceContextMessage({});
		expect(cm.content).toBe('');
		expect(cm.tokenEstimate).toBe(0);
		expect(cm.tier).toBe('trigger');
	});
});
