import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRecord, upstreamSse, streamUpstream } from './sse';

describe('parseRecord', () => {
	it('parses event + data', () => {
		expect(parseRecord('event: turn_end\ndata: {"type":"turn_end"}')).toEqual({
			event: 'turn_end',
			data: '{"type":"turn_end"}'
		});
	});
	it('drops comment/heartbeat-only records', () => {
		expect(parseRecord(': ping')).toBeNull();
		expect(parseRecord(': connected')).toBeNull();
	});
	it('concatenates multiple data lines', () => {
		expect(parseRecord('data: a\ndata: b')).toEqual({ event: undefined, data: 'a\nb' });
	});
	it('strips a trailing CR per line (CRLF tolerance)', () => {
		// Stray \r must not leak into the event name or data values.
		expect(parseRecord('event: not_live\r\ndata: {"x":1}\r')).toEqual({
			event: 'not_live',
			data: '{"x":1}'
		});
		expect(parseRecord('data: a\r\ndata: b\r')).toEqual({ event: undefined, data: 'a\nb' });
	});
});

/** Build a Response whose body streams the given string chunks as bytes. */
function streamResponse(chunks: string[]): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		}
	});
	return new Response(body, { status: 200 });
}

async function collect(gen: AsyncGenerator<{ type: string }>): Promise<string[]> {
	const out: string[] = [];
	for await (const e of gen) out.push(e.type);
	return out;
}

describe('upstreamSse', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('frames events across arbitrary chunk boundaries and skips heartbeats', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				': connected\n\n',
				'event: turn_start\ndata: {"type":"turn',
				'_start"}\n\n: ping\n\n', // record split mid-data + a heartbeat
				'event: turn_end\ndata: {"type":"turn_end","message":{}}\n\n'
			])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual([
			'turn_start',
			'turn_end'
		]);
	});

	it('terminates the generator on agent_end', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: agent_end\ndata: {"type":"agent_end","messages":[]}\n\n',
				'event: turn_start\ndata: {"type":"turn_start"}\n\n' // must NOT be yielded
			])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual(['agent_end']);
	});

	it('terminates immediately on not_live with no events', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse(['event: not_live\ndata: {"sessionId":"s","status":"completed"}\n\n'])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual([]);
	});

	it('skips malformed records without killing the stream', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: junk\ndata: {not json}\n\n',
				'event: turn_end\ndata: {"type":"turn_end"}\n\n'
			])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual(['turn_end']);
	});

	it('frames CRLF-delimited records and matches CRLF terminators', async () => {
		// Whole stream normalized to CRLF: framing must split on \r\n\r\n and the
		// not_live terminator must still match despite the trailing \r.
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: turn_start\r\ndata: {"type":"turn_start"}\r\n\r\n',
				'event: turn_end\r\ndata: {"type":"turn_end","message":{}}\r\n\r\n',
				'event: not_live\r\ndata: {"sessionId":"s","status":"completed"}\r\n\r\n',
				'event: turn_start\r\ndata: {"type":"turn_start"}\r\n\r\n' // after not_live → dropped
			])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual([
			'turn_start',
			'turn_end'
		]);
	});

	it('matches a CRLF agent_end terminator', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: agent_end\r\ndata: {"type":"agent_end","messages":[]}\r\n\r\n',
				'event: turn_start\r\ndata: {"type":"turn_start"}\r\n\r\n' // after agent_end → dropped
			])
		);
		expect(await collect(upstreamSse('/x', new AbortController().signal))).toEqual(['agent_end']);
	});

	it('aborts with 502 when the upstream never delimits past the buffer cap', async () => {
		// A single record that never terminates: each chunk is < cap but the buffer
		// accumulates past it. The generator must throw rather than grow unbounded.
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: turn_start\ndata: {"type":"turn_start","x":"',
				...Array.from({ length: 5 }, () => 'a'.repeat(2 * 1024 * 1024)) // ~10 MiB, no \n\n
			])
		);
		await expect(collect(upstreamSse('/x', new AbortController().signal))).rejects.toMatchObject({
			status: 502
		});
	});
});

/**
 * #12 — teardown-abort path, exercised end-to-end through the controller-owning
 * wrapper (`streamUpstream`, the body behind `streamSession` in sessions.remote.ts)
 * rather than `upstreamSse` alone. When the consumer stops early, the wrapper's
 * `finally` must abort the AbortSignal handed to the stubbed `fetch` so the agent
 * releases its subscription.
 */
describe('streamUpstream teardown aborts the upstream fetch', () => {
	afterEach(() => vi.unstubAllGlobals());

	function captureSignalFetch(chunks: string[]): { signal: () => AbortSignal | undefined } {
		let captured: AbortSignal | undefined;
		vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
			captured = init?.signal ?? undefined;
			return streamResponse(chunks);
		});
		return { signal: () => captured };
	}

	it('aborts when the consumer breaks out of the loop early', async () => {
		// Stream stays "live" (many turn_start records, no terminator) so the loop
		// would run forever if the consumer did not break.
		const ref = captureSignalFetch(
			Array.from({ length: 50 }, () => 'event: turn_start\ndata: {"type":"turn_start"}\n\n')
		);
		const gen = streamUpstream('/api/sessions/sess-1/stream');
		for await (const e of gen) {
			expect(e.type).toBe('turn_start');
			break; // early teardown after the first event
		}
		const sig = ref.signal();
		expect(sig).toBeInstanceOf(AbortSignal);
		expect(sig!.aborted).toBe(true);
	});

	it('aborts when the consumer calls .return() on the generator', async () => {
		const ref = captureSignalFetch(
			Array.from({ length: 50 }, () => 'event: turn_start\ndata: {"type":"turn_start"}\n\n')
		);
		const gen = streamUpstream('/api/sessions/sess-2/stream');
		const first = await gen.next();
		expect(first.value?.type).toBe('turn_start');
		await gen.return(undefined); // explicit teardown
		const sig = ref.signal();
		expect(sig).toBeInstanceOf(AbortSignal);
		expect(sig!.aborted).toBe(true);
	});
});
