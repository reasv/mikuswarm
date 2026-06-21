import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackfetchTargetKind } from "../../storage/index.js";
import type { RequestContext } from "./types.js";
import { sendJson, sendError } from "./responses.js";

/**
 * Message-only history backfetch console routes (spec MESSAGE-BACKFETCH §8;
 * ARCHITECTURE.md §7d). Mutating routes take their inputs as query params (no
 * request body), matching the rest of the console's mutating surface (abort /
 * resume / pipeline retry); the CSRF header guard in `index.ts` covers them.
 */

const VALID_TARGETS: ReadonlySet<string> = new Set([
  "beginning",
  "date",
  "oldest_decryptable",
  "count",
]);

const BASE_KEY_RE = /^matrix:([^:]+):(room|dm):(.+)$/;

/** GET /api/backfetch/jobs — every job, newest first (empty when not wired). */
export function backfetchJobs(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const deps = ctx.deps.backfetch;
  if (!deps) return sendJson(res, 200, { jobs: [], enabled: false });
  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  sendJson(res, 200, { jobs: deps.list(limit), enabled: deps.enabled });
}

/**
 * POST /api/backfetch/jobs — start a job. Query params: `timelineKey` (the base
 * room/dm key), `targetKind`, optional `targetValue` (ISO date / count), optional
 * `captionAfter`, `safetyCap`, `timeoutMs`. The roomId + accountId are derived
 * from the timeline key (must be a base key, not a thread).
 */
export async function startBackfetchJob(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const deps = ctx.deps.backfetch;
  if (!deps) return sendError(res, 503, "backfetch not wired");
  const q = ctx.url.searchParams;
  const timelineKey = q.get("timelineKey")?.trim();
  if (!timelineKey) return sendError(res, 400, "timelineKey is required");
  if (timelineKey.includes(":thread:")) {
    return sendError(res, 400, "timelineKey must be a base room/dm key, not a thread");
  }
  const m = BASE_KEY_RE.exec(timelineKey);
  if (!m) return sendError(res, 400, `unrecognized timelineKey: ${timelineKey}`);
  const accountId = m[1]!;
  const roomId = m[3]!;

  const targetKind = q.get("targetKind") ?? "";
  if (!VALID_TARGETS.has(targetKind)) {
    return sendError(res, 400, `targetKind must be one of beginning|date|oldest_decryptable|count`);
  }
  const targetValueRaw = q.get("targetValue");
  // Validate target value for the kinds that require it.
  if (targetKind === "date") {
    if (!targetValueRaw || !Number.isFinite(Date.parse(targetValueRaw))) {
      return sendError(res, 400, "targetValue must be a parseable date for targetKind=date");
    }
  }
  if (targetKind === "count") {
    const n = Number.parseInt(targetValueRaw ?? "", 10);
    if (!Number.isFinite(n) || n <= 0) {
      return sendError(res, 400, "targetValue must be a positive integer for targetKind=count");
    }
  }

  const result = await deps.start({
    roomId,
    accountId,
    timelineKey,
    targetKind: targetKind as BackfetchTargetKind,
    targetValue: targetKind === "date" || targetKind === "count" ? targetValueRaw : null,
    captionAfter: parseBool(q.get("captionAfter")),
    safetyCap: parseNonNegInt(q.get("safetyCap")),
    timeoutMs: parseNonNegInt(q.get("timeoutMs")),
  });
  if (!result.ok) return sendError(res, 409, result.reason);
  sendJson(res, 200, { job: result.job });
}

/** POST /api/backfetch/jobs/:id/pause */
export async function pauseBackfetchJob(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  await jobAction(res, ctx, (id) => ctx.deps.backfetch!.pause(id));
}

/** POST /api/backfetch/jobs/:id/resume */
export async function resumeBackfetchJob(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  await jobAction(res, ctx, (id) => ctx.deps.backfetch!.resume(id));
}

/** POST /api/backfetch/jobs/:id/cancel */
export async function cancelBackfetchJob(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  await jobAction(res, ctx, (id) => ctx.deps.backfetch!.cancel(id));
}

/**
 * POST /api/backfetch/caption-promote — retroactively promote a room's deferred
 * backfetched media to pending (§7.3). Query params: `timelineKey` (base key),
 * optional `fromTs`/`toTs` (ms) sub-range. Returns the count promoted.
 */
export async function promoteBackfetchCaptions(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const deps = ctx.deps.backfetch;
  if (!deps) return sendError(res, 503, "backfetch not wired");
  const q = ctx.url.searchParams;
  const timelineKey = q.get("timelineKey")?.trim();
  if (!timelineKey) return sendError(res, 400, "timelineKey is required");
  const promoted = await deps.promoteCaptions(timelineKey, {
    fromTs: parseTs(q.get("fromTs")),
    toTs: parseTs(q.get("toTs")),
  });
  sendJson(res, 200, { promoted });
}

async function jobAction(
  res: ServerResponse,
  ctx: RequestContext,
  action: (id: string) => Promise<{ ok: boolean; reason?: string }>,
): Promise<void> {
  if (!ctx.deps.backfetch) return sendError(res, 503, "backfetch not wired");
  const id = ctx.params.id;
  const result = await action(id);
  if (!result.ok) return sendError(res, 409, result.reason ?? "action failed");
  sendJson(res, 200, { ok: true });
}

function parseBool(v: string | null): boolean {
  return v === "1" || v === "true";
}

function parseNonNegInt(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseTs(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseLimit(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : undefined;
}
