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
	CostOverview,
	UsageSummary,
	UsageTimeseries,
	UsageSessions,
	UsageSessionRow,
	UsageToolCalls,
	UsageEventRow,
	UsageBudgets,
	RuleStatus
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
		// `deferred` is absent on a pre-feature backend → defaults to 0.
		expect(out.counts.deferred).toBe(0);
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

/**
 * Usage & cost page wire shapes (spec USAGE-COST-LIMITS §7). The `/api/usage/*`
 * endpoints serve the unified `usage_events` ledger views + the BudgetEngine rule
 * statuses; these decode tests pin the producer contract (one representative
 * payload per schema) so a backend shape change forces a test change here.
 */
describe('usage & cost schemas', () => {
	it('decodes GET /api/usage/summary (totals by class + by model)', () => {
		const out = decode(UsageSummary, {
			since: 1_700_000_000_000,
			now: 1_700_000_086_400_000,
			firstTs: 1_700_000_001_000,
			total: 7.5,
			byClass: [
				{ class: 'tool', cost: 4, events: 3 },
				{ class: 'agent_loop', cost: 3.5, events: 12 },
				{ class: 'caption', cost: 0, events: 5 }
			],
			byModel: [
				{ model: 'anthropic/claude', cost: 3.5, events: 12 },
				{ model: 'gemini-3-pro-image', cost: 4, events: 3 }
			]
		});
		expect(out.total).toBeCloseTo(7.5);
		expect(out.byClass).toHaveLength(3);
		// A zero-cost class is still a valid summary row (counted in `events`).
		expect(out.byClass[2].cost).toBe(0);
		expect(out.byClass[2].events).toBe(5);
		// Average-denominator fields: `now` upper bound + actual data start in the window.
		expect(out.now).toBe(1_700_000_086_400_000);
		expect(out.firstTs).toBe(1_700_000_001_000);
		// An empty window carries a null data start.
		expect(decode(UsageSummary, { since: 0, now: 1, firstTs: null, total: 0, byClass: [], byModel: [] }).firstTs).toBeNull();
	});

	it('decodes GET /api/usage/timeseries (stacked series + bucket meta)', () => {
		const out = decode(UsageTimeseries, {
			series: [
				{ bucket: 3_600_000, grp: 'agent_loop', cost: 3 },
				{ bucket: 7_200_000, grp: 'tool', cost: 4 }
			],
			bucketMs: 3_600_000,
			groupBy: 'class'
		});
		expect(out.series).toHaveLength(2);
		expect(out.bucketMs).toBe(3_600_000);
		expect(out.groupBy).toBe('class');
	});

	it('decodes GET /api/usage/sessions with the per-session tool rollup', () => {
		const out = decode(UsageSessions, {
			sessions: [
				{
					sessionId: 's-A',
					modelId: 'anthropic/claude',
					sessionType: 'default',
					timelineKey: '!abc:m',
					channelLabel: 'General (Acme)',
					triggerSender: 'Alice',
					status: 'completed',
					completedAt: 9_000,
					requests: 3,
					inputTokens: 300,
					outputTokens: 100,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					agentCost: 0.238,
					toolCost: 0.1,
					toolCalls: 2
				}
			]
		});
		expect(out.sessions[0].toolCalls).toBe(2);
		expect(out.sessions[0].toolCost).toBeCloseTo(0.1);
	});

	it('decodes a UsageSessionRow with null model/sender/completedAt (no-tool session → 0/0)', () => {
		// A still-running session with no model committed yet, no trigger sender, and
		// no tool spend: nullable attribution stays null; the rollup coalesces to 0.
		const out = decode(UsageSessionRow, {
			sessionId: 's-B',
			modelId: null,
			sessionType: 'summarize',
			timelineKey: '!def:m',
			channelLabel: '!def:m',
			triggerSender: null,
			status: 'running',
			completedAt: null,
			requests: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			agentCost: 0,
			toolCost: 0,
			toolCalls: 0
		});
		expect(out.modelId).toBeNull();
		expect(out.triggerSender).toBeNull();
		expect(out.completedAt).toBeNull();
		expect(out.toolCalls).toBe(0);
	});

	it('decodes GET /api/usage/tool-calls (a fully-populated paid event row)', () => {
		const out = decode(UsageToolCalls, {
			toolCalls: [
				{
					id: 'usage_abc123',
					ts: 9_100,
					class: 'tool',
					agent_session_id: 's-A',
					session_type: 'default',
					timeline_key: '!abc:m',
					trigger_sender_id: '@alice:example.org',
					tool_name: 'image_generate',
					model_id: 'gemini-3-pro-image',
					provider: 'gemini',
					input_tokens: 100,
					output_tokens: 1290,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					images: 1,
					cost_usd: 0.08,
					ref: 'workspace/out.png',
					channel_label: 'General (Acme)'
				}
			]
		});
		expect(out.toolCalls[0].tool_name).toBe('image_generate');
		expect(out.toolCalls[0].cost_usd).toBeCloseTo(0.08);
	});

	it('decodes a null-heavy UsageEventRow (background caption: no attribution/tokens)', () => {
		// A caption/embedding row carries no session attribution and the gateway may
		// omit token counts entirely — every nullable column reads null, not 0.
		const out = decode(UsageEventRow, {
			id: 'usage_capbf_xyz',
			ts: 7_000,
			class: 'caption',
			agent_session_id: null,
			session_type: null,
			timeline_key: null,
			trigger_sender_id: null,
			tool_name: null,
			model_id: 'google/gemini-3.5-flash',
			provider: null,
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			images: null,
			cost_usd: 0,
			ref: null,
			channel_label: null
		});
		expect(out.agent_session_id).toBeNull();
		expect(out.input_tokens).toBeNull();
		// model_id is non-nullable (always present); cost_usd is a number (0 here).
		expect(out.model_id).toBe('google/gemini-3.5-flash');
		expect(out.cost_usd).toBe(0);
	});

	it('rejects a UsageEventRow whose non-null model_id is null (fidelity guard)', () => {
		// model_id is Schema.String (never null) — the producer always writes it,
		// coalescing an unknown source model to 'unknown'.
		expect(() =>
			decode(UsageEventRow, {
				id: 'usage_x',
				ts: 1,
				class: 'tool',
				agent_session_id: null,
				session_type: null,
				timeline_key: null,
				trigger_sender_id: null,
				tool_name: 'x_search',
				model_id: null,
				provider: null,
				input_tokens: null,
				output_tokens: null,
				cache_read_tokens: null,
				cache_write_tokens: null,
				images: null,
				cost_usd: 0,
				ref: null
			})
		).toThrow();
	});

	it('decodes GET /api/usage/budgets — a CALENDAR-window rule status', () => {
		const out = decode(UsageBudgets, {
			rules: [
				{
					name: 'daily-global',
					spentUsd: 3.5,
					capUsd: 10,
					fraction: 0.35,
					state: 'ok',
					window: { type: 'calendar', period: 'day', tz: 'UTC' },
					resetsAt: 1_700_086_400_000,
					scope: {}
				}
			]
		});
		const rule = out.rules[0];
		expect(rule.window.type).toBe('calendar');
		expect(rule.window.period).toBe('day');
		expect(rule.window.tz).toBe('UTC');
		// A calendar window carries no `duration`.
		expect(rule.window.duration).toBeUndefined();
	});

	it('decodes a ROLLING-window RuleStatus with a scoped selector', () => {
		const out = decode(RuleStatus, {
			name: 'image-burst',
			spentUsd: 5,
			capUsd: 5,
			fraction: 1,
			state: 'blocked',
			window: { type: 'rolling', duration: '24h' },
			resetsAt: 1_700_010_000_000,
			scope: { tools: ['image_generate'], models: ['gemini-3-pro-image'] }
		});
		expect(out.window.type).toBe('rolling');
		expect(out.window.duration).toBe('24h');
		// A rolling window carries no calendar period/tz.
		expect(out.window.period).toBeUndefined();
		expect(out.window.tz).toBeUndefined();
		expect(out.scope.tools).toEqual(['image_generate']);
		expect(out.scope.models).toEqual(['gemini-3-pro-image']);
	});

	it('decodes RuleStatus.fraction at the 0 and ≥1 boundaries', () => {
		// fraction = 0 (no spend) and fraction ≥ 1 (over/at cap, incl. a cap-0 rule
		// reported as fraction: 1, state: "blocked") are both valid wire values.
		const zero = decode(RuleStatus, {
			name: 'fresh',
			spentUsd: 0,
			capUsd: 10,
			fraction: 0,
			state: 'ok',
			window: { type: 'rolling', duration: '1h' },
			resetsAt: 1,
			scope: {}
		});
		expect(zero.fraction).toBe(0);

		const over = decode(RuleStatus, {
			name: 'cap-zero',
			spentUsd: 0,
			capUsd: 0,
			fraction: 1,
			state: 'blocked',
			window: { type: 'calendar', period: 'month', tz: 'America/New_York' },
			resetsAt: 2,
			scope: { classes: ['tool'] }
		});
		expect(over.fraction).toBeGreaterThanOrEqual(1);
		expect(over.state).toBe('blocked');

		// fraction can exceed 1 when spend overshoots the cap before the gate trips.
		const past = decode(RuleStatus, {
			name: 'overshot',
			spentUsd: 13,
			capUsd: 10,
			fraction: 1.3,
			state: 'blocked',
			window: { type: 'rolling', duration: '7d' },
			resetsAt: 3,
			scope: {}
		});
		expect(past.fraction).toBeCloseTo(1.3);
	});

	it('rejects a RuleStatus missing the required window field', () => {
		expect(() =>
			decode(RuleStatus, {
				name: 'x',
				spentUsd: 0,
				capUsd: 1,
				fraction: 0,
				state: 'ok',
				resetsAt: 1,
				scope: {}
			})
		).toThrow();
	});
});
