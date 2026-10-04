import { createQuery } from '@tanstack/svelte-query';
import { getSessionRecord } from '$lib/api/sessions-record.remote';
import { getSessionDecisions } from '$lib/api/sessions-decisions.remote';
import { fresh } from './client';
import { keys } from './keys';

/**
 * TanStack wrapper for the session's own record (spec SESSION-RECORDS §3, §8).
 * Returns `{ sessionRecord: null }` while loading or when the feature is not
 * yet available on the connected backend (pre-v24 DB / 404 → treated as empty).
 */
export function sessionRecordQuery(id: () => string | null) {
	return createQuery(() => {
		const sid = id();
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
			retry: 0
		};
	});
}

/**
 * TanStack wrapper for the session's decision evaluations (spec SESSION-RECORDS §8).
 * Returns `{ evaluations: [] }` on any error (pre-feature backend or table absent).
 */
export function sessionDecisionsQuery(id: () => string | null) {
	return createQuery(() => {
		const sid = id();
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
			retry: 0
		};
	});
}
