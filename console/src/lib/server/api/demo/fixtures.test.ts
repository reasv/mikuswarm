import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import {
	resolveFixture,
	DEMO_FEATURED_SESSION,
	DEMO_FEATURED_ROOM,
	DEMO_FEATURED_CAPTION_ITEM
} from './fixtures';
import {
	UsageSummary,
	UsageTimeseries,
	UsageSessions,
	UsageToolCalls,
	UsageLeaderboard,
	UsageBudgets,
	UserLimitsPage,
	RoomsResponse,
	SessionsResponse,
	SessionFacetsResponse,
	RoomContextResponse,
	SessionDetailResponse,
	PipelinesResponse,
	PipelineItemsResponse,
	PipelineItemDetail,
	CostOverview,
	AgentsResponse
} from '$lib/schemas';

/**
 * Fidelity guard on the demo fixtures (spec CONSOLE-DEMO-MODE §6): every fixture must
 * decode through the same Effect Schema the live BFF decodes real responses with, so a
 * fixture that drifts from the wire shape fails here rather than silently in the UI.
 */

const room = encodeURIComponent(DEMO_FEATURED_ROOM);

type Case = { path: string; query?: Record<string, string>; schema: Schema.Schema<unknown, unknown> };

const cases: Case[] = [
	{ path: '/api/agents', schema: AgentsResponse as never },
	{ path: '/api/usage/sessions', schema: UsageSessions as never },
	{ path: '/api/usage/tool-calls', schema: UsageToolCalls as never },
	{ path: '/api/usage/budgets', schema: UsageBudgets as never },
	{ path: '/api/usage/user-limits', query: { scope: 'individuals', page: '0' }, schema: UserLimitsPage as never },
	{ path: '/api/usage/user-limits', query: { scope: 'shared', page: '0' }, schema: UserLimitsPage as never },
	{ path: '/api/rooms', schema: RoomsResponse as never },
	{ path: `/api/rooms/${room}/sessions`, schema: SessionsResponse as never },
	{ path: `/api/rooms/${room}/session-facets`, schema: SessionFacetsResponse as never },
	{ path: `/api/rooms/${room}/context`, schema: RoomContextResponse as never },
	{ path: `/api/sessions/${encodeURIComponent(DEMO_FEATURED_SESSION)}`, schema: SessionDetailResponse as never },
	{ path: '/api/pipelines', schema: PipelinesResponse as never },
	{ path: '/api/cost-overview', schema: CostOverview as never },
	{ path: '/api/pipelines/captioning/items', schema: PipelineItemsResponse as never },
	{ path: '/api/pipelines/enrichment/items', schema: PipelineItemsResponse as never },
	{ path: `/api/pipelines/captioning/items/${encodeURIComponent(DEMO_FEATURED_CAPTION_ITEM)}`, schema: PipelineItemDetail as never }
];

const WINDOWS = ['today', '24h', '7d', '30d', 'month', 'all'];

describe('demo fixtures decode through their wire schemas', () => {
	for (const c of cases) {
		const label = c.query ? `${c.path}?${new URLSearchParams(c.query)}` : c.path;
		it(label, () => {
			const params = new URLSearchParams(c.query ?? {});
			const fixture = resolveFixture(c.path, params);
			expect(fixture).toBeDefined();
			expect(() => Schema.decodeUnknownSync(c.schema)(fixture)).not.toThrow();
		});
	}

	// Window-parameterised endpoints: exercise every window (bucketing differs).
	for (const window of WINDOWS) {
		it(`/api/usage/summary?window=${window}`, () => {
			const f = resolveFixture('/api/usage/summary', new URLSearchParams({ window }));
			expect(() => Schema.decodeUnknownSync(UsageSummary as never)(f)).not.toThrow();
		});
		for (const groupBy of ['class', 'model', 'agent']) {
			it(`/api/usage/timeseries?window=${window}&groupBy=${groupBy}`, () => {
				const f = resolveFixture(
					'/api/usage/timeseries',
					new URLSearchParams({ window, groupBy })
				);
				expect(() => Schema.decodeUnknownSync(UsageTimeseries as never)(f)).not.toThrow();
			});
		}
		it(`/api/usage/leaderboard?window=${window}`, () => {
			const f = resolveFixture('/api/usage/leaderboard', new URLSearchParams({ window }));
			expect(() => Schema.decodeUnknownSync(UsageLeaderboard as never)(f)).not.toThrow();
		});
	}

	// Page-wide agent filter (spec CONSOLE-MULTI-AGENT §9): agent-scoped variants of every
	// usage endpoint still decode, aggregates shrink, and tables keep only that agent's rows.
	describe('agent-filtered usage fixtures (§9)', () => {
		const q = (extra: Record<string, string>) =>
			new URLSearchParams({ window: '24h', ...extra });

		it('summary scales down and reports a single byAgent bucket', () => {
			const all = Schema.decodeUnknownSync(UsageSummary as never)(
				resolveFixture('/api/usage/summary', q({}))
			) as { total: number; byAgent?: Array<{ agent: string | null; cost: number }> };
			const aria = Schema.decodeUnknownSync(UsageSummary as never)(
				resolveFixture('/api/usage/summary', q({ agent: 'aria' }))
			) as { total: number; byAgent?: Array<{ agent: string | null; cost: number }> };
			expect(aria.total).toBeLessThan(all.total);
			expect(all.byAgent?.map((b) => b.agent)).toEqual(['aria', 'nova', null]);
			expect(aria.byAgent?.map((b) => b.agent)).toEqual(['aria']);
		});

		it('timeseries groupBy=agent stacks one series per agent plus the residual', () => {
			const f = Schema.decodeUnknownSync(UsageTimeseries as never)(
				resolveFixture('/api/usage/timeseries', q({ groupBy: 'agent' }))
			) as { groupBy: string; series: Array<{ grp: string }> };
			expect(f.groupBy).toBe('agent');
			expect(new Set(f.series.map((r) => r.grp))).toEqual(
				new Set(['aria', 'nova', 'unattributed'])
			);
		});

		it('sessions and tool-calls keep only the filtered agent’s rows', () => {
			const sess = Schema.decodeUnknownSync(UsageSessions as never)(
				resolveFixture('/api/usage/sessions', q({ agent: 'nova' }))
			) as { sessions: Array<{ timelineKey: string }> };
			expect(sess.sessions.length).toBeGreaterThan(0);
			expect(sess.sessions.every((s) => s.timelineKey.startsWith('discord:'))).toBe(true);
			const calls = Schema.decodeUnknownSync(UsageToolCalls as never)(
				resolveFixture('/api/usage/tool-calls', q({ agent: 'aria' }))
			) as { toolCalls: Array<{ timeline_key: string | null }> };
			expect(calls.toolCalls.length).toBeGreaterThan(0);
			expect(calls.toolCalls.every((t) => t.timeline_key != null)).toBe(true);
		});

		it('leaderboard decodes and an unknown agent name means All (§3.5)', () => {
			const f = resolveFixture('/api/usage/leaderboard', q({ agent: 'aria' }));
			expect(() => Schema.decodeUnknownSync(UsageLeaderboard as never)(f)).not.toThrow();
			const unknown = Schema.decodeUnknownSync(UsageSummary as never)(
				resolveFixture('/api/usage/summary', q({ agent: 'nobody' }))
			) as { total: number };
			const all = Schema.decodeUnknownSync(UsageSummary as never)(
				resolveFixture('/api/usage/summary', q({}))
			) as { total: number };
			expect(unknown.total).toBe(all.total);
		});
	});

	it('returns undefined for an unknown path', () => {
		expect(resolveFixture('/api/nope', new URLSearchParams())).toBeUndefined();
	});
});
