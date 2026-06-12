import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamSessionEvents, streamPipelineActivity } from './live';

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

async function collectTypes(gen: AsyncGenerator<{ type: string }>): Promise<string[]> {
	const out: string[] = [];
	for await (const e of gen) out.push(e.type);
	return out;
}

describe('streamSessionEvents', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('yields events across chunk boundaries and skips heartbeats', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				': connected\n\n',
				'event: turn_start\ndata: {"type":"turn',
				'_start"}\n\n: ping\n\n', // record split mid-data + a heartbeat
				'event: turn_end\ndata: {"type":"turn_end","message":{}}\n\n'
			])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual(['turn_start', 'turn_end']);
	});

	it('terminates the generator on agent_end', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: agent_end\ndata: {"type":"agent_end","messages":[]}\n\n',
				'event: turn_start\ndata: {"type":"turn_start"}\n\n' // must NOT be yielded
			])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual(['agent_end']);
	});

	it('terminates immediately on not_live with no events', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse(['event: not_live\ndata: {"sessionId":"s","status":"completed"}\n\n'])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual([]);
	});

	it('skips malformed records without killing the stream', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: junk\ndata: {not json}\n\n',
				'event: junk\ndata: {"noType":1}\n\n',
				'event: turn_end\ndata: {"type":"turn_end"}\n\n'
			])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual(['turn_end']);
	});

	it('matches CRLF-normalized terminators', async () => {
		// Whole stream normalized to CRLF: the not_live terminator must still match
		// despite the trailing \r.
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: turn_end\r\ndata: {"type":"turn_end","message":{}}\r\n\r\n',
				'event: not_live\r\ndata: {"sessionId":"s","status":"completed"}\r\n\r\n',
				'event: turn_start\r\ndata: {"type":"turn_start"}\r\n\r\n' // after not_live → dropped
			])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual(['turn_end']);
	});

	it('throws when the response is not ok', async () => {
		vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
		await expect(
			collectTypes(streamSessionEvents('s', new AbortController().signal))
		).rejects.toThrow(/stream failed \(502\)/);
	});

	it('forwards the abort signal into fetch', async () => {
		let captured: AbortSignal | undefined;
		vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
			captured = init?.signal ?? undefined;
			return streamResponse(['event: not_live\ndata: {}\n\n']);
		});
		const controller = new AbortController();
		await collectTypes(streamSessionEvents('s', controller.signal));
		expect(captured).toBe(controller.signal);
	});
});

describe('streamPipelineActivity', () => {
	afterEach(() => vi.unstubAllGlobals());

	const activity = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			pool: 'enrichment',
			id: 'item-1',
			kind: 'completed',
			status: 'done',
			attempts: 1,
			room: null,
			ts: 1,
			...over
		});

	it('yields every activity record (event-log semantics)', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				`event: activity\ndata: ${activity({ id: 'a' })}\n\n`,
				`event: activity\ndata: ${activity({ id: 'b', pool: 'diary' })}\n\n`,
				`event: activity\ndata: ${activity({ id: 'c' })}\n\n`
			])
		);
		const out = [];
		for await (const e of streamPipelineActivity(new AbortController().signal)) out.push(e);
		expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
		expect(out[1].pool).toBe('diary');
	});

	it('skips non-activity records and malformed/unknown payloads', async () => {
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				`event: other\ndata: ${activity({ id: 'x' })}\n\n`, // wrong event name
				'event: activity\ndata: {not json}\n\n',
				`event: activity\ndata: ${activity({ pool: 'unknown-pool' })}\n\n`,
				`event: activity\ndata: ${activity({ kind: 'exploded' })}\n\n`,
				`event: activity\ndata: ${activity({ id: 'ok' })}\n\n`
			])
		);
		const out = [];
		for await (const e of streamPipelineActivity(new AbortController().signal)) out.push(e);
		expect(out.map((e) => e.id)).toEqual(['ok']);
	});
});
