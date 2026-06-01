import type { IncomingMessage, ServerResponse } from "node:http";
import type { ObservabilityServerConfig } from "../../config/index.js";
import type { Storage } from "../../storage/index.js";
import type { AgentSessionFactory } from "../../agent/factory.js";
import type { SessionManager } from "../../agent/session-manager.js";
import type { Logger } from "../logger.js";

/**
 * Live references the read-only observability console holds (spec §8). In-process
 * is mandatory: the room view needs the real `ContextBuilder` (via the factory's
 * `buildPreview`), live streaming needs the in-memory `Agent` (via `SessionManager`),
 * and every JSON response is redacted before it leaves the process.
 */
export interface ConsoleServerDeps {
  config: ObservabilityServerConfig;
  storage: Storage;
  factory: AgentSessionFactory;
  sessions: SessionManager;
  /** Workspace root; media `local_path`s are resolved beneath it. */
  workspaceRoot: string;
  logger: Logger;
}

/** Per-request context handed to a route handler. */
export interface RequestContext {
  /** Decoded path params captured by the route pattern (e.g. `{ key, id }`). */
  params: Record<string, string>;
  /** Parsed request URL (query string available via `url.searchParams`). */
  url: URL;
  deps: ConsoleServerDeps;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => Promise<void> | void;
