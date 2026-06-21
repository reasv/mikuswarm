import { query, command } from '$app/server';
import { Schema } from 'effect';
import { apiGet, apiPost } from '$lib/server/api/runtime';
import {
	BackfetchJobsResponse,
	StartBackfetchResponse,
	BackfetchActionResponse,
	PromoteCaptionsResponse
} from '$lib/schemas';

/**
 * Message-only history backfetch remote (ARCHITECTURE.md §7d; spec
 * MESSAGE-BACKFETCH §8). The job list is a polled `query`; the operator actions
 * (start/pause/resume/cancel + retroactive caption promote) are `command`s
 * proxying to `POST /api/backfetch/...` on the agent, with inputs as query params
 * (matching the agent's query-param mutation convention). Cache invalidation is
 * driven on the client after each command resolves (TanStack stays authoritative).
 */
export const getBackfetchJobs = query(() => apiGet('/api/backfetch/jobs', BackfetchJobsResponse));

const StartArg = Schema.standardSchemaV1(
	Schema.Struct({
		timelineKey: Schema.NonEmptyString,
		targetKind: Schema.Literal('beginning', 'date', 'oldest_decryptable', 'count'),
		targetValue: Schema.optional(Schema.NullOr(Schema.String)),
		captionAfter: Schema.optional(Schema.Boolean),
		safetyCap: Schema.optional(Schema.Number),
		timeoutMs: Schema.optional(Schema.Number)
	})
);

export const startBackfetchJob = command(StartArg, (arg) => {
	const q = new URLSearchParams();
	q.set('timelineKey', arg.timelineKey);
	q.set('targetKind', arg.targetKind);
	if (arg.targetValue) q.set('targetValue', arg.targetValue);
	if (arg.captionAfter) q.set('captionAfter', '1');
	if (arg.safetyCap != null) q.set('safetyCap', String(arg.safetyCap));
	if (arg.timeoutMs != null) q.set('timeoutMs', String(arg.timeoutMs));
	return apiPost(`/api/backfetch/jobs?${q.toString()}`, StartBackfetchResponse);
});

const JobId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const pauseBackfetchJob = command(JobId, (id) =>
	apiPost(`/api/backfetch/jobs/${encodeURIComponent(id)}/pause`, BackfetchActionResponse)
);

export const resumeBackfetchJob = command(JobId, (id) =>
	apiPost(`/api/backfetch/jobs/${encodeURIComponent(id)}/resume`, BackfetchActionResponse)
);

export const cancelBackfetchJob = command(JobId, (id) =>
	apiPost(`/api/backfetch/jobs/${encodeURIComponent(id)}/cancel`, BackfetchActionResponse)
);

const PromoteArg = Schema.standardSchemaV1(
	Schema.Struct({
		timelineKey: Schema.NonEmptyString,
		fromTs: Schema.optional(Schema.NullOr(Schema.Number)),
		toTs: Schema.optional(Schema.NullOr(Schema.Number))
	})
);

export const promoteBackfetchCaptions = command(PromoteArg, (arg) => {
	const q = new URLSearchParams();
	q.set('timelineKey', arg.timelineKey);
	if (arg.fromTs != null) q.set('fromTs', String(arg.fromTs));
	if (arg.toTs != null) q.set('toTs', String(arg.toTs));
	return apiPost(`/api/backfetch/caption-promote?${q.toString()}`, PromoteCaptionsResponse);
});
