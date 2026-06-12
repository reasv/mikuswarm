import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import {
	PipelineId,
	PipelinesResponse,
	PipelineItemsResponse,
	PipelineItemDetail
} from '$lib/schemas';

/**
 * Pipeline-monitor read endpoints (ARCHITECTURE.md §11), exposed as type-safe
 * remote queries. Bodies run on the BFF, proxy to the in-process agent API, and
 * decode through Effect Schema (the fidelity guard). The live activity stream
 * is NOT a remote function: it is a same-origin SSE proxy route
 * (`routes/api/pipelines/stream/+server.ts`) consumed by `$lib/api/live.ts` —
 * `query.live` is a latest-value channel that drops events under backpressure.
 */

/** GET /api/pipelines — the four-pool dashboard feed. */
export const getPipelines = query(() => apiGet('/api/pipelines', PipelinesResponse));

/** Filter/cursor input for the item-list query. */
const PipelineItemsArg = Schema.standardSchemaV1(
	Schema.Struct({
		pool: PipelineId,
		status: Schema.optional(Schema.NullOr(Schema.String)),
		room: Schema.optional(Schema.NullOr(Schema.String)),
		cursor: Schema.optional(Schema.NullOr(Schema.String)),
		limit: Schema.optional(Schema.Number)
	})
);

/** GET /api/pipelines/:pool/items?status=&room=&cursor=&limit= — a keyset page. */
export const getPipelineItems = query(PipelineItemsArg, (arg) => {
	const q = new URLSearchParams();
	if (arg.status) q.set('status', arg.status);
	if (arg.room) q.set('room', arg.room);
	if (arg.cursor) q.set('cursor', arg.cursor);
	if (arg.limit != null) q.set('limit', String(arg.limit));
	const qs = q.toString();
	return apiGet(
		`/api/pipelines/${encodeURIComponent(arg.pool)}/items${qs ? `?${qs}` : ''}`,
		PipelineItemsResponse
	);
});

const PipelineItemArg = Schema.standardSchemaV1(
	Schema.Struct({ pool: PipelineId, id: Schema.NonEmptyString })
);

/** GET /api/pipelines/:pool/items/:id — the pool-specific detail union. */
export const getPipelineItem = query(PipelineItemArg, (arg) =>
	apiGet(
		`/api/pipelines/${encodeURIComponent(arg.pool)}/items/${encodeURIComponent(arg.id)}`,
		PipelineItemDetail
	)
);

