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

/** Session-list chip counters (refusal-detail.ts `getSessionCheckChips`). */
export const SessionCheckChips = Schema.Struct({
	refused: Schema.Number,
	redone: Schema.Number,
	nudged: Schema.Number,
	revised: Schema.Number,
	unjudged: Schema.Number
});
export type SessionCheckChips = Schema.Schema.Type<typeof SessionCheckChips>;

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
	// Session-list chips (spec REFUSAL-HANDLING §12.2): refusal events, redos,
	// nudges, revised and unjudged judged calls. null = nothing to show; optional
	// so a pre-feature backend still decodes.
	checkChips: Schema.optional(Schema.NullOr(SessionCheckChips)),
	// Redos from scratch after a late input (an edited trigger, a late addition;
	// ARCHITECTURE.md §8 "Late input"). Optional so a pre-feature backend decodes.
	redoCount: Schema.optional(Schema.NullOr(Schema.Number)),
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
  metadata: Schema.optional(Schema.Struct({
    requestId: Schema.optional(Schema.String), mode: Schema.optional(Schema.String),
    costProvenance: Schema.optional(Schema.String), estimateVersion: Schema.optional(Schema.String),
    latencyMs: Schema.optional(Schema.Number), reportedCost: Schema.NullOr(Schema.Number),
    jobId: Schema.optional(Schema.String), state: Schema.optional(Schema.String), stopReason: Schema.optional(Schema.String)
  })),
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

// ── Refusal handling in the session view (spec REFUSAL-HANDLING §9, §12.1–§12.2;
// src/observability/server/refusal-detail.ts) ────────────────────────────────

/**
 * The message whose arrival caused a late-input branch (`cause_event_id`, resolved
 * server-side): sender, CURRENT body (edits are stored in place) and the last edit time.
 */
export const BranchCause = Schema.Struct({
	eventId: Schema.String,
	senderId: Schema.String,
	senderName: Schema.NullOr(Schema.String),
	body: Schema.String,
	timestamp: Schema.Number,
	editedAt: Schema.NullOr(Schema.Number)
});
export type BranchCause = Schema.Schema.Type<typeof BranchCause>;

/**
 * One discarded span (`agent_session_branches`). `forkIndex` is the index in the
 * live message list at fork time; `messages` the span (a sibling-edit fork's
 * first message is the ORIGINAL assistant message). Branch 0 is the live transcript.
 * An edit/addition redo forks at 0: its span is the whole old rollout, kickoff included.
 */
export const SessionBranch = Schema.Struct({
	branchNo: Schema.Number,
	parentBranchNo: Schema.Number,
	forkIndex: Schema.Number,
	/** refusal_redo | contract_redo | edit_redo | addition_redo | revival | turn_aborted */
	reason: Schema.String,
	checkCode: Schema.NullOr(Schema.String),
	decisionEvaluationId: Schema.NullOr(Schema.Number),
	fromModel: Schema.NullOr(Schema.String),
	toModel: Schema.NullOr(Schema.String),
	messages: Schema.Array(PassthroughObject),
	costUsd: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	// Late input (ARCHITECTURE.md §8): the causing message; optional for older backends.
	causeEventId: Schema.optional(Schema.NullOr(Schema.String)),
	cause: Schema.optional(Schema.NullOr(BranchCause))
});
export type SessionBranch = Schema.Schema.Type<typeof SessionBranch>;

/**
 * One interjection delivered into the session (`session_interjections`). `kind`:
 * reply | co-reply | follow-up | edit | revival | addition (open-ended string).
 */
export const SessionInterjection = Schema.Struct({
	eventId: Schema.NullOr(Schema.String),
	externalId: Schema.NullOr(Schema.String),
	senderId: Schema.NullOr(Schema.String),
	senderName: Schema.NullOr(Schema.String),
	kind: Schema.String,
	body: Schema.String,
	createdAt: Schema.Number
});
export type SessionInterjection = Schema.Schema.Type<typeof SessionInterjection>;

/** One detected refusal (`refusal_events`), hard (checkpoint `request`) or judged. */
export const RefusalEvent = Schema.Struct({
	id: Schema.Number,
	ts: Schema.Number,
	branchNo: Schema.Number,
	site: Schema.String,
	servedModel: Schema.NullOr(Schema.String),
	wireModel: Schema.NullOr(Schema.String),
	/** hard | soft */
	kind: Schema.String,
	checkCode: Schema.String,
	reason: Schema.String,
	subReason: Schema.NullOr(Schema.String),
	/** stop_reason | provider_category | pattern | judged */
	method: Schema.String,
	source: Schema.NullOr(Schema.String),
	probability: Schema.NullOr(Schema.Number),
	rawStopReason: Schema.NullOr(Schema.String),
	category: Schema.NullOr(Schema.String),
	explanation: Schema.NullOr(Schema.String),
	/** request | send | ending | artifact | rollout */
	checkpoint: Schema.String,
	ruleName: Schema.NullOr(Schema.String),
	/** fallover | redo | exhausted_* | failed | observed */
	outcome: Schema.String,
	toModel: Schema.NullOr(Schema.String),
	decisionEvaluationId: Schema.NullOr(Schema.Number)
});
export type RefusalEvent = Schema.Schema.Type<typeof RefusalEvent>;

/** One send-contract attempt (`contract_attempts`); `failureTypes` [] = a valid ending. */
export const ContractAttempt = Schema.Struct({
	branchNo: Schema.Number,
	redoNo: Schema.Number,
	attemptNo: Schema.Number,
	ts: Schema.NullOr(Schema.Number),
	servedModel: Schema.NullOr(Schema.String),
	wireModel: Schema.NullOr(Schema.String),
	/** original | not_sent | sent_not_final */
	variant: Schema.String,
	failureTypes: Schema.Array(Schema.String),
	primaryType: Schema.NullOr(Schema.String)
});
export type ContractAttempt = Schema.Schema.Type<typeof ContractAttempt>;

/** The session's send-contract record; `maxNudges` = the configured nudge budget. */
export const SessionContract = Schema.Struct({
	outcome: Schema.NullOr(Schema.String),
	nudges: Schema.NullOr(Schema.Number),
	maxNudges: Schema.NullOr(Schema.Number),
	attempts: Schema.Array(ContractAttempt)
});
export type SessionContract = Schema.Schema.Type<typeof SessionContract>;

/** A check named by the session's rows, as its agent's catalogue describes it. */
export const CheckInfo = Schema.Struct({
	code: Schema.String,
	kind: Schema.String,
	remedy: Schema.String,
	reason: Schema.NullOr(Schema.String),
	description: Schema.String
});
export type CheckInfo = Schema.Schema.Type<typeof CheckInfo>;

/**
 * One row of the offline audit (`session_audits`): `audit` = send_contract |
 * refusal, `status` = done | skipped | unauditable | failed, `verdict` = the
 * audit's parsed result (kept permissive; `$lib/checks` reads it).
 */
export const SessionAudit = Schema.Struct({
	audit: Schema.String,
	eventId: Schema.NullOr(Schema.String),
	status: Schema.String,
	verdict: Schema.Unknown,
	confidence: Schema.NullOr(Schema.Number),
	modelId: Schema.NullOr(Schema.String),
	costUsd: Schema.NullOr(Schema.Number),
	version: Schema.Number,
	createdAt: Schema.Number
});
export type SessionAudit = Schema.Schema.Type<typeof SessionAudit>;

/** GET /api/sessions/:id — transcript/snapshot elements kept permissive. */
export const SessionDetailResponse = Schema.Struct({
	session: SessionMeta,
	contextSnapshot: Schema.Array(ContextMessageWire),
	transcript: Schema.Array(PassthroughObject),
	rolloutStartIndex: Schema.Number,
	contextDumpPath: Schema.NullOr(Schema.String),
	// Auxiliary tool-use ledger rows for this session (spec §10.3); optional so a
	// pre-feature backend still decodes.
	toolInvocations: Schema.optional(Schema.Array(ToolInvocation)),
	// Model prompts the served members sent (one row per member/profile/text hash);
	// optional so a pre-feature backend still decodes.
	modelPrompts: Schema.optional(
		Schema.Array(
			Schema.Struct({
				member: Schema.String,
				profile: Schema.String,
				hash: Schema.NullOr(Schema.String),
				requests: Schema.Number
			})
		)
	),
	// Refusal handling (spec REFUSAL-HANDLING §9, §12); optional so a pre-feature
	// backend still decodes.
	branches: Schema.optional(Schema.Array(SessionBranch)),
	refusalEvents: Schema.optional(Schema.Array(RefusalEvent)),
	contract: Schema.optional(SessionContract),
	checks: Schema.optional(Schema.Array(CheckInfo)),
	audits: Schema.optional(Schema.Array(SessionAudit)),
	// The session's interjections with their kinds; optional for older backends.
	interjections: Schema.optional(Schema.Array(SessionInterjection))
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
	deferred: Schema.optionalWith(Schema.Number, { default: () => 0 }),
	// Diary-only: rows terminalized as `excluded` by channel visibility config
	// (ARCHITECTURE.md §9h). Terminal — not retryable. 0 on all other pools.
	// Optional so a pre-feature backend still decodes (defaults to 0).
	excluded: Schema.optionalWith(Schema.Number, { default: () => 0 })
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
	// Wire id of the REQUESTED (head) model — kept for backward compat.
	model: Schema.String,
	// Logical id (config block name) of the requested model (head or per-user
	// selected). Absent when the retry context is not wired (non-agent callers).
	requestedModel: Schema.optional(Schema.String),
	// Logical id (config block name) of the chain member that actually served
	// this attempt. Absent for never-dispatched attempts or non-agent callers.
	// When present and different from requestedModel, the attempt hit a fallback.
	servedModel: Schema.optional(Schema.String),
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
			cost: Schema.Number,
			estimated: Schema.optional(Schema.NullOr(Schema.Union(Schema.Boolean, Schema.Number)))
		})
	),
	// Output (maybe input) tokens estimated: the stream was aborted mid-way (late
	// input). Tolerated here or on `usage`; absent on older backends.
	estimated: Schema.optional(Schema.NullOr(Schema.Union(Schema.Boolean, Schema.Number)))
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
	),
	// Per-agent breakdown (spec CONSOLE-MULTI-AGENT §9): present only in agents mode.
	// `agent: null` is the residual bucket — spend with no timeline key (background
	// caption/embedding) or on accounts no longer in config; the rows sum to `total`.
	byAgent: Schema.optional(
		Schema.Array(
			Schema.Struct({
				agent: Schema.NullOr(Schema.String),
				cost: Schema.Number,
				events: Schema.Number
			})
		)
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
	channel_label: Schema.NullOr(Schema.String),
	// 1 when the row's tokens were estimated (an aborted stream); absent on older backends.
	estimated: Schema.optional(Schema.NullOr(Schema.Number))
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

// ===========================================================================
// Session records (spec SESSION-RECORDS §3, §8, CONTRACT.md). Tables
// `session_records` and `decision_evaluations` added in migration v24.
// Backends without them return empty/null, not errors (CONTRACT.md §Storage).
// ===========================================================================

/**
 * One row from `session_records` (spec §3.4, CONTRACT.md).
 * `buildsOn` is the JSON-decoded list of session ids injected into this session.
 */
export const SessionRecord = Schema.Struct({
	sessionId: Schema.String,
	timelineKey: Schema.String,
	agent: Schema.NullOr(Schema.String),
	text: Schema.String,
	tokenCount: Schema.Number,
	buildsOn: Schema.Array(Schema.String),
	modelId: Schema.NullOr(Schema.String),
	/** Epoch ms; replaced on a later resume generation. */
	createdAt: Schema.Number
});
export type SessionRecord = Schema.Schema.Type<typeof SessionRecord>;

/**
 * GET /api/sessions/:id/record — the session's own record (null if none or
 * tables absent). Always a 200; empty when the session did no tool work or the
 * record is still being written (in-flight).
 */
export const SessionRecordResponse = Schema.Struct({
	sessionRecord: Schema.NullOr(SessionRecord)
});
export type SessionRecordResponse = Schema.Schema.Type<typeof SessionRecordResponse>;

/**
 * One row from `decision_evaluations` (spec §8, CONTRACT.md §Storage).
 * Raw JSON columns (`verdictJson`, `answersJson`, `stateJson`, `questionsJson`)
 * are kept as strings and pretty-printed in the inspector.
 */
export const DecisionEvaluation = Schema.Struct({
	id: Schema.Number,
	ts: Schema.Number,
	decisionGroup: Schema.String,
	point: Schema.String,              // 'routing' | 'records' | 'memory' | 'checks' | 'audit'
	agent: Schema.NullOr(Schema.String),
	timelineKey: Schema.NullOr(Schema.String),
	agentSessionId: Schema.NullOr(Schema.String),
	triggerEventId: Schema.NullOr(Schema.String),
	candidateSessionId: Schema.NullOr(Schema.String),  // records point only
	source: Schema.String,             // 'model' | 'heuristic'
	reason: Schema.NullOr(Schema.String),
	verdictJson: Schema.NullOr(Schema.String),
	answersJson: Schema.NullOr(Schema.String),   // with probabilities
	stateJson: Schema.NullOr(Schema.String),     // capped 64 KiB
	questionsJson: Schema.NullOr(Schema.String), // capped 16 KiB
	servedModel: Schema.NullOr(Schema.String),
	servedVersion: Schema.NullOr(Schema.String),
	latencyMs: Schema.NullOr(Schema.Number),
	inputTokens: Schema.NullOr(Schema.Number),
	costUsd: Schema.NullOr(Schema.Number),
	// Check-gate anchor (spec REFUSAL-HANDLING §9), `checks` rows only; optional
	// so a pre-feature backend still decodes. `checkpoint`: send | ending |
	// artifact | rollout; `consequence`: sent | sent_unjudged | revise |
	// overridden | redo | observed | withheld.
	checkpoint: Schema.optional(Schema.NullOr(Schema.String)),
	branchNo: Schema.optional(Schema.NullOr(Schema.Number)),
	toolCallId: Schema.optional(Schema.NullOr(Schema.String)),
	attemptNo: Schema.optional(Schema.NullOr(Schema.Number)),
	consequence: Schema.optional(Schema.NullOr(Schema.String))
});
export type DecisionEvaluation = Schema.Schema.Type<typeof DecisionEvaluation>;

/**
 * GET /api/sessions/:id/decisions — all `decision_evaluations` rows for this
 * session, in `ts` order. Empty array when the table is absent or no decisions
 * were made. The console groups them by `decisionGroup` for the inline cards.
 */
export const SessionDecisionsResponse = Schema.Struct({
	evaluations: Schema.Array(DecisionEvaluation)
});
export type SessionDecisionsResponse = Schema.Schema.Type<typeof SessionDecisionsResponse>;

// ===========================================================================
// Memory retrieval (spec MEMORY-RETRIEVAL §7.4, §9; ARCHITECTURE.md §9d
// "Observability", §9c "Memory filters"). Rows of `memory_retrievals` and
// `memory_filter_hits` (schema v34), camelCased like the store's readers
// (src/storage/memory-retrieval-store.ts). An older backend without the tables
// or the routes degrades to empty in the query layer, never an error.
// ===========================================================================

/**
 * One `memory_retrievals` row: one auto-retrieval build. `reportJson` is the
 * pipeline's `RetrievalReport` (src/retrieval/auto/types.ts) kept as a string and
 * parsed defensively by `$lib/memory-retrieval`.
 */
export const MemoryRetrieval = Schema.Struct({
	id: Schema.String,
	agentSessionId: Schema.NullOr(Schema.String),
	agent: Schema.NullOr(Schema.String),
	timelineKey: Schema.NullOr(Schema.String),
	ts: Schema.Number,
	source: Schema.String, // 'model' | 'fallback' | 'unjudged' | 'none'
	decisionGroup: Schema.NullOr(Schema.String),
	candidates: Schema.Number,
	judged: Schema.Number,
	kept: Schema.Number,
	hidden: Schema.Number,
	tokens: Schema.Number,
	ms: Schema.Number,
	reportJson: Schema.NullOr(Schema.String),
	followUpAt: Schema.NullOr(Schema.Number),
	followUpKind: Schema.NullOr(Schema.String)
});
export type MemoryRetrieval = Schema.Schema.Type<typeof MemoryRetrieval>;

/** GET /api/sessions/:id/memory-retrievals — the session's builds in `ts` order. */
export const SessionMemoryRetrievalsResponse = Schema.Struct({
	retrievals: Schema.Array(MemoryRetrieval)
});
export type SessionMemoryRetrievalsResponse = Schema.Schema.Type<typeof SessionMemoryRetrievalsResponse>;

/** One `memory_filter_hits` row: a block a filter has hidden (the audit trail). */
export const MemoryFilterHit = Schema.Struct({
	agent: Schema.String, // '' = legacy single-agent mode
	contentHash: Schema.String,
	filterKey: Schema.String,
	filterHash: Schema.String,
	kind: Schema.String, // 'keyword' | 'pattern' | 'judged'
	detail: Schema.NullOr(Schema.String),
	probability: Schema.NullOr(Schema.Number),
	path: Schema.NullOr(Schema.String),
	startLine: Schema.NullOr(Schema.Number),
	endLine: Schema.NullOr(Schema.Number),
	surface: Schema.String,
	firstHiddenAt: Schema.Number,
	lastHiddenAt: Schema.Number,
	hideCount: Schema.Number
});
export type MemoryFilterHit = Schema.Schema.Type<typeof MemoryFilterHit>;

/** GET /api/memory/filter-hits?limit= — newest `lastHiddenAt` first. */
export const MemoryFilterHitsResponse = Schema.Struct({
	hits: Schema.Array(MemoryFilterHit)
});
export type MemoryFilterHitsResponse = Schema.Schema.Type<typeof MemoryFilterHitsResponse>;

/**
 * One window of GET /api/memory/stats. The follow-up figures are
 * `MemoryRetrievalStore.followUpStats(sinceTs)`: distinct sessions with a build
 * that kept something, and how many of them followed up. `builds` / `sources`
 * count every build row since `sinceTs` by its `source`.
 */
export const MemoryStatsWindow = Schema.Struct({
	days: Schema.Number,
	sinceTs: Schema.Number,
	sessionsWithBlock: Schema.Number,
	followedUp: Schema.Number,
	rate: Schema.NullOr(Schema.Number),
	builds: Schema.Number,
	sources: Schema.Record({ key: Schema.String, value: Schema.Number })
});
export type MemoryStatsWindow = Schema.Schema.Type<typeof MemoryStatsWindow>;

/** GET /api/memory/stats — the 7- and 30-day windows. */
export const MemoryStatsResponse = Schema.Struct({
	windows: Schema.Array(MemoryStatsWindow)
});
export type MemoryStatsResponse = Schema.Schema.Type<typeof MemoryStatsResponse>;

// ===========================================================================
// Model behaviour page (spec REFUSAL-HANDLING §12.3, §12.4). Wire shapes of
// GET /api/models/behaviour and /api/models/behaviour/incidents, mirroring
// src/behaviour/types.ts.
// ===========================================================================

/** A typed change event (config diff at boot, or an observed prompt change). */
export const BehaviourChangeEvent = Schema.Struct({
	id: Schema.Number,
	ts: Schema.Number,
	/** head_model_changed | chain_changed | preference_changed | thinking_changed | routing_task_changed | rule_changed | check_changed | code_changed | config_changed | prompt_changed */
	kind: Schema.String,
	sentence: Schema.String,
	path: Schema.NullOr(Schema.String),
	old: Schema.Unknown,
	new: Schema.Unknown,
	/** Touched agents / sites / models; [] = every one. */
	agents: Schema.Array(Schema.String),
	sites: Schema.Array(Schema.String),
	models: Schema.Array(Schema.String),
	/** prompt_changed: { prompt: 'system' | 'model', oldHash, newHash }. */
	detail: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
});
export type BehaviourChangeEvent = Schema.Schema.Type<typeof BehaviourChangeEvent>;

/** One chart marker: changes within a few minutes of each other (one deploy). */
export const BehaviourMarker = Schema.Struct({
	ts: Schema.Number,
	until: Schema.Number,
	kinds: Schema.Array(Schema.String),
	events: Schema.Array(BehaviourChangeEvent)
});
export type BehaviourMarker = Schema.Schema.Type<typeof BehaviourMarker>;

export const BehaviourRateCell = Schema.Struct({
	rate: Schema.NullOr(Schema.Number),
	count: Schema.Number,
	denominator: Schema.Number,
	previousRate: Schema.NullOr(Schema.Number),
	change: Schema.NullOr(Schema.Number),
	/** Denominator below the rate's minSample: render greyed. */
	lowSample: Schema.Boolean
});
export type BehaviourRateCell = Schema.Schema.Type<typeof BehaviourRateCell>;

export const BehaviourScorecardRow = Schema.Struct({
	group: Schema.String,
	members: Schema.Array(Schema.String),
	volume: Schema.Struct({ requests: Schema.Number, sessions: Schema.Number, messages: Schema.Number }),
	/** Keyed by headline rate id. */
	cells: Schema.Record({ key: Schema.String, value: BehaviourRateCell })
});
export type BehaviourScorecardRow = Schema.Schema.Type<typeof BehaviourScorecardRow>;

export const BehaviourRateDefinition = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	numerator: Schema.Array(Schema.String),
	denominator: Schema.String,
	scale: Schema.Number,
	minSample: Schema.Number
});
export type BehaviourRateDefinition = Schema.Schema.Type<typeof BehaviourRateDefinition>;

export const BehaviourSeriesPoint = Schema.Struct({
	bucket: Schema.Number,
	group: Schema.String,
	count: Schema.Number,
	denominator: Schema.Number,
	rate: Schema.NullOr(Schema.Number)
});
export type BehaviourSeriesPoint = Schema.Schema.Type<typeof BehaviourSeriesPoint>;

/** One headline rate over the window, all groups combined, with its buckets (the overview chart). */
export const BehaviourOverviewMetric = Schema.Struct({
	id: Schema.String,
	count: Schema.Number,
	denominator: Schema.Number,
	rate: Schema.NullOr(Schema.Number),
	points: Schema.Array(
		Schema.Struct({
			bucket: Schema.Number,
			count: Schema.Number,
			denominator: Schema.Number,
			rate: Schema.NullOr(Schema.Number)
		})
	)
});
export type BehaviourOverviewMetric = Schema.Schema.Type<typeof BehaviourOverviewMetric>;

/** A metric the chart can plot, with its total in the window (0 = nothing recorded). */
export const BehaviourChartOption = Schema.Struct({
	/** A headline rate id, or `mix:<family>` (one line per key). */
	id: Schema.String,
	label: Schema.String,
	/** rate | count */
	kind: Schema.String,
	count: Schema.Number,
	denominator: Schema.NullOr(Schema.Number)
});
export type BehaviourChartOption = Schema.Schema.Type<typeof BehaviourChartOption>;

/** A keyed family per scorecard group (failure types, after the correction, no_reply intent, judged refusal reasons). */
export const BehaviourMixTable = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	keys: Schema.Array(Schema.String),
	rows: Schema.Array(
		Schema.Struct({
			group: Schema.String,
			total: Schema.Number,
			counts: Schema.Record({ key: Schema.String, value: Schema.Number })
		})
	)
});
export type BehaviourMixTable = Schema.Schema.Type<typeof BehaviourMixTable>;

/** A config entry's wire model id and configured family. */
export const BehaviourModelInfo = Schema.Struct({
	id: Schema.NullOr(Schema.String),
	family: Schema.NullOr(Schema.String)
});
export type BehaviourModelInfo = Schema.Schema.Type<typeof BehaviourModelInfo>;

/** The offline audit's backlog, counted in the background (stages in processing order). */
export const AuditBacklogProgress = Schema.Struct({
	countedAt: Schema.Number,
	sessions: Schema.Number,
	prioritySessions: Schema.Number,
	stages: Schema.Array(
		Schema.Struct({ id: Schema.String, label: Schema.String, done: Schema.Number, remaining: Schema.Number })
	),
	current: Schema.NullOr(Schema.String)
});
export type AuditBacklogProgress = Schema.Schema.Type<typeof AuditBacklogProgress>;

const BehaviourCount = Schema.Struct({ key: Schema.String, count: Schema.Number });
const BehaviourCheckBreakdown = Schema.Struct({
	code: Schema.String,
	hits: Schema.Number,
	revisions: Schema.Number,
	overrides: Schema.Number
});

export const BehaviourBreakdown = Schema.Struct({
	refusals: Schema.Struct({
		hard: Schema.Number,
		judged: Schema.Number,
		redos: Schema.Number,
		byReason: Schema.Array(BehaviourCount),
		bySite: Schema.Array(BehaviourCount),
		byMethod: Schema.Array(BehaviourCount),
		outcomes: Schema.Array(BehaviourCount),
		discardedBranchCostUsd: Schema.Number
	}),
	contract: Schema.Struct({
		nudgedSessions: Schema.Number,
		failedAttempts: Schema.Number,
		/** keys "1", "2", "3" (3+), "after_redo", "gave_up", "exhausted". */
		untilRecovery: Schema.Array(BehaviourCount),
		failureTypes: Schema.Array(BehaviourCount),
		redos: Schema.Number,
		discardedBranchCostUsd: Schema.Number,
		afterCorrection: Schema.Array(BehaviourCount),
		noReplyIntent: Schema.Array(BehaviourCount)
	}),
	style: Schema.Struct({
		hits: Schema.Number,
		messagesWithHit: Schema.Number,
		revisions: Schema.Number,
		overrides: Schema.Number,
		perCheck: Schema.Array(BehaviourCheckBreakdown)
	}),
	checks: Schema.Array(BehaviourCheckBreakdown)
});
export type BehaviourBreakdown = Schema.Schema.Type<typeof BehaviourBreakdown>;

export const BehaviourIncidentRow = Schema.Struct({
	sessionId: Schema.String,
	ts: Schema.Number,
	agent: Schema.NullOr(Schema.String),
	timelineKey: Schema.String,
	roomLabel: Schema.String,
	site: Schema.String,
	models: Schema.Array(Schema.String),
	/** refusal | nudge | redo | revision | ending */
	types: Schema.Array(Schema.String),
	chips: Schema.Struct({
		refused: Schema.Number,
		redone: Schema.Number,
		nudged: Schema.Number,
		revised: Schema.Number,
		overridden: Schema.Number,
		endings: Schema.Number
	}),
	outcome: Schema.String,
	link: Schema.Struct({
		sessionId: Schema.String,
		branchNo: Schema.Number,
		toolCallId: Schema.NullOr(Schema.String),
		attemptNo: Schema.NullOr(Schema.Number)
	})
});
export type BehaviourIncidentRow = Schema.Schema.Type<typeof BehaviourIncidentRow>;

/** GET /api/models/behaviour/incidents — one page; pass `nextCursor` back as `cursor`. */
export const BehaviourIncidentPage = Schema.Struct({
	rows: Schema.Array(BehaviourIncidentRow),
	nextCursor: Schema.NullOr(Schema.String)
});
export type BehaviourIncidentPage = Schema.Schema.Type<typeof BehaviourIncidentPage>;

/** GET /api/models/behaviour — the whole page under one set of URL filters. */
export const ModelBehaviourResponse = Schema.Struct({
	window: Schema.String,
	since: Schema.Number,
	until: Schema.Number,
	groupBy: Schema.String,
	family: Schema.Boolean,
	filters: Schema.Struct({
		agent: Schema.NullOr(Schema.String),
		site: Schema.NullOr(Schema.String),
		task: Schema.NullOr(Schema.String),
		selected: Schema.NullOr(Schema.String)
	}),
	/** A headline rate id, `mix:<family>`, or null for the overview. */
	metric: Schema.NullOr(Schema.String),
	rates: Schema.Array(BehaviourRateDefinition),
	/** Every plottable metric with its total in the window. */
	charts: Schema.optional(Schema.Array(BehaviourChartOption)),
	scorecard: Schema.Array(BehaviourScorecardRow),
	/** Every headline rate over time, all groups combined (the default chart). */
	overview: Schema.optional(Schema.Struct({ bucketMs: Schema.Number, metrics: Schema.Array(BehaviourOverviewMetric) })),
	series: Schema.Struct({
		metric: Schema.NullOr(Schema.String),
		/** rate (one line per group) | count (a family: one line per key, `group` = the key) */
		kind: Schema.optional(Schema.String),
		bucketMs: Schema.Number,
		points: Schema.Array(BehaviourSeriesPoint)
	}),
	breakdown: BehaviourBreakdown,
	mix: Schema.optional(Schema.Array(BehaviourMixTable)),
	/** Wire id and configured family of each config entry shown. */
	models: Schema.optional(Schema.Record({ key: Schema.String, value: BehaviourModelInfo })),
	markers: Schema.Array(BehaviourMarker),
	incidents: BehaviourIncidentPage,
	facets: Schema.Struct({
		agents: Schema.Array(Schema.String),
		sites: Schema.Array(Schema.String),
		models: Schema.Array(Schema.String),
		tasks: Schema.Array(Schema.String)
	}),
	pendingHours: Schema.Number,
	/** The offline audit's backlog progress; null when the audit worker does not run. */
	audit: Schema.optional(Schema.NullOr(AuditBacklogProgress))
});
export type ModelBehaviourResponse = Schema.Schema.Type<typeof ModelBehaviourResponse>;
