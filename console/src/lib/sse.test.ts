import { describe, it, expect, vi } from 'vitest';
import { parseRecord, sseRecords, type SseRecord } from './sse';

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

/** A byte ReadableStream that emits the given string chunks. */
function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		}
	});
}

async function collect(gen: AsyncGenerator<SseRecord>): Promise<SseRecord[]> {
	const out: SseRecord[] = [];
	for await (const r of gen) out.push(r);
	return out;
}

describe('sseRecords', () => {
	it('frames records across arbitrary chunk boundaries and skips heartbeats', async () => {
		const records = await collect(
			sseRecords(
				byteStream([
					': connected\n\n',
					'event: turn_start\ndata: {"type":"turn',
					'_start"}\n\n: ping\n\n', // record split mid-data + a heartbeat
					'event: turn_end\ndata: {"type":"turn_end","message":{}}\n\n'
				])
			)
		);
		expect(records).toEqual([
			{ event: 'turn_start', data: '{"type":"turn_start"}' },
			{ event: 'turn_end', data: '{"type":"turn_end","message":{}}' }
		]);
	});

	it('frames CRLF-delimited records', async () => {
		const records = await collect(
			sseRecords(
				byteStream([
					'event: turn_start\r\ndata: {"type":"turn_start"}\r\n\r\n',
					'event: not_live\r\ndata: {"sessionId":"s"}\r\n\r\n'
				])
			)
		);
		expect(records).toEqual([
			{ event: 'turn_start', data: '{"type":"turn_start"}' },
			{ event: 'not_live', data: '{"sessionId":"s"}' }
		]);
	});

	it('throws when the stream never delimits past the buffer cap', async () => {
		// A single record that never terminates: each chunk is < cap but the buffer
		// accumulates past it. The generator must throw rather than grow unbounded.
		const gen = sseRecords(
			byteStream([
				'event: turn_start\ndata: {"type":"turn_start","x":"',
				...Array.from({ length: 5 }, () => 'a'.repeat(2 * 1024 * 1024)) // ~10 MiB, no \n\n
			])
		);
		await expect(collect(gen)).rejects.toThrow(/SSE record exceeded/);
	});

	it('cancels the underlying stream when the consumer returns early', async () => {
		let cancelled = false;
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 50; i++) {
					controller.enqueue(enc.encode('event: turn_start\ndata: {"type":"turn_start"}\n\n'));
				}
				// Deliberately never closed: only cancel() ends it.
			},
			cancel() {
				cancelled = true;
			}
		});
		for await (const rec of sseRecords(body)) {
			expect(rec.event).toBe('turn_start');
			break; // early teardown after the first record
		}
		// Cancellation propagates through the TextDecoderStream pipe asynchronously.
		await vi.waitFor(() => expect(cancelled).toBe(true));
	});
});
