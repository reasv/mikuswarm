import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import {
	UsageSummary,
	UsageTimeseries,
	UsageSessions,
	UsageToolCalls,
	UsageLeaderboard,
	UsageBudgets,
	UserLimitsPage
} from '$lib/schemas';

/**
 * Usage & Cost read endpoints (spec USAGE-COST-LIMITS §7), exposed as type-safe
 * remote queries. Bodies run on the BFF, proxy to the in-process agent API over
 * the unified `usage_events` ledger + the live BudgetEngine, and decode through
 * Effect Schema (the fidelity guard). Polled — the aggregates are cheap.
 */

/** Window keyword shared by summary + timeseries. */
const WindowArg = Schema.standardSchemaV1(
	Schema.Struct({
		window: Schema.String,
		groupBy: Schema.optional(Schema.String)
	})
);

/** GET /api/usage/summary?window= — totals by class + by model. */
export const getUsageSummary = query(WindowArg, (arg) =>
	apiGet(`/api/usage/summary?window=${encodeURIComponent(arg.window)}`, UsageSummary)
);

/** GET /api/usage/timeseries?window=&groupBy= — stacked spend-over-time. */
export const getUsageTimeseries = query(WindowArg, (arg) => {
	const q = new URLSearchParams({ window: arg.window });
	if (arg.groupBy) q.set('groupBy', arg.groupBy);
	return apiGet(`/api/usage/timeseries?${q.toString()}`, UsageTimeseries);
});

/** GET /api/usage/sessions — recent sessions with per-class rollup. */
export const getUsageSessions = query(() => apiGet('/api/usage/sessions?limit=50', UsageSessions));

/** GET /api/usage/tool-calls — recent paid tool/caption/embedding events. */
export const getUsageToolCalls = query(() =>
	apiGet('/api/usage/tool-calls?limit=50', UsageToolCalls)
);

/** GET /api/usage/leaderboard?window= — top users by spend (per-user equivalent of the Total card). */
export const getUsageLeaderboard = query(WindowArg, (arg) =>
	apiGet(`/api/usage/leaderboard?window=${encodeURIComponent(arg.window)}`, UsageLeaderboard)
);

/** GET /api/usage/budgets — every configured rule's live status + live per-user picks. */
export const getUsageBudgets = query(() => apiGet('/api/usage/budgets', UsageBudgets));

/** Per-user-limits page selector: which scope (individuals / shared pools) + page. */
const UserLimitsArg = Schema.standardSchemaV1(
	Schema.Struct({ scope: Schema.String, page: Schema.Number })
);

/** GET /api/usage/user-limits?scope=&page= — one hottest-first page of per-user meters. */
export const getUserLimits = query(UserLimitsArg, (arg) => {
	const q = new URLSearchParams({ scope: arg.scope, page: String(arg.page) });
	return apiGet(`/api/usage/user-limits?${q.toString()}`, UserLimitsPage);
});
