import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SessionDetailResponse } from '$lib/schemas';
import { streamUpstream } from '$lib/server/api/sse';

/**
 * Session read endpoint + live rollout stream (spec §8, §3.3).
 *
 * `getSession` returns the persisted record (snapshot + transcript). `streamSession`
 * is a `query.live` that re-yields the agent's live `AgentEvent`s via `streamUpstream`;
 * when the live generator is torn down (client disconnect or early consumer teardown),
 * `streamUpstream`'s `finally` aborts the upstream fetch so the agent releases its
 * subscription. (SvelteKit only allows remote functions to be exported from
 * `*.remote.ts`, so the controller-owning wrapper lives in `server/api/sse.ts`.)
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSession = query(SessionId, (id) =>
	apiGet(`/api/sessions/${encodeURIComponent(id)}`, SessionDetailResponse)
);

export const streamSession = query.live(SessionId, (id) =>
	streamUpstream(`/api/sessions/${encodeURIComponent(id)}/stream`)
);
