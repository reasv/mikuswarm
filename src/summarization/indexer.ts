import { nanoid } from "nanoid";
import type { Storage, TimelineCursor, Summary, SummarizationJob } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import type { SummarizationConfig, AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { estimateTokens } from "../context/tokens.js";
import { renderCompactMessage, renderRichMessage } from "../context/renderer.js";
import { selectSummaryCoverage, renderSummaryLayer } from "../context/summary-layer.js";
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
  /**
   * Optional per-timeline mirroring check (spec MULTI-AGENT-SUPPORT §10b).
   * When set and returns true for a timeline, the indexer skips enqueueing a
   * native L1 job — the mirror worker provides summaries from the donor instead.
   * Absent (legacy / no mirroring configured) → never skip.
   */
  isMirroredTimeline?: (timelineKey: string) => boolean;
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
  /**
   * Per-timeline episode latch (spec SUMMARY-LAYER-BUDGET §3): true while a
   * budget condensation episode is active. In-memory only; lost on restart —
   * benign because on restart the next max-crossing re-enters the episode.
   * Not persisted, not exported, intentionally opaque outside this class.
   */
  private readonly episodeLatch = new Map<string, boolean>();

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

    // §10b: skip mirrored timelines — the mirror worker provides summaries.
    if (this.options.isMirroredTimeline?.(timelineKey)) return;

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

    // Level-1 threshold logic: enqueue at most one new L1 job when the
    // un-summarized compact-tier token count crosses the threshold.
    let enqueued_l1 = false;
    if (rawEvents.length > 0) {
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

      if (compactTotal > generationThreshold) {
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

        if (chunk.length > 0) {
          const first = chunk[0]!;
          const last = chunk[chunk.length - 1]!;

          // Skip if a pending/processing level-1 job already covers this range.
          // If cursors are missing, the timeline is in an inconsistent state — skip
          // enqueueing rather than bypass the overlap check and risk duplicates.
          const active = storage.getActiveSummarizationJobs(timelineKey, 1);
          const firstCursor = storage.getEventCursor(timelineKey, first.id);
          const lastCursor = storage.getEventCursor(timelineKey, last.id);
          if (firstCursor && lastCursor) {
            const overlaps = active.some((job) => {
              const jobStart = storage.getEventCursor(timelineKey, job.inputStartId);
              const jobEnd = storage.getEventCursor(timelineKey, job.inputEndId);
              if (!jobStart || !jobEnd) return false;
              // Ranges overlap unless one is entirely before the other.
              return !cursorAfter(firstCursor, jobEnd) && !cursorAfter(jobStart, lastCursor);
            });
            if (!overlaps) {
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
              enqueued_l1 = true;
            }
          }
        }
      }
    }

    // Budget-driven eager condensation (spec SUMMARY-LAYER-BUDGET §4).
    // Runs after the level-1 threshold logic. When the feature is disabled
    // (summary_target_tokens = 0), this is a no-op. When rawEvents.length = 0
    // (all history summarized), we still run this check — it is most useful
    // precisely when the raw tier is empty and the summary layer is the only
    // remaining cost.
    void enqueued_l1; // used only to document that L1 work can coexist with eager
    await this.runEagerCondensation(timelineKey);
  }

  /**
   * Budget-driven eager condensation episode (spec SUMMARY-LAYER-BUDGET §3–§5).
   * Runs after the level-1 threshold logic. Computes the rendered summary-layer
   * cost, manages the in-memory per-timeline episode latch, and enqueues at most
   * ONE absorption or bootstrap job per pass. The worker pool's completion
   * callback re-reconciles, so episodes converge stepwise.
   *
   * Called only when the feature is enabled (summary_target_tokens > 0).
   */
  private async runEagerCondensation(timelineKey: string): Promise<void> {
    const { storage, config, logger } = this.options;
    const tiers = this.options.tiers;
    const summaryTarget = tiers.summary_target_tokens ?? 0;
    if (summaryTarget === 0) return; // feature disabled

    // Re-read current selection to estimate the rendered layer cost. The L1
    // pass may have just enqueued a job but its result is not yet available —
    // only the existing summaries contribute to the current estimate.
    const sel = selectSummaryCoverage(storage, timelineKey);
    if (sel.summaries.length === 0) return;

    // Estimate layer tokens: render with a dummy recency label set (labels are
    // a small fraction; using "< 1 hour ago" everywhere is a close approximation).
    const dummyLabels = sel.summaries.map(() => "< 1 hour ago");
    const layerTokens = estimateTokens(renderSummaryLayer(sel.summaries, dummyLabels));

    const summaryMax = tiers.summary_max_tokens ?? 0;
    const effectiveMax = summaryMax === 0 ? summaryTarget : summaryMax;

    // Latch transitions.
    const wasInEpisode = this.episodeLatch.get(timelineKey) ?? false;
    if (!wasInEpisode && layerTokens > effectiveMax) {
      this.episodeLatch.set(timelineKey, true);
      logger?.info("summary_budget_episode", {
        timelineKey,
        phase: "start",
        layerTokens,
        targetTokens: summaryTarget,
        maxTokens: effectiveMax,
      });
    } else if (wasInEpisode && layerTokens <= summaryTarget) {
      this.episodeLatch.set(timelineKey, false);
      logger?.info("summary_budget_episode", {
        timelineKey,
        phase: "end",
        layerTokens,
        targetTokens: summaryTarget,
        maxTokens: effectiveMax,
      });
      return; // episode ended; quiesce
    }

    if (!(this.episodeLatch.get(timelineKey) ?? false)) return; // not in an episode

    // Pick one job to enqueue this pass. Find the lowest-level eligible run.
    const fanout = config.condense_fanout ?? 5;
    const absorb_max = (() => {
      const raw = config.eager_absorb_max_children ?? 0;
      return raw === 0 ? 2 * fanout : raw;
    })();
    const min_children = config.eager_condense_min_children ?? 2;
    const condenseTarget = config.condense_target_tokens ?? 800;

    // Find the newest summary (live-edge guard): the latest latestTimestamp
    // among all complete/truncated summaries on this timeline.
    const allSummaries = sel.summaries;
    const newestLatestTs = allSummaries.reduce((m, s) => Math.max(m, s.latestTimestamp), 0);

    const maxLevel = storage.getMaxSummaryLevel(timelineKey);
    if (maxLevel === undefined) return;

    // Walk levels from lowest to highest, looking for an eligible run.
    for (let level = 1; level <= maxLevel; level++) {
      const enqueued = await this.tryEagerJobAtLevel(
        timelineKey,
        level,
        maxLevel,
        fanout,
        absorb_max,
        min_children,
        condenseTarget,
        newestLatestTs,
        layerTokens,
        summaryTarget,
      );
      if (enqueued) return; // one job per pass
    }
  }

  /**
   * Try to enqueue ONE eager job (absorb or bootstrap) at `level`. Returns
   * true if a job was enqueued.
   */
  private async tryEagerJobAtLevel(
    timelineKey: string,
    level: number,
    maxLevel: number,
    fanout: number,
    absorbMax: number,
    minChildren: number,
    condenseTarget: number,
    newestLatestTs: number,
    layerTokens: number,
    summaryTarget: number,
  ): Promise<boolean> {
    const { storage, config, logger } = this.options;

    // Get uncondensed summaries at this level (same exclusion as evaluateCondensation).
    const allAtLevel = storage.getSummariesByLevel(timelineKey, level);
    const covered = storage.getCondensedSummaryIds(timelineKey, level);
    const summaries = covered.size === 0
      ? allAtLevel
      : allAtLevel.filter((s) => !covered.has(s.id));
    if (summaries.length === 0) return false;

    // Build failed ranges for levels 1..level (same logic as evaluateCondensation).
    const failedRanges: Array<{ earliestTimestamp: number; latestTimestamp: number }> = [];
    for (let failedLevel = 1; failedLevel <= level; failedLevel++) {
      for (const job of storage.getFailedSummarizationJobs(timelineKey, failedLevel)) {
        if (failedLevel === 1) {
          const start = storage.getEventCursor(timelineKey, job.inputStartId);
          const end = storage.getEventCursor(timelineKey, job.inputEndId);
          if (!start || !end) continue;
          failedRanges.push({ earliestTimestamp: start.timestamp, latestTimestamp: end.timestamp });
        } else {
          const start = storage.getSummaryById(job.inputStartId);
          const end = storage.getSummaryById(job.inputEndId);
          if (!start || !end) continue;
          failedRanges.push({
            earliestTimestamp: start.earliestTimestamp,
            latestTimestamp: end.latestTimestamp,
          });
        }
      }
    }
    const failedRangeInGap = (prev: Summary, next: Summary): boolean =>
      failedRanges.some(
        (r) =>
          r.latestTimestamp >= prev.latestTimestamp && r.earliestTimestamp <= next.earliestTimestamp,
      );

    // Split into contiguous runs (same logic as evaluateCondensation).
    const runs: Summary[][] = [];
    let current: Summary[] = [];
    for (const summary of summaries) {
      if (current.length === 0) {
        current = [summary];
        continue;
      }
      const prev = current[current.length - 1]!;
      const interrupted =
        storage.hasSummaryBetween(timelineKey, level, prev.latestTimestamp, summary.earliestTimestamp) ||
        failedRangeInGap(prev, summary);
      if (interrupted) {
        runs.push(current);
        current = [summary];
      } else {
        current.push(summary);
      }
    }
    if (current.length > 0) runs.push(current);

    // Active jobs at level+1 (used for active-job exclusion and overlap check).
    const activeJobsAbove = storage.getActiveSummarizationJobs(timelineKey, level + 1);

    // Try each run (oldest first within the level).
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri]!;
      const r1 = run[0]!;
      const rk = run[run.length - 1]!;

      // Live-edge guard: skip a run containing the timeline's newest summary.
      if (rk.latestTimestamp >= newestLatestTs) continue;

      // Skip if an active job at level+1 overlaps this run (P4 idempotency /
      // active-job exclusion, mirroring evaluateCondensation).
      const runOverlapsActiveJob = activeJobsAbove.some((job) => {
        const jobStart = storage.getSummaryById(job.inputStartId);
        const jobEnd = storage.getSummaryById(job.inputEndId);
        if (!jobStart || !jobEnd) return false;
        return !(rk.latestTimestamp < jobStart.earliestTimestamp ||
                 r1.earliestTimestamp > jobEnd.latestTimestamp);
      });
      if (runOverlapsActiveJob) continue;

      // Find adjacent level-(level+1) parents.
      const prevRunEnd = ri > 0 ? runs[ri - 1]![runs[ri - 1]!.length - 1]!.latestTimestamp : 0;
      const nextRunStart = ri < runs.length - 1 ? runs[ri + 1]![0]!.earliestTimestamp : Infinity;
      // Only consider parents that are resident in the summary layer — i.e. not already
      // condensed into a level-(level+2) summary. A condensed parent contributes zero tokens
      // to the rendered layer; absorbing into it reduces cost by nothing, wastes inference,
      // and can orphan the replacement outside the grandparent's child list (spec §5).
      const allParents = storage.getSummariesByLevel(timelineKey, level + 1);
      const condensedParentIds = storage.getCondensedSummaryIds(timelineKey, level + 1);
      const parents = condensedParentIds.size === 0
        ? allParents
        : allParents.filter((p) => !condensedParentIds.has(p.id));

      // Left-adjacent: parent's coverage ends in the gap before this run.
      const leftCandidates = parents.filter(
        (p) => p.latestTimestamp > prevRunEnd && p.latestTimestamp <= r1.earliestTimestamp,
      );
      // Right-adjacent: parent's coverage starts in the gap after this run.
      const rightCandidates = parents.filter(
        (p) => p.earliestTimestamp >= rk.latestTimestamp && p.earliestTimestamp < nextRunStart,
      );

      // Prefer older neighbor (left) per spec; left candidate has max latestTimestamp
      // (closest to run), right candidate has min earliestTimestamp.
      const leftParent =
        leftCandidates.length > 0
          ? leftCandidates.reduce((a, b) => (a.latestTimestamp >= b.latestTimestamp ? a : b))
          : undefined;
      const rightParent =
        rightCandidates.length > 0
          ? rightCandidates.reduce((a, b) =>
              a.earliestTimestamp <= b.earliestTimestamp ? a : b,
            )
          : undefined;

      // Check capacity and failed-range validity for each candidate.
      const findAbsorbParent = (candidate: Summary | undefined): {
        parent: Summary;
        childIds: string[];
        runToAbsorb: Summary[];
      } | undefined => {
        if (!candidate) return undefined;
        const childIds = storage.getSummaryParentIds(candidate.id);
        // Check failed range: no failed range should interrupt the combined
        // span (P's children + run members).
        const combinedStart = Math.min(candidate.earliestTimestamp, r1.earliestTimestamp);
        const combinedEnd = Math.max(candidate.latestTimestamp, rk.latestTimestamp);
        const combinedSpanHasFailedRange = failedRanges.some(
          (r) => r.latestTimestamp >= combinedStart && r.earliestTimestamp <= combinedEnd,
        );
        if (combinedSpanHasFailedRange) return undefined;
        // Check active-job overlap for the combined span.
        const combinedOverlapsActiveJob = activeJobsAbove.some((job) => {
          const jobStart = storage.getSummaryById(job.inputStartId);
          const jobEnd = storage.getSummaryById(job.inputEndId);
          if (!jobStart || !jobEnd) return false;
          return !(combinedEnd < jobStart.earliestTimestamp ||
                   combinedStart > jobEnd.latestTimestamp);
        });
        if (combinedOverlapsActiveJob) return undefined;
        // Capacity: P's current children + run length ≤ absorb_max.
        // If at capacity, truncate run to oldest members that fit.
        const capacity = absorbMax - childIds.length;
        if (capacity <= 0) return undefined; // P is full; cannot absorb any run members
        const runToAbsorb = run.slice(0, capacity); // oldest-first truncation
        // Guaranteed-saving guard for absorption:
        // rendered(P) + Σ rendered(run) − condense_target ≥ condense_target
        // => rendered(P) + Σ rendered(run) ≥ 2 × condense_target
        const renderedP = estimateTokens(renderSummaryLayer([candidate], ["< 1 hour ago"]));
        const renderedRunTokens = runToAbsorb.reduce(
          (sum, s) => sum + estimateTokens(renderSummaryLayer([s], ["< 1 hour ago"])),
          0,
        );
        const savingGuard =
          renderedP + renderedRunTokens - condenseTarget >= condenseTarget;
        if (!savingGuard) return undefined;
        return { parent: candidate, childIds, runToAbsorb };
      };

      const leftAbsorb = findAbsorbParent(leftParent);
      const rightAbsorb = findAbsorbParent(rightParent);

      // Prefer older neighbor (left) when both qualify.
      const absorb = leftAbsorb ?? rightAbsorb;
      if (absorb) {
        const { parent, childIds, runToAbsorb } = absorb;
        // Build the combined child list: P's original children ∪ run members,
        // ordered chronologically.
        const allChildren: Summary[] = [];
        // P's original children by id — fetch their summaries.
        for (const cid of childIds) {
          const s = storage.getSummaryById(cid);
          if (s) allChildren.push(s);
        }
        for (const s of runToAbsorb) {
          allChildren.push(s);
        }
        allChildren.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);
        const first = allChildren[0]!;
        const last = allChildren[allChildren.length - 1]!;

        const inputTokenCount = allChildren.reduce((sum, s) => sum + s.tokenCount, 0);
        const jobId = `sumjob_${nanoid(10)}`;
        await storage.insertSummarizationJob({
          id: jobId,
          timelineKey,
          level: level + 1, // same level as P
          inputStartId: first.id,
          inputEndId: last.id,
          inputTokenCount,
          targetTokenCount: condenseTarget,
          maxRetries: config.max_retries ?? 2,
          absorbedParentId: parent.id,
        });
        logger?.info("summary_budget_condense_enqueued", {
          timelineKey,
          shape: "absorb",
          summaryLevel: level + 1,
          runLength: runToAbsorb.length,
          parentId: parent.id,
          childCount: allChildren.length,
          layerTokens,
          jobId,
        });
        logger?.info("summarization_job_enqueued", {
          jobId,
          timelineKey,
          level: level + 1,
          inputTokens: inputTokenCount,
        });
        this.options.onJobEnqueued?.();
        return true;
      }

      // Bootstrap fallback: no adjacent parent with capacity.
      // Top-level guard: never bootstrap at the timeline's current max level.
      if (level === maxLevel) continue;

      // Minimum-run guard: need at least minChildren members.
      if (run.length < minChildren) continue;

      // Check that an active job at level+1 doesn't already cover this exact run.
      const alreadyBlocked = activeJobsAbove.some((job) => {
        const jobStart = storage.getSummaryById(job.inputStartId);
        const jobEnd = storage.getSummaryById(job.inputEndId);
        if (!jobStart || !jobEnd) return job.status !== "failed";
        return !(rk.latestTimestamp < jobStart.earliestTimestamp ||
                 r1.earliestTimestamp > jobEnd.latestTimestamp);
      });
      if (alreadyBlocked) continue;

      // Also check failed jobs at level+1 (terminal failure = never re-enqueue).
      const failedJobsAbove = storage.getFailedSummarizationJobs(timelineKey, level + 1);
      const alreadyFailed = failedJobsAbove.some((job) => {
        const jobStart = storage.getSummaryById(job.inputStartId);
        const jobEnd = storage.getSummaryById(job.inputEndId);
        if (!jobStart || !jobEnd) return false;
        return !(rk.latestTimestamp < jobStart.earliestTimestamp ||
                 r1.earliestTimestamp > jobEnd.latestTimestamp);
      });
      if (alreadyFailed) continue;

      // Bootstrap: condense oldest fanout (or min_children..) members of the run.
      const chunk = run.slice(0, fanout);
      const chunkFirst = chunk[0]!;
      const chunkLast = chunk[chunk.length - 1]!;

      // Guaranteed-saving guard for bootstrap:
      // Σ rendered(run) ≥ 2 × condense_target
      const renderedBootstrap = chunk.reduce(
        (sum, s) => sum + estimateTokens(renderSummaryLayer([s], ["< 1 hour ago"])),
        0,
      );
      if (renderedBootstrap < 2 * condenseTarget) continue;

      const inputTokenCount = chunk.reduce((sum, s) => sum + s.tokenCount, 0);
      const jobId = `sumjob_${nanoid(10)}`;
      await storage.insertSummarizationJob({
        id: jobId,
        timelineKey,
        level: level + 1,
        inputStartId: chunkFirst.id,
        inputEndId: chunkLast.id,
        inputTokenCount,
        targetTokenCount: condenseTarget,
        maxRetries: config.max_retries ?? 2,
        // No absorbedParentId — this is a new parent
      });
      logger?.info("summary_budget_condense_enqueued", {
        timelineKey,
        shape: "bootstrap",
        summaryLevel: level + 1,
        runLength: chunk.length,
        childCount: chunk.length,
        layerTokens,
        jobId,
      });
      logger?.info("summarization_job_enqueued", {
        jobId,
        timelineKey,
        level: level + 1,
        inputTokens: inputTokenCount,
      });
      this.options.onJobEnqueued?.();
      return true;
    }

    return false;
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
