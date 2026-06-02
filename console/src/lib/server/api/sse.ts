import { error } from '@sveltejs/kit';
import { Schema } from 'effect';
import { apiBaseUrl, authHeaders } from '../config';
import { AgentEventWire, type AgentEventWire as AgentEvent } from '$lib/schemas';

/**
 * Server-side consumer of the agent's SSE endpoint (`GET /api/sessions/:id/stream`),
 * re-yielded as an async generator for a remote `query.live` (spec §3.3 / §8).
 *
 * Uses `fetch` + `ReadableStream` (not `EventSource`) so we can attach the bearer
 * header and stay server-side. The `signal` (from client disconnect) is forwarded
 * into the upstream fetch so the agent's `req.on("close")` fires and its
 * `Agent.subscribe` listener is released — no leaked subscriptions.
 *
 * The generator ends on the upstream's own terminators (`not_live`, `agent_end`),
 * after which the client falls back to the byte-identical persisted record.
 */
const decodeEvent = Schema.decodeUnknownSync(AgentEventWire);

/**
 * Hard cap on the inter-delimiter buffer. An upstream that never emits a `\n\n`
 * record boundary (or a single pathologically large record) would otherwise grow
 * BFF memory without bound. 8 MiB comfortably exceeds any legitimate AgentEvent
 * record — the largest plausible payload is an `agent_end` carrying the full
 * message array, and images are externalized to `ImageRef`s upstream (spec §3),
 * so no base64 blobs ride the event stream. Past the cap we fail with 502.
 */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Record-boundary matcher: a blank line, tolerant of LF or CRLF endings. */
const RECORD_DELIMITER = /\r?\n\r?\n/;

interface SseRecord {
	event?: string;
	data: string;
}

/**
 * Parse one SSE record into its event name + concatenated data.
 *
 * Lines are split on `\n`; a trailing `\r` is stripped per line so the parser is
 * correct regardless of whether the upstream (or an intermediary) normalizes line
 * endings to CRLF. Without this a stray `\r` would make `'not_live\r'` miss the
 * terminator match and leave `\r` baked into `data:` values.
 */
export function parseRecord(raw: string): SseRecord | null {
	let event: string | undefined;
	const data: string[] = [];
	for (let line of raw.split('\n')) {
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line === '' || line.startsWith(':')) continue; // blank or comment (heartbeat)
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') data.push(value);
	}
	if (data.length === 0 && event === undefined) return null;
	return { event, data: data.join('\n') };
}

export async function* upstreamSse(
	path: string,
	signal: AbortSignal
): AsyncGenerator<AgentEvent> {
	const res = await fetch(apiBaseUrl + path, {
		headers: { accept: 'text/event-stream', ...authHeaders() },
		signal
	});
	if (!res.ok || !res.body) throw error(res.status || 502, `upstream stream failed for ${path}`);

	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += value;
			// Guard against an upstream that never delimits (or a single oversized
			// record) accumulating without bound in BFF memory.
			if (buf.length > MAX_SSE_BUFFER_BYTES) {
				throw error(502, `upstream stream record exceeded ${MAX_SSE_BUFFER_BYTES} bytes for ${path}`);
			}
			let m: RegExpMatchArray | null;
			while ((m = RECORD_DELIMITER.exec(buf)) !== null) {
				const idx = m.index!;
				const rec = parseRecord(buf.slice(0, idx));
				buf = buf.slice(idx + m[0].length);
				if (!rec) continue;
				// The agent emits a synthetic `not_live` when a session is terminal/evicted.
				if (rec.event === 'not_live') return;
				if (!rec.data) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(rec.data);
				} catch {
					continue; // skip malformed record rather than killing the stream
				}
				let evt: AgentEvent;
				try {
					evt = decodeEvent(parsed);
				} catch {
					continue;
				}
				yield evt;
				if (evt.type === 'agent_end') return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Controller-owning wrapper around {@link upstreamSse} for a `query.live` body.
 *
 * Owns an `AbortController` and forwards its signal into the upstream fetch. When
 * the live generator is torn down — client disconnect, an early consumer `break`,
 * or an explicit `.return()` — the `finally` aborts the signal so the upstream
 * fetch closes and the agent's `req.on("close")` fires, releasing its
 * `Agent.subscribe` listener (spec §8). No leaked upstream connections.
 *
 * This lives here (not in `sessions.remote.ts`) because SvelteKit only permits
 * remote functions to be exported from `*.remote.ts`; keeping the wrapper in a
 * plain module also makes the teardown-abort path directly testable.
 */
export async function* streamUpstream(path: string): AsyncGenerator<AgentEvent> {
	const controller = new AbortController();
	try {
		yield* upstreamSse(path, controller.signal);
	} finally {
		controller.abort();
	}
}
