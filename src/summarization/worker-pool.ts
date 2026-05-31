import { nanoid } from "nanoid";
import type { Storage, SummarizationJob } from "../storage/index.js";
import type { AgentSessionFactory, AgentSessionRecord } from "../agent/index.js";
import type { SummarizationConfig } from "../config/index.js";
import type { Logger } from "../observability/index.js";
import type { CanonicalChatEvent } from "../types.js";
import { SummaryDraft, createSummaryTool } from "../tools/index.js";
import { estimateTokens, truncateToTokens } from "../context/index.js";
import { attachSessionCapture } from "../agent/session-capture.js";
import { evaluateCondensation } from "./evaluator.js";

export interface SummarizationWorkerPoolOptions {
  storage: Storage;
  factory: AgentSessionFactory;
  config: SummarizationConfig;
  onComplete: (jobId: string, summaryId: string) => void;
  /** Fires only on permanent (non-retriable) failures — not on retries. */
  onError: (jobId: string, error: Error) => void;
  logger: Logger;
}

/** Material resolved from a job's input range, ready to persist as a summary. */
interface ResolvedInput {
  cutoffTimestamp: number;
  earliestTimestamp: number;
  latestTimestamp: number;
  latestEventId: string;
  eventCount: number;
  modelId: string;
  /** Ordered leaf event IDs (level 1). */
  eventIds?: string[];
  /** Ordered parent summary IDs (level 2+). */
  parentIds?: string[];
}

export class SummarizationWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeResolve?: () => void;

  constructor(private readonly options: SummarizationWorkerPoolOptions) {}

  async start(): Promise<void> {
    this.running = true;
    const resetCount = await this.options.storage.resetStaleSummarizationJobs();
    if (resetCount > 0) {
      this.options.logger.info("summarization_reset_stale", { count: resetCount });
    }
    this.schedulePoll(100);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.wakeResolve) this.wakeResolve();
    await Promise.allSettled([...this.activeWorkers]);
  }

  notifyNewWork(): void {
    if (this.wakeResolve) {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
      this.wakeResolve();
      this.wakeResolve = undefined;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll().catch((error) =>
        this.options.logger.error("summarization_poll_error", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    const workerCount = this.options.config.worker_count ?? 1;
    const available = workerCount - this.activeWorkers.size;
    if (available <= 0) {
      this.schedulePoll(100);
      return;
    }

    let claimedAny = false;
    for (let i = 0; i < available; i++) {
      const job = await this.options.storage.claimNextSummarizationJob();
      if (!job) break;
      claimedAny = true;
      const work = this.processJob(job)
        .catch((error) =>
          this.options.logger.error("summarization_worker_error", {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          this.activeWorkers.delete(work);
          if (this.running) this.schedulePoll(0);
        });
      this.activeWorkers.add(work);
    }

    if (!claimedAny) {
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        this.pollTimer = setTimeout(() => {
          this.wakeResolve = undefined;
          resolve();
        }, 1000);
      });
      if (!this.running) return;
      this.schedulePoll(0);
      return;
    }

    if (this.running) this.schedulePoll(100);
  }

  private async processJob(job: SummarizationJob): Promise<void> {
    const { storage, factory, config, logger } = this.options;
    const started = Date.now();
    logger.debug("summarization_job_claimed", {
      jobId: job.id,
      timelineKey: job.timelineKey,
      level: job.level,
      attempt: job.attempts,
    });

    const input = this.resolveInput(job);
    if (!input) {
      // Input material no longer resolvable (e.g. events dropped). Nothing to do.
      await storage.failSummarizationJob(job.id, "input material not found");
      this.options.onError(job.id, new Error("input material not found"));
      return;
    }

    const draft = new SummaryDraft();
    const summaryTool = createSummaryTool({
      draft,
      targetTokenCount: job.targetTokenCount,
      maxOverageFactor: config.summary_max_overage_factor ?? 2.5,
    });

    const syntheticTrigger: CanonicalChatEvent = {
      id: `summarize:${job.id}`,
      timelineKey: job.timelineKey,
      provider: "system",
      role: "user",
      sender: { id: "system", displayName: "Summarization" },
      body: "Summarize the conversation shown above.",
      timestamp: input.cutoffTimestamp,
      receivedAt: Date.now(),
    };
    const syntheticSession: AgentSessionRecord = {
      // Unique per attempt: each summarization run is a real, separately
      // inspectable session, and reusing `sumjob:${job.id}` across retries of the
      // same job would collide on the agent_sessions PRIMARY KEY.
      id: `s-${nanoid(10)}`,
      timelineKey: job.timelineKey,
      sessionType: job.level === 1 ? "summarize" : "condense",
      status: "running",
      trigger: {
        provider: "system",
        timelineKey: job.timelineKey,
        event: syntheticTrigger,
      },
      createdAt: Date.now(),
    };

    // This synthetic session bypasses SessionManager, so write its durable
    // agent_sessions row inline. It runs immediately, so insert as 'running'.
    const sessionStartedAt = Date.now();
    await storage.insertAgentSession({
      id: syntheticSession.id,
      timelineKey: job.timelineKey,
      sessionType: syntheticSession.sessionType,
      status: "running",
      modelId: input.modelId,
      triggerEventId: syntheticTrigger.id,
      triggerBody: syntheticTrigger.body,
      createdAt: sessionStartedAt,
      updatedAt: sessionStartedAt,
    });

    let agentError: unknown;
    try {
      const { agent, finalTurn, snapshot, tokenEstimate } = await factory.create(
        syntheticSession,
        [summaryTool],
        { summarizationCutoff: { endTimestamp: input.cutoffTimestamp } },
      );
      // Attach snapshot + transcript capture so summarization sessions are
      // inspectable too (spec §5). Detached after the run settles.
      const detachCapture = attachSessionCapture(agent, {
        storage,
        sessionId: syntheticSession.id,
        snapshot,
        tokenEstimate,
        logger,
      });
      try {
        // Drive the agent directly — SessionRunner is hardwired to chat semantics
        // (send_message / NO_REPLY) and would fight a summary_tool-only session.
        // Frozen sessions (§2b) pop the final turn off the prefix; for a cutoff build
        // that is the runtime-suppressed `satellite` block. Deliver it followed by the
        // summarize instruction as the kickoff turns, preserving the prior ordering.
        const kickoff = finalTurn
          ? [finalTurn, { role: "user", content: syntheticTrigger.body, timestamp: syntheticTrigger.timestamp }]
          : syntheticTrigger.body;
        await agent.prompt(kickoff as any);
        await agent.waitForIdle();
      } finally {
        detachCapture();
      }
    } catch (err) {
      agentError = err;
    }

    const content = draft.getContent();
    const succeeded = !agentError && draft.isCreated() && content.trim().length > 0;

    // Record the synthetic session's terminal status (spec §5). Content capture
    // is handled by attachSessionCapture above; this only flips status/error.
    if (succeeded) {
      await storage.updateAgentSessionStatus(syntheticSession.id, "completed", {
        completedAt: Date.now(),
      });
    } else {
      const sessionErr = agentError instanceof Error
        ? agentError.message
        : agentError != null
          ? String(agentError)
          : "summary draft empty or not created";
      await storage.updateAgentSessionStatus(syntheticSession.id, "discarded", {
        completedAt: Date.now(),
        error: sessionErr,
      });
    }

    if (succeeded) {
      const summaryId = `sum_${nanoid(10)}`;
      const tokenCount = estimateTokens(content);
      await storage.insertSummaryWithLineage({
        id: summaryId,
        timelineKey: job.timelineKey,
        level: job.level,
        content,
        earliestTimestamp: input.earliestTimestamp,
        latestTimestamp: input.latestTimestamp,
        latestEventId: input.latestEventId,
        eventCount: input.eventCount,
        tokenCount,
        modelId: input.modelId,
        status: "complete",
        generatedAt: Date.now(),
        eventIds: input.eventIds,
        parentIds: input.parentIds,
        jobId: job.id,
      });
      logger.info("summarization_complete", {
        jobId: job.id,
        summaryId,
        level: job.level,
        tokenCount,
        elapsed: Date.now() - started,
      });
      this.options.onComplete(job.id, summaryId);
      await this.runCondensation(job.timelineKey, job.level);
      return;
    }

    // Failure path. attempts was already incremented at claim time.
    const errMsg = agentError instanceof Error
      ? agentError.message
      : agentError != null
        ? String(agentError)
        : "summary draft empty or not created";

    if (content.trim().length > 0) {
      const existing = job.bestEffortDraft;
      if (!existing || estimateTokens(content) < estimateTokens(existing)) {
        await storage.saveBestEffortDraft(job.id, content);
      }
    }

    logger.error("summarization_failed", {
      jobId: job.id,
      level: job.level,
      attempt: job.attempts,
      error: errMsg,
    });

    try {
      if (job.attempts <= job.maxRetries) {
        await storage.retrySummarizationJob(job.id, errMsg);
      } else {
        await this.truncationFallback(
          job,
          input,
          errMsg,
          draft.isCreated() ? draft.getContent() : undefined,
        );
      }
    } catch (writeErr) {
      // Retry/truncation write failed — try to fail the job so it doesn't stay
      // stuck in 'processing' forever.
      const writeErrMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      logger.error("summarization_retry_write_failed", {
        jobId: job.id,
        originalError: errMsg,
        writeError: writeErrMsg,
      });
      try {
        await storage.failSummarizationJob(job.id, `retry/truncation write failed: ${writeErrMsg}`);
      } catch (failErr) {
        logger.error("summarization_fail_fallback_failed", {
          jobId: job.id,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
      this.options.onError(job.id, new Error(errMsg));
    }
  }

  /** §10 truncation fallback: salvage the best-effort draft or give up. */
  private async truncationFallback(
    job: SummarizationJob,
    input: ResolvedInput,
    errMsg: string,
    currentDraftContent?: string,
  ): Promise<void> {
    const { storage, logger } = this.options;
    // Re-read the job to get the authoritative shortest draft saved across all
    // attempts (the best-effort save at line 232-234 already ran before this
    // method is called). Compare with the current attempt's draft by token count
    // and pick whichever is shorter.
    const savedDraft = storage.getSummarizationJobById(job.id)?.bestEffortDraft;
    const hasCurrent = currentDraftContent != null && currentDraftContent.trim().length > 0;
    const hasSaved = savedDraft != null && savedDraft.trim().length > 0;
    let bestEffort: string | undefined;
    if (hasCurrent && hasSaved) {
      bestEffort = estimateTokens(currentDraftContent!) <= estimateTokens(savedDraft!)
        ? currentDraftContent
        : savedDraft;
    } else {
      bestEffort = hasCurrent ? currentDraftContent : hasSaved ? savedDraft : undefined;
    }

    if (!bestEffort || bestEffort.trim().length === 0) {
      await storage.failSummarizationJob(job.id, errMsg || "no best-effort draft");
      this.options.onError(job.id, new Error(errMsg || "summarization failed"));
      return;
    }

    const originalTokens = estimateTokens(bestEffort);
    const content =
      originalTokens > job.targetTokenCount
        ? truncateToBudget(bestEffort, job.targetTokenCount)
        : bestEffort;
    const truncatedTokens = estimateTokens(content);

    const summaryId = `sum_${nanoid(10)}`;
    await storage.insertSummaryWithLineage({
      id: summaryId,
      timelineKey: job.timelineKey,
      level: job.level,
      content,
      earliestTimestamp: input.earliestTimestamp,
      latestTimestamp: input.latestTimestamp,
      latestEventId: input.latestEventId,
      eventCount: input.eventCount,
      tokenCount: truncatedTokens,
      modelId: input.modelId,
      status: "truncated",
      generatedAt: Date.now(),
      eventIds: input.eventIds,
      parentIds: input.parentIds,
      jobId: job.id,
    });
    logger.warn("summarization_truncated", {
      jobId: job.id,
      summaryId,
      level: job.level,
      originalTokens,
      truncatedTokens,
    });
    this.options.onComplete(job.id, summaryId);
    await this.runCondensation(job.timelineKey, job.level);
  }

  private async runCondensation(timelineKey: string, level: number): Promise<void> {
    await evaluateCondensation({
      storage: this.options.storage,
      config: this.options.config,
      timelineKey,
      level,
      logger: this.options.logger,
    }).catch((error) =>
      this.options.logger.error("condensation_evaluator_error", {
        timelineKey,
        level,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * Resolve the job's input range to concrete material via cursors (never raw
   * id BETWEEN, since nanoids are not chronologically sortable). Returns
   * undefined when the range can no longer be resolved.
   */
  private resolveInput(job: SummarizationJob): ResolvedInput | undefined {
    const { storage, factory } = this.options;
    const modelId = factory.resolveModelId(job.level === 1 ? "summarize" : "condense");

    if (job.level === 1) {
      const start = storage.getEventCursor(job.timelineKey, job.inputStartId);
      const end = storage.getEventCursor(job.timelineKey, job.inputEndId);
      if (!start || !end) return undefined;
      const events = storage.getTimelineEventsBetween(job.timelineKey, start, end);
      if (events.length === 0) return undefined;
      const latestTimestamp = Math.max(...events.map((e) => e.timestamp));
      return {
        cutoffTimestamp: latestTimestamp,
        earliestTimestamp: events[0]!.timestamp,
        latestTimestamp,
        latestEventId: events[events.length - 1]!.id,
        eventCount: events.length,
        modelId,
        eventIds: events.map((e) => e.id),
      };
    }

    const summaries = storage.getSummariesBetween(job.timelineKey, job.inputStartId, job.inputEndId, job.level - 1);
    if (summaries.length === 0) return undefined;
    const latestTimestamp = Math.max(...summaries.map((s) => s.latestTimestamp));
    const last = summaries[summaries.length - 1]!;
    return {
      cutoffTimestamp: latestTimestamp,
      earliestTimestamp: summaries[0]!.earliestTimestamp,
      latestTimestamp,
      latestEventId: last.latestEventId,
      eventCount: summaries.reduce((sum, s) => sum + s.eventCount, 0),
      modelId,
      parentIds: summaries.map((s) => s.id),
    };
  }
}

const TRUNCATION_TRAILER =
  "\n\n[Summary truncated — original exceeded size limit. Coverage may be incomplete.]";

/**
 * Hard-truncate over-budget text to roughly target_token_count, preferring a
 * sentence boundary within the last 20% of the clipped text (§10).
 * Uses the real BPE tokenizer to respect the budget precisely. The trailer is
 * accounted for in the token budget so the final result stays within bounds.
 */
/** @internal Exported for testing. */
export function truncateToBudget(text: string, targetTokenCount: number): string {
  const trailerTokens = estimateTokens(TRUNCATION_TRAILER);
  const bodyBudget = Math.max(1, targetTokenCount - trailerTokens);
  let clipped = truncateToTokens(text, bodyBudget);
  const minBoundary = Math.floor(clipped.length * 0.8);
  const matches = [...clipped.matchAll(/[.!?。！？](?:\s|$)/g)];
  const lastBoundary = matches.length > 0 ? matches[matches.length - 1]!.index ?? -1 : -1;
  if (lastBoundary >= minBoundary) {
    clipped = clipped.slice(0, lastBoundary + 1);
  }
  return `${clipped}${TRUNCATION_TRAILER}`;
}
