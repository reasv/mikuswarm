import { createQuery, createInfiniteQuery } from '@tanstack/svelte-query';
import {
	getPipelines,
	getPipelineItems,
	getPipelineItem,
	getCostOverview
} from '$lib/api/pipelines.remote';
import type { PipelineId, PipelineItemsResponse } from '$lib/schemas';
import { fresh } from './client';
import { keys } from './keys';

/**
 * TanStack wrappers over the pipeline-monitor remote queries (ARCHITECTURE.md §11).
 * The dashboard feed and item lists carry the same 5s `refetchInterval` as the
 * room/session lists, so counts + badges stay current; the live SSE activity
 * stream (Phase 4) patches on top of this poll.
 */
export function pipelinesQuery() {
	return createQuery(() => ({
		queryKey: keys.pipelines(),
		queryFn: () => fresh(getPipelines()),
		refetchInterval: 5_000
	}));
}

export interface PipelineItemFilters {
	status: string | null;
	room: string | null;
}

/**
 * Keyset-paginated, infinitely-scrollable item list. Each page carries a
 * `nextCursor`; `getNextPageParam` chains them. The 5s `refetchInterval` keeps the
 * loaded pages current (the SSE listener also invalidates this key on activity).
 */
export function pipelineItemsQuery(
	pool: () => PipelineId | null,
	filters: () => PipelineItemFilters
) {
	return createInfiniteQuery(() => {
		const p = pool();
		const f = filters();
		return {
			queryKey: p
				? keys.pipelineItems(p, { status: f.status, room: f.room })
				: (['pipelines', '∅', 'items'] as const),
			queryFn: ({ pageParam }: { pageParam: string | null }) =>
				fresh(
					getPipelineItems({
						pool: p as PipelineId,
						status: f.status,
						room: f.room,
						cursor: pageParam
					})
				),
			initialPageParam: null as string | null,
			getNextPageParam: (lastPage: PipelineItemsResponse) => lastPage.nextCursor,
			enabled: p != null,
			refetchInterval: 5_000
		};
	});
}

/**
 * Global cost overview across the three spend lanes (spec AUXILIARY-USAGE-TRACKING
 * §10.4). Polled on the same 5s cadence as the dashboard feed.
 */
export function costOverviewQuery() {
	return createQuery(() => ({
		queryKey: keys.costOverview(),
		queryFn: () => fresh(getCostOverview()),
		refetchInterval: 5_000
	}));
}

export function pipelineItemQuery(pool: () => PipelineId | null, id: () => string | null) {
	return createQuery(() => {
		const p = pool();
		const i = id();
		return {
			queryKey: p && i ? keys.pipelineItem(p, i) : (['pipelines', '∅', 'item'] as const),
			queryFn: () => fresh(getPipelineItem({ pool: p as PipelineId, id: i as string })),
			enabled: p != null && i != null
		};
	});
}
