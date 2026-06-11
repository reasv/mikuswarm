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
	preview: Schema.optional(Schema.Boolean)
});
export type ContextMessageWire = Schema.Schema.Type<typeof ContextMessageWire>;

/** GET /api/rooms */
export const Room = Schema.Struct({
	timelineKey: Schema.String,
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
	tokenEstimate: Schema.NullOr(Schema.Number),
	noReply: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	startedAt: Schema.NullOr(Schema.Number),
	updatedAt: Schema.Number,
	completedAt: Schema.NullOr(Schema.Number)
});
export type SessionMeta = Schema.Schema.Type<typeof SessionMeta>;
export const SessionsResponse = Schema.Struct({ sessions: Schema.Array(SessionMeta) });

/** GET /api/sessions/:id — transcript/snapshot elements kept permissive. */
export const SessionDetailResponse = Schema.Struct({
	session: SessionMeta,
	contextSnapshot: Schema.Array(ContextMessageWire),
	transcript: Schema.Array(PassthroughObject),
	rolloutStartIndex: Schema.Number,
	contextDumpPath: Schema.NullOr(Schema.String)
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
	skipped: Schema.Number
});
export type PipelineCounts = Schema.Schema.Type<typeof PipelineCounts>;

/** One pool's dashboard row (GET /api/pipelines). */
export const PipelineHealth = Schema.Struct({
	pool: PipelineId,
	enabled: Schema.Boolean,
	workerCount: Schema.Number,
	maxRetries: Schema.Number,
	inFlight: Schema.Number,
	counts: PipelineCounts
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
	hasBytes: Schema.Boolean
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
	waiters: Schema.Number
});
export type SchedulerModel = Schema.Schema.Type<typeof SchedulerModel>;

export const SchedulerSnapshot = Schema.Struct({
	groups: Schema.Array(SchedulerGroup),
	models: Schema.Array(SchedulerModel)
});
export type SchedulerSnapshot = Schema.Schema.Type<typeof SchedulerSnapshot>;

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
	errorMessage: Schema.optional(Schema.String)
});
export type LlmRequestRecord = Schema.Schema.Type<typeof LlmRequestRecord>;

export const LlmRequestsResponse = Schema.Struct({
	requests: Schema.Array(LlmRequestRecord)
});
export type LlmRequestsResponse = Schema.Schema.Type<typeof LlmRequestsResponse>;
