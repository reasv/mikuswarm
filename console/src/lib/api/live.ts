import { sseRecords } from '$lib/sse';
import type { AgentEventWire, PipelineActivityEvent } from '$lib/schemas';

/**
 * Browser-side consumers of the BFF's same-origin SSE proxy routes
 * (`/api/sessions/:id/stream`, `/api/pipelines/stream` — `routes/api/…/+server.ts`),
 * which pipe the agent's event-stream bytes verbatim with the bearer token
 * attached server-side.
 *
 * These are plain `fetch` + `ReadableStream` async generators rather than
 * `query.live` remote functions because live queries are **latest-value**
 * channels: SvelteKit keeps only the newest pending value when the consumer
 * lags (by design — "live streams are not event logs"). AgentEvents arrive in
 * bursts (every authoritative commit is a burst now that Layer-0 buffers
 * attempts to the terminal event, ARCHITECTURE.md §8a), so a live query
 * dropped the `turn_end`s the rollout fold accumulates and the live rollout
 * rendered empty. Event-log semantics need a real byte stream end-to-end.
 *
 * Callers pass an `AbortSignal` and abort it on teardown: the fetch dies, the
 * BFF proxy's forwarded signal aborts its upstream fetch, and the agent's
 * `req.on("close")` releases the `Agent.subscribe` / activity-bus listener.
 */

/** Open an SSE response and hand back its byte stream. */
async function openStream(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	const res = await fetch(path, { headers: { accept: 'text/event-stream' }, signal });
	if (!res.ok || !res.body) throw new Error(`stream failed (${res.status}) for ${path}`);
	return res.body;
}

/** Narrow a record's JSON payload to the permissive AgentEvent wire shape. */
function parseAgentEvent(data: string): AgentEventWire | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null; // skip a malformed record rather than killing the stream
	}
	if (!parsed || typeof parsed !== 'object') return null;
	if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
	return parsed as AgentEventWire;
}

/**
 * Live `AgentEvent`s for a running session (spec §8 `/api/sessions/:id/stream`).
 * Ends on the upstream terminators: a synthetic `not_live` (session already
 * terminal/evicted — the caller falls back to the persisted record) or the
 * authoritative `agent_end` (yielded, then the generator returns).
 */
export async function* streamSessionEvents(
	sessionId: string,
	signal: AbortSignal
): AsyncGenerator<AgentEventWire> {
	const body = await openStream(
		`/api/sessions/${encodeURIComponent(sessionId)}/stream`,
		signal
	);
	for await (const rec of sseRecords(body)) {
		if (rec.event === 'not_live') return;
		if (!rec.data) continue;
		const evt = parseAgentEvent(rec.data);
		if (!evt) continue;
		yield evt;
		if (evt.type === 'agent_end') return;
	}
}

// Defensive narrowing in place of the Effect Schema decode that ran on the BFF
// when this was a query.live (Effect stays out of the browser bundle). Mirrors
// PipelineActivityEvent in $lib/schemas — keep the two in sync.
const ACTIVITY_POOLS = new Set(['enrichment', 'captioning', 'summarization', 'diary']);
const ACTIVITY_KINDS = new Set(['claimed', 'completed', 'failed', 'retried', 'skipped']);

function parseActivityEvent(data: string): PipelineActivityEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const o = parsed as Record<string, unknown>;
	if (typeof o.pool !== 'string' || !ACTIVITY_POOLS.has(o.pool)) return null;
	if (typeof o.id !== 'string') return null;
	if (typeof o.kind !== 'string' || !ACTIVITY_KINDS.has(o.kind)) return null;
	if (typeof o.status !== 'string') return null;
	if (typeof o.attempts !== 'number') return null;
	if (o.room !== null && typeof o.room !== 'string') return null;
	if (typeof o.ts !== 'number') return null;
	return parsed as PipelineActivityEvent;
}

/**
 * The cross-pool pipeline activity firehose (`/api/pipelines/stream`,
 * ARCHITECTURE.md §11). Unlike the session stream this never self-terminates —
 * it runs until aborted or the upstream closes. Non-`activity` records (the
 * heartbeat comments are already dropped by the parser) and malformed/unknown
 * payloads are skipped rather than killing the stream.
 */
export async function* streamPipelineActivity(
	signal: AbortSignal
): AsyncGenerator<PipelineActivityEvent> {
	const body = await openStream('/api/pipelines/stream', signal);
	for await (const rec of sseRecords(body)) {
		if (rec.event !== 'activity' || !rec.data) continue;
		const evt = parseActivityEvent(rec.data);
		if (evt) yield evt;
	}
}
