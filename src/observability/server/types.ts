import type { IncomingMessage, ServerResponse } from "node:http";
import type { ObservabilityServerConfig } from "../../config/index.js";
import type { Storage } from "../../storage/index.js";
import type { AgentSessionFactory } from "../../agent/factory.js";
import type { SessionManager } from "../../agent/session-manager.js";
import type { Logger } from "../logger.js";
import type { PipelineRegistry, PipelineActivityBus } from "../pipelines.js";
import type { SessionLiveEventBus } from "../live-events.js";
import type { LlmScheduler } from "../../agent/scheduler.js";
import type { LlmRequestRing } from "../../agent/request-ring.js";

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
  /**
   * Live stat sources for the four background worker pools (ARCHITECTURE.md §11).
   * The monitor reads in-flight counts + config from here; counts-by-status come
   * from the DB via `storage`. Optional so existing callers/tests that don't
   * exercise the pipeline routes need not assemble it.
   */
  pipelines?: PipelineRegistry;
  /** In-process activity bus the pools publish to; backs the `/api/pipelines/stream` SSE. */
  activityBus?: PipelineActivityBus;
  /**
   * Per-session tentative-event bus (spec LLM-FAILURE-HANDLING §4.2): the
   * Layer-0 tap's raw attempt events, merged into the session SSE as
   * `tentative_event` / `attempt_discarded` — kinds distinct from the
   * authoritative agent events. Optional so existing callers/tests need not
   * provide it (the stream then carries committed events only).
   */
  liveEvents?: SessionLiveEventBus;
  /**
   * The LLM request scheduler, for the `GET /api/scheduler` snapshot (spec
   * LLM-FAILURE-HANDLING §9.1). Optional: absent = the route 503s.
   */
  scheduler?: LlmScheduler;
  /**
   * In-memory Layer-0 attempt ring backing `GET /api/llm-requests` (spec
   * §9.2). Optional: absent = the route 503s.
   */
  llmRequestRing?: LlmRequestRing;
  /** Workspace root; media `local_path`s are resolved beneath it. */
  workspaceRoot: string;
  /**
   * Manual resume-in-place of a parked `failed-resumable` session (spec
   * CONCURRENCY-AND-RATE-LIMITING §6.2). Injected by app wiring; optional so
   * existing callers/tests that don't exercise the resume route need not
   * provide it (the route then 503s).
   */
  resumeSession?: (sessionId: string) => Promise<{ ok: boolean; status: string; reason?: string }>;
  /**
   * Startup gap-backfetch status snapshot (ARCHITECTURE.md §7c §11): per-room
   * phase (frozen/filling/committing/done), buffered counts, and any capped holes,
   * so an operator can watch the bot catch up after a restart. Optional: absent =
   * the route returns an empty list (feature disabled or not wired).
   */
  gapBackfetch?: () => unknown[];
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
