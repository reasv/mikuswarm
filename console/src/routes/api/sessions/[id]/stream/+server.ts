import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiBaseUrl, authHeaders, demoMode } from '$lib/server/config';
import { emptyEventStream } from '$lib/server/api/demo/sse';

/**
 * Same-origin SSE proxy for the live session stream (spec §8
 * `/api/sessions/:id/stream`). Pipes the agent's event-stream bytes verbatim —
 * redaction + image externalization already happened agent-side — attaching the
 * bearer token server-side so the browser never sees it (mirrors the media proxy).
 *
 * A route handler, not a `query.live` remote function, because the rollout fold
 * needs event-log semantics: live queries are latest-value channels that drop
 * intermediate values under backpressure, which lost AgentEvents and left the
 * live rollout empty. The browser parses the records itself ($lib/api/live.ts).
 *
 * `request.signal` (forwarded into the upstream fetch) aborts on browser
 * disconnect, so the agent's `req.on("close")` fires and its `Agent.subscribe`
 * listener is released — no leaked subscriptions.
 */
export const GET: RequestHandler = async ({ params, request, fetch }) => {
	if (demoMode) return emptyEventStream();
	const id = encodeURIComponent(params.id);
	const upstream = await fetch(`${apiBaseUrl}/api/sessions/${id}/stream`, {
		headers: { accept: 'text/event-stream', ...authHeaders() },
		signal: request.signal
	});
	if (!upstream.ok || !upstream.body) {
		throw error(upstream.status || 502, 'session stream failed');
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
