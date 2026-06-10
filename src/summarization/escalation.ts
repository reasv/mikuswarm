import type { Storage, SummarizationJobPriority } from "../storage/index.js";
import type { Logger } from "../observability/index.js";

/**
 * Dependencies for {@link createEscalateSummary}. Narrow Picks so tests can
 * stub them without standing up the full runtime.
 */
export interface EscalateSummaryDeps {
  storage: Pick<Storage, "escalateSummarizationJob" | "getSummarizationJobById">;
  /** `LlmScheduler.escalate` bound to the scheduler singleton. */
  escalateScheduled: (key: string, priority: SummarizationJobPriority) => void;
  /** `SummarizationWorkerPool.notifyNewWork` bound to the pool. */
  notifyPool: () => void;
  logger: Logger;
}

/**
 * Build the `ContextBuilder.escalateSummary` callback (spec
 * CONCURRENCY-AND-RATE-LIMITING §5.5): one injected callback does all three
 * escalation writes, in order — job row (claim order), scheduler entry (a
 * request already queued at `background`), pool wake (so an idle worker claims
 * the escalated job immediately). The scheduler escalation is sticky, so it
 * also covers a request that registers AFTER this runs (claim/admission race).
 *
 * Escalate-vs-terminal race guard: the job can reach a terminal state between
 * the storage write resolving and the `.then` continuation running — at which
 * point the pool's onComplete/onError already ran `clearEscalation`, and a late
 * `scheduler.escalate` would re-insert a sticky entry that nothing ever cleans
 * (job ids are never reused → a permanent map entry per occurrence). So the
 * continuation re-reads the job row (synchronous SQLite read) and skips the
 * scheduler/pool writes when the job is already terminal or gone. The check and
 * the sticky insert run in the same synchronous block, and `clearEscalation`
 * always runs strictly after the terminal DB write — so a sticky entry inserted
 * here while the job is non-terminal is always cleaned up at terminal.
 */
export function createEscalateSummary(
  deps: EscalateSummaryDeps,
): (jobId: string, priority: SummarizationJobPriority) => void {
  return (jobId, priority) => {
    void deps.storage
      .escalateSummarizationJob(jobId, priority)
      .then(() => {
        const job = deps.storage.getSummarizationJobById(jobId);
        if (!job || job.status === "complete" || job.status === "failed") return;
        deps.escalateScheduled(`sumjob:${jobId}`, priority);
        deps.notifyPool();
      })
      .catch((error) =>
        deps.logger.error("summary_escalation_failed", {
          jobId,
          priority,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  };
}
