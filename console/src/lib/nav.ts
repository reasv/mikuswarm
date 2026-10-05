import type { PipelineId } from '$lib/schemas';

/**
 * URL is the source of truth for selection (ARCHITECTURE.md §11). Each area encodes
 * its selection in query params on its own route, so every selection is a real link:
 * deep-linkable, refreshable, shareable, and openable in a new tab. The selection
 * stores (`selection.svelte.ts`, `pipeline-selection.svelte.ts`) READ these params;
 * these helpers BUILD the hrefs the list/detail components navigate with.
 *
 * Conversations (`/`):   ?agent=<name>&room=<timelineKey>&session=<sessionId>
 *                         [&branch=<n>&call=<toolCallId>&attempt=<n>] (rollout deep link)
 * Pipelines (`/pipelines`): ?pool=<pool>&status=<chip>&room=<roomFilter>&item=<itemId>
 *
 * `agent` (spec CONSOLE-MULTI-AGENT §3.5): the selected room-list agent tab; absent
 * or unknown → "All". Carried in the URL so filtered views are deep-linkable.
 */

/** Build `path` plus a querystring, dropping null/empty params (stable key order). */
function href(path: string, params: Record<string, string | null | undefined>): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v != null && v !== '') sp.set(k, v);
	const qs = sp.toString();
	return qs ? `${path}?${qs}` : path;
}

export function conversationsHref(opts: {
	agent?: string | null;
	room?: string | null;
	session?: string | null;
	/** Deep link into the rollout (REFUSAL-HANDLING §12.3): a stored branch (0 = live, omitted). */
	branch?: number | null;
	/** …a judged tool call… */
	call?: string | null;
	/** …or a send-contract ending attempt. */
	attempt?: number | null;
}): string {
	return href('/', {
		agent: opts.agent,
		room: opts.room,
		session: opts.session,
		branch: opts.branch ? String(opts.branch) : null,
		call: opts.call,
		attempt: opts.attempt != null ? String(opts.attempt) : null
	});
}

/**
 * The model behaviour page (`/models`, spec REFUSAL-HANDLING §12.3); its filters
 * are URL params too (`$lib/model-behaviour-view`).
 */
export function modelsHref(params: Record<string, string | null | undefined> = {}): string {
	return href('/models', params);
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
