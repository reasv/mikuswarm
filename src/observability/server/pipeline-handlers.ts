import type { IncomingMessage, ServerResponse } from "node:http";
import { PIPELINE_IDS, type MediaAssetRow, type PipelineId } from "../../storage/index.js";
import { sendJson, sendError } from "./responses.js";
import { openSse } from "./sse.js";
import type { RequestContext } from "./types.js";

/**
 * Retry-cap fallback when a pool is disabled by config (its registry entry is
 * null) but its history still has items. Mirrors each pool's own default so a
 * disabled pool's items show a sensible `2/N`.
 */
const FALLBACK_MAX_RETRIES: Record<PipelineId, number> = {
  enrichment: 3,
  captioning: 2,
  summarization: 2,
  diary: 3,
};

function isPipelineId(value: string): value is PipelineId {
  return (PIPELINE_IDS as readonly string[]).includes(value);
}

/** Parse a finite positive `?limit=`; undefined (→ storage default) otherwise. */
function parseLimit(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * GET /api/pipelines — one row per pool for the dashboard (ARCHITECTURE.md §11):
 * `{ pool, enabled, workerCount, maxRetries, inFlight, counts }`.
 * `counts` are DB aggregates (survive restart); `inFlight` is the one live number
 * (the pool's `activeWorkers.size`). A pool disabled by config reports
 * `enabled: false`, `inFlight: 0`, and zero worker count, but still surfaces its
 * historical `counts`.
 */
export function listPipelines(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const registry = ctx.deps.pipelines;
  const pipelines = PIPELINE_IDS.map((pool) => {
    const stats = registry ? registry[pool] : null;
    return {
      pool,
      enabled: stats != null,
      workerCount: stats?.workerCount ?? 0,
      maxRetries: stats?.maxRetries ?? FALLBACK_MAX_RETRIES[pool],
      inFlight: stats ? stats.inFlight() : 0,
      counts: ctx.deps.storage.getPipelineCounts(pool),
    };
  });
  sendJson(res, 200, { pipelines });
}

/**
 * GET /api/pipelines/:pool/items?status=&room=&cursor=&limit= — a keyset page of
 * a pool's items, reverse-chron on `(updatedAt, id)` (ARCHITECTURE.md §11).
 * Returns `{ items, nextCursor }`. 404 for an unknown pool.
 */
export function pipelineItems(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const pool = ctx.params.pool;
  if (!isPipelineId(pool)) return sendError(res, 404, `Unknown pipeline: ${pool}`);

  const stats = ctx.deps.pipelines ? ctx.deps.pipelines[pool] : null;
  const maxRetries = stats?.maxRetries ?? FALLBACK_MAX_RETRIES[pool];
  const q = ctx.url.searchParams;
  const page = ctx.deps.storage.listPipelineItems(
    pool,
    {
      status: q.get("status"),
      room: q.get("room"),
      cursor: q.get("cursor"),
      limit: parseLimit(q.get("limit")),
    },
    maxRetries,
  );
  sendJson(res, 200, page);
}

/** Wire projection of a produced/source media asset (no base64; bytes via /api/media). */
function mediaAssetWire(asset: MediaAssetRow): Record<string, unknown> {
  return {
    ref: asset.id,
    role: asset.role,
    mediaType: asset.media_type,
    mimeType: asset.mime_type ?? null,
    filename: asset.original_filename ?? null,
    downloadStatus: asset.download_status,
    captionStatus: asset.caption_status,
    caption: asset.caption ?? null,
    captionModel: asset.caption_model ?? null,
    /** Whether bytes are fetchable at GET /api/media/:ref. */
    hasBytes: asset.local_path != null,
  };
}

/**
 * GET /api/pipelines/:pool/items/:id — the pool-specific detail union
 * (ARCHITECTURE.md §11). 404 for an unknown pool or an id outside the pool's
 * track. Every response carries the base `item` plus pool-specific extras:
 *
 * - enrichment → the produced `mediaAssets` / `linkPreviews` / `replyContext`.
 * - captioning → the source `media` (bytes via `/api/media/:ref`) + caption/model.
 * - summarization → the resulting `summary` + `lineage` (mirrors `/api/summaries/:id`)
 *   + `bestEffortDraft`/`error`, and `sessionId` → the synthetic agent_sessions run.
 * - diary → the source `summary` (covered range + neutral record) + `sessionId`; the
 *   written first-person entry is rendered by the client via the linked SessionView
 *   (the day-file path depends on the agent timezone, which the console does not hold).
 */
export function pipelineItemDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const pool = ctx.params.pool;
  if (!isPipelineId(pool)) return sendError(res, 404, `Unknown pipeline: ${pool}`);

  const stats = ctx.deps.pipelines ? ctx.deps.pipelines[pool] : null;
  const maxRetries = stats?.maxRetries ?? FALLBACK_MAX_RETRIES[pool];
  const { storage } = ctx.deps;
  const item = storage.getPipelineItem(pool, ctx.params.id, maxRetries);
  if (!item) return sendError(res, 404, `Unknown ${pool} item: ${ctx.params.id}`);

  switch (pool) {
    case "enrichment": {
      const data = storage.getEnrichmentData([item.id]);
      return sendJson(res, 200, {
        pool,
        item,
        replyContext: data.replyContexts.get(item.id) ?? null,
        linkPreviews: data.linkPreviews.get(item.id) ?? [],
        mediaAssets: (data.mediaAssets.get(item.id) ?? []).map(mediaAssetWire),
      });
    }
    case "captioning": {
      const asset = storage.getMediaAssetById(item.id);
      return sendJson(res, 200, {
        pool,
        item,
        media: asset ? mediaAssetWire(asset) : null,
      });
    }
    case "summarization": {
      const job = storage.getSummarizationJobById(item.id);
      const summaryId = job?.resultSummaryId ?? null;
      const summary = summaryId ? (storage.getSummaryById(summaryId) ?? null) : null;
      const lineage = summaryId ? storage.getSummaryLineage(summaryId) : null;
      return sendJson(res, 200, {
        pool,
        item,
        sessionId: item.sessionId,
        summary,
        lineage,
        bestEffortDraft: job?.bestEffortDraft ?? null,
        error: job?.error ?? null,
      });
    }
    case "diary": {
      // The diary item IS a level-1 summary; surface it (covered range + the neutral
      // record) plus the session that wrote the first-person entry.
      const summary = storage.getSummaryById(item.id) ?? null;
      return sendJson(res, 200, {
        pool,
        item,
        sessionId: item.sessionId,
        summary,
      });
    }
  }
}

/**
 * GET /api/pipelines/stream — SSE firehose of {@link PipelineActivityEvent}s across
 * all four pools (ARCHITECTURE.md §11). Each event is one `event: activity` record;
 * the stream stays open (heartbeat only) until the client disconnects. Redacted +
 * image-externalized by the SSE layer like every other stream. When no activity bus
 * is wired (e.g. a degraded/test deployment), the stream opens and idles rather than
 * erroring, so the client's `query.live` simply receives nothing.
 */
export function pipelineActivityStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): void {
  const bus = ctx.deps.activityBus;
  const stream = openSse(req, res);
  if (!bus) return; // open + idle; heartbeat keeps it alive until disconnect

  // Read-only observer: openSse's safeWrite never throws back into publish(), and
  // the bus isolates a throwing listener per-call, so a dead socket can't reach a
  // worker loop. Unsubscribe on client disconnect.
  const unsubscribe = bus.subscribe((event) => {
    if (stream.closed) return;
    stream.send("activity", event);
  });
  stream.onClose(unsubscribe);
}

/** Operator-facing reason a manual retry was rejected (the BFF surfaces it verbatim). */
function retryRejectionMessage(pool: PipelineId, itemStatus: string, id: string): string {
  if (itemStatus === "processing") {
    return `${pool} item ${id} is currently processing; stop the linked session instead of retrying.`;
  }
  if (pool === "summarization" && itemStatus === "complete") {
    return `Regenerating a consumed summary isn't supported yet — it may already feed a higher-level condensation and a diary entry (item ${id} is ${itemStatus}).`;
  }
  if (pool === "diary" && itemStatus === "done") {
    return `Re-running a written diary entry isn't supported yet — the day file is append-only and would be duplicated (item ${id} is done).`;
  }
  return `${pool} item ${id} is ${itemStatus}, which is not a retryable state.`;
}

/**
 * POST /api/pipelines/:pool/items/:id/retry — manual retry (ARCHITECTURE.md §11,
 * spec §3.7). Resets a terminal safe item to `pending` and pokes the pool.
 * `200 { pool, id, status: "pending" }` on success; `404` unknown item; `409` when
 * not retryable (`processing`, or a deferred unsafe state). The `409` uses the
 * standard error envelope with structured details `{ pool, id, itemStatus }` and a
 * message that reads sensibly on its own (the BFF surfaces it as operator text).
 * Behind the `x-console-request` CSRF guard like every mutating route.
 */
export async function retryPipelineItem(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const pool = ctx.params.pool;
  if (!isPipelineId(pool)) return sendError(res, 404, `Unknown pipeline: ${pool}`);
  const id = ctx.params.id;

  const outcome = await ctx.deps.storage.retryPipelineItem(pool, id);
  if (!outcome.ok && outcome.code === "not_found") {
    return sendError(res, 404, `Unknown ${pool} item: ${id}`);
  }
  if (!outcome.ok && outcome.code === "not_retryable") {
    return sendError(res, 409, retryRejectionMessage(pool, outcome.itemStatus, id), {
      pool,
      id,
      itemStatus: outcome.itemStatus,
    });
  }
  // Poke the pool so the re-enqueued item is claimed at once (else next 1s tick).
  ctx.deps.pipelines?.[pool]?.notify?.();
  sendJson(res, 200, { pool, id, status: "pending" });
}

/**
 * POST /api/pipelines/:pool/retry-failed — bulk retry (ARCHITECTURE.md §11, spec
 * §3.7), restricted to the unambiguously-safe `failed` state. `200 { pool, retried }`.
 * Behind the same CSRF guard.
 */
export async function retryFailedPipelineItems(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const pool = ctx.params.pool;
  if (!isPipelineId(pool)) return sendError(res, 404, `Unknown pipeline: ${pool}`);
  const retried = await ctx.deps.storage.retryFailedPipelineItems(pool);
  if (retried > 0) ctx.deps.pipelines?.[pool]?.notify?.();
  sendJson(res, 200, { pool, retried });
}
