import { Schema } from 'effect';

/**
 * Effect Schema definitions mirroring the agent's in-process API wire shapes
 * (src/observability/server/handlers.ts). Every upstream response is decoded
 * through these, so a backend wire-shape drift surfaces as a DecodeError at the
 * BFF rather than a silent UI bug (the fidelity guard, spec §8/§10).
 *
 * Envelopes and context messages are strict (the verbatim renderer needs exact
 * `content`); deeply-nested AgentMessage / AgentEvent payloads are `any` upstream,
 * so they are kept as permissive passthrough objects.
 */

/** Object passthrough that preserves unknown keys (for evolving message bodies). */
const PassthroughObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** Externalized image reference (src/agent/session-capture.ts `ImageRef`). */
export const ImageRef = Schema.Struct({
	__imageRef: Schema.optional(Schema.Boolean),
	eventId: Schema.optional(Schema.String),
	attachmentId: Schema.optional(Schema.String),
	mimeType: Schema.optional(Schema.String),
	sizeBytes: Schema.Number
});
export type ImageRef = Schema.Schema.Type<typeof ImageRef>;

/** One named piece of the system prompt and its token contribution (prompt.ts `SystemPromptSegment`). */
export const SystemPromptSegmentWire = Schema.Struct({
	tag: Schema.String,
	label: Schema.String,
	source: Schema.NullOr(Schema.String),
	tokenEstimate: Schema.Number
});
export type SystemPromptSegmentWire = Schema.Schema.Type<typeof SystemPromptSegmentWire>;

/** One tool's contribution + definition within the tool-definition block (tool-block.ts `ToolSegment`). */
export const ToolWire = Schema.Struct({
	name: Schema.String,
	tokenEstimate: Schema.Number,
	/** Pretty-printed wire JSON of this tool's definition, shown when its row expands. */
	text: Schema.String
});
export type ToolWire = Schema.Schema.Type<typeof ToolWire>;

/** A rendered context message (handlers.ts `renderContextMessage`). */
export const ContextMessageWire = Schema.Struct({
	type: Schema.String,
	role: Schema.String,
	content: Schema.String,
	tier: Schema.NullOr(Schema.String),
	// Nullable so a genuinely-legacy persisted transcript head (captured before the
	// producer threaded the real estimate, issue #9) decodes and renders an em-dash
	// rather than a misleading 0. Live producer paths always emit a real number.
	tokenEstimate: Schema.NullOr(Schema.Number),
	timestamp: Schema.NullOr(Schema.Number),
	imageRefs: Schema.optional(Schema.Array(ImageRef)),
	/** present only on room-context preview messages (spec §9) */
	preview: Schema.optional(Schema.Boolean),
	/**
	 * Per-segment token breakdown of the system prompt — present ONLY on the
	 * `system` message of a live room-context preview (spec §10a). Absent on every
	 * other message and on persisted session snapshots, which carry the system
	 * prompt as one opaque blob.
	 */
	segments: Schema.optional(Schema.Array(SystemPromptSegmentWire)),
	/**
	 * Per-tool breakdown of the tool-definition block — present ONLY on the
	 * synthetic `tools` message the inspector prepends above the system prompt
	 * (spec §10a). Each entry carries the tool's name, token cost, and its own
	 * definition text, so the block renders hierarchically (block → tool → schema).
	 */
	tools: Schema.optional(Schema.Array(ToolWire))
});
export type ContextMessageWire = Schema.Schema.Type<typeof ContextMessageWire>;

// ── Agents meta (spec CONSOLE-MULTI-AGENT §2) ───────────────────────────────

/** One account belonging to an agent (provider + accountId). */
export const AgentAccount = Schema.Struct({
	provider: Schema.String,
	accountId: Schema.String
});
export type AgentAccount = Schema.Schema.Type<typeof AgentAccount>;

/** One declared agent with its ordered account list. */
export const AgentEntry = Schema.Struct({
	name: Schema.String,
	accounts: Schema.Array(AgentAccount)
});
export type AgentEntry = Schema.Schema.Type<typeof AgentEntry>;

/**
 * GET /api/agents — static agents snapshot. `mode` is "agents" (multi-agent
 * deployment) or "legacy" (single implicit identity). In legacy mode `agents`
 * is empty and the console suppresses all agent chrome.
 */
export const AgentsResponse = Schema.Struct({
	mode: Schema.Literal('agents', 'legacy'),
	agents: Schema.Array(AgentEntry)
});
export type AgentsResponse = Schema.Schema.Type<typeof AgentsResponse>;

/** GET /api/rooms */
export const Room = Schema.Struct({
	timelineKey: Schema.String,
	// Provider/account segments of the timeline key, parsed server-side (null for a
	// malformed key). Optional for backward compatibility with an older BFF that
	// omits them — without them the room list simply renders untabbed.
	provider: Schema.optional(Schema.NullOr(Schema.String)),
	accountId: Schema.optional(Schema.NullOr(Schema.String)),
	displayName: Schema.NullOr(Schema.String),
	timelineState: Schema.NullOr(Schema.String),
	lastActivityAt: Schema.NullOr(Schema.Number),
	eventCount: Schema.Number,
	sessionCount: Schema.Number
});
export type Room = Schema.Schema.Type<typeof Room>;
export const RoomsResponse = Schema.Struct({ rooms: Schema.Array(Room) });

/** GET /api/rooms/:key/context */
export const RoomContextResponse = Schema.Struct({
	timelineKey: Schema.String,
	preview: Schema.Boolean,
	syntheticTriggerEventId: Schema.NullOr(Schema.String),
	messages: Schema.Array(ContextMessageWire),
	tokenEstimate: Schema.Number,
	compactTokens: Schema.Number,
	richTokens: Schema.Number,
	cacheBoundaries: Schema.Array(Schema.String)
});
export type RoomContextResponse = Schema.Schema.Type<typeof RoomContextResponse>;

/** session meta (handlers.ts `sessionMeta`) */
export const SessionMeta = Schema.Struct({
	id: Schema.String,
	timelineKey: Schema.String,
	sessionType: Schema.String,
	status: Schema.String,
	modelId: Schema.NullOr(Schema.String),
	triggerEventId: Schema.NullOr(Schema.String),
	triggerExternalId: Schema.NullOr(Schema.String),
	triggerBody: Schema.NullOr(Schema.String),
	// Frozen-prefix ESTIMATE (unchanged, kept clearly separate from actuals below).
	tokenEstimate: Schema.NullOr(Schema.Number),
	// Actuals (spec TOKEN-USAGE-TRACKING §7.1). All optional/nullable: legacy rows
	// and pre-first-commit sessions read as "unknown". `usage` is null until a
	// request commits; `contextTokens` is the last-observed actual context size;
	// `maxContextTokens` is the operative ceiling from current config — now always
	// a non-null number for live sessions (spec CONTEXT-LIMIT-UNIFICATION §4), so
	// the `/ limit` denominator always renders; kept nullable for legacy/headless rows.
	llmRequests: Schema.optional(Schema.NullOr(Schema.Number)),
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				input: Schema.Number,
				output: Schema.Number,
				cacheRead: Schema.Number,
				cacheWrite: Schema.Number,
				cost: Schema.Number
			})
		)
	),
	contextTokens: Schema.optional(Schema.NullOr(Schema.Number)),
	maxContextTokens: Schema.optional(Schema.NullOr(Schema.Number)),
	// Per-session cost ceiling (spec SESSION-COST-LIMITS §6), resolved from current
	// config; null = unlimited. Denominator for the combined (agent-loop + tool)
	// spend indicator below.
	maxSessionCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
	// Auxiliary tool-spend rollup (spec AUXILIARY-USAGE-TRACKING §10.3): a SEPARATE
	// lane shown beside the §8b actuals, never blended in (§9). Present on the
	// session-detail meta only (absent on the list shape), hence optional. Always a
	// zeroed shape (never null) when present — `calls === 0` means no tool spend.
	toolUsage: Schema.optional(
		Schema.Struct({
			calls: Schema.Number,
			inputTokens: Schema.Number,
			outputTokens: Schema.Number,
			cacheReadTokens: Schema.Number,
			cacheWriteTokens: Schema.Number,
			cost: Schema.Number
		})
	),
	noReply: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	startedAt: Schema.NullOr(Schema.Number),
	updatedAt: Schema.Number,
	completedAt: Schema.NullOr(Schema.Number)
});
export type SessionMeta = Schema.Schema.Type<typeof SessionMeta>;
export const SessionsResponse = Schema.Struct({ sessions: Schema.Array(SessionMeta) });

/** session filter facets (handlers.ts `roomSessionFacets`) — distinct types present. */
export const SessionFacetsResponse = Schema.Struct({ types: Schema.Array(Schema.String) });
export type SessionFacetsResponse = Schema.Schema.Type<typeof SessionFacetsResponse>;

/**
 * One auxiliary tool-use ledger row (spec AUXILIARY-USAGE-TRACKING §10.3),
 * matched into the rollout by `toolCallId` to annotate the `image_generate`
 * block. Token/cost fields are nullable ("unknown", rendered "—").
 */
export const ToolInvocation = Schema.Struct({
	id: Schema.String,
	toolCallId: Schema.NullOr(Schema.String),
	toolName: Schema.String,
	modelId: Schema.NullOr(Schema.String),
	provider: Schema.NullOr(Schema.String),
	input: Schema.NullOr(Schema.Number),
	output: Schema.NullOr(Schema.Number),
	cacheRead: Schema.NullOr(Schema.Number),
	cacheWrite: Schema.NullOr(Schema.Number),
	images: Schema.NullOr(Schema.Number),
	cost: Schema.NullOr(Schema.Number),
	ref: Schema.NullOr(Schema.String),
	createdAt: Schema.Number
});
export type ToolInvocation = Schema.Schema.Type<typeof ToolInvocation>;

/** GET /api/sessions/:id — transcript/snapshot elements kept permissive. */
export const SessionDetailResponse = Schema.Struct({
	session: SessionMeta,
	contextSnapshot: Schema.Array(ContextMessageWire),
	transcript: Schema.Array(PassthroughObject),
	rolloutStartIndex: Schema.Number,
	contextDumpPath: Schema.NullOr(Schema.String),
	// Auxiliary tool-use ledger rows for this session (spec §10.3); optional so a
	// pre-feature backend still decodes.
	toolInvocations: Schema.optional(Schema.Array(ToolInvocation))
});
export type SessionDetailResponse = Schema.Schema.Type<typeof SessionDetailResponse>;

/**
 * POST /api/sessions/:id/abort — the Stop button (spec §13). On a 200 the agent
 * returns `{ sessionId, status: "interrupted" }`. A 409 (session not running) is
 * mapped to a thrown `HttpError` by the API client before this schema is reached.
 */
export const AbortSessionResponse = Schema.Struct({
	sessionId: Schema.String,
	status: Schema.String
});
export type AbortSessionResponse = Schema.Schema.Type<typeof AbortSessionResponse>;

/**
 * POST /api/sessions/:id/resume — manual resume-in-place of a parked
 * `failed-resumable` or `interrupted` session of a user-facing type (spec
 * CONCURRENCY-AND-RATE-LIMITING §6.2 / Decision D; synthetic
 * summarize/condense/diary sessions are rejected). On a 200 the resume ran to
 * completion (`{ sessionId, status: "completed" }`); a 409 (not resumable /
 * synthetic session type / resume failed again, with the resulting
 * `sessionStatus`) is mapped to a thrown `HttpError` by the API client before
 * this schema is reached.
 */
export const ResumeSessionResponse = Schema.Struct({
	sessionId: Schema.String,
	status: Schema.String
});
export type ResumeSessionResponse = Schema.Schema.Type<typeof ResumeSessionResponse>;

/** GET /api/summaries/:id — lineage shape is backend-internal; keep permissive. */
export const SummaryResponse = Schema.Struct({
	summary: Schema.Unknown,
	lineage: Schema.Unknown
});

/**
 * A single `AgentEvent` off the SSE stream. `type` is validated; the rest of the
 * payload (message/messages/args/result) is genuinely `any` upstream, so kept open.
 */
export const AgentEventWire = Schema.Struct({ type: Schema.String }, PassthroughObject);
export type AgentEventWire = Schema.Schema.Type<typeof AgentEventWire>;

// ── Pipeline monitor (ARCHITECTURE.md §11) ──────────────────────────────────

/** The four background pipelines surfaced by the monitor. */
export const PipelineId = Schema.Literal('enrichment', 'captioning', 'summarization', 'diary');
export type PipelineId = Schema.Schema.Type<typeof PipelineId>;

/** Status-bucket counts (GET /api/pipelines `counts`). */
export const PipelineCounts = Schema.Struct({
	pending: Schema.Number,
	processing: Schema.Number,
	retrying: Schema.Number,
	done: Schema.Number,
	failed: Schema.Number,
	skipped: Schema.Number,
	// Captioning-only: pending assets the pool would never claim under the current
	// config (the derived `deferred` status), carved out of `pending`. 0 elsewhere.
	// Optional so a pre-feature backend still decodes (defaults to 0).
	deferred: Schema.optionalWith(Schema.Number, { default: () => 0 })
});
export type PipelineCounts = Schema.Schema.Type<typeof PipelineCounts>;

/**
 * Captioning-pool usage aggregate (spec AUXILIARY-USAGE-TRACKING §10.2), present
 * only on the captioning pool's row (null elsewhere). SUM/COUNT over media_assets.
 */
export const CaptioningUsageAggregate = Schema.Struct({
	captionedCount: Schema.Number,
	totalInputTokens: Schema.Number,
	totalOutputTokens: Schema.Number,
	totalCost: Schema.Number
});
export type CaptioningUsageAggregate = Schema.Schema.Type<typeof CaptioningUsageAggregate>;

/** One pool's dashboard row (GET /api/pipelines). */
export const PipelineHealth = Schema.Struct({
	pool: PipelineId,
	enabled: Schema.Boolean,
	workerCount: Schema.Number,
	maxRetries: Schema.Number,
	inFlight: Schema.Number,
	counts: PipelineCounts,
	// Captioning usage aggregate (§10.2); null on non-captioning pools. Optional so
	// a pre-feature backend still decodes.
	usage: Schema.optional(Schema.NullOr(CaptioningUsageAggregate))
});
export type PipelineHealth = Schema.Schema.Type<typeof PipelineHealth>;
export const PipelinesResponse = Schema.Struct({ pipelines: Schema.Array(PipelineHealth) });
export type PipelinesResponse = Schema.Schema.Type<typeof PipelinesResponse>;

/** One unified queue item (GET /api/pipelines/:pool/items). */
export const PipelineItem = Schema.Struct({
	pool: PipelineId,
	id: Schema.String,
	status: Schema.String,
	attempts: Schema.Number,
	maxRetries: Schema.Number,
	retrying: Schema.Boolean,
	room: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	inputSummary: Schema.String,
	outputSummary: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	sessionId: Schema.NullOr(Schema.String)
});
export type PipelineItem = Schema.Schema.Type<typeof PipelineItem>;
export const PipelineItemsResponse = Schema.Struct({
	items: Schema.Array(PipelineItem),
	nextCursor: Schema.NullOr(Schema.String)
});
export type PipelineItemsResponse = Schema.Schema.Type<typeof PipelineItemsResponse>;

/** Wire shape of a produced/source media asset in an item detail. */
export const PipelineMediaAsset = Schema.Struct({
	ref: Schema.String,
	role: Schema.String,
	mediaType: Schema.String,
	mimeType: Schema.NullOr(Schema.String),
	filename: Schema.NullOr(Schema.String),
	downloadStatus: Schema.String,
	captionStatus: Schema.String,
	caption: Schema.NullOr(Schema.String),
	captionModel: Schema.NullOr(Schema.String),
	hasBytes: Schema.Boolean,
	// Auxiliary caption usage/cost (spec §10.1); null on legacy rows / gateways
	// that omit usage. `cost` may be 0 (usage known, no rates) → hidden by formatUsd.
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				input: Schema.Number,
				output: Schema.Number,
				cacheRead: Schema.Number,
				total: Schema.Number,
				cost: Schema.Number
			})
		)
	)
});
export type PipelineMediaAsset = Schema.Schema.Type<typeof PipelineMediaAsset>;

/**
 * GET /api/pipelines/:pool/items/:id — the pool-specific detail. Modeled as one
 * Struct with the base `{ pool, item }` plus all-optional per-pool extras (rather
 * than a strict discriminated union), so a partial/evolving backend detail stays
 * forward-decodable; the UI branches on `pool`. Backend-internal `summary`/`lineage`/
 * `replyContext` shapes are kept permissive.
 */
export const PipelineItemDetail = Schema.Struct({
	pool: PipelineId,
	item: PipelineItem,
	sessionId: Schema.optional(Schema.NullOr(Schema.String)),
	// enrichment
	mediaAssets: Schema.optional(Schema.Array(PipelineMediaAsset)),
	linkPreviews: Schema.optional(Schema.Array(Schema.Unknown)),
	replyContext: Schema.optional(Schema.Unknown),
	// captioning
	media: Schema.optional(Schema.NullOr(PipelineMediaAsset)),
	// summarization / diary
	summary: Schema.optional(Schema.Unknown),
	lineage: Schema.optional(Schema.Unknown),
	bestEffortDraft: Schema.optional(Schema.NullOr(Schema.String)),
	error: Schema.optional(Schema.NullOr(Schema.String))
});
export type PipelineItemDetail = Schema.Schema.Type<typeof PipelineItemDetail>;

/**
 * POST /api/pipelines/:pool/items/:id/retry (Phase 5). On 200 the item is reset to
 * `pending`; a 409 (not retryable) is mapped to a thrown HttpError before this.
 */
export const RetryPipelineItemResponse = Schema.Struct({
	pool: PipelineId,
	id: Schema.String,
	status: Schema.String
});
export type RetryPipelineItemResponse = Schema.Schema.Type<typeof RetryPipelineItemResponse>;

/** POST /api/pipelines/:pool/retry-failed — bulk retry; `retried` is the count reset. */
export const RetryFailedResponse = Schema.Struct({
	pool: PipelineId,
	retried: Schema.Number
});
export type RetryFailedResponse = Schema.Schema.Type<typeof RetryFailedResponse>;

/** One live activity event off GET /api/pipelines/stream (the SSE firehose). */
export const PipelineActivityEvent = Schema.Struct({
	pool: PipelineId,
	id: Schema.String,
	kind: Schema.Literal('claimed', 'completed', 'failed', 'retried', 'skipped'),
	status: Schema.String,
	attempts: Schema.Number,
	room: Schema.NullOr(Schema.String),
	ts: Schema.Number
});
export type PipelineActivityEvent = Schema.Schema.Type<typeof PipelineActivityEvent>;

// ── Scheduler view (spec LLM-FAILURE-HANDLING §9.1/§9.2) ────────────────────

/** One admitted (in-flight) request in a group (GET /api/scheduler). */
export const SchedulerActiveEntry = Schema.Struct({
	sessionId: Schema.NullOr(Schema.String),
	sessionType: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	priority: Schema.String,
	key: Schema.NullOr(Schema.String),
	heldMs: Schema.Number
});
export type SchedulerActiveEntry = Schema.Schema.Type<typeof SchedulerActiveEntry>;

/** One queued waiter in a group (GET /api/scheduler). */
export const SchedulerQueuedEntry = Schema.Struct({
	sessionId: Schema.NullOr(Schema.String),
	sessionType: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	priority: Schema.String,
	key: Schema.NullOr(Schema.String),
	waitingMs: Schema.Number
});
export type SchedulerQueuedEntry = Schema.Schema.Type<typeof SchedulerQueuedEntry>;

export const SchedulerGroup = Schema.Struct({
	name: Schema.String,
	maxInFlight: Schema.Number,
	/** Throttle backoff, epoch ms; 0 = none. */
	backoffUntil: Schema.Number,
	active: Schema.Array(SchedulerActiveEntry),
	queue: Schema.Array(SchedulerQueuedEntry),
	stickyEscalations: Schema.Array(
		Schema.Struct({ key: Schema.String, priority: Schema.String })
	)
});
export type SchedulerGroup = Schema.Schema.Type<typeof SchedulerGroup>;

export const SchedulerModel = Schema.Struct({
	key: Schema.String,
	health: Schema.String,
	consecutiveFailures: Schema.Number,
	probeInFlight: Schema.Boolean,
	nextProbeAt: Schema.Number,
	lastFailure: Schema.NullOr(
		Schema.Struct({
			ts: Schema.Number,
			status: Schema.optional(Schema.Number),
			class: Schema.String
		})
	),
	waiters: Schema.Number,
	// Config annotations (spec MODEL-FALLBACK section 8): the LOGICAL id(s) that
	// resolve to this health key + whether any carries a fallback chain (its probe
	// is the canary). Defaulted for snapshots served without the annotation map.
	logicalIds: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
	hasFallback: Schema.optionalWith(Schema.Boolean, { default: () => false })
});
export type SchedulerModel = Schema.Schema.Type<typeof SchedulerModel>;

export const SchedulerSnapshot = Schema.Struct({
	groups: Schema.Array(SchedulerGroup),
	models: Schema.Array(SchedulerModel)
});
export type SchedulerSnapshot = Schema.Schema.Type<typeof SchedulerSnapshot>;

/**
 * One room's startup gap-backfetch status (GET /api/gap-backfetch; ARCHITECTURE.md
 * §7c §11). `phase` walks frozen → filling → committing → done (or failed); the
 * buffered counts show how much history is staged before the oldest-first commit,
 * and `cappedHole` (when present) marks a permanent hole left below the oldest
 * committed gap message under an operator-set cap/window/timeout. `cappedHole.reason`
 * is the descent's stop reason (issue #6) — `count`/`window`/`timeout` for an
 * operator opt-in, or `utd_halt` for a floor-undefined UTD wall — so the operator
 * can tell *why* the hole was left. Optional/back-compatible: absent on a backend
 * that predates the field.
 */
export const GapBackfetchRoom = Schema.Struct({
	accountId: Schema.String,
	roomId: Schema.String,
	baseTimelineKey: Schema.String,
	phase: Schema.String,
	backfillBuffered: Schema.Number,
	liveBuffered: Schema.Number,
	committed: Schema.Number,
	cappedHole: Schema.optional(
		Schema.Struct({
			fromTimestamp: Schema.Number,
			toTimestamp: Schema.Number,
			reason: Schema.optional(Schema.String)
		})
	)
});
export type GapBackfetchRoom = Schema.Schema.Type<typeof GapBackfetchRoom>;

export const GapBackfetchSnapshot = Schema.Array(GapBackfetchRoom);
export type GapBackfetchSnapshot = Schema.Schema.Type<typeof GapBackfetchSnapshot>;

/**
 * One message-only history backfetch job (ARCHITECTURE.md §7d; spec
 * MESSAGE-BACKFETCH §8.1). Persistent + resumable — `cursorToken` is the backward
 * continuation it resumes from; `floorEventId` the context floor it pinned.
 */
export const BackfetchJob = Schema.Struct({
	id: Schema.String,
	roomId: Schema.String,
	accountId: Schema.String,
	timelineKey: Schema.String,
	targetKind: Schema.String,
	targetValue: Schema.NullOr(Schema.String),
	captionAfter: Schema.Boolean,
	status: Schema.String,
	cursorToken: Schema.NullOr(Schema.String),
	oldestReachedEventId: Schema.NullOr(Schema.String),
	oldestReachedTs: Schema.NullOr(Schema.Number),
	fetched: Schema.Number,
	stored: Schema.Number,
	stopReason: Schema.NullOr(Schema.String),
	floorEventId: Schema.NullOr(Schema.String),
	safetyCap: Schema.Number,
	timeoutMs: Schema.Number,
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number
});
export type BackfetchJob = Schema.Schema.Type<typeof BackfetchJob>;

export const BackfetchJobsResponse = Schema.Struct({
	jobs: Schema.Array(BackfetchJob),
	enabled: Schema.Boolean
});
export type BackfetchJobsResponse = Schema.Schema.Type<typeof BackfetchJobsResponse>;

export const StartBackfetchResponse = Schema.Struct({ job: BackfetchJob });
export type StartBackfetchResponse = Schema.Schema.Type<typeof StartBackfetchResponse>;

export const BackfetchActionResponse = Schema.Struct({ ok: Schema.Boolean });
export type BackfetchActionResponse = Schema.Schema.Type<typeof BackfetchActionResponse>;

export const PromoteCaptionsResponse = Schema.Struct({ promoted: Schema.Number });
export type PromoteCaptionsResponse = Schema.Schema.Type<typeof PromoteCaptionsResponse>;

/** One settled Layer-0 attempt (GET /api/llm-requests, newest-first). */
export const LlmRequestRecord = Schema.Struct({
	ts: Schema.Number,
	sessionId: Schema.optional(Schema.String),
	sessionType: Schema.optional(Schema.String),
	group: Schema.optional(Schema.String),
	model: Schema.String,
	priority: Schema.optional(Schema.String),
	attempt: Schema.Number,
	admissionWaitMs: Schema.optional(Schema.Number),
	durationMs: Schema.Number,
	outcome: Schema.String,
	status: Schema.optional(Schema.Number),
	class: Schema.optional(Schema.String),
	errorMessage: Schema.optional(Schema.String),
	// Usage of the committed response (spec TOKEN-USAGE-TRACKING §3.2): present on
	// `done` rows only; absent on error/aborted.
	usage: Schema.optional(
		Schema.Struct({
			input: Schema.Number,
			output: Schema.Number,
			cacheRead: Schema.Number,
			cacheWrite: Schema.Number,
			totalTokens: Schema.Number,
			cost: Schema.Number
		})
	)
});
export type LlmRequestRecord = Schema.Schema.Type<typeof LlmRequestRecord>;

export const LlmRequestsResponse = Schema.Struct({
	requests: Schema.Array(LlmRequestRecord)
});
export type LlmRequestsResponse = Schema.Schema.Type<typeof LlmRequestsResponse>;

/**
 * GET /api/cost-overview — global spend across the three lanes (spec
 * AUXILIARY-USAGE-TRACKING §10.4): kept side-by-side, never summed into one
 * headline (§9). All USD.
 */
export const CostOverview = Schema.Struct({
	agentLoopCost: Schema.Number,
	toolCost: Schema.Number,
	captioningCost: Schema.Number
});
export type CostOverview = Schema.Schema.Type<typeof CostOverview>;

// ===========================================================================
// Usage & Cost page (spec USAGE-COST-LIMITS §7). Wire shapes for the unified
// `usage_events` ledger views + the BudgetEngine rule statuses. All USD.
// ===========================================================================

/** GET /api/usage/summary — totals by class + by model over a window (§7.1 cards). */
export const UsageSummary = Schema.Struct({
	since: Schema.Number,
	// `now` (server clock) + `firstTs` (earliest event in window, null when empty) let the
	// card average spend over the *actual* elapsed data range, not the nominal window width.
	now: Schema.Number,
	firstTs: Schema.NullOr(Schema.Number),
	total: Schema.Number,
	byClass: Schema.Array(
		Schema.Struct({ class: Schema.String, cost: Schema.Number, events: Schema.Number })
	),
	byModel: Schema.Array(
		Schema.Struct({ model: Schema.String, cost: Schema.Number, events: Schema.Number })
	)
});
export type UsageSummary = Schema.Schema.Type<typeof UsageSummary>;

/** GET /api/usage/timeseries — stacked spend-over-time (§7.1 chart). */
export const UsageTimeseries = Schema.Struct({
	series: Schema.Array(
		Schema.Struct({ bucket: Schema.Number, grp: Schema.String, cost: Schema.Number })
	),
	bucketMs: Schema.Number,
	groupBy: Schema.String
});
export type UsageTimeseries = Schema.Schema.Type<typeof UsageTimeseries>;

/** One recent-sessions row (§7.1 table 5). */
export const UsageSessionRow = Schema.Struct({
	sessionId: Schema.String,
	modelId: Schema.NullOr(Schema.String),
	sessionType: Schema.String,
	timelineKey: Schema.String,
	// Human room label (`Name (Space)`) from room_metadata, falling back to the raw key.
	channelLabel: Schema.String,
	triggerSender: Schema.NullOr(Schema.String),
	status: Schema.String,
	completedAt: Schema.NullOr(Schema.Number),
	requests: Schema.Number,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	cacheWriteTokens: Schema.Number,
	agentCost: Schema.Number,
	toolCost: Schema.Number,
	toolCalls: Schema.Number
});
export const UsageSessions = Schema.Struct({ sessions: Schema.Array(UsageSessionRow) });
export type UsageSessions = Schema.Schema.Type<typeof UsageSessions>;

/** One recent paid-event row — tool/caption/embedding (§7.1 table 6). */
export const UsageEventRow = Schema.Struct({
	id: Schema.String,
	ts: Schema.Number,
	class: Schema.String,
	agent_session_id: Schema.NullOr(Schema.String),
	session_type: Schema.NullOr(Schema.String),
	timeline_key: Schema.NullOr(Schema.String),
	trigger_sender_id: Schema.NullOr(Schema.String),
	tool_name: Schema.NullOr(Schema.String),
	model_id: Schema.String,
	provider: Schema.NullOr(Schema.String),
	input_tokens: Schema.NullOr(Schema.Number),
	output_tokens: Schema.NullOr(Schema.Number),
	cache_read_tokens: Schema.NullOr(Schema.Number),
	cache_write_tokens: Schema.NullOr(Schema.Number),
	images: Schema.NullOr(Schema.Number),
	cost_usd: Schema.Number,
	ref: Schema.NullOr(Schema.String),
	// Human room label (`Name (Space)`) from room_metadata, else the raw key; null only
	// when the event has no timeline_key (background caption/embedding).
	channel_label: Schema.NullOr(Schema.String)
});
export const UsageToolCalls = Schema.Struct({ toolCalls: Schema.Array(UsageEventRow) });
export type UsageToolCalls = Schema.Schema.Type<typeof UsageToolCalls>;

/** One configured-rule status (§6.2 / §7.1 #3). Window/scope kept loose to decode both kinds. */
export const RuleStatus = Schema.Struct({
	name: Schema.String,
	spentUsd: Schema.Number,
	capUsd: Schema.Number,
	fraction: Schema.Number,
	state: Schema.String,
	window: Schema.Struct({
		type: Schema.String,
		period: Schema.optional(Schema.String),
		duration: Schema.optional(Schema.String),
		tz: Schema.optional(Schema.String)
	}),
	resetsAt: Schema.Number,
	scope: Schema.Struct({
		classes: Schema.optional(Schema.Array(Schema.String)),
		sessionTypes: Schema.optional(Schema.Array(Schema.String)),
		tools: Schema.optional(Schema.Array(Schema.String)),
		models: Schema.optional(Schema.Array(Schema.String)),
		// Resolved "provider:accountKey" prefixes when the rule has an agent/account
		// matcher (spec CONSOLE-MULTI-AGENT §5 / MULTI-AGENT-SUPPORT §8). Optional for
		// backward compatibility with older backends and non-scoped rules.
		timelineKeyPrefixes: Schema.optional(Schema.Array(Schema.String))
	}),
	// Per-model spend for a multi-model rule (§14) — lets the console segment the bar as a
	// composite. Optional/back-compat: absent for single-model rules and older BFFs.
	components: Schema.optional(
		Schema.Array(Schema.Struct({ model: Schema.String, spentUsd: Schema.Number }))
	)
});
export type RuleStatus = Schema.Schema.Type<typeof RuleStatus>;

/** One per-user / shared-pool meter status (spec PER-USER-LIMITS §14). */
export const UserLimitStatus = Schema.Struct({
	meterKey: Schema.String,
	partitionKey: Schema.String,
	isUserPartition: Schema.Boolean,
	// Human label for a USER partition (BFF-resolved): the sender's display name and —
	// Discord only — unique username. Optional for backward compatibility with an older
	// BFF that omits them (falls back to the raw partitionKey); absent on shared pools.
	displayName: Schema.optional(Schema.NullOr(Schema.String)),
	username: Schema.optional(Schema.NullOr(Schema.String)),
	modelScope: Schema.optional(Schema.Array(Schema.String)),
	// Optional for backward compatibility with an older BFF that omits it (falls back
	// to fill-fraction ordering); the ladder order (config constraint index).
	orderIndex: Schema.optional(Schema.Number),
	spentUsd: Schema.Number,
	capUsd: Schema.Number,
	fraction: Schema.Number,
	state: Schema.String,
	window: Schema.Struct({
		type: Schema.String,
		period: Schema.optional(Schema.String),
		duration: Schema.optional(Schema.String),
		tz: Schema.optional(Schema.String)
	}),
	resetsAt: Schema.Number
});
export type UserLimitStatus = Schema.Schema.Type<typeof UserLimitStatus>;

/** A live per-user session's currently-selected model (spec PER-USER-LIMITS §14). */
export const UserLimitSelection = Schema.Struct({
	// Optional for backward compatibility with an older BFF that omits it; the
	// `{#each}` key falls back when absent.
	sessionId: Schema.optional(Schema.String),
	userId: Schema.String,
	// Human label (BFF-resolved, same shape as UserLimitStatus): display name plus —
	// Discord only — the unique username. Optional for an older BFF that omits them.
	displayName: Schema.optional(Schema.NullOr(Schema.String)),
	username: Schema.optional(Schema.NullOr(Schema.String)),
	roomId: Schema.optional(Schema.String),
	model: Schema.String
});
export type UserLimitSelection = Schema.Schema.Type<typeof UserLimitSelection>;
export const UsageBudgets = Schema.Struct({
	rules: Schema.Array(RuleStatus),
	// Optional for backward compatibility with an older BFF that omits them. `userLimits`
	// (the unbounded per-user meters) moved to the paginated `/api/usage/user-limits`;
	// it is no longer sent here but stays optional so an older BFF still decodes.
	userLimits: Schema.optional(Schema.Array(UserLimitStatus)),
	userSelections: Schema.optional(Schema.Array(UserLimitSelection))
});
export type UsageBudgets = Schema.Schema.Type<typeof UsageBudgets>;

/**
 * One page of per-user / shared-pool meters (spec PER-USER-LIMITS §14). The BFF groups
 * meters by partition and sorts hottest-first, then returns the requested scope's page
 * (all meters for the page's partitions) + both scope group counts for the tab badges.
 */
export const UserLimitsPage = Schema.Struct({
	scope: Schema.String, // "individuals" | "shared"
	page: Schema.Number,
	pageSize: Schema.Number,
	meters: Schema.Array(UserLimitStatus),
	totals: Schema.Struct({
		individuals: Schema.Number,
		shared: Schema.Number
	})
});
export type UserLimitsPage = Schema.Schema.Type<typeof UserLimitsPage>;

/** One per-bucket point feeding a leaderboard user's sub-period averages (§7.1 leaderboard). */
export const UsageLeaderboardSeriesPoint = Schema.Struct({
	bucket: Schema.Number,
	cost: Schema.Number
});

/**
 * One leaderboard entry — the per-actor equivalent of the Total-spend card (§7.1
 * leaderboard). `kind:'user'` rows are humans with a contiguous `rank`; `kind:'system'`
 * rows are non-human/self actors (Summarization/Diary/Proactive) with a `comparisonRank`
 * (where they would place among users). `senderId` is the matrix id for users, the actor
 * label for system actors.
 */
export const UsageLeaderboardUser = Schema.Struct({
	senderId: Schema.String,
	displayName: Schema.NullOr(Schema.String),
	kind: Schema.String,
	rank: Schema.optional(Schema.Number),
	comparisonRank: Schema.optional(Schema.Number),
	total: Schema.Number,
	events: Schema.Number,
	sessions: Schema.Number,
	firstTs: Schema.Number,
	lastTs: Schema.Number,
	series: Schema.Array(UsageLeaderboardSeriesPoint)
});

/** Reference stats over the non-zero human users in the window (System & self cards). */
export const UsageLeaderboardUserStats = Schema.Struct({
	count: Schema.Number,
	average: Schema.Number,
	median: Schema.Number
});

/** GET /api/usage/leaderboard — humans-only ranking + a separate System & self block. */
export const UsageLeaderboard = Schema.Struct({
	now: Schema.Number,
	bucketMs: Schema.Number,
	// Grand total over EVERY event in the window (incl. non-attributable) — the share
	// denominator, so per-actor shares sum to ≤ 100%.
	grandTotal: Schema.Number,
	userStats: UsageLeaderboardUserStats,
	users: Schema.Array(UsageLeaderboardUser),
	systemActors: Schema.Array(UsageLeaderboardUser)
});
export type UsageLeaderboard = Schema.Schema.Type<typeof UsageLeaderboard>;
