import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAuthorized } from "./auth.js";
import { Router } from "./router.js";
import { sendError } from "./responses.js";
import {
  listRooms,
  roomContext,
  roomSessions,
  sessionDetail,
  sessionStream,
  media,
  summaryDetail,
} from "./handlers.js";
import type { ConsoleServerDeps } from "./types.js";

export type { ConsoleServerDeps } from "./types.js";

export interface ConsoleServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bound port (useful when `port: 0` is used for tests). Null until started. */
  address(): number | null;
}

/**
 * In-process, read-only observability console (spec §8). Plain `node:http`, no
 * framework, no new dependencies. Every request is bearer-authorized (when a
 * token is configured) and every JSON body is secret-redacted on the way out.
 * Read-only: no mutating routes (admin actions, spec §13, are a later phase).
 */
export function createObservabilityServer(deps: ConsoleServerDeps): ConsoleServer {
  const log = deps.logger;

  const router = new Router()
    .add("GET", "/api/rooms", listRooms)
    .add("GET", "/api/rooms/:key/context", roomContext)
    .add("GET", "/api/rooms/:key/sessions", roomSessions)
    .add("GET", "/api/sessions/:id", sessionDetail)
    .add("GET", "/api/sessions/:id/stream", sessionStream)
    .add("GET", "/api/media/:ref", media)
    .add("GET", "/api/summaries/:id", summaryDetail);

  // Track live sockets so `stop()` can force-close long-lived SSE connections
  // (which would otherwise keep `server.close()` pending forever).
  const sockets = new Set<Socket>();
  let server: Server | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!isAuthorized(req, url, deps.config.auth_token)) {
        return sendError(res, 401, "Unauthorized");
      }
      const matched = router.match(req.method ?? "GET", url.pathname);
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
