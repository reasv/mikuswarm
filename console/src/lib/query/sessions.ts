import { createQuery } from '@tanstack/svelte-query';
import { getSession } from '$lib/api/sessions.remote';
import { fresh } from './client';
import { keys } from './keys';
import { sessionPollInterval } from './session-poll';

/**
 * TanStack wrapper over the session detail remote query (persisted snapshot +
 * transcript). The live rollout stream is consumed directly in LiveRollout via
 * the SSE proxy route + `$lib/api/live.ts`, outside TanStack (spec plan §5). A
 * status-driven `refetchInterval` (see {@link sessionPollInterval}) keeps the
 * view honest across resume / follow-up-fold transitions without a refresh.
 */
export function sessionQuery(
	id: () => string | null,
	opts: {
		/** True while the record turn may still append to the transcript (SESSION-RECORDS §3.2). */
		recordPending?: () => boolean;
	} = {}
) {
	return createQuery(() => {
		const sid = id();
		return {
			queryKey: sid ? keys.session(sid) : ['sessions', '∅'],
			queryFn: () => fresh(getSession(sid as string)),
			enabled: sid != null,
			refetchInterval: (query) => {
				const base = sessionPollInterval(query.state.data);
				if (base !== false) return base;
				return opts.recordPending?.() ? RECORD_PENDING_POLL_MS : false;
			}
		};
	});
}

/** Session re-poll while its record turn may still be running. */
const RECORD_PENDING_POLL_MS = 8000;
