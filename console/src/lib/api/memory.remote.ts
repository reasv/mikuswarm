import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import {
	MemoryFilterHitsResponse,
	MemoryStatsResponse,
	SessionMemoryRetrievalsResponse
} from '$lib/schemas';

/**
 * Judged memory retrieval (spec MEMORY-RETRIEVAL §7.4, §9). The agent API reads
 * `memory_retrievals` / `memory_filter_hits` (schema v34) and returns empty
 * results when the tables are absent; the query layer (`$lib/query/memory`)
 * also degrades a 404 from an older agent without these routes to empty.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

/** The session's retrieval builds, in `ts` order. */
export const getSessionMemoryRetrievals = query(SessionId, (id) =>
	apiGet(
		`/api/sessions/${encodeURIComponent(id)}/memory-retrievals`,
		SessionMemoryRetrievalsResponse
	)
);

const HitsLimit = Schema.standardSchemaV1(Schema.Number);

/** The filters audit: blocks hidden by a memory filter, newest first. */
export const getMemoryFilterHits = query(HitsLimit, (limit) =>
	apiGet(`/api/memory/filter-hits?limit=${encodeURIComponent(String(limit))}`, MemoryFilterHitsResponse)
);

/** Follow-up rate and source mix over the last 7 and 30 days. */
export const getMemoryStats = query(() => apiGet('/api/memory/stats', MemoryStatsResponse));
