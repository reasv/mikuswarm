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
