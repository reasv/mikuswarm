import type { IncomingMessage, ServerResponse } from "node:http";
import { PIPELINE_IDS, type PipelineId } from "../../storage/index.js";
import { sendJson, sendError } from "./responses.js";
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
 * `{ pool, enabled, workerCount, maxRetries, concurrency, inFlight, counts }`.
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
      concurrency: stats?.concurrency ?? null,
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
