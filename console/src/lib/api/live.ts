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
 * Why a session stream ended, distinguishing a definitive terminal from a
 * recoverable close:
 * - `not_live` — the server says the session isn't live (terminal/evicted at
 *   attach). Stop and fall back to the persisted record.
 * - `closed` — the byte stream ended cleanly. The agent closes it on EVERY run
 *   settlement (not on `agent_end`; handlers.ts `onSettle`), and resume /
 *   follow-up-fold reuse the same session id across settle→running cycles, so a
 *   clean close is NOT proof the session is done — `consumeSessionStream`
 *   reconnects once to re-check rather than giving up.
 */
export type SessionStreamEnd = 'not_live' | 'closed';

/**
 * Live `AgentEvent`s for a running session (spec §8 `/api/sessions/:id/stream`).
 * Ends when the server closes the stream — which it does on **run settlement**,
 * not on `agent_end`. A single run drives several agent-loop invocations (kickoff
 * + forced-completion prompts), each emitting its own `agent_end`; returning on
 * the first would truncate the live view after one turn (the server spans the
 * whole run, ARCHITECTURE.md §11). So `agent_end` is yielded like any other event
 * and the loop runs until the byte stream ends (settlement → returns `closed`) or
 * a synthetic `not_live` record (returns `not_live`). The terminal reason is the
 * generator's RETURN value, so a `for await` consumer is unaffected while
 * `consumeSessionStream` (and the tests) can read it via the iterator protocol.
 */
export async function* streamSessionEvents(
	sessionId: string,
	signal: AbortSignal
): AsyncGenerator<AgentEventWire, SessionStreamEnd, void> {
	const body = await openStream(
		`/api/sessions/${encodeURIComponent(sessionId)}/stream`,
		signal
	);
	for await (const rec of sseRecords(body)) {
		if (rec.event === 'not_live') return 'not_live';
		if (!rec.data) continue;
		const evt = parseAgentEvent(rec.data);
		if (!evt) continue;
		yield evt;
	}
	return 'closed';
}

/** A sleep that resolves early when `signal` aborts, so a teardown during the
 *  reconnect backoff doesn't leave a dangling timer / delayed loop exit. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true }
		);
	});
}

export interface SessionStreamConsumer {
	/** Apply one live event (the rollout fold). Not called after `signal` aborts. */
	onEvent: (evt: AgentEventWire) => void;
	/** Aborts the whole consumption (component teardown / session switch). */
	signal: AbortSignal;
	/** Backoff between reconnect attempts. Default 1500ms. */
	reconnectMs?: number;
	/** Injectable opener (tests). Defaults to {@link streamSessionEvents}. */
	open?: (
		sessionId: string,
		signal: AbortSignal
	) => AsyncGenerator<AgentEventWire, SessionStreamEnd, void>;
	/** Injectable sleep (tests). Defaults to an abortable `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Drive a session's live SSE with reconnect + re-attach semantics, resolving
 * only when the session is definitively terminal (`not_live`) or the caller
 * aborts. A single attach is not enough: the agent closes the byte stream on
 * EVERY run settlement (not on `agent_end`), and resume / follow-up-fold reuse
 * the same session id across multiple settle→running cycles. This loop:
 *
 *   - reconnects after a DROPPED connection (network blip, proxy idle-timeout,
 *     agent restart) instead of freezing the view until a manual refresh — the
 *     bug that made live viewing "glitchy" (cf. `PipelineActivityListener`,
 *     which already does this for the activity firehose);
 *   - on a CLEAN close (`closed` = settlement) reconnects once to re-check: the
 *     server answers `not_live` if the session is truly done (→ resolve, fall
 *     back to the persisted record), or sends a fresh `rollout_seed` for the
 *     next run if it resumed (→ keep streaming seamlessly).
 *
 * Each (re)attach re-seeds via `rollout_seed`, which the fold applies as a
 * wholesale replace — so reconnecting never duplicates already-shown messages.
 */
export async function consumeSessionStream(
	sessionId: string,
	c: SessionStreamConsumer
): Promise<void> {
	const open = c.open ?? streamSessionEvents;
	const reconnectMs = c.reconnectMs ?? 1500;
	const sleep = c.sleep ?? ((ms: number) => abortableSleep(ms, c.signal));
	while (!c.signal.aborted) {
		let end: SessionStreamEnd = 'closed';
		try {
			const iter = open(sessionId, c.signal);
			for (;;) {
				const next = await iter.next();
				if (next.done) {
					end = next.value ?? 'closed';
					break;
				}
				if (c.signal.aborted) return;
				c.onEvent(next.value);
			}
		} catch {
			// The fetch threw: a dropped connection — or our own teardown abort.
			// On teardown, exit; otherwise back off and reconnect (re-seed).
			if (c.signal.aborted) return;
			await sleep(reconnectMs);
			continue;
		}
		if (end === 'not_live') return; // definitively terminal → persisted record wins
		if (c.signal.aborted) return;
		await sleep(reconnectMs); // clean settlement → reconnect once to re-check (resume?)
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
