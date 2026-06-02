import { createQuery } from '@tanstack/svelte-query';
import { getRooms, getRoomContext, getRoomSessions } from '$lib/api/rooms.remote';
import { fresh } from './client';
import { keys } from './keys';

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

export function roomSessionsQuery(key: () => string | null) {
	return createQuery(() => {
		const k = key();
		return {
			queryKey: k ? keys.roomSessions(k) : ['rooms', '∅', 'sessions'],
			queryFn: () => fresh(getRoomSessions(k as string)),
			enabled: k != null,
			refetchInterval: 5_000
		};
	});
}
