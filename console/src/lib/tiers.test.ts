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

// Default-expansion contract for the verbatim renderer (spec §10a vs §10b, issue #13).
describe('verbatim collapse defaults', () => {
	const msg = (m: CollapsibleMessage): CollapsibleMessage => m;

	describe('room mode (§10a)', () => {
		it('collapses only system, satellite and the diary layer', () => {
			expect(isCollapsible(msg({ type: 'system', tier: 'system' }), 'room')).toBe(true);
			expect(isCollapsible(msg({ type: 'satellite', tier: 'mixed' }), 'room')).toBe(true);
			expect(isCollapsible(msg({ type: 'diaryLayer', tier: 'diary' }), 'room')).toBe(true);
			expect(defaultOpen(msg({ type: 'diaryLayer', tier: 'diary' }), 'room')).toBe(false);
		});

		it('keeps summary/compact/rich tiers expanded', () => {
			expect(isCollapsible(msg({ type: 'chatEvent', tier: 'summary' }), 'room')).toBe(false);
			expect(isCollapsible(msg({ type: 'chatEvent', tier: 'compact' }), 'room')).toBe(false);
			expect(isCollapsible(msg({ type: 'chatEvent', tier: 'rich' }), 'room')).toBe(false);
			expect(defaultOpen(msg({ type: 'chatEvent', tier: 'rich' }), 'room')).toBe(true);
		});

		it('keeps the trigger / final user turn expanded', () => {
			expect(isCollapsible(msg({ type: 'triggerGroup', tier: 'trigger' }), 'room')).toBe(false);
			expect(defaultOpen(msg({ type: 'triggerGroup', tier: 'trigger' }), 'room')).toBe(true);
		});
	});

	describe('session mode (§10b)', () => {
		it('collapses system and satellite (kept affordance)', () => {
			expect(isCollapsible(msg({ type: 'system', tier: 'system' }), 'session')).toBe(true);
			expect(isCollapsible(msg({ type: 'satellite', tier: 'mixed' }), 'session')).toBe(true);
			expect(defaultOpen(msg({ type: 'system', tier: 'system' }), 'session')).toBe(false);
		});

		it('collapses earlier summary/compact/rich tiers by default', () => {
			for (const tier of ['summary', 'compact', 'rich', 'mixed']) {
				expect(isCollapsible(msg({ type: 'chatEvent', tier }), 'session')).toBe(true);
				expect(defaultOpen(msg({ type: 'chatEvent', tier }), 'session')).toBe(false);
			}
		});

		it('collapses the diary layer by default', () => {
			expect(isCollapsible(msg({ type: 'diaryLayer', tier: 'diary' }), 'session')).toBe(true);
			expect(defaultOpen(msg({ type: 'diaryLayer', tier: 'diary' }), 'session')).toBe(false);
		});

		it('keeps the final user turn / trigger expanded', () => {
			expect(isCollapsible(msg({ type: 'triggerGroup', tier: 'trigger' }), 'session')).toBe(false);
			expect(defaultOpen(msg({ type: 'triggerGroup', tier: 'trigger' }), 'session')).toBe(true);
			expect(isCollapsible(msg({ type: 'satellite', tier: 'trigger' }), 'session')).toBe(true); // <system> satellite block keeps its affordance
		});

		it('treats messages with no tier as expanded (runtime/unknown)', () => {
			expect(isCollapsible(msg({ type: 'chatEvent', tier: null }), 'session')).toBe(false);
			expect(isCollapsible(msg({ type: 'chatEvent' }), 'session')).toBe(false);
		});
	});
});
