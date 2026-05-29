import { nanoid } from "nanoid";
import type { Storage, Summary } from "../storage/index.js";
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
 * two consecutive members. Cascades naturally: the level+1 completion re-runs
 * this evaluator at level+1.
 */
export async function evaluateCondensation(options: CondensationEvaluatorOptions): Promise<void> {
  const { storage, config, timelineKey, level, logger } = options;
  const fanout = config.condense_fanout ?? 5;

  const summaries = storage.getSummariesByLevel(timelineKey, level);
  if (summaries.length < fanout) return;

  // Split into contiguous runs.
  const runs: Summary[][] = [];
  let current: Summary[] = [];
  for (const summary of summaries) {
    if (current.length === 0) {
      current = [summary];
      continue;
    }
    const prev = current[current.length - 1]!;
    const interrupted = storage.hasSummaryBetween(
      timelineKey,
      level,
      prev.latestTimestamp,
      summary.earliestTimestamp,
    );
    if (interrupted) {
      runs.push(current);
      current = [summary];
    } else {
      current.push(summary);
    }
  }
  if (current.length > 0) runs.push(current);

  for (const run of runs) {
    if (run.length < fanout) continue;
    const start = run[0]!;
    const end = run[run.length - 1]!;

    // Skip if a pending/processing level+1 job already overlaps this run.
    const active = storage.getActiveSummarizationJobs(timelineKey, level + 1);
    const overlaps = active.some((job) => {
      const jobStart = storage.getSummaryById(job.inputStartId);
      const jobEnd = storage.getSummaryById(job.inputEndId);
      // Treat an unresolvable active range as overlapping — be conservative and
      // never enqueue a duplicate condensation job.
      if (!jobStart || !jobEnd) {
        logger.warn("condensation_unresolvable_active_job", {
          activeJobId: job.id,
          inputStartId: job.inputStartId,
          inputEndId: job.inputEndId,
          startResolved: !!jobStart,
          endResolved: !!jobEnd,
          timelineKey,
          level: level + 1,
        });
        return true;
      }
      return !summaryAfter(start, jobEnd) && !summaryAfter(jobStart, end);
    });
    if (overlaps) continue;

    const inputTokenCount = run.reduce((sum, s) => sum + s.tokenCount, 0);
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
      summaryCount: run.length,
    });
    logger.info("summarization_job_enqueued", {
      jobId,
      timelineKey,
      level: level + 1,
      inputTokens: inputTokenCount,
    });
  }
}
