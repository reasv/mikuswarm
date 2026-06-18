/**
 * Query-key factory — the single source of truth for TanStack cache keys and the
 * cross-column invalidation contract (spec §11 master→detail). Keys are
 * hierarchical so invalidating `['rooms', key]` cascades to context + sessions.
 */
export const keys = {
	rooms: () => ['rooms'] as const,
	roomContext: (key: string) => ['rooms', key, 'context'] as const,
	// `filters` is folded into the key so changing the search/status/type filter is a
	// distinct cache entry that refetches; invalidating `['rooms', key, 'sessions']`
	// still cascades across every filter variant.
	roomSessions: (key: string, filters: Record<string, unknown> = {}) =>
		['rooms', key, 'sessions', filters] as const,
	roomSessionFacets: (key: string) => ['rooms', key, 'session-facets'] as const,
	session: (id: string) => ['sessions', id] as const,
	summary: (id: string) => ['summaries', id] as const,
	// Pipeline monitor (ARCHITECTURE.md §11). `pipelines()` is the dashboard feed;
	// `pipelineItems(pool, filters)` a filtered list; `pipelineItem(pool, id)` one
	// detail. Hierarchical so invalidating `['pipelines', pool]` cascades to its
	// lists + details.
	pipelines: () => ['pipelines'] as const,
	pipelineItems: (pool: string, filters: Record<string, unknown> = {}) =>
		['pipelines', pool, 'items', filters] as const,
	pipelineItem: (pool: string, id: string) => ['pipelines', pool, 'items', id] as const,
	// Scheduler view (spec LLM-FAILURE-HANDLING §9.1/§9.2) — polled snapshots.
	scheduler: () => ['scheduler'] as const,
	llmRequests: () => ['llm-requests'] as const,
	// Startup gap-backfetch status panel (ARCHITECTURE.md §7c §11) — polled.
	gapBackfetch: () => ['gap-backfetch'] as const,
	// Global cost overview across the three spend lanes (spec AUXILIARY-USAGE-TRACKING §10.4).
	costOverview: () => ['cost-overview'] as const,
	// Usage & Cost page (spec USAGE-COST-LIMITS §7) — polled ledger views + budgets.
	// `window` folds into the summary/timeseries keys so changing it refetches.
	usageSummary: (window: string) => ['usage', 'summary', window] as const,
	usageTimeseries: (window: string, groupBy: string) =>
		['usage', 'timeseries', window, groupBy] as const,
	usageSessions: () => ['usage', 'sessions'] as const,
	usageToolCalls: () => ['usage', 'tool-calls'] as const,
	// `window` folds into the key so changing it refetches the leaderboard (cards + table).
	usageLeaderboard: (window: string) => ['usage', 'leaderboard', window] as const,
	usageBudgets: () => ['usage', 'budgets'] as const
};
