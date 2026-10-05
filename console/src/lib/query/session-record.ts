import { createQuery } from '@tanstack/svelte-query';
import { getSessionRecord } from '$lib/api/sessions-record.remote';
import { getSessionDecisions } from '$lib/api/sessions-decisions.remote';
import type { SessionDetailResponse } from '$lib/schemas';
import { fresh } from './client';
import { keys } from './keys';
import { decisionsPollInterval, recordPollInterval } from './session-poll';

/**
 * TanStack wrapper for the session's own record (spec SESSION-RECORDS §3, §8).
 * Returns `{ sessionRecord: null }` while loading or when the feature is not
 * yet available on the connected backend (pre-v24 DB / 404 → treated as empty).
 * `session` (the session detail, when the caller has it) keeps the query
 * polling while the record turn may still be running, so the record shows up
 * without a refresh.
 */
export function sessionRecordQuery(
	id: () => string | null,
	session?: () => SessionDetailResponse | undefined
) {
	return createQuery(() => {
		const sid = id();
		// Read here (not only inside refetchInterval) so a status change re-applies
		// the options and the interval is recomputed against the new status.
		const detail = session?.();
		return {
			queryKey: sid ? keys.sessionRecord(sid) : ['sessions', '∅', 'record'],
			queryFn: async () => {
				try {
					return await fresh(getSessionRecord(sid as string));
				} catch {
					return { sessionRecord: null } as const;
				}
			},
			enabled: sid != null,
			retry: 0,
			refetchInterval: (query: { state: { data?: { sessionRecord: unknown } } }) =>
				recordPollInterval(detail, query.state.data?.sessionRecord != null)
		};
	});
}

/**
 * TanStack wrapper for the session's decision evaluations (spec SESSION-RECORDS §8).
 * Returns `{ evaluations: [] }` on any error (pre-feature backend or table absent).
 * With `session`, it polls while the session runs (decisions are written then).
 */
export function sessionDecisionsQuery(
	id: () => string | null,
	session?: () => SessionDetailResponse | undefined
) {
	return createQuery(() => {
		const sid = id();
		const detail = session?.();
		return {
			queryKey: sid ? keys.sessionDecisions(sid) : ['sessions', '∅', 'decisions'],
			queryFn: async () => {
				try {
					return await fresh(getSessionDecisions(sid as string));
				} catch {
					return { evaluations: [] } as const;
				}
			},
			enabled: sid != null,
			retry: 0,
			refetchInterval: decisionsPollInterval(detail)
		};
	});
}
