/**
 * SSE record framing + parsing for the browser live-stream consumers
 * (`$lib/api/live.ts`). Client-safe: no server-only imports, so it bundles into
 * the browser. Moved out of the BFF (`lib/server/api/sse.ts`, now deleted) when
 * live streaming switched from `query.live` remote functions to same-origin SSE
 * proxy routes.
 *
 * Why the browser parses SSE itself (fetch + ReadableStream, not `EventSource`):
 * the agent names every record after its event type (`event: turn_end`, …), and
 * `EventSource` needs one listener per name — a generic record reader yields
 * every record regardless of name. Why not `query.live`: SvelteKit live queries
 * are *latest-value* channels — under backpressure only the newest pending value
 * is kept ("live streams are not event logs"), silently dropping events. The
 * rollout fold and the pipeline-activity listener need event-log semantics:
 * every `turn_end` / `activity` record matters.
 */

/**
 * Hard cap on the inter-delimiter buffer. An upstream that never emits a `\n\n`
 * record boundary (or a single pathologically large record) would otherwise grow
 * memory without bound. 8 MiB comfortably exceeds any legitimate AgentEvent
 * record — the largest plausible payload is an `agent_end` carrying the full
 * message array, and images are externalized to `ImageRef`s upstream (spec §3),
 * so no base64 blobs ride the event stream. Past the cap the generator throws.
 */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Record-boundary matcher: a blank line, tolerant of LF or CRLF endings. */
const RECORD_DELIMITER = /\r?\n\r?\n/;

export interface SseRecord {
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

/**
 * Frame a byte stream into parsed SSE records, yielding each one. Heartbeat
 * comments parse to `null` and are dropped. The `finally` cancels the reader so
 * an early consumer `return`/`break` (e.g. on a terminator record) releases the
 * underlying connection even before the caller aborts its fetch.
 */
export async function* sseRecords(body: ReadableStream<Uint8Array>): AsyncGenerator<SseRecord> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			// Guard against an upstream that never delimits (or a single oversized
			// record) accumulating without bound.
			if (buf.length > MAX_SSE_BUFFER_BYTES) {
				throw new Error(`SSE record exceeded ${MAX_SSE_BUFFER_BYTES} bytes`);
			}
			let m: RegExpMatchArray | null;
			while ((m = RECORD_DELIMITER.exec(buf)) !== null) {
				const idx = m.index!;
				const rec = parseRecord(buf.slice(0, idx));
				buf = buf.slice(idx + m[0].length);
				if (rec) yield rec;
			}
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
