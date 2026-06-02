import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SessionDetailResponse, type AgentEventWire } from '$lib/schemas';
import { upstreamSse } from '$lib/server/api/sse';

/**
 * Session read endpoint + live rollout stream (spec §8, §3.3).
 *
 * `getSession` returns the persisted record (snapshot + transcript). `streamSession`
 * is a `query.live` that re-yields the agent's live `AgentEvent`s; when the live
 * generator is torn down (client disconnect), the `finally` aborts the upstream
 * fetch so the agent releases its subscription.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSession = query(SessionId, (id) =>
	apiGet(`/api/sessions/${encodeURIComponent(id)}`, SessionDetailResponse)
);

async function* streamEvents(id: string): AsyncGenerator<AgentEventWire> {
	const controller = new AbortController();
	try {
		yield* upstreamSse(`/api/sessions/${encodeURIComponent(id)}/stream`, controller.signal);
	} finally {
		controller.abort();
	}
}

export const streamSession = query.live(SessionId, (id) => streamEvents(id));
