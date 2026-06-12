import { command } from '$app/server';
import { Schema } from 'effect';
import { apiPost } from '$lib/server/api/runtime';
import {
	AbortSessionResponse,
	ResumeSessionResponse,
	PipelineId,
	RetryPipelineItemResponse,
	RetryFailedResponse
} from '$lib/schemas';

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

/**
 * Manually resume a parked `failed-resumable` or `interrupted` session (spec
 * CONCURRENCY-AND-RATE-LIMITING §6.2 / Decision D): the agent re-creates the
 * run from the persisted snapshot + transcript and redoes the failed request
 * (or rebuilds the context fresh and re-runs when the transcript never
 * flushed — a crash before the first turn committed).
 * Only user-facing session types are eligible — synthetic worker-pool
 * sessions (summarize/condense/diary) are rejected outright. The request
 * long-polls until the resumed run reaches a terminal state; the agent
 * returns 409 when the session isn't resumable (wrong status, synthetic
 * session type, resume already in flight, timeline busy, or nothing to redo)
 * or the resume failed again (re-parked or discarded — the body's message
 * says which).
 */
export const resumeSession = command(SessionId, (id) =>
	apiPost(`/api/sessions/${encodeURIComponent(id)}/resume`, ResumeSessionResponse)
);

/**
 * Manual retry of a pipeline item (ARCHITECTURE.md §11, spec §3.7): re-enqueue a
 * terminal safe item to `pending`. The agent returns 409 when the item isn't
 * retryable (in-flight, or a deferred unsafe state); `apiPost` maps that to a
 * thrown `HttpError(409)` the caller treats as a benign neutral warning.
 */
const RetryItemArg = Schema.standardSchemaV1(
	Schema.Struct({ pool: PipelineId, id: Schema.NonEmptyString })
);
export const retryPipelineItem = command(RetryItemArg, (arg) =>
	apiPost(
		`/api/pipelines/${encodeURIComponent(arg.pool)}/items/${encodeURIComponent(arg.id)}/retry`,
		RetryPipelineItemResponse
	)
);

/** Bulk retry: reset every `failed` item in a pool to `pending`. */
const RetryFailedArg = Schema.standardSchemaV1(PipelineId);
export const retryFailedPipelineItems = command(RetryFailedArg, (pool) =>
	apiPost(`/api/pipelines/${encodeURIComponent(pool)}/retry-failed`, RetryFailedResponse)
);
