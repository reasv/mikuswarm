import { describe, it, expect } from 'vitest';
import { tierMeta, isCollapsible, defaultOpen, type CollapsibleMessage } from './tiers';

describe('tierMeta', () => {
	it('returns metadata for known tiers', () => {
		expect(tierMeta('summary').label).toBe('summary');
		expect(tierMeta('rich').label).toBe('rich');
		expect(tierMeta('diary').label).toBe('diary');
	});

	it('falls back for unknown / null tiers', () => {
		expect(tierMeta(null).label).toBe('—');
		expect(tierMeta('nope').label).toBe('—');
	});
});

// Default-expansion contract for the verbatim renderer. The room-context preview and
// the session-input view share one uniform policy (they used to diverge — issue #13).
describe('verbatim collapse defaults', () => {
	const msg = (m: CollapsibleMessage): CollapsibleMessage => m;

	it('collapses the system prompt, the satellite block and the diary layer', () => {
		expect(isCollapsible(msg({ type: 'system', tier: 'system' }))).toBe(true);
		expect(isCollapsible(msg({ type: 'satellite', tier: 'mixed' }))).toBe(true);
		expect(isCollapsible(msg({ type: 'diaryLayer', tier: 'diary' }))).toBe(true);
		expect(defaultOpen(msg({ type: 'system', tier: 'system' }))).toBe(false);
		expect(defaultOpen(msg({ type: 'diaryLayer', tier: 'diary' }))).toBe(false);
	});

	it('collapses the earlier summary/compact/rich/mixed tiers by default', () => {
		for (const tier of ['summary', 'compact', 'rich', 'mixed']) {
			expect(isCollapsible(msg({ type: 'chatEvent', tier }))).toBe(true);
			expect(defaultOpen(msg({ type: 'chatEvent', tier }))).toBe(false);
		}
	});

	it('keeps the final user turn / trigger expanded', () => {
		expect(isCollapsible(msg({ type: 'triggerGroup', tier: 'trigger' }))).toBe(false);
		expect(defaultOpen(msg({ type: 'triggerGroup', tier: 'trigger' }))).toBe(true);
		// The <system> satellite block keeps its affordance even at the trigger position.
		expect(isCollapsible(msg({ type: 'satellite', tier: 'trigger' }))).toBe(true);
	});

	it('treats messages with no tier as expanded (runtime/unknown)', () => {
		expect(isCollapsible(msg({ type: 'chatEvent', tier: null }))).toBe(false);
		expect(isCollapsible(msg({ type: 'chatEvent' }))).toBe(false);
	});
});
