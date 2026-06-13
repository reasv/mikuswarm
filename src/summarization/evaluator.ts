import { nanoid } from "nanoid";
import type { Storage, Summary, SummarizationJob } from "../storage/index.js";
import type { SummarizationConfig } from "../config/index.js";
import type { Logger } from "../observability/index.js";

export interface CondensationEvaluatorOptions {
  storage: Storage;
  config: SummarizationConfig;
  timelineKey: string;
  /** Level of the summary that just completed; condensation produces level + 1. */
  level: number;
  logger: Logger;
}

/** Order key for summaries: (earliest_timestamp, id) ascending. */
function summaryAfter(a: Summary, b: Summary): boolean {
  if (a.earliestTimestamp !== b.earliestTimestamp) return a.earliestTimestamp > b.earliestTimestamp;
  return a.id > b.id;
}

/**
 * After a summary completes, look for contiguous runs of same-level summaries
 * long enough to condense, and enqueue level+1 jobs for them (§9). A run is
 * "contiguous" when no summary at the same or higher level sits strictly between
 * two consecutive members, AND no terminally failed range (of any level <= the
 * input level) sits in the gap. Cascades naturally: the level+1 completion
 * re-runs this evaluator at level+1.
 */
export async function evaluateCondensation(options: CondensationEvaluatorOptions): Promise<void> {
  const { storage, config, timelineKey, level, logger } = options;
  const fanout = config.condense_fanout ?? 5;

  // Fix A — condensation idempotency on input identity (spec
  // SUMMARIZATION-JOB-INPUT-INTEGRITY §3.2 / P4): a level-N summary already
  // condensed into a completed level-(N+1) summary is NOT a condensation
  // candidate. Exclude the covered set (lineage-keyed, via `summary_parents`)
  // before run-splitting so re-evaluation of unchanged timeline state enqueues
  // nothing new. This mirrors render-time pruning and closes the duplicate-
  // enqueue gap (Defect A) that triggered the field case — the existing
  // active/failed `blocksChunk` checks below remain the in-flight / terminal-
  // failure guards; this handles the COMPLETED case they never consulted.
  const allSummaries = storage.getSummariesByLevel(timelineKey, level);
  const covered = storage.getCondensedSummaryIds(timelineKey, level);
  const summaries = covered.size === 0 ? allSummaries : allSummaries.filter((s) => !covered.has(s.id));
  if (summaries.length < fanout) return;

  // Terminally failed ranges interrupt runs at EVERY level above them: a
  // level-1 failure's placeholder (spec §7.2) is synthesized at selection
  // time, never persisted, and a level-2+ condensation failure permanently
  // strands its input summaries between their condensed neighbors. In both
  // cases selection prunes any summary fully covered by a selected
  // higher-level one — so a condensed summary whose span crossed a failed
  // range would permanently erase the failure marker (level 1) or the
  // stranded input summaries' content (level 2+) from context. At input
  // level N the evaluator therefore consults failed jobs at every level <= N
  // (failed level N+1 jobs are the chunk-skip below, not run interrupters):
  // level-1 ranges resolve via their boundary events' cursors, level-2+
  // ranges via their input summaries' spans. Mirrors the indexer's
  // `failedCoveredEventIds` chunk guard. Unresolvable ranges (boundary
  // events retention-deleted; input summaries gone) are skipped, symmetric
  // with `synthesizeFailurePlaceholders` and the chunk-skip's failed-side
  // handling — nothing renders or remains selectable for them, so there is
  // nothing to protect.
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

  // Split into contiguous runs.
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

  // Jobs that block a chunk from being enqueued: pending/processing level+1
  // jobs (skip duplicates), and terminally FAILED level+1 jobs — `failed` is
  // terminal for that condensation range, mirroring the level-1 terminality
  // (spec §7.2): the failure is content-determined (retries exhausted) and
  // re-enqueueing would loop the same doomed job forever on the background
  // budget. Nothing is lost — the input summaries remain selectable; the range
  // simply never condenses. The manual override is deleting the failed job
  // row, after which the next evaluation re-enqueues the chunk. Fetched once:
  // chunks never overlap each other, so a job inserted below cannot overlap a
  // later chunk.
  const activeJobs = storage.getActiveSummarizationJobs(timelineKey, level + 1);
  const failedJobs = storage.getFailedSummarizationJobs(timelineKey, level + 1);

  for (const run of runs) {
    // Chunk oversized runs into fanout-sized segments. The last chunk may be
    // smaller than fanout — only enqueue it if it meets the minimum (>= fanout).
    // Leftover summaries below the threshold stay as stranded summaries until
    // more accumulate.
    for (let chunkStart = 0; chunkStart + fanout <= run.length; chunkStart += fanout) {
      const chunk = run.slice(chunkStart, chunkStart + fanout);
      const start = chunk[0]!;
      const end = chunk[chunk.length - 1]!;

      const blocksChunk = (job: SummarizationJob): boolean => {
        const jobStart = storage.getSummaryById(job.inputStartId);
        const jobEnd = storage.getSummaryById(job.inputEndId);
        if (!jobStart || !jobEnd) {
          logger.warn("condensation_unresolvable_job_range", {
            jobId: job.id,
            jobStatus: job.status,
            inputStartId: job.inputStartId,
            inputEndId: job.inputEndId,
            startResolved: !!jobStart,
            endResolved: !!jobEnd,
            timelineKey,
            level: level + 1,
          });
          // Unresolvable ACTIVE range: treat as overlapping — be conservative
          // and never enqueue a possible duplicate. Unresolvable FAILED range:
          // treat as non-blocking — its input summaries are gone, so a chunk
          // built from existing summaries cannot be the same doomed input.
          return job.status !== "failed";
        }
        return !summaryAfter(start, jobEnd) && !summaryAfter(jobStart, end);
      };
      if (activeJobs.some(blocksChunk) || failedJobs.some(blocksChunk)) continue;

      const inputTokenCount = chunk.reduce((sum, s) => sum + s.tokenCount, 0);
      const jobId = `sumjob_${nanoid(10)}`;
      await storage.insertSummarizationJob({
        id: jobId,
        timelineKey,
        level: level + 1,
        inputStartId: start.id,
        inputEndId: end.id,
        inputTokenCount,
        targetTokenCount: config.condense_target_tokens ?? 800,
        maxRetries: config.max_retries ?? 2,
      });
      logger.info("condensation_triggered", {
        timelineKey,
        sourceLevel: level,
        summaryCount: chunk.length,
      });
      logger.info("summarization_job_enqueued", {
        jobId,
        timelineKey,
        level: level + 1,
        inputTokens: inputTokenCount,
      });
    }
  }
}
