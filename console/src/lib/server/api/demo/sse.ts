/**
 * Demo-mode SSE stub (spec CONSOLE-DEMO-MODE). The live-stream proxy routes are not
 * remote functions and don't go through `AgentApiClient`, so demo mode short-circuits
 * them here: an immediately-closed `text/event-stream` with no backend to reach. A
 * completed persisted session renders fully from `GET /api/sessions/:id` alone, so the
 * observability screenshot never needs a live stream; this just keeps a stream open
 * request from hanging (or erroring) when there is no agent behind the console.
 */
export function emptyEventStream(): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
}
