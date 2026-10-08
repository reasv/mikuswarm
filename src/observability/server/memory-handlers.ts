/**
 * Console routes of judged memory retrieval (ARCHITECTURE.md §9d
 * "Observability", §9c "Memory filters"): a session's retrieval builds, the
 * filters' audit trail, and the follow-up rate with the source mix. Read-only;
 * a database without the tables answers empty, never an error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import { sendJson } from "./responses.js";
import type { RequestContext } from "./types.js";

const DAY = 86_400_000;

function safe<T>(read: () => T, empty: T): T {
  try {
    return read();
  } catch {
    return empty;
  }
}

/** GET /api/sessions/:id/memory-retrievals — the session's builds in `ts` order. */
export function sessionMemoryRetrievals(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const store = new MemoryRetrievalStore(ctx.deps.storage);
  sendJson(res, 200, { retrievals: safe(() => store.retrievalsForSession(ctx.params.id ?? ""), []) });
}

/** GET /api/memory/filter-hits?limit=N — blocks the memory filters hid, newest first. */
export function memoryFilterHits(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const store = new MemoryRetrievalStore(ctx.deps.storage);
  const raw = Number(ctx.url.searchParams.get("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 2000) : 500;
  sendJson(res, 200, { hits: safe(() => store.filterHits({ limit }), []) });
}

/** GET /api/memory/stats — follow-up rate and source mix over 7 and 30 days. */
export function memoryStats(_req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  const store = new MemoryRetrievalStore(ctx.deps.storage);
  const now = Date.now();
  const windows = [7, 30].map((days) => {
    const sinceTs = now - days * DAY;
    const follow = safe(() => store.followUpStats(sinceTs), { sessionsWithBlock: 0, followedUp: 0, rate: null });
    const sources = safe(() => store.sourceCounts(sinceTs), {} as Record<string, number>);
    return {
      days,
      sinceTs,
      ...follow,
      builds: Object.values(sources).reduce((a, b) => a + b, 0),
      sources,
    };
  });
  sendJson(res, 200, { windows });
}
