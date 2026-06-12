import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SessionDetailResponse } from '$lib/schemas';

/**
 * Session read endpoint (spec §8). Returns the persisted record (snapshot +
 * transcript). The live rollout stream is NOT a remote function: it is a
 * same-origin SSE proxy route (`routes/api/sessions/[id]/stream/+server.ts`)
 * consumed by `$lib/api/live.ts` — `query.live` is a latest-value channel that
 * drops events under backpressure, which the rollout fold cannot tolerate.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSession = query(SessionId, (id) =>
	apiGet(`/api/sessions/${encodeURIComponent(id)}`, SessionDetailResponse)
);
