import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRecord, upstreamSse } from './sse';

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
});
