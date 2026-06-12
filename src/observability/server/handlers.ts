import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ContextMessage } from "../../context/builder.js";
import { externalizeImages } from "../../agent/session-capture.js";
import { isFinalTurnMessage } from "../../agent/factory.js";
import type { AgentSessionRow } from "../../storage/index.js";
import { sendJson, sendError } from "./responses.js";
import { openSse } from "./sse.js";
import type { RequestContext } from "./types.js";

/** GET /api/rooms — timelines, reverse-chron by last activity (spec §8). */
export function listRooms(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const rooms = ctx.deps.storage.listConsoleRooms().map((row) => ({
    timelineKey: row.timeline_key,
    displayName: row.display_name,
    timelineState: row.timeline_state,
    lastActivityAt: row.last_activity_at,
    eventCount: row.event_count,
    sessionCount: row.session_count,
  }));
  sendJson(res, 200, { rooms });
}

/**
 * GET /api/rooms/:key/context — the live, real `ContextBuilder.build()` for the
 * room in preview mode (spec §9). Everything through the rich tier is current;
 * the trigger-dependent final user turn is flagged `preview: true` (synthetic
 * trigger). Image blocks are externalized to refs — no base64 over the wire.
 */
export async function roomContext(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const { built, syntheticTriggerEventId, finalTurnIndex, cacheBoundaries } =
    await ctx.deps.factory.buildPreview(ctx.params.key);
  const messages = built.messages.map((msg, i) => ({
    ...renderContextMessage(msg),
    preview: finalTurnIndex >= 0 && i >= finalTurnIndex,
  }));
  sendJson(res, 200, {
    timelineKey: ctx.params.key,
    preview: true,
    syntheticTriggerEventId,
    messages,
    tokenEstimate: built.tokenEstimate,
    compactTokens: built.compactTokens,
    richTokens: built.richTokens,
    cacheBoundaries,
  });
}

/** GET /api/rooms/:key/sessions — sessions for a timeline, reverse-chron (spec §8). */
export function roomSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const sessions = ctx.deps.storage
    .getAgentSessionsByTimeline(ctx.params.key)
    .map(sessionMeta);
  sendJson(res, 200, { sessions });
}

/**
 * GET /api/sessions/:id — the session record + frozen input context (snapshot)
 * + persisted transcript (rollout) (spec §8, §10). The snapshot prefix and the
 * transcript head (final user turn) together are the verbatim input view; the
 * rest of the transcript is the rollout. Both are stored already redacted and
 * with images externalized.
 *
 * `rolloutStartIndex` marks where the rollout begins inside `transcript`: the
 * index of the first message that is NOT a head final-user-turn
 * (`triggerGroup`/`satellite`) message. The verbatim input view (§10a) renders
 * the snapshot prefix plus `transcript[0..rolloutStartIndex)`; the rollout
 * renderer (§10b) begins at `rolloutStartIndex` (the first assistant turn). This
 * is explicit so the client never heuristically guesses the first assistant
 * message (interjection / forced-completion user turns can legitimately appear
 * later in the rollout). Edge cases: empty transcript → 0; a transcript with no
 * head final turn → 0; an all-final-turn transcript → transcript length.
 *
 * `contextDumpPath` surfaces the on-disk dump path for snapshot/dump parity
 * debugging (issue #9); it is deliberately NOT included in the list/meta shape.
 */
export function sessionDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const row = ctx.deps.storage.getAgentSession(ctx.params.id);
  if (!row) return sendError(res, 404, `Unknown session: ${ctx.params.id}`);
  const transcript = parseJsonArray(row.transcript_json);
  sendJson(res, 200, {
    session: sessionMeta(row),
    // Normalize to the same wire shape as the room-context endpoint: the
    // persisted snapshot is raw ContextMessage JSON whose optional keys
    // (timestamp/tier/imageBlocks) were dropped by serialization, but the
    // console decodes both endpoints through one strict ContextMessageWire
    // schema (present-or-null fields, refs under `imageRefs`).
    contextSnapshot: parseJsonArray(row.context_snapshot_json).map((msg) =>
      renderContextMessage(msg as PersistedContextMessage),
    ),
    transcript,
    rolloutStartIndex: rolloutStartIndex(transcript),
    contextDumpPath: row.context_dump_path,
  });
}

/**
 * Index of the first rollout message in a persisted transcript: skip the leading
 * run of head final-user-turn messages (`triggerGroup`/`satellite`), reusing the
 * factory's {@link isFinalTurnMessage} predicate so the classification cannot
 * drift from the prefix/turn split (§3 / §10). Returns `transcript.length` when
 * every message is a head final turn, and `0` when there is none at the head.
 */
function rolloutStartIndex(transcript: unknown[]): number {
  let i = 0;
  while (i < transcript.length && isFinalTurnMessage(transcript[i] as { type?: string })) {
    i++;
  }
  return i;
}

/**
 * GET /api/scheduler — point-in-time scheduler snapshot (spec
 * LLM-FAILURE-HANDLING §9.1): per-group budget state (active/queued waiters
 * with attribution, throttle backoff, sticky escalations) beside per-model
 * health (streak, probe countdown, waiter counts). The "who is waiting on
 * what, and which model is down" screen for a starvation/outage event.
 * Polling is sufficient; SSE optional later.
 */
export function schedulerSnapshot(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const scheduler = ctx.deps.scheduler;
  if (!scheduler) return sendError(res, 503, "scheduler not wired");
  sendJson(res, 200, scheduler.snapshot());
}

/**
 * GET /api/llm-requests — the in-memory Layer-0 attempt ring (spec §9.2),
 * newest-first. Deliberately not durable: llm-gateway holds the authoritative
 * wire log; this adds session/priority attribution, admission wait, attempt
 * numbering, and failures that never reached the wire.
 */
export function llmRequests(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const ring = ctx.deps.llmRequestRing;
  if (!ring) return sendError(res, 503, "llm request ring not wired");
  sendJson(res, 200, { requests: ring.list() });
}

/**
 * GET /api/sessions/:id/stream — SSE of live `AgentEvent`s for a running session
 * (spec §8). If the session isn't live (terminal/evicted), emit one `not_live`
 * event and close; the console then renders from `GET /api/sessions/:id`.
 */
export function sessionStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const id = ctx.params.id;
  const row = ctx.deps.storage.getAgentSession(id);
  if (!row) return sendError(res, 404, `Unknown session: ${id}`);

  const agent = ctx.deps.sessions.getAgent(id);
  const stream = openSse(req, res);

  if (!agent) {
    stream.send("not_live", { sessionId: id, status: row.status });
    stream.close();
    return;
  }

  // Forward every AgentEvent verbatim (redacted + images externalized by the SSE
  // layer). Close on agent_end — the persisted transcript is then authoritative.
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (stream.closed) return;
    stream.send(event.type, event);
    if (event.type === "agent_end") stream.close();
  });
  stream.onClose(unsubscribe);

  // Tentative-token merge (spec LLM-FAILURE-HANDLING §4.2): Layer-0 buffers
  // attempts to the terminal event, so live tokens only exist on the tap bus.
  // Forwarded under their own event kinds (`tentative_event` /
  // `attempt_discarded`) so the client can render-then-clear partials without
  // ever confusing them with authoritative agent events. Same redaction/
  // externalization path as everything else (the SSE layer owns it).
  if (ctx.deps.liveEvents) {
    const unsubscribeLive = ctx.deps.liveEvents.subscribe(id, (event) => {
      if (stream.closed) return;
      stream.send(event.type, event);
    });
    stream.onClose(unsubscribeLive);
  }

  // Late-subscribe race: `Agent.subscribe` only delivers FUTURE events and does
  // not replay the terminal `agent_end`. The agent is evicted from the map only
  // AFTER its run settles, so `getAgent(id)` can return an agent whose run has
  // already ended — we'd then forward nothing and never close, leaking the SSE.
  // Subscribe FIRST (above) so an `agent_end` firing between this check and the
  // subscribe isn't lost, THEN re-check liveness: if the run already settled,
  // synthesize a terminal `not_live` event and close so the client falls back to
  // the persisted record.
  if (!stream.closed && !ctx.deps.sessions.isAgentLive(id)) {
    stream.send("not_live", { sessionId: id, status: row.status });
    stream.close();
  }
}

/**
 * POST /api/sessions/:id/abort — operator Stop button (spec §13). Aborts the
 * in-flight run and marks the session `interrupted` via
 * {@link SessionManager.interrupt}.
 *
 * - 200 `{ sessionId, status: "interrupted" }` — a live run was aborted.
 * - 404 — no such session row (standard error envelope).
 * - 409 — the session exists but isn't actively running (already terminal, or
 *   evicted between runs). Uses the standard error envelope with structured
 *   details: `{ error: { status: 409, message, sessionId, sessionStatus } }`.
 *   `sessionStatus` is the session's current lifecycle status (e.g. `completed`,
 *   `interrupted`) — named distinctly from the HTTP `error.status` so the two
 *   never collide. The `message` embeds it too so the BFF (which surfaces the raw
 *   409 body text as the operator-facing error message) stays human-readable.
 *   Idempotent-friendly: the caller learns the run is already not in flight and
 *   can treat it as success.
 *
 * This is the console's first mutating route; everything else is read-only. The
 * bearer-token check in the server's request handler gates it like every route,
 * and the `x-console-request` CSRF-guard header is required before dispatch.
 */
export function abortSession(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const id = ctx.params.id;
  const row = ctx.deps.storage.getAgentSession(id);
  if (!row) return sendError(res, 404, `Unknown session: ${id}`);

  const aborted = ctx.deps.sessions.interrupt(id);
  if (!aborted) {
    const sessionStatus = ctx.deps.sessions.get(id)?.status ?? row.status;
    return sendError(res, 409, `Session is not running (${sessionStatus}): ${id}`, {
      sessionId: id,
      sessionStatus,
    });
  }
  sendJson(res, 200, { sessionId: id, status: "interrupted" });
}

/**
 * POST /api/sessions/:id/resume — manual resume-in-place of a parked
 * `failed-resumable` or `interrupted` session (spec
 * CONCURRENCY-AND-RATE-LIMITING §6.2 / Decision D; both statuses carry the
 * same snapshot/transcript material — and a crash-interrupted row whose
 * transcript never flushed resumes via a fresh context rebuild instead of a
 * replay, see `loadResumeMaterial`). The console's second mutating route,
 * mirroring `abortSession`'s envelope conventions.
 *
 * - 200 `{ sessionId, status }` — the resume ran to completion (`status:
 *   "completed"`).
 * - 404 — no such session row.
 * - 409 — the session isn't resumable (wrong status; a synthetic worker-pool
 *   session type — summarize/condense/diary, never chat-resumable; a resume
 *   already in flight; the timeline slot is held by a live session; or there
 *   is nothing to redo — the transcript ends at a clean boundary), or the
 *   resume attempt itself failed (re-parked or discarded); `sessionStatus`
 *   carries the resulting state and `message` the reason.
 * - 503 — the runtime didn't inject a resume action (read-only deployment).
 *
 * The resume runs the session to a terminal state before responding, so the
 * operator gets the definitive outcome (a session run is seconds-to-minutes;
 * the console client tolerates a long-poll here).
 */
export async function resumeSession(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const id = ctx.params.id;
  const resume = ctx.deps.resumeSession;
  if (!resume) return sendError(res, 503, "Resume is not available in this deployment");
  const row = ctx.deps.storage.getAgentSession(id);
  if (!row) return sendError(res, 404, `Unknown session: ${id}`);

  const result = await resume(id);
  if (!result.ok) {
    return sendError(res, 409, result.reason ?? `Session could not be resumed: ${id}`, {
      sessionId: id,
      sessionStatus: result.status,
    });
  }
  sendJson(res, 200, { sessionId: id, status: result.status });
}

/**
 * GET /api/media/:ref — bytes for an externalized image ref. `:ref` is the media
 * asset id (= `attachmentId`). Resolved beneath the workspace root with a
 * path-traversal guard.
 */
export async function media(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const asset = ctx.deps.storage.getMediaAssetById(ctx.params.ref);
  if (!asset || !asset.local_path) {
    return sendError(res, 404, `Unknown media ref: ${ctx.params.ref}`);
  }

  const root = path.resolve(ctx.deps.workspaceRoot);
  const abs = path.resolve(root, asset.local_path);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return sendError(res, 403, "Media path escapes workspace root");
  }

  try {
    const info = await stat(abs);
    if (!info.isFile()) return sendError(res, 404, "Media not a file");
    res.writeHead(200, {
      "content-type": asset.mime_type ?? "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": "private, max-age=300",
    });
    createReadStream(abs).pipe(res);
  } catch {
    sendError(res, 404, "Media file missing");
  }
}

/** GET /api/summaries/:id — a summary + its lineage for the detail column (spec §12). */
export function summaryDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const summary = ctx.deps.storage.getSummaryById(ctx.params.id);
  if (!summary) return sendError(res, 404, `Unknown summary: ${ctx.params.id}`);
  sendJson(res, 200, { summary, lineage: ctx.deps.storage.getSummaryLineage(ctx.params.id) });
}

// --- helpers ---------------------------------------------------------------

/** Project a stored session row into the camelCase list/meta shape (spec §8). */
function sessionMeta(row: AgentSessionRow): Record<string, unknown> {
  return {
    id: row.id,
    timelineKey: row.timeline_key,
    sessionType: row.session_type,
    status: row.status,
    modelId: row.model_id,
    triggerEventId: row.trigger_event_id,
    triggerExternalId: row.trigger_external_id,
    triggerBody: row.trigger_body,
    tokenEstimate: row.token_estimate,
    noReply: row.no_reply === 1,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * A persisted context-snapshot message as it comes back out of
 * `context_snapshot_json`: structurally a {@link ContextMessage}, but optional
 * keys (`tier`/`timestamp`/`imageBlocks`) may be absent (JSON.stringify drops
 * `undefined`), `tokenEstimate` may be missing on legacy rows, and
 * `imageBlocks` holds already-externalized {@link ImageRef}s rather than raw
 * base64 blocks (session-capture externalizes at write time).
 */
type PersistedContextMessage = Partial<Omit<ContextMessage, "imageBlocks">> & {
  imageBlocks?: unknown;
};

/**
 * Verbatim-renderer view of a context message (spec §10a): content is kept raw;
 * image blocks are externalized to refs so no base64 crosses the wire. Tier and
 * token metadata drive the gutter. This is the ONE wire shape the console's
 * strict `ContextMessageWire` schema decodes — both the live room-context
 * preview and the persisted session snapshot must pass through it (optional
 * source fields become explicit nulls). For persisted snapshots `imageBlocks`
 * already holds refs; `externalizeImages` is a no-op deep clone there.
 */
function renderContextMessage(msg: ContextMessage | PersistedContextMessage): Record<string, unknown> {
  return {
    type: msg.type,
    role: msg.role,
    content: msg.content,
    tier: msg.tier ?? null,
    tokenEstimate: msg.tokenEstimate ?? null,
    timestamp: msg.timestamp ?? null,
    imageRefs: msg.imageBlocks ? externalizeImages(msg.imageBlocks) : undefined,
  };
}

/** Parse a stored JSON array column; `[]` on null/parse failure. */
function parseJsonArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
