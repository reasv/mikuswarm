import { createQuery } from '@tanstack/svelte-query';
import {
	getRooms,
	getRoomContext,
	getRoomSessions,
	getRoomSessionFacets
} from '$lib/api/rooms.remote';
import { fresh } from './client';
import { keys } from './keys';

/** Committed sessions-list filters (console sessions filter, ARCHITECTURE.md §11). */
export type SessionListFilters = {
	q: string;
	statuses: string[];
	types: string[];
};

/**
 * TanStack wrappers over the room remote queries. Each `queryFn` forces a fresh
 * remote round-trip via `fresh()`. Lists carry a `refetchInterval` so lifecycle /
 * status badges stay current without streaming (spec plan §5).
 */
export function roomsQuery() {
	return createQuery(() => ({
		queryKey: keys.rooms(),
		queryFn: () => fresh(getRooms()),
		refetchInterval: 5_000
	}));
}

export function roomContextQuery(key: () => string | null) {
	return createQuery(() => {
		const k = key();
		return {
			queryKey: k ? keys.roomContext(k) : ['rooms', '∅', 'context'],
			queryFn: () => fresh(getRoomContext(k as string)),
			enabled: k != null
		};
	});
}

export function roomSessionsQuery(
	key: () => string | null,
	filters: () => SessionListFilters = () => ({ q: '', statuses: [], types: [] })
) {
	return createQuery(() => {
		const k = key();
		const f = filters();
		// Only the meaningful (non-empty) parts of the filter participate in the cache
		// key and the request, so an empty filter is byte-identical to the old call.
		const trimmedQ = f.q.trim();
		const active: Record<string, unknown> = {};
		if (trimmedQ.length > 0) active.q = trimmedQ;
		if (f.statuses.length > 0) active.statuses = [...f.statuses].sort();
		if (f.types.length > 0) active.types = [...f.types].sort();
		return {
			queryKey: k ? keys.roomSessions(k, active) : ['rooms', '∅', 'sessions'],
			queryFn: () =>
				fresh(
					getRoomSessions({
						key: k as string,
						q: trimmedQ,
						statuses: f.statuses,
						types: f.types
					})
				),
			enabled: k != null,
			refetchInterval: 5_000
		};
	});
}

export function roomSessionFacetsQuery(key: () => string | null) {
	return createQuery(() => {
		const k = key();
		return {
			queryKey: k ? keys.roomSessionFacets(k) : ['rooms', '∅', 'session-facets'],
			queryFn: () => fresh(getRoomSessionFacets(k as string)),
			enabled: k != null,
			refetchInterval: 10_000
		};
	});
}
