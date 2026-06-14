import { query } from '$app/server';
import { apiGet } from '$lib/server/api/runtime';
import { GapBackfetchSnapshot } from '$lib/schemas';

/**
 * Startup gap-backfetch status remote (ARCHITECTURE.md §7c §11): a point-in-time
 * list of in-scope rooms with their fill phase and buffered/committed counts.
 * Polled — the snapshot is cheap and the room set is small; SSE is unnecessary.
 * Returns an empty list when the feature is disabled or not wired.
 */
export const getGapBackfetch = query(() => apiGet('/api/gap-backfetch', GapBackfetchSnapshot));
