import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import {
	RoomsResponse,
	RoomContextResponse,
	SessionsResponse,
	SessionDetailResponse,
	AgentEventWire,
	ImageRef,
	ContextMessageWire
} from './schemas';

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) => Schema.decodeUnknownSync(s)(v);

/**
 * Real producer cache-boundary labels. Pinned to `CACHE_BOUNDARIES` in
 * src/context/dump.ts so a backend change to the boundary shape forces a test
 * change here (fidelity guard, spec §8). The labels are strings, not indices.
 */
const CACHE_BOUNDARIES = ['after_system', 'after_compact_tier'];

describe('wire schemas (fidelity guard)', () => {
	it('decodes /api/rooms', () => {
		const out = decode(RoomsResponse, {
			rooms: [
				{
					timelineKey: '!abc:m',
					displayName: 'Room',
					timelineState: 'active',
					lastActivityAt: 1,
					eventCount: 3,
					sessionCount: 2
				},
				{
					timelineKey: '!def:m',
					displayName: null,
					timelineState: null,
					lastActivityAt: null,
					eventCount: 0,
					sessionCount: 0
				}
			]
		});
		expect(out.rooms).toHaveLength(2);
		expect(out.rooms[1].displayName).toBeNull();
	});

	it('decodes /api/rooms/:key/context with preview flags', () => {
		const out = decode(RoomContextResponse, {
			timelineKey: '!abc:m',
			preview: true,
			syntheticTriggerEventId: 'e1',
			messages: [
				{ type: 'system', role: 'system', content: '<sys/>', tier: 'system', tokenEstimate: 10, timestamp: null },
				{ type: 'triggerGroup', role: 'user', content: 'hi', tier: 'trigger', tokenEstimate: 2, timestamp: 5, preview: true }
			],
			tokenEstimate: 12,
			compactTokens: 0,
			richTokens: 0,
			cacheBoundaries: CACHE_BOUNDARIES
		});
		expect(out.messages[1].preview).toBe(true);
		expect(out.cacheBoundaries).toEqual(['after_system', 'after_compact_tier']);
	});

	it('rejects numeric cacheBoundaries (guards #1: backend emits string labels)', () => {
		expect(() =>
			decode(RoomContextResponse, {
				timelineKey: '!abc:m',
				preview: true,
				syntheticTriggerEventId: null,
				messages: [],
				tokenEstimate: 0,
				compactTokens: 0,
				richTokens: 0,
				cacheBoundaries: [1, 2]
			})
		).toThrow();
	});

	it('decodes an externalized ImageRef (producer shape: sizeBytes required, rest optional)', () => {
		// Full ContextMessage-block ref (src/agent/session-capture.ts line ~190).
		const full = decode(ImageRef, {
			__imageRef: true,
			eventId: '$evt:m',
			attachmentId: 'att-1',
			mimeType: 'image/png',
			sizeBytes: 4096
		});
		expect(full.sizeBytes).toBe(4096);
		expect(full.__imageRef).toBe(true);

		// data-URI ref carries only mimeType + sizeBytes (line ~168); eventId/attachmentId absent.
		const partial = decode(ImageRef, { __imageRef: true, mimeType: 'image/jpeg', sizeBytes: 12 });
		expect(partial.eventId).toBeUndefined();
		expect(partial.sizeBytes).toBe(12);
	});

	it('rejects an ImageRef missing the required sizeBytes (would pass as Schema.Unknown, #10)', () => {
		expect(() => decode(ImageRef, { __imageRef: true, mimeType: 'image/png' })).toThrow();
	});

	it('decodes a context message carrying structured imageRefs', () => {
		const out = decode(ContextMessageWire, {
			type: 'userMessage',
			role: 'user',
			content: 'see attached',
			tier: 'rich',
			tokenEstimate: 8,
			timestamp: 1,
			imageRefs: [
				{ __imageRef: true, eventId: '$e:m', attachmentId: 'a1', mimeType: 'image/png', sizeBytes: 2048 },
				{ __imageRef: true, sizeBytes: 9 }
			]
		});
		expect(out.imageRefs).toHaveLength(2);
		expect(out.imageRefs?.[0].sizeBytes).toBe(2048);
		expect(out.imageRefs?.[1].mimeType).toBeUndefined();
	});

	it('rejects a context message whose imageRefs lack sizeBytes (#10 fidelity guard)', () => {
		expect(() =>
			decode(ContextMessageWire, {
				type: 'userMessage',
				role: 'user',
				content: 'x',
				tier: null,
				tokenEstimate: 1,
				timestamp: null,
				imageRefs: [{ __imageRef: true, mimeType: 'image/png' }]
			})
		).toThrow();
	});

	it('decodes /api/rooms/:key/sessions meta', () => {
		const out = decode(SessionsResponse, {
			sessions: [
				{
					id: 's-1',
					timelineKey: '!abc:m',
					sessionType: 'default',
					status: 'completed',
					modelId: 'claude',
					triggerEventId: 'e1',
					triggerExternalId: '$e1',
					triggerBody: 'hello',
					tokenEstimate: 100,
					noReply: false,
					error: null,
					createdAt: 1,
					startedAt: 2,
					updatedAt: 3,
					completedAt: 4
				}
			]
		});
		expect(out.sessions[0].noReply).toBe(false);
	});

	it('decodes /api/sessions/:id and keeps transcript permissive', () => {
		const out = decode(SessionDetailResponse, {
			session: {
				id: 's-1',
				timelineKey: '!abc:m',
				sessionType: 'default',
				status: 'running',
				modelId: null,
				triggerEventId: null,
				triggerExternalId: null,
				triggerBody: null,
				tokenEstimate: null,
				noReply: false,
				error: null,
				createdAt: 1,
				startedAt: null,
				updatedAt: 2,
				completedAt: null
			},
			contextSnapshot: [
				{ type: 'system', role: 'system', content: 'x', tier: 'system', tokenEstimate: 1, timestamp: null }
			],
			transcript: [
				{ type: 'triggerGroup', role: 'user', content: 'hi', tier: 'trigger', tokenEstimate: 1 },
				{ role: 'assistant', content: [{ type: 'text', text: 'yo' }], anyExtraField: 42 }
			],
			rolloutStartIndex: 1,
			contextDumpPath: '/tmp/x'
		});
		expect(out.rolloutStartIndex).toBe(1);
		// permissive transcript preserves unknown fields
		expect((out.transcript[1] as Record<string, unknown>).anyExtraField).toBe(42);
	});

	it('AgentEventWire validates type and preserves payload', () => {
		const out = decode(AgentEventWire, {
			type: 'tool_execution_end',
			toolCallId: 't1',
			toolName: 'send',
			result: { ok: true },
			isError: false
		});
		expect(out.type).toBe('tool_execution_end');
		expect((out as Record<string, unknown>).toolName).toBe('send');
	});

	it('rejects a malformed envelope (missing fields)', () => {
		expect(() => decode(RoomsResponse, { rooms: [{ timelineKey: '!a' }] })).toThrow();
	});
});
