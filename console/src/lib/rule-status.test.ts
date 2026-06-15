import { describe, it, expect } from 'vitest';
import { presentRule } from './rule-status';

describe('presentRule', () => {
	// Issue #10b: a cap-0 rule (paid spend disabled) arrives as
	// { capUsd:0, fraction:1, state:"blocked" }. It must render as a distinct
	// badge, NOT a maxed-out fill bar (no money was spent).
	describe('cap-0 (paid spend disabled)', () => {
		it('renders a disabled badge instead of a bar', () => {
			const pres = presentRule({ capUsd: 0, fraction: 1, state: 'blocked' });
			expect(pres.kind).toBe('disabled');
			if (pres.kind === 'disabled') {
				expect(pres.label).toMatch(/\$0 cap/);
				expect(pres.label).toMatch(/disabled/);
			}
		});

		it('treats cap-0 as disabled regardless of the reported fraction', () => {
			expect(presentRule({ capUsd: 0, fraction: 0, state: 'blocked' }).kind).toBe('disabled');
		});
	});

	describe('normal capped rule (bar)', () => {
		it('clamps the bar width to 100% but reports the true (over-100) percent label', () => {
			const pres = presentRule({ capUsd: 1, fraction: 1.2, state: 'blocked' });
			expect(pres.kind).toBe('bar');
			if (pres.kind === 'bar') {
				expect(pres.fillPct).toBe(100); // clamped width
				expect(pres.percentLabel).toBe('120%'); // unclamped label
			}
		});

		it('renders a partial fill for an under-cap rule', () => {
			const pres = presentRule({ capUsd: 2, fraction: 0.25, state: 'ok' });
			expect(pres.kind).toBe('bar');
			if (pres.kind === 'bar') {
				expect(pres.fillPct).toBeCloseTo(25, 10);
				expect(pres.percentLabel).toBe('25%');
			}
		});

		it('renders a zero fill at zero spend (non-zero cap)', () => {
			const pres = presentRule({ capUsd: 5, fraction: 0, state: 'ok' });
			expect(pres.kind).toBe('bar');
			if (pres.kind === 'bar') {
				expect(pres.fillPct).toBe(0);
				expect(pres.percentLabel).toBe('0%');
			}
		});
	});
});
