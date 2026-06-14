import { describe, it, expect } from 'vitest';
import { computeCostBudget } from './cost-budget';

describe('computeCostBudget', () => {
	describe('lane-sum', () => {
		it('sums the agent-loop lane and the tool lane', () => {
			const b = computeCostBudget({
				maxSessionCostUsd: 1.0,
				usage: { cost: 0.5 },
				toolUsage: { cost: 0.32 }
			});
			expect(b).not.toBeNull();
			expect(b!.spent).toBeCloseTo(0.82, 10);
			expect(b!.limit).toBe(1.0);
		});

		it('treats an absent usage lane as 0 (tool-only spend)', () => {
			const b = computeCostBudget({ maxSessionCostUsd: 1.0, toolUsage: { cost: 0.4 } });
			expect(b!.spent).toBeCloseTo(0.4, 10);
		});

		it('treats an absent tool lane as 0 (agent-loop-only spend)', () => {
			const b = computeCostBudget({ maxSessionCostUsd: 1.0, usage: { cost: 0.4 } });
			expect(b!.spent).toBeCloseTo(0.4, 10);
		});

		it('treats both lanes absent/null as 0 spend', () => {
			const b = computeCostBudget({ maxSessionCostUsd: 1.0, usage: null, toolUsage: null });
			expect(b!.spent).toBe(0);
			expect(b!.pct).toBe(0);
		});
	});

	describe('percentage rounding (Math.round, half rounds up)', () => {
		// pct = round(spent / limit * 100); limit 1.0 keeps spent == fraction.
		it('rounds 99.4% down to 99', () => {
			expect(computeCostBudget({ maxSessionCostUsd: 1.0, usage: { cost: 0.994 } })!.pct).toBe(99);
		});
		it('rounds 99.5% up to 100', () => {
			expect(computeCostBudget({ maxSessionCostUsd: 1.0, usage: { cost: 0.995 } })!.pct).toBe(100);
		});
		it('rounds 0.4% down to 0', () => {
			expect(computeCostBudget({ maxSessionCostUsd: 1.0, usage: { cost: 0.004 } })!.pct).toBe(0);
		});
		it('can exceed 100% (indicator turns destructive at ≥100)', () => {
			const b = computeCostBudget({ maxSessionCostUsd: 1.0, usage: { cost: 1.2 } });
			expect(b!.pct).toBe(120);
		});
	});

	describe('null-gating (no budget line)', () => {
		it('returns null when the session is absent', () => {
			expect(computeCostBudget(null)).toBeNull();
			expect(computeCostBudget(undefined)).toBeNull();
		});
		it('returns null when the ceiling is null (unlimited)', () => {
			expect(
				computeCostBudget({ maxSessionCostUsd: null, usage: { cost: 0.5 } })
			).toBeNull();
		});
		it('returns null when the ceiling is undefined (unlimited)', () => {
			expect(computeCostBudget({ usage: { cost: 0.5 } })).toBeNull();
		});
		// The `limit <= 0` defensive guard is deliberately retained (review issue #2
		// was struck) — a non-positive ceiling yields no budget line, never a
		// divide-by-zero / negative denominator.
		it('returns null when the ceiling is 0', () => {
			expect(computeCostBudget({ maxSessionCostUsd: 0, usage: { cost: 0.5 } })).toBeNull();
		});
		it('returns null when the ceiling is negative', () => {
			expect(computeCostBudget({ maxSessionCostUsd: -1, usage: { cost: 0.5 } })).toBeNull();
		});
	});
});
