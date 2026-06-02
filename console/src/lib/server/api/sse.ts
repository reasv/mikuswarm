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

interface SseRecord {
	event?: string;
	data: string;
}

/** Parse one `\n`-delimited SSE record into its event name + concatenated data. */
export function parseRecord(raw: string): SseRecord | null {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of raw.split('\n')) {
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
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const rec = parseRecord(buf.slice(0, idx));
				buf = buf.slice(idx + 2);
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
