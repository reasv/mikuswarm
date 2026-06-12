import { createQuery } from '@tanstack/svelte-query';
import { getSession } from '$lib/api/sessions.remote';
import { fresh } from './client';
import { keys } from './keys';

/**
 * TanStack wrapper over the session detail remote query (persisted snapshot +
 * transcript). The live rollout stream is consumed directly in LiveRollout via
 * the SSE proxy route + `$lib/api/live.ts`, outside TanStack (spec plan §5).
 */
export function sessionQuery(id: () => string | null) {
	return createQuery(() => {
		const sid = id();
		return {
			queryKey: sid ? keys.session(sid) : ['sessions', '∅'],
			queryFn: () => fresh(getSession(sid as string)),
			enabled: sid != null
		};
	});
}
