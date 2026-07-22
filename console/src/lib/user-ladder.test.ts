import { describe, it, expect } from 'vitest';
import { buildLadder, buildSegments } from './user-ladder';
import type { UserLimitStatus } from './schemas';

/** Terse UserLimitStatus fixture (daily-UTC window, fields defaulted). */
function meter(
	p: Partial<UserLimitStatus> & Pick<UserLimitStatus, 'partitionKey' | 'spentUsd' | 'capUsd'>
): UserLimitStatus {
	const fraction = p.fraction ?? (p.capUsd > 0 ? p.spentUsd / p.capUsd : 1);
	return {
		meterKey: p.meterKey ?? `${p.partitionKey}:${(p.modelScope ?? ['*']).join('+')}`,
		partitionKey: p.partitionKey,
		isUserPartition: p.isUserPartition ?? true,
		modelScope: p.modelScope,
		orderIndex: p.orderIndex,
		spentUsd: p.spentUsd,
		capUsd: p.capUsd,
		fraction,
		state: p.state ?? (fraction >= 1 ? 'blocked' : fraction >= 0.8 ? 'near' : 'ok'),
		window: { type: 'calendar', period: 'day', tz: 'UTC' },
		resetsAt: p.resetsAt ?? 1000
	} as UserLimitStatus;
}

// Preference order sol(1) < terra(1001) < sol+terra(1002) < glm(2001), per the backend key.
function sample(): UserLimitStatus[] {
	return [
		// Deliberately out of order in the array — buildLadder must re-sort by orderIndex.
		meter({ partitionKey: '@a', modelScope: ['sol', 'terra'], spentUsd: 1.69, capUsd: 4, orderIndex: 1002, state: 'ok' }),
		meter({ partitionKey: '@a', modelScope: ['glm'], spentUsd: 0.03, capUsd: 1.5, orderIndex: 2001, state: 'ok' }),
		meter({ partitionKey: '@a', modelScope: ['sol'], spentUsd: 1.45, capUsd: 1.5, orderIndex: 1, state: 'near' }),
		meter({ partitionKey: '@a', modelScope: ['terra'], spentUsd: 0.24, capUsd: 3, orderIndex: 1001, state: 'ok' }),
		meter({ partitionKey: 'all-users', isUserPartition: false, modelScope: ['sol'], spentUsd: 1.09, capUsd: 10, orderIndex: 1, state: 'ok' })
	];
}

describe('buildLadder', () => {
	it('splits users from shared pools', () => {
		const m = buildLadder(sample());
		expect(m.users.map((g) => g.partitionKey)).toEqual(['@a']);
		expect(m.pools.map((g) => g.partitionKey)).toEqual(['all-users']);
	});

	it('orders caps by preference (composite right after its members)', () => {
		const g = buildLadder(sample()).users[0];
		expect(g.caps.map((c) => c.label)).toEqual(['sol', 'terra', 'sol + terra', 'glm']);
	});

	it('renders a composite as a segmented bar composed of its members, in preference order', () => {
		const composite = buildLadder(sample()).users[0].caps.find((c) => c.isComposite)!;
		expect(composite.label).toBe('sol + terra');
		expect(composite.segments.map((s) => s.model)).toEqual(['sol', 'terra']); // sol(pref 1) before terra
		expect(composite.segments[0].widthFraction).toBeCloseTo(1.45 / 4, 6);
		expect(composite.segments[1].widthFraction).toBeCloseTo(0.24 / 4, 6);
		expect(composite.remainderFraction).toBeCloseTo(0, 6); // members sum to the composite total
	});

	it('colors composite segments from a non-health palette (no green/amber/red)', () => {
		const composite = buildLadder(sample()).users[0].caps.find((c) => c.isComposite)!;
		const HEALTH = ['#10b981', '#22c55e', '#f59e0b', '#ef4444', '#eab308'];
		for (const seg of composite.segments) expect(HEALTH).not.toContain(seg.color);
		expect(composite.segments[0].color).not.toBe(composite.segments[1].color);
	});

	it('renders single-model caps as plain (non-composite) bars', () => {
		const sol = buildLadder(sample()).users[0].caps[0];
		expect(sol.label).toBe('sol');
		expect(sol.isComposite).toBe(false);
		expect(sol.segments).toEqual([]);
	});

	it('preserves an over-cap fraction (>100%) and the blocked state', () => {
		const g = buildLadder([
			meter({ partitionKey: '@b', modelScope: ['sol'], spentUsd: 2.82, capUsd: 1.5, fraction: 1.88, orderIndex: 1, state: 'blocked' })
		]).users[0];
		expect(g.caps[0].fraction).toBeCloseTo(1.88, 6);
		expect(g.caps[0].state).toBe('blocked');
	});

	it('puts unattributed composite spend into remainderFraction when a member has no meter', () => {
		// A composite with $2 spent but only a sol single ($1) present — terra's $1 is remainder.
		const composite = buildLadder([
			meter({ partitionKey: '@c', modelScope: ['sol'], spentUsd: 1, capUsd: 1.5, orderIndex: 1 }),
			meter({ partitionKey: '@c', modelScope: ['sol', 'terra'], spentUsd: 2, capUsd: 4, orderIndex: 1002 })
		]).users[0].caps.find((c) => c.isComposite)!;
		expect(composite.segments.map((s) => s.model)).toEqual(['sol']);
		expect(composite.remainderFraction).toBeCloseTo(1 / 4, 6);
	});

	it('labels a fungible (no-modelScope) total as "all models"', () => {
		const g = buildLadder([meter({ partitionKey: '@x', modelScope: undefined, spentUsd: 1, capUsd: 5, orderIndex: -1000 })]).users[0];
		expect(g.caps[0].label).toBe('all models');
		expect(g.caps[0].isComposite).toBe(false);
	});

	it('takes the earliest reset across a group', () => {
		const g = buildLadder([
			meter({ partitionKey: '@x', modelScope: ['sol'], spentUsd: 1, capUsd: 2, resetsAt: 500 }),
			meter({ partitionKey: '@x', modelScope: ['glm'], spentUsd: 1, capUsd: 2, resetsAt: 300 })
		]).users[0];
		expect(g.resetsAt).toBe(300);
	});

	it('buildSegments colors by position (shared by global limits) with distinct hues', () => {
		// The global-limits path: per-model components → segments, colored by position.
		const segs = buildSegments(
			[
				{ model: 'sol', spentUsd: 3 },
				{ model: 'terra', spentUsd: 1 }
			],
			8
		);
		expect(segs.map((s) => s.model)).toEqual(['sol', 'terra']);
		expect(segs[0].widthFraction).toBeCloseTo(3 / 8, 6);
		expect(segs[1].widthFraction).toBeCloseTo(1 / 8, 6);
		expect(segs[0].color).not.toBe(segs[1].color);
		const HEALTH = ['#10b981', '#22c55e', '#f59e0b', '#ef4444', '#eab308'];
		for (const s of segs) expect(HEALTH).not.toContain(s.color);
	});

	it('does not crash when the BFF omits orderIndex (back-compat)', () => {
		const g = buildLadder([
			meter({ partitionKey: '@old', modelScope: ['sol'], spentUsd: 1, capUsd: 2, orderIndex: undefined }),
			meter({ partitionKey: '@old', modelScope: ['glm'], spentUsd: 0.5, capUsd: 2, orderIndex: undefined })
		]).users[0];
		expect(g.caps).toHaveLength(2);
	});
});
