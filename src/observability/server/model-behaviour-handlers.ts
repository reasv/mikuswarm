import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BEHAVIOUR_GROUP_BYS,
  BEHAVIOUR_WINDOWS,
  INCIDENT_TYPES,
  type BehaviourGroupBy,
  type BehaviourIncidentType,
  type BehaviourWindow,
  type ModelBehaviourQuery,
} from "../../behaviour/index.js";
import { sendError, sendJson } from "./responses.js";
import type { RequestContext } from "./types.js";

/**
 * Parse the model behaviour page's URL filters (spec REFUSAL-HANDLING §12.3):
 * `window` (today|24h|7d|30d|month|all, default 24h), `groupBy`
 * (model|agent|site|task, default model), `family` (1|true), `agent`, `site`,
 * `task`, `selected`, `metric` (headline rate id or `mix:<family>`; absent =
 * the overview), `type` (incident type),
 * `cursor`, `limit`. Unknown values fall back to the defaults; empty strings are
 * absent.
 */
export function parseModelBehaviourQuery(url: URL): ModelBehaviourQuery {
  const p = url.searchParams;
  const opt = (name: string) => {
    const v = p.get(name);
    return v === null || v === "" ? null : v;
  };
  const window = (BEHAVIOUR_WINDOWS as readonly string[]).includes(p.get("window") ?? "")
    ? (p.get("window") as BehaviourWindow)
    : "24h";
  const groupBy = (BEHAVIOUR_GROUP_BYS as readonly string[]).includes(p.get("groupBy") ?? "")
    ? (p.get("groupBy") as BehaviourGroupBy)
    : "model";
  const type = (INCIDENT_TYPES as readonly string[]).includes(p.get("type") ?? "")
    ? (p.get("type") as BehaviourIncidentType)
    : null;
  const limit = Number(p.get("limit"));
  return {
    window,
    groupBy,
    family: p.get("family") === "1" || p.get("family") === "true",
    agent: opt("agent"),
    site: opt("site"),
    task: opt("task"),
    selected: opt("selected"),
    metric: opt("metric"),
    incidentType: type,
    cursor: opt("cursor"),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
}

/**
 * GET /api/models/behaviour — the model behaviour page in one response: scorecard,
 * series for the selected rate, breakdown, change markers, the first incident page
 * and the filter facets. 503 when the feature is not wired.
 */
export async function modelBehaviour(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const api = ctx.deps.modelBehaviour;
  if (!api) return sendError(res, 503, "Model behaviour statistics are not available");
  sendJson(res, 200, await api.read(parseModelBehaviourQuery(ctx.url)));
}

/** GET /api/models/behaviour/incidents — one more incident-log page (same filters + `cursor`). */
export async function modelBehaviourIncidents(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const api = ctx.deps.modelBehaviour;
  if (!api) return sendError(res, 503, "Model behaviour statistics are not available");
  sendJson(res, 200, await api.incidents(parseModelBehaviourQuery(ctx.url)));
}
