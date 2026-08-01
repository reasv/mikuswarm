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
		for (const groupBy of ['class', 'model']) {
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

	it('returns undefined for an unknown path', () => {
		expect(resolveFixture('/api/nope', new URLSearchParams())).toBeUndefined();
	});
});
