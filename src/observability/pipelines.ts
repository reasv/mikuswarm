import type { CaptionEligibility, PipelineId } from "../storage/index.js";

/**
 * The tiny read-only stats seam each background worker pool exposes for the
 * pipeline monitor (ARCHITECTURE.md §11). Counts-by-status are derived from the DB
 * (the single source of truth that survives restart); the only genuinely live
 * number here is `inFlight()` (the pool's `activeWorkers.size`). `workerCount`/
 * `maxRetries` come from config.
 */
export interface PipelineStats {
  readonly pool: PipelineId;
  workerCount: number;
  maxRetries: number;
  inFlight(): number;
  /**
   * Wake the pool's poll loop so a manually re-enqueued item (Phase 5 retry) is
   * claimed immediately rather than on the next 1s tick. Optional so test stubs and
   * the dashboard read path need not provide it.
   */
  notify?(): void;
  /**
   * Captioning only: the config-derived eligibility the monitor needs to compute
   * the derived `deferred` status (a pending asset the pool would never claim). The
   * captioning pool sets it from its `caption_all`/`caption_assistant_messages`
   * config; other pools omit it.
   */
  captionEligibility?: CaptionEligibility;
}

/**
 * The four pool stat sources handed to the observability server. Summarization and
 * diary are nullable: either can be disabled by config, in which case the monitor
 * still reports DB-derived history for the pool but shows it as not running
 * (no live worker, inFlight 0).
 */
export interface PipelineRegistry {
  enrichment: PipelineStats;
  captioning: PipelineStats;
  summarization: PipelineStats | null;
  diary: PipelineStats | null;
}

/**
 * The transition a {@link PipelineActivityEvent} reports — the five points each
 * pool publishes at: `claimed` (pending→processing), `completed` (terminal
 * success, carrying the persisted job status: enrichment/captioning/summarization
 * `complete`, diary `done` — a best-effort truncated summary is still a `complete`
 * job), `failed` (terminal failure), `retried` (back to pending, attempts
 * incremented), `skipped` (terminal no-op).
 */
export type PipelineActivityKind = "claimed" | "completed" | "failed" | "retried" | "skipped";

/**
 * One live activity event off the in-process bus (ARCHITECTURE.md §11). Carries
 * just enough for the console to feel live: `pool`+`id` identify the row, `kind`
 * drives the transition animation, and `status`/`attempts`/`room` let the client
 * patch the row (or just invalidate the affected pool's counts). `room`/`attempts`
 * are best-effort — null/0 where the publishing point doesn't cheaply hold them.
 */
export interface PipelineActivityEvent {
  pool: PipelineId;
  id: string;
  kind: PipelineActivityKind;
  status: string;
  attempts: number;
  room: string | null;
  ts: number;
}

/**
 * A lightweight in-process pub/sub for pipeline activity (ARCHITECTURE.md §11).
 * Pools publish at their existing transition points (additive — the existing
 * onComplete/onError callbacks are untouched); the observability server subscribes
 * and fans out to SSE clients.
 *
 * Read-only-observer discipline (same as the session SSE): a subscriber that throws
 * is isolated per-listener so a write failure (e.g. a dead SSE socket) can NEVER
 * propagate back into a worker loop's `publish()` call.
 */
export class PipelineActivityBus {
  private readonly listeners = new Set<(event: PipelineActivityEvent) => void>();

  publish(event: PipelineActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // An observer must never break the worker loop that published.
      }
    }
  }

  subscribe(listener: (event: PipelineActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
