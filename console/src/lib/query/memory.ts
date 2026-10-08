import { createQuery } from '@tanstack/svelte-query';
import {
	getMemoryFilterHits,
	getMemoryStats,
	getSessionMemoryRetrievals
} from '$lib/api/memory.remote';
import type { SessionDetailResponse } from '$lib/schemas';
import { fresh } from './client';
import { keys } from './keys';
import { decisionsPollInterval } from './session-poll';

/**
 * TanStack wrappers for judged memory retrieval (spec MEMORY-RETRIEVAL §7.4, §9).
 * Every query degrades to empty on any error: a pre-v34 database (tables absent)
 * or an older agent without the routes (404) shows nothing rather than an error.
 */

/** The session's `memory_retrievals` rows; polls while the session runs (follow-ups land then). */
export function sessionMemoryRetrievalsQuery(
	id: () => string | null,
	session?: () => SessionDetailResponse | undefined
) {
	return createQuery(() => {
		const sid = id();
		const detail = session?.();
		return {
			queryKey: sid ? keys.sessionMemoryRetrievals(sid) : ['sessions', '∅', 'memory-retrievals'],
			queryFn: async () => {
				try {
					return await fresh(getSessionMemoryRetrievals(sid as string));
				} catch {
					return { retrievals: [] } as const;
				}
			},
			enabled: sid != null,
			retry: 0,
			refetchInterval: decisionsPollInterval(detail)
		};
	});
}

/** How many filter-hit rows the memory page asks for. */
export const FILTER_HITS_LIMIT = 500;

export function memoryFilterHitsQuery() {
	return createQuery(() => ({
		queryKey: keys.memoryFilterHits(FILTER_HITS_LIMIT),
		queryFn: async () => {
			try {
				return await fresh(getMemoryFilterHits(FILTER_HITS_LIMIT));
			} catch {
				return { hits: [] } as const;
			}
		},
		retry: 0,
		refetchInterval: 60_000
	}));
}

export function memoryStatsQuery() {
	return createQuery(() => ({
		queryKey: keys.memoryStats(),
		queryFn: async () => {
			try {
				return await fresh(getMemoryStats());
			} catch {
				return { windows: [] } as const;
			}
		},
		retry: 0,
		refetchInterval: 60_000
	}));
}
