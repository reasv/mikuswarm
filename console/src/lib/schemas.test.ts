import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import {
	RoomsResponse,
	RoomContextResponse,
	SessionsResponse,
	SessionDetailResponse,
	AgentEventWire
} from './schemas';

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) => Schema.decodeUnknownSync(s)(v);

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
			cacheBoundaries: [1, 2]
		});
		expect(out.messages[1].preview).toBe(true);
		expect(out.cacheBoundaries).toEqual([1, 2]);
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
