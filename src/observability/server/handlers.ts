import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ContextMessage } from "../../context/builder.js";
import { externalizeImages } from "../../agent/session-capture.js";
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
  const { built, syntheticTriggerEventId, finalTurnIndex } = await ctx.deps.factory.buildPreview(
    ctx.params.key,
  );
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
 */
export function sessionDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const row = ctx.deps.storage.getAgentSession(ctx.params.id);
  if (!row) return sendError(res, 404, `Unknown session: ${ctx.params.id}`);
  sendJson(res, 200, {
    session: sessionMeta(row),
    contextSnapshot: parseJsonArray(row.context_snapshot_json),
    transcript: parseJsonArray(row.transcript_json),
  });
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
 * Verbatim-renderer view of a context message (spec §10a): content is kept raw;
 * image blocks are externalized to refs so no base64 crosses the wire. Tier and
 * token metadata drive the gutter.
 */
function renderContextMessage(msg: ContextMessage): Record<string, unknown> {
  return {
    type: msg.type,
    role: msg.role,
    content: msg.content,
    tier: msg.tier ?? null,
    tokenEstimate: msg.tokenEstimate,
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
