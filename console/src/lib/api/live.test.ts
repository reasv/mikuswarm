import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	streamSessionEvents,
	streamPipelineActivity,
	consumeSessionStream,
	type SessionStreamEnd
} from './live';
import type { AgentEventWire } from '$lib/schemas';

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

	it('yields agent_end like any other event and runs until the stream ends', async () => {
		// A single run drives several agent-loop invocations (kickoff + forced-completion
		// prompts), each emitting its own agent_end; the server's stream spans the whole
		// run, so agent_end is NOT a terminator (ARCHITECTURE.md §11 / live.ts). The events
		// after it are still yielded; termination is the byte stream closing on run
		// settlement — here, after the final chunk.
		vi.stubGlobal('fetch', async () =>
			streamResponse([
				'event: agent_end\ndata: {"type":"agent_end","messages":[]}\n\n',
				'event: turn_start\ndata: {"type":"turn_start"}\n\n' // a later invocation — still yielded
			])
		);
		expect(
			await collectTypes(streamSessionEvents('s', new AbortController().signal))
		).toEqual(['agent_end', 'turn_start']);
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

	it('returns the terminal reason as the generator return value', async () => {
		// `not_live` record → 'not_live'; a clean byte-stream end → 'closed'. The
		// reason is the RETURN value (a `for await` ignores it; consumeSessionStream
		// reads it to decide reconnect-vs-stop).
		async function drainEnd(
			gen: AsyncGenerator<AgentEventWire, SessionStreamEnd, void>
		): Promise<{ types: string[]; end: SessionStreamEnd }> {
			const types: string[] = [];
			for (;;) {
				const n = await gen.next();
				if (n.done) return { types, end: n.value };
				types.push(n.value.type);
			}
		}

		vi.stubGlobal('fetch', async () =>
			streamResponse(['event: not_live\ndata: {"sessionId":"s","status":"completed"}\n\n'])
		);
		expect(await drainEnd(streamSessionEvents('s', new AbortController().signal))).toEqual({
			types: [],
			end: 'not_live'
		});

		vi.stubGlobal('fetch', async () =>
			streamResponse(['event: turn_end\ndata: {"type":"turn_end"}\n\n'])
		);
		expect(await drainEnd(streamSessionEvents('s', new AbortController().signal))).toEqual({
			types: ['turn_end'],
			end: 'closed'
		});
	});
});

describe('consumeSessionStream', () => {
	// Build a mock opener from a list of per-attempt "scripts": each attempt yields
	// its events then ends with `end` ('closed'/'not_live'), or `throws` to simulate
	// a dropped connection. The last script repeats for any further reconnects.
	type Script = { events?: string[]; end?: SessionStreamEnd; throws?: boolean };
	function mockOpen(scripts: Script[]) {
		const calls: string[] = [];
		const open = (sessionId: string): AsyncGenerator<AgentEventWire, SessionStreamEnd, void> => {
			const script = scripts[Math.min(calls.length, scripts.length - 1)];
			calls.push(sessionId);
			return (async function* () {
				if (script.throws) throw new Error('dropped connection');
				for (const t of script.events ?? []) yield { type: t } as AgentEventWire;
				return script.end ?? 'closed';
			})();
		};
		return { open, calls };
	}
	const immediateSleep = () => Promise.resolve();

	it('stops on not_live without reconnecting', async () => {
		const { open, calls } = mockOpen([{ events: ['turn_end'], end: 'not_live' }]);
		const seen: string[] = [];
		await consumeSessionStream('s', {
			signal: new AbortController().signal,
			onEvent: (e) => seen.push(e.type),
			open,
			sleep: immediateSleep
		});
		expect(seen).toEqual(['turn_end']);
		expect(calls.length).toBe(1);
	});

	it('reconnects after a dropped connection, then settles on not_live', async () => {
		const { open, calls } = mockOpen([{ throws: true }, { events: ['turn_start'], end: 'not_live' }]);
		const seen: string[] = [];
		await consumeSessionStream('s', {
			signal: new AbortController().signal,
			onEvent: (e) => seen.push(e.type),
			open,
			sleep: immediateSleep
		});
		expect(seen).toEqual(['turn_start']); // the dropped attempt produced nothing
		expect(calls.length).toBe(2); // dropped → reconnected
	});

	it('re-attaches across a clean settlement to stream the resumed run', async () => {
		// First run settles (`closed`); the resumed run streams on the reconnect and
		// then ends terminal — events from BOTH runs are delivered, none duplicated by
		// the consumer (re-seed dedup is the fold's job, tested elsewhere).
		const { open, calls } = mockOpen([
			{ events: ['turn_end'], end: 'closed' },
			{ events: ['turn_start'], end: 'not_live' }
		]);
		const seen: string[] = [];
		await consumeSessionStream('s', {
			signal: new AbortController().signal,
			onEvent: (e) => seen.push(e.type),
			open,
			sleep: immediateSleep
		});
		expect(seen).toEqual(['turn_end', 'turn_start']);
		expect(calls.length).toBe(2);
	});

	it('stops delivering events once aborted mid-stream', async () => {
		const controller = new AbortController();
		const { open, calls } = mockOpen([{ events: ['a', 'b', 'c'], end: 'closed' }]);
		const seen: string[] = [];
		await consumeSessionStream('s', {
			signal: controller.signal,
			onEvent: (e) => {
				seen.push(e.type);
				if (e.type === 'a') controller.abort(); // teardown after the first event
			},
			open,
			sleep: immediateSleep
		});
		expect(seen).toEqual(['a']); // 'b'/'c' suppressed after abort
		expect(calls.length).toBe(1); // no reconnect after teardown
	});

	it('does nothing when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const { open, calls } = mockOpen([{ events: ['x'], end: 'not_live' }]);
		const seen: string[] = [];
		await consumeSessionStream('s', {
			signal: controller.signal,
			onEvent: (e) => seen.push(e.type),
			open,
			sleep: immediateSleep
		});
		expect(seen).toEqual([]);
		expect(calls.length).toBe(0);
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
