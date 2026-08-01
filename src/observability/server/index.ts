import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAuthorized } from "./auth.js";
import { Router } from "./router.js";
import { sendError } from "./responses.js";
import {
  agentsSnapshot,
  listRooms,
  roomContext,
  roomSessions,
  roomSessionFacets,
  sessionDetail,
  sessionStream,
  abortSession,
  resumeSession,
  media,
  summaryDetail,
  schedulerSnapshot,
  gapBackfetchSnapshot,
  llmRequests,
  costOverview,
  usageSummary,
  usageTimeseries,
  usageSessions,
  usageToolCalls,
  usageLeaderboard,
  usageBudgets,
  usageUserLimits,
} from "./handlers.js";
import {
  listPipelines,
  pipelineItems,
  pipelineItemDetail,
  pipelineActivityStream,
  retryPipelineItem,
  retryFailedPipelineItems,
} from "./pipeline-handlers.js";
import {
  backfetchJobs,
  startBackfetchJob,
  pauseBackfetchJob,
  resumeBackfetchJob,
  cancelBackfetchJob,
  promoteBackfetchCaptions,
} from "./backfetch-handlers.js";
import type { ConsoleServerDeps } from "./types.js";

export type { ConsoleServerDeps } from "./types.js";

/**
 * CSRF guard for state-mutating routes. The console BFF attaches this header to
 * every outbound request (`console/src/lib/server/api/client.ts` `request()`); the
 * value is a constant marker, not a credential. Requiring a *custom* header on
 * mutating methods makes any cross-origin browser request non-"simple" → the
 * browser must send a CORS preflight → this server implements no CORS, so the
 * actual request is blocked. A real CSRF attack (auto-submitted form / `no-cors`
 * fetch) can only issue simple requests and cannot set this header. The legitimate
 * server-to-server BFF `fetch` is not subject to CORS and passes. Keep this literal
 * in sync with the BFF constant of the same name.
 */
export const CONSOLE_REQUEST_HEADER = "x-console-request";

/** HTTP methods that mutate state and therefore require the CSRF guard header. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ConsoleServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bound port (useful when `port: 0` is used for tests). Null until started. */
  address(): number | null;
}

/**
 * In-process observability console (spec §8). Plain `node:http`, no framework,
 * no new dependencies. Every request is bearer-authorized (when a token is
 * configured) and every JSON body is secret-redacted on the way out.
 *
 * Read-only except for the operator mutations `POST /api/sessions/:id/abort`
 * (the Stop button, spec §13), `POST /api/sessions/:id/resume` (manual
 * resume-in-place of a parked `failed-resumable` session, spec
 * CONCURRENCY-AND-RATE-LIMITING §6.2), and the pipeline retry actions. All
 * other routes are GET observability reads.
 */
export function createObservabilityServer(deps: ConsoleServerDeps): ConsoleServer {
  const log = deps.logger;

  const router = new Router()
    .add("GET", "/api/agents", agentsSnapshot)
    .add("GET", "/api/rooms", listRooms)
    .add("GET", "/api/rooms/:key/context", roomContext)
    .add("GET", "/api/rooms/:key/sessions", roomSessions)
    .add("GET", "/api/rooms/:key/session-facets", roomSessionFacets)
    .add("GET", "/api/sessions/:id", sessionDetail)
    .add("GET", "/api/sessions/:id/stream", sessionStream)
    .add("POST", "/api/sessions/:id/abort", abortSession)
    .add("POST", "/api/sessions/:id/resume", resumeSession)
    .add("GET", "/api/media/:ref", media)
    .add("GET", "/api/summaries/:id", summaryDetail)
    .add("GET", "/api/scheduler", schedulerSnapshot)
    .add("GET", "/api/gap-backfetch", gapBackfetchSnapshot)
    .add("GET", "/api/backfetch/jobs", backfetchJobs)
    .add("POST", "/api/backfetch/jobs", startBackfetchJob)
    .add("POST", "/api/backfetch/jobs/:id/pause", pauseBackfetchJob)
    .add("POST", "/api/backfetch/jobs/:id/resume", resumeBackfetchJob)
    .add("POST", "/api/backfetch/jobs/:id/cancel", cancelBackfetchJob)
    .add("POST", "/api/backfetch/caption-promote", promoteBackfetchCaptions)
    .add("GET", "/api/llm-requests", llmRequests)
    .add("GET", "/api/cost-overview", costOverview)
    .add("GET", "/api/usage/summary", usageSummary)
    .add("GET", "/api/usage/timeseries", usageTimeseries)
    .add("GET", "/api/usage/sessions", usageSessions)
    .add("GET", "/api/usage/tool-calls", usageToolCalls)
    .add("GET", "/api/usage/leaderboard", usageLeaderboard)
    .add("GET", "/api/usage/budgets", usageBudgets)
    .add("GET", "/api/usage/user-limits", usageUserLimits)
    .add("GET", "/api/pipelines", listPipelines)
    .add("GET", "/api/pipelines/stream", pipelineActivityStream)
    .add("GET", "/api/pipelines/:pool/items", pipelineItems)
    .add("GET", "/api/pipelines/:pool/items/:id", pipelineItemDetail)
    .add("POST", "/api/pipelines/:pool/items/:id/retry", retryPipelineItem)
    .add("POST", "/api/pipelines/:pool/retry-failed", retryFailedPipelineItems);

  // Track live sockets so `stop()` can force-close long-lived SSE connections
  // (which would otherwise keep `server.close()` pending forever).
  const sockets = new Set<Socket>();
  let server: Server | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const startedAt = performance.now();
    try {
      if (!isAuthorized(req, url, deps.config.auth_token)) {
        return sendError(res, 401, "Unauthorized");
      }
      // CSRF guard: mutating routes are console-BFF-only (server-to-server). A
      // browser can only reach them via a CORS-preflighted request carrying this
      // custom header, which this no-CORS server never approves; simple-request
      // CSRF cannot set it. GET reads (incl. the SSE stream) need no header.
      const method = req.method ?? "GET";
      if (MUTATING_METHODS.has(method) && req.headers[CONSOLE_REQUEST_HEADER] === undefined) {
        return sendError(res, 403, "Forbidden");
      }
      const matched = router.match(method, url.pathname);
      if (!matched) {
        if (router.pathExists(url.pathname)) return sendError(res, 405, "Method not allowed");
        return sendError(res, 404, "Not found");
      }
      await matched.handler(req, res, { params: matched.params, url, deps });
    } catch (err) {
      log.error("console_request_failed", {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.end();
    } finally {
      const durationMs = performance.now() - startedAt;
      const fields = {
        method: req.method ?? "GET",
        path: url.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      };
      if (durationMs >= 250) log.warn("console_request_slow", fields);
      else log.debug("console_request_completed", fields);
    }
  }

  return {
    async start() {
      const srv = createServer((req, res) => void handle(req, res));
      srv.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        srv.once("error", onError);
        srv.listen(deps.config.port, deps.config.bind, () => {
          srv.off("error", onError);
          resolve();
        });
      });
      server = srv;
      log.info("console_started", {
        bind: deps.config.bind,
        port: this.address(),
        authRequired: Boolean(deps.config.auth_token),
      });
    },

    async stop() {
      const srv = server;
      if (!srv) return;
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      log.info("console_stopped");
    },

    address() {
      const addr = server?.address();
      return addr && typeof addr === "object" ? addr.port : null;
    },
  };
}
