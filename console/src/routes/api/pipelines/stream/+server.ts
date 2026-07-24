import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiBaseUrl, authHeaders, demoMode } from '$lib/server/config';
import { emptyEventStream } from '$lib/server/api/demo/sse';

/**
 * Same-origin SSE proxy for the pipeline activity firehose
 * (`/api/pipelines/stream`, ARCHITECTURE.md §11). Same rationale and shape as
 * the session-stream proxy (../../sessions/[id]/stream/+server.ts): verbatim
 * byte pipe, bearer token attached server-side, event-log semantics preserved
 * end-to-end (a `query.live` would drop activity events under backpressure and
 * the listener would miss invalidations). `request.signal` aborts the upstream
 * fetch on browser disconnect so the agent releases its activity-bus listener.
 */
export const GET: RequestHandler = async ({ request, fetch }) => {
	if (demoMode) return emptyEventStream();
	const upstream = await fetch(`${apiBaseUrl}/api/pipelines/stream`, {
		headers: { accept: 'text/event-stream', ...authHeaders() },
		signal: request.signal
	});
	if (!upstream.ok || !upstream.body) {
		throw error(upstream.status || 502, 'pipeline activity stream failed');
	}
	return new Response(upstream.body, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			// Disable proxy buffering (nginx) so events flush immediately.
			'x-accel-buffering': 'no'
		}
	});
};
