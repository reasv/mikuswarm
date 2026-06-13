import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import {
	RoomsResponse,
	RoomContextResponse,
	SessionsResponse,
	SessionDetailResponse,
	AbortSessionResponse,
	AgentEventWire,
	ImageRef,
	ContextMessageWire,
	SessionMeta,
	ToolInvocation,
	CaptioningUsageAggregate,
	PipelineHealth,
	PipelineMediaAsset,
	CostOverview
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

	it('decodes POST /api/sessions/:id/abort 200 body to the typed value', () => {
		// The Stop button's success path branches on this `status` (SessionView.svelte
		// `handleStop`), so pin the 200 contract: `{ sessionId, status: "interrupted" }`.
		const out = decode(AbortSessionResponse, { sessionId: 's-x', status: 'interrupted' });
		expect(out.sessionId).toBe('s-x');
		expect(out.status).toBe('interrupted');
	});

	it('rejects an abort body missing the status field', () => {
		expect(() => decode(AbortSessionResponse, { sessionId: 's-x' })).toThrow();
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

/**
 * Auxiliary (out-of-loop) usage & cost wire fields (spec AUXILIARY-USAGE-TRACKING
 * §10). Pins the decode contract for the new captioning/image-gen/cost-overview
 * shapes, including the null-not-zero ("—") and optional-for-legacy conventions.
 */
describe('auxiliary usage schemas', () => {
	// A minimal valid SessionMeta to hang the optional toolUsage field off of.
	const baseSession = {
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
	};

	it('decodes the captioning pool usage aggregate (§10.2)', () => {
		const out = decode(CaptioningUsageAggregate, {
			captionedCount: 12,
			totalInputTokens: 3400,
			totalOutputTokens: 900,
			totalCost: 0.0123
		});
		expect(out.captionedCount).toBe(12);
		expect(out.totalCost).toBeCloseTo(0.0123);
	});

	it('decodes the global cost overview as three side-by-side lanes (§10.4)', () => {
		const out = decode(CostOverview, { agentLoopCost: 1.5, toolCost: 0.25, captioningCost: 0.03 });
		expect(out.agentLoopCost).toBe(1.5);
		expect(out.toolCost).toBe(0.25);
		expect(out.captioningCost).toBe(0.03);
	});

	it('decodes a fully-populated tool invocation ledger row (§10.3)', () => {
		const out = decode(ToolInvocation, {
			id: 'toolinv_abc',
			toolCallId: 'call_1',
			toolName: 'image_generate',
			modelId: 'gemini-3-pro-image',
			provider: 'gemini',
			input: 100,
			output: 1290,
			cacheRead: 0,
			cacheWrite: 0,
			images: 1,
			cost: 0.0795,
			ref: 'workspace/out.png',
			createdAt: 5
		});
		expect(out.toolName).toBe('image_generate');
		expect(out.cost).toBeCloseTo(0.0795);
	});

	it('decodes a tool invocation with null usage ("unknown" → "—")', () => {
		// Gateway omitted usageMetadata: every token/cost field is null, not 0.
		const out = decode(ToolInvocation, {
			id: 'toolinv_def',
			toolCallId: null,
			toolName: 'image_generate',
			modelId: null,
			provider: null,
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			images: null,
			cost: null,
			ref: null,
			createdAt: 6
		});
		expect(out.cost).toBeNull();
		expect(out.input).toBeNull();
	});

	it('rejects a tool invocation where a null-or-number field is a string', () => {
		expect(() =>
			decode(ToolInvocation, {
				id: 'x',
				toolCallId: null,
				toolName: 'image_generate',
				modelId: null,
				provider: null,
				input: '100',
				output: null,
				cacheRead: null,
				cacheWrite: null,
				images: null,
				cost: null,
				ref: null,
				createdAt: 6
			})
		).toThrow();
	});

	it('decodes a captioning pool health row carrying a usage aggregate', () => {
		const out = decode(PipelineHealth, {
			pool: 'captioning',
			enabled: true,
			workerCount: 2,
			maxRetries: 3,
			inFlight: 0,
			counts: { pending: 0, processing: 0, retrying: 0, done: 5, failed: 0, skipped: 0 },
			usage: { captionedCount: 5, totalInputTokens: 1000, totalOutputTokens: 200, totalCost: 0.004 }
		});
		expect(out.usage?.captionedCount).toBe(5);
	});

	it('decodes a non-captioning pool health row with null usage', () => {
		const out = decode(PipelineHealth, {
			pool: 'summarization',
			enabled: true,
			workerCount: 1,
			maxRetries: 3,
			inFlight: 0,
			counts: { pending: 0, processing: 0, retrying: 0, done: 0, failed: 0, skipped: 0 },
			usage: null
		});
		expect(out.usage).toBeNull();
	});

	it('decodes a pool health row from a pre-feature backend (usage absent)', () => {
		const out = decode(PipelineHealth, {
			pool: 'enrichment',
			enabled: true,
			workerCount: 1,
			maxRetries: 3,
			inFlight: 0,
			counts: { pending: 0, processing: 0, retrying: 0, done: 0, failed: 0, skipped: 0 }
		});
		expect(out.usage).toBeUndefined();
	});

	it('decodes a media asset with caption usage, and with legacy null usage', () => {
		const withUsage = decode(PipelineMediaAsset, {
			ref: 'r',
			role: 'user',
			mediaType: 'image',
			mimeType: 'image/png',
			filename: null,
			downloadStatus: 'done',
			captionStatus: 'done',
			caption: 'a cat',
			captionModel: 'google/gemini-3.5-flash',
			hasBytes: true,
			usage: { input: 700, output: 200, cacheRead: 300, total: 1200, cost: 0.0009 }
		});
		expect(withUsage.usage?.total).toBe(1200);

		const legacy = decode(PipelineMediaAsset, {
			ref: 'r',
			role: 'user',
			mediaType: 'image',
			mimeType: null,
			filename: null,
			downloadStatus: 'done',
			captionStatus: 'done',
			caption: null,
			captionModel: null,
			hasBytes: false,
			usage: null
		});
		expect(legacy.usage).toBeNull();
	});

	it('decodes a session meta with the separate tool-spend lane, and without it', () => {
		const withTools = decode(SessionMeta, {
			...baseSession,
			toolUsage: { calls: 3, inputTokens: 300, outputTokens: 3870, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.238 }
		});
		expect(withTools.toolUsage?.calls).toBe(3);
		expect(withTools.toolUsage?.cost).toBeCloseTo(0.238);

		// Absent on the list shape / pre-feature backend.
		const noTools = decode(SessionMeta, baseSession);
		expect(noTools.toolUsage).toBeUndefined();
	});
});
