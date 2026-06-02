import { command } from '$app/server';
import { Schema } from 'effect';
import { apiPost } from '$lib/server/api/runtime';
import { AbortSessionResponse } from '$lib/schemas';

/**
 * Admin actions (spec §13). Each admin action is a `command` (an imperative
 * mutation from a UI event handler), validated with an Effect Standard Schema,
 * proxying to a `POST /api/...` on the agent. Cache invalidation is driven on the
 * client (the caller refreshes affected TanStack queries after the command
 * resolves), keeping TanStack the single cache authority.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

/**
 * Stop a running session: aborts the in-flight run and marks it `interrupted`.
 * The agent returns 409 when the session isn't actively running; `apiPost` maps
 * that to a thrown `HttpError(409)`, which the caller treats as benign ("already
 * stopped") — either way the run is no longer in flight.
 */
export const abortSession = command(SessionId, (id) =>
	apiPost(`/api/sessions/${encodeURIComponent(id)}/abort`, AbortSessionResponse)
);
