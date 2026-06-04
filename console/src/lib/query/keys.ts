/**
 * Query-key factory — the single source of truth for TanStack cache keys and the
 * cross-column invalidation contract (spec §11 master→detail). Keys are
 * hierarchical so invalidating `['rooms', key]` cascades to context + sessions.
 */
export const keys = {
	rooms: () => ['rooms'] as const,
	roomContext: (key: string) => ['rooms', key, 'context'] as const,
	roomSessions: (key: string) => ['rooms', key, 'sessions'] as const,
	session: (id: string) => ['sessions', id] as const,
	summary: (id: string) => ['summaries', id] as const,
	// Pipeline monitor (ARCHITECTURE.md §11). `pipelines()` is the dashboard feed;
	// `pipelineItems(pool, filters)` a filtered list; `pipelineItem(pool, id)` one
	// detail. Hierarchical so invalidating `['pipelines', pool]` cascades to its
	// lists + details.
	pipelines: () => ['pipelines'] as const,
	pipelineItems: (pool: string, filters: Record<string, unknown> = {}) =>
		['pipelines', pool, 'items', filters] as const,
	pipelineItem: (pool: string, id: string) => ['pipelines', pool, 'items', id] as const
};
