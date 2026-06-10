import { nanoid } from "nanoid";
import type { Storage, TimelineCursor } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import type { SummarizationConfig, AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { estimateTokens } from "../context/tokens.js";
import { renderCompactMessage, renderRichMessage } from "../context/renderer.js";
import { selectSummaryCoverage } from "../context/summary-layer.js";
import { hydrateEvents } from "../context/hydrate.js";

// =============================================================================
// Eager level-1 summarization (spec CONCURRENCY-AND-RATE-LIMITING §7.1/§7.3).
//
// Level-1 jobs used to be enqueued lazily, inside a live session's context
// build — so a summary's generation only *started* when a session already
// needed the room it frees. This indexer moves the threshold evaluation off the
// build hot path and onto event ingestion: after events persist, the timeline's
// un-summarized compact-tier token count is recomputed and a job is enqueued the
// moment it crosses `generation_threshold_tokens` — long before any build needs
// it. Jobs run in advance at `background` priority (Design A); if one hasn't
// finished when a build needs it, the build waits and priority inheritance
// promotes it (§5.2, builder wait-or-omit).
//
// The shape mirrors `ChatSearchIndexer` (src/search/indexer.ts): a strict-FIFO
// tail so reconciles never overlap, fire-and-forget entry points whose errors
// are logged and never thrown back into the message pipeline, and a startup
// `reconcileAll()` sweep that catches thresholds crossed while the process was
// down. Unlike the chat index it is keyed **per timeline**, not per event — the
// threshold is a timeline-level property — and `enqueueReconcileTimeline` is
// self-coalescing, so an ingest burst collapses to one recompute.
//
// With this in place the context builder is read-only w.r.t. jobs: ingestion
// writes jobs (here), builds consume summaries (and wait on / escalate jobs).
// =============================================================================

export interface SummarizationIndexerOptions {
  storage: Storage;
  store: TimelineStore;
  config: SummarizationConfig;
  tiers: AppConfig["context"]["tiers"];
  /** Fired after a job is inserted — wired to `SummarizationWorkerPool.notifyNewWork`. */
  onJobEnqueued?: () => void;
  logger?: Logger;
}

export class SummarizationIndexer {
  private readonly options: SummarizationIndexerOptions;
  /** Strict-FIFO tail so reconciles never overlap (mirrors ChatSearchIndexer). */
  private tail: Promise<unknown> = Promise.resolve();
  /** Timelines queued on the tail but not yet recomputed (self-coalescing). */
  private readonly queued = new Set<string>();
  /** Set by `stop()`: refuse new work and let the in-flight tail drain. */
  private stopped = false;

  constructor(options: SummarizationIndexerOptions) {
    this.options = options;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Drain on shutdown: refuse new reconciles, await the in-flight tail. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.tail;
  }

  /**
   * Fire-and-forget per-timeline reconcile, hooked off the persist seam and the
   * worker pool's completion callback. Self-coalescing: a timeline already
   * queued (and not yet recomputed) is not queued again, so an ingest burst
   * collapses to one recompute. Errors are logged, never thrown to the caller.
   */
  enqueueReconcileTimeline(timelineKey: string): void {
    if (this.stopped) return;
    if (this.queued.has(timelineKey)) return;
    this.queued.add(timelineKey);
    void this.enqueue(() => {
      this.queued.delete(timelineKey);
      return this.reconcileTimelineInner(timelineKey);
    }).catch((error) => {
      this.options.logger?.warn("summarization_reconcile_failed", {
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Awaited single-timeline reconcile, for the context builder's wait-or-omit
   * loop (via the injected `reconcileSummaries` callback): when a build is over
   * budget but finds no job covering its oldest events, it must not conclude
   * "nothing covers them" while this indexer simply hasn't caught up — it asks
   * for one reconcile pass and re-checks. Serialized on the same FIFO tail;
   * unlike `enqueueReconcileTimeline` it is NOT fire-and-forget (the caller
   * awaits completion) and does not coalesce (an awaited pass must actually
   * run). Errors propagate to the awaiter (app wiring catches and logs).
   */
  reconcileTimeline(timelineKey: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(() => this.reconcileTimelineInner(timelineKey));
  }

  /**
   * Startup sweep over every active timeline — catches thresholds crossed while
   * the process was down (the eager equivalent of the chat index's
   * `reconcileAll`). Serialized on the tail like everything else.
   */
  reconcileAll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(async () => {
      for (const timelineKey of this.options.storage.listActiveTimelineKeys()) {
        try {
          await this.reconcileTimelineInner(timelineKey);
        } catch (error) {
          this.options.logger?.warn("summarization_reconcile_failed", {
            timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }

  /**
   * The threshold evaluation, lifted verbatim from the builder's old
   * `maybeEnqueueLevel1` — threshold check → oldest-chunk selection →
   * active-job overlap check → insert — except the compact-tier token count is
   * computed *without* a full context build: the same primitives the builder
   * uses (summary coverage cursor → raw events after it → compact rendering),
   * minus the rich tail the compaction boundary would carve off. No session, no
   * satellite/diary/retrieval work — strictly cheaper than a build.
   *
   * Enqueues at most ONE job per reconcile (matching the old one-per-build
   * behaviour); the worker pool's completion callback re-reconciles, so the
   * next over-threshold chunk is enqueued the moment the first completes.
   */
  private async reconcileTimelineInner(timelineKey: string): Promise<void> {
    const { storage, store, config } = this.options;
    if (config.enabled === false) return;

    const generationThreshold = config.generation_threshold_tokens ?? 6000;

    // Un-summarized raw events: strictly after the summary coverage cursor.
    // The shared selection (same as the builder's) chains with event-existence
    // contiguity — without it the cursor would stall at the first summary and
    // already-summarized ranges would be re-counted and re-enqueued — and
    // includes failure placeholders for terminally failed ranges, so a failed
    // range is terminal for its RANGE (spec §7.2): the cursor advances over
    // it, its events are never counted or re-enqueued, and the builder renders
    // the placeholder. (There is deliberately NO automatic retry; the manual
    // override is deleting the failed job row, after which the next reconcile
    // re-enqueues the range.)
    const selection = selectSummaryCoverage(storage, timelineKey);
    const rawEvents = selection.coverageEndEventId
      ? store.queryAfterContext(timelineKey, selection.coverageEndEventId)
      : store.queryForContext(timelineKey, store.getCompactionState(timelineKey));
    if (rawEvents.length === 0) return;
    // Hydrate so the compact rendering (and thus token estimate) matches what a
    // build would produce — captions/previews/reply context all count.
    const events = hydrateEvents(storage, rawEvents);

    // Carve off the rich tail the compaction boundary would keep rich (mirrors
    // the builder's estimate): accumulate rich-rendered tokens from the newest
    // event until rich_target_tokens; everything older is compact-tier material.
    const richTarget = this.options.tiers.rich_target_tokens;
    let richTailTokens = 0;
    let richTailStart = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (richTailTokens >= richTarget) break;
      richTailTokens += estimateTokens(renderRichMessage(events[i]!));
      richTailStart = i;
    }

    const compactEvents = events.slice(0, richTailStart).map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      compactTokens: estimateTokens(renderCompactMessage(event)),
    }));
    const compactTotal = compactEvents.reduce((sum, e) => sum + e.compactTokens, 0);
    if (compactTotal <= generationThreshold) return;

    // Oldest chunk: accumulate until the running sum first reaches
    // leaf_input_tokens; the crossing event is included, so a single large event
    // naturally overshoots (capped in practice by the oversized-event truncation
    // at generation-build time). Defense-in-depth: the chunk stops BEFORE any
    // event covered by a terminally failed job — normally such events sit
    // behind the coverage cursor (their placeholder links the chain) and never
    // appear here, but a failed range stranded past a genuine coverage gap
    // (retention/corruption) must not be re-enqueued; the chunk then covers
    // only the gap, whose summary re-links the chain on the next reconcile.
    const failedCovered = this.failedCoveredEventIds(timelineKey);
    const leafInput = config.leaf_input_tokens ?? 4000;
    const chunk: typeof compactEvents = [];
    let running = 0;
    for (const e of compactEvents) {
      if (failedCovered.has(e.id)) break;
      chunk.push(e);
      running += e.compactTokens;
      if (running >= leafInput) break;
    }
    if (chunk.length === 0) return;

    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;

    // Skip if a pending/processing level-1 job already covers this range.
    // If cursors are missing, the timeline is in an inconsistent state — skip
    // enqueueing rather than bypass the overlap check and risk duplicates.
    const active = storage.getActiveSummarizationJobs(timelineKey, 1);
    const firstCursor = storage.getEventCursor(timelineKey, first.id);
    const lastCursor = storage.getEventCursor(timelineKey, last.id);
    if (!firstCursor || !lastCursor) return;
    const overlaps = active.some((job) => {
      const jobStart = storage.getEventCursor(timelineKey, job.inputStartId);
      const jobEnd = storage.getEventCursor(timelineKey, job.inputEndId);
      if (!jobStart || !jobEnd) return false;
      // Ranges overlap unless one is entirely before the other.
      return !cursorAfter(firstCursor, jobEnd) && !cursorAfter(jobStart, lastCursor);
    });
    if (overlaps) return;

    const jobId = `sumjob_${nanoid(10)}`;
    await storage.insertSummarizationJob({
      id: jobId,
      timelineKey,
      level: 1,
      inputStartId: first.id,
      inputEndId: last.id,
      inputTokenCount: running,
      targetTokenCount: config.leaf_target_tokens ?? 600,
      maxRetries: config.max_retries ?? 2,
    });
    this.options.logger?.info("summarization_job_enqueued", {
      jobId,
      timelineKey,
      level: 1,
      inputTokens: running,
    });
    this.options.onJobEnqueued?.();
  }

  /**
   * Event ids covered by terminally failed level-1 jobs — the chunk guard's
   * input (failed is terminal for the range; see `reconcileTimelineInner`).
   * Unresolvable ranges (boundary events gone) are skipped.
   */
  private failedCoveredEventIds(timelineKey: string): Set<string> {
    const { storage } = this.options;
    const ids = new Set<string>();
    for (const job of storage.getFailedSummarizationJobs(timelineKey, 1)) {
      const start = storage.getEventCursor(timelineKey, job.inputStartId);
      const end = storage.getEventCursor(timelineKey, job.inputEndId);
      if (!start || !end) continue;
      for (const e of storage.getTimelineEventsBetween(timelineKey, start, end)) {
        ids.add(e.id);
      }
    }
    return ids;
  }
}

/** True if cursor `a` is strictly after cursor `b` in (timestamp, received_at, id) order. */
function cursorAfter(a: TimelineCursor, b: TimelineCursor): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  return a.id > b.id;
}
