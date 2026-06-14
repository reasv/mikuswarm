import type { PipelineId } from '$lib/schemas';

/**
 * URL is the source of truth for selection (ARCHITECTURE.md §11). Each area encodes
 * its selection in query params on its own route, so every selection is a real link:
 * deep-linkable, refreshable, shareable, and openable in a new tab. The selection
 * stores (`selection.svelte.ts`, `pipeline-selection.svelte.ts`) READ these params;
 * these helpers BUILD the hrefs the list/detail components navigate with.
 *
 * Conversations (`/`):   ?room=<timelineKey>&session=<sessionId>
 * Pipelines (`/pipelines`): ?pool=<pool>&status=<chip>&room=<roomFilter>&item=<itemId>
 */

/** Build `path` plus a querystring, dropping null/empty params (stable key order). */
function href(path: string, params: Record<string, string | null | undefined>): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v != null && v !== '') sp.set(k, v);
	const qs = sp.toString();
	return qs ? `${path}?${qs}` : path;
}

export function conversationsHref(opts: { room?: string | null; session?: string | null }): string {
	return href('/', { room: opts.room, session: opts.session });
}

export function pipelinesHref(opts: {
	pool?: PipelineId | null;
	status?: string | null;
	room?: string | null;
	item?: string | null;
}): string {
	return href('/pipelines', {
		pool: opts.pool,
		status: opts.status,
		room: opts.room,
		item: opts.item
	});
}
