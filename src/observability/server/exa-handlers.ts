import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./types.js";
import { sendError, sendJson } from "./responses.js";

/** Operator-only snapshots; never include credentials or research input/output bodies. */
export function exaHealth(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const source = ctx.deps.exa, health = source?.health();
  const circuit = (c: NonNullable<typeof health>["account"]) => ({ state: c.state, reason: c.reason ?? null,
    retryAt: c.retryAt, probing: c.probing, lastObserved: c.lastObserved ?? null });
  sendJson(res, 200, { enabled: source?.enabled ?? false, researchEnabled: source?.researchEnabled ?? false,
    health: health ? { account: circuit(health.account), cooldownUntil: health.cooldownUntil,
      endpoints: Object.fromEntries(Object.entries(health.endpoints).map(([scope, c]) => [scope, circuit(c)])) } : null });
}
export function exaJobs(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const rawLimit = ctx.url.searchParams.get("limit"), limit = rawLimit === null ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) { sendError(res, 400, "limit must be an integer from 1 to 100"); return; }
  const state = ctx.url.searchParams.get("status"), agent = ctx.url.searchParams.get("agent");
  if (state && !["submitting", "submission_unknown", "queued", "running", "completed", "failed", "cancelled"].includes(state)) { sendError(res, 400, "Unknown research status"); return; }
  const jobs = ctx.deps.storage.listExaResearchJobs().filter((j) => (!state || j.state === state) && (!agent || j.origin.agent === agent));
  const cursor = ctx.url.searchParams.get("cursor"); let offset = 0;
  if (cursor) {
    const found = jobs.findIndex((j) => j.id === cursor);
    if (found < 0) { sendError(res, 400, "Research cursor unavailable; reload without cursor"); return; }
    offset = found + 1;
  }
  const page = jobs.slice(offset, offset + limit);
  const summaries = page.map((job) => {
    const billing = ctx.deps.storage.read((db) => db.prepare("select cost, metadata_json from tool_invocations where id=?")
      .get(`exa_research_tool:${job.id}`) as { cost: number | null; metadata_json: string | null } | undefined);
    let provenance: "reported" | "estimated" | "unknown" = "unknown";
    if (billing?.metadata_json) {
      try { const value = JSON.parse(billing.metadata_json).costProvenance; if (value === "reported" || value === "estimated") provenance = value; } catch { /* legacy unknown */ }
    }
    return { id: job.id, status: job.state, agent: job.origin.agent, timelineKey: job.origin.timelineKey,
      sessionId: job.origin.sessionId, requesterId: job.origin.requesterId, query: job.request.query.slice(0, 160),
      effort: job.request.effort, createdAt: job.createdAt, updatedAt: job.updatedAt,
      stopReason: job.remote?.stopReason ?? null, cost: billing?.cost ?? null, costProvenance: provenance,
      accounted: job.accounted, lastError: job.lastError?.slice(0, 500) ?? null };
  });
  sendJson(res, 200, { jobs: summaries, total: jobs.length, nextCursor: offset + page.length < jobs.length ? page.at(-1)?.id ?? null : null });
}
