import { nanoid } from "nanoid";
import type { Storage, SummarizationJob, Summary } from "../storage/index.js";
import {
  assertRunSettledCleanly,
  wasRunAborted,
  WorkerDrainAbortError,
  type AgentSessionFactory,
  type AgentSessionRecord,
} from "../agent/index.js";
import type { SummarizationConfig } from "../config/index.js";
import type { Logger } from "../observability/index.js";
import type { PipelineActivityBus, PipelineActivityKind, PipelineStats } from "../observability/pipelines.js";
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
  /** Pipeline monitor activity bus (ARCHITECTURE.md §11); additive to the callbacks. */
  activityBus?: PipelineActivityBus;
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
  /**
   * Resolved child summaries to render for a condense (level 2+) job, in
   * chronological order — the input-addressed render material (spec
   * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1). Parallel to `parentIds` (same set,
   * same order); the full rows are needed so the builder can render them
   * directly without re-reading the timeline.
   */
  summaries?: Summary[];
}

export class SummarizationWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  /** Live agents of in-flight runs, aborted at drain (spec LLM-FAILURE-HANDLING §7). */
  private readonly activeAgents = new Set<{ abort(): void }>();
  /**
   * Agents the drain sweep in {@link stop} actually aborted (issue #13). The
   * drain-vs-cap bifurcation tests membership HERE rather than inferring a drain
   * from `!running`: a genuine cap abort (runaway tool/turn loop) that settles
   * while `stop()` is in progress would otherwise read as a drain and earn a
   * free attempt refund across restart. An agent is in this set iff `stop()`
   * called `abort()` on it.
   */
  private readonly drainSwept = new WeakSet<{ abort(): void }>();
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
    // Abort in-flight runs (spec §7): a background-class LLM request retries
    // WITHOUT BOUND at Layer-0 — during an outage an in-flight worker would
    // otherwise wait in the admission queue forever and this stop() would
    // never settle. The abort surfaces as a drain abort; the job returns to
    // 'pending' with its claim-time attempts increment compensated, and a
    // restart re-claims and re-runs it from scratch (the job queue is the
    // durable unit; mid-session inference state is deliberately not persisted).
    for (const agent of this.activeAgents) {
      // Record the agent as drain-swept BEFORE aborting so the run's
      // post-`waitForIdle` bifurcation can tell a drain abort apart from a cap
      // abort that merely coincided with the drain (issue #13).
      this.drainSwept.add(agent);
      try {
        agent.abort();
      } catch {
        /* best-effort */
      }
    }
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

  /** Read-only stats seam for the pipeline monitor (ARCHITECTURE.md §11). */
  stats(): PipelineStats {
    return {
      pool: "summarization",
      workerCount: this.options.config.worker_count ?? 1,
      maxRetries: this.options.config.max_retries ?? 2,
      inFlight: () => this.activeWorkers.size,
      notify: () => this.notifyNewWork(),
    };
  }

  /** Publish one pipeline-activity event (ARCHITECTURE.md §11); best-effort. */
  private emit(job: SummarizationJob, kind: PipelineActivityKind, status: string): void {
    this.options.activityBus?.publish({
      pool: "summarization",
      id: job.id,
      kind,
      status,
      attempts: job.attempts,
      room: job.timelineKey,
      ts: Date.now(),
    });
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
      this.emit(job, "claimed", "processing");
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

  /**
   * Post-claim terminality guard (spec §6.3 / §7.2): the wait-or-omit builder
   * polls a claimed job until it reaches a terminal state with no wall clock,
   * so a job stranded at 'processing' would stall every build on its timeline
   * for the process lifetime (only startup healing resets stale claims).
   * `runJob` terminalizes its own agent-run failures, but its storage awaits
   * (insertAgentSession, updateAgentSessionStatus, insertSummaryWithLineage, …)
   * can reject outside that guarded path — route ANY escaped rejection to the
   * same retry/fail terminalization instead of letting poll()'s log-only catch
   * swallow it.
   */
  private async processJob(job: SummarizationJob): Promise<void> {
    try {
      await this.runJob(job);
    } catch (err) {
      await this.terminalizeEscapedRejection(job, err);
    }
  }

  private async terminalizeEscapedRejection(job: SummarizationJob, err: unknown): Promise<void> {
    const { storage, logger } = this.options;
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("summarization_unexpected_rejection", {
      jobId: job.id,
      attempt: job.attempts,
      error: errMsg,
    });
    try {
      // The rejection may have escaped AFTER the row left 'processing' (e.g. an
      // onComplete callback threw once the job was already complete, or the
      // retry write landed before a later await rejected). Only a row still
      // claimed is stranded — never overwrite a terminal or re-pending row.
      const current = storage.getSummarizationJobById(job.id);
      if (!current || current.status !== "processing") return;
      if (job.attempts <= job.maxRetries) {
        await storage.retrySummarizationJob(job.id, errMsg);
        this.emit(job, "retried", "pending");
      } else {
        await storage.failSummarizationJob(job.id, errMsg);
        this.options.onError(job.id, new Error(errMsg));
        this.emit(job, "failed", "failed");
      }
    } catch (writeErr) {
      logger.error("summarization_terminalize_write_failed", {
        jobId: job.id,
        originalError: errMsg,
        writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
      // Last resort: best-effort fail so the job cannot stay 'processing'.
      try {
        await storage.failSummarizationJob(job.id, errMsg);
      } catch (failErr) {
        logger.error("summarization_fail_fallback_failed", {
          jobId: job.id,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
    }
  }

  private async runJob(job: SummarizationJob): Promise<void> {
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
      this.emit(job, "failed", "failed");
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
      // Inserted directly at 'running' (bypasses created → markRunning), so set
      // started_at here; otherwise the row would show a null start time.
      startedAt: sessionStartedAt,
      updatedAt: sessionStartedAt,
    });

    let agentError: unknown;
    try {
      // Input-addressed generation (spec SUMMARIZATION-JOB-INPUT-INTEGRITY
      // §3.1): a condense job renders its DECLARED child summaries directly —
      // never a cutoff re-derived against live state, which is what let a
      // duplicate sibling L2 be summarized in the field case (Defect B). A
      // level-1 job keeps the cutoff path (raw events get covered and pruned;
      // an existing L1 cannot masquerade as raw events), guarded by the
      // declared-vs-rendered assertion below.
      const inputMode =
        job.level === 1
          ? { summarizationCutoff: { endTimestamp: input.cutoffTimestamp } }
          : { condenseInputs: { summaries: input.summaries ?? [] } };
      const { agent, finalTurn, snapshot, tokenEstimate, usage, renderedInputIds } = await factory.create(
        syntheticSession,
        [summaryTool],
        {
          ...inputMode,
          // Priority inheritance, scheduler half (spec §5.5): the job row's
          // (possibly escalated) class admits this session's LLM request, and
          // the stable job-keyed escalation key lets a waiter raise a request
          // already queued — the synthetic session id is regenerated per
          // attempt, so the job id is the only stable handle.
          priority: job.priority,
          escalationKey: `sumjob:${job.id}`,
        },
      );

      // Declared-vs-rendered integrity assertion (spec
      // SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1 / invariant 1): the inputs the
      // builder actually rendered as "material to reduce" must equal the job's
      // declared input set. A mismatch is a programming / data-consistency
      // error — fail the run (it routes through the catch → retry → fail path,
      // committing NO artifact) rather than persist a mislabeled summary. This
      // converts the entire Defect-B class from silent corruption into a loud,
      // attributable failure.
      const declaredInputIds = job.level === 1 ? input.eventIds ?? [] : input.parentIds ?? [];
      assertDeclaredInputsRendered(job, declaredInputIds, renderedInputIds ?? []);
      // Attach snapshot + transcript capture so summarization sessions are
      // inspectable too (spec §5), plus usage actuals (spec TOKEN-USAGE-TRACKING
      // §4.3). Detached after the run settles.
      // Resolve the cost ceiling ONCE per run (spec SESSION-COST-LIMITS §3/§6) so
      // the settle log's spend-vs-ceiling line is self-contained. Summary/condense
      // sessions get the §2.2 hard cap (no soft-warn watcher), but the ceiling they
      // were measured against must still be logged rather than a misleading null.
      const costCeiling = factory.resolveSessionCostCeiling(syntheticSession.sessionType);
      const capture = attachSessionCapture(agent, {
        storage,
        sessionId: syntheticSession.id,
        snapshot,
        tokenEstimate,
        usage,
        timelineKey: syntheticSession.timelineKey,
        sessionType: syntheticSession.sessionType,
        model: factory.resolveModelId(syntheticSession.sessionType),
        maxSessionCostUsd: costCeiling,
        logger,
      });
      this.activeAgents.add(agent);
      try {
        // Drain gate: stop() may have fired between create and prompt (the
        // agent was not yet in activeAgents for the abort sweep). Don't start
        // a run the drain can no longer cancel.
        if (!this.running) throw new WorkerDrainAbortError("pool draining before run start");
        // Drive the agent directly — SessionRunner is hardwired to chat semantics
        // (send_message / NO_REPLY) and would fight a summary_tool-only session.
        // Frozen sessions (§2b) pop the final turn off the prefix; for a generation
        // build that is the runtime-suppressed `satellite` block, which already
        // carries the session type's `session_instruction` + tail — the full task
        // framing. Deliver it as the SOLE kickoff (spec
        // SUMMARIZATION-JOB-INPUT-INTEGRITY §3.3 / P5, Fix C): the old appended
        // "Summarize the conversation shown above." user turn was redundant for
        // summarize and actively wrong for condense ("conversation" contradicts the
        // condense instruction's "lower-level summaries"). The synthetic trigger
        // event still backs the `agent_sessions` trigger columns and the cutoff
        // anchor — only the extra conversational turn is removed. The neutral,
        // level-appropriate fallback is a pure safety net for the (never-hit on a
        // generation build) case where the satellite is somehow absent.
        const kickoff = finalTurn ?? neutralKickoffFor(job.level);
        await agent.prompt(kickoff as any);
        await agent.waitForIdle();
        // Outcome bifurcation (spec LLM-FAILURE-HANDLING §7). A DRAIN abort
        // (this agent was swept by stop()) is not a semantic failure: the job
        // goes back to 'pending' with its claim-time attempts increment
        // compensated. A CAP abort (runaway tool/turn loop) stays on the
        // semantic path — a degenerate run is an output problem. We test the
        // explicit drain-swept set rather than `!this.running` so a cap abort
        // that settles WHILE stop() is in progress is not misread as a drain
        // (issue #13).
        if (wasRunAborted(agent) && this.drainSwept.has(agent)) {
          throw new WorkerDrainAbortError(agent.state.errorMessage ?? "pool draining");
        }
        // pi-agent-core resolves the run promise even when the cap-driven abort
        // (§8c) or a stream error fires — it synthesizes a final message with
        // stopReason "aborted"/"error" and sets `state.errorMessage` rather than
        // throwing. Surface that as a throw HERE so a runaway/errored run routes to
        // the failure → retry path below (a partial summary is load-bearing for
        // context reconstruction, so committing one is worse than retrying).
        // Environmental LLM failures can no longer reach this point — they are
        // absorbed (unbounded) at Layer-0; what remains is content failures,
        // cap aborts, and our own code throwing — all semantic.
        assertRunSettledCleanly(agent);
      } catch (err) {
        // The run rejected (possibly before any turn_end). Best-effort flush the
        // current transcript so the discarded summarization session is still
        // inspectable (issue #1), before detaching. Never let the flush mask the
        // original error.
        try {
          await capture.flushNow();
        } catch (flushErr) {
          logger.error("session capture: error-path flush failed", {
            sessionId: syntheticSession.id,
            error: flushErr instanceof Error ? flushErr.message : String(flushErr),
          });
        }
        throw err;
      } finally {
        this.activeAgents.delete(agent);
        capture.detach();
      }
    } catch (err) {
      agentError = err;
    }

    // Drain abort (spec LLM-FAILURE-HANDLING §7): the run was cancelled by the
    // pool's own stop(), not judged. The job returns to 'pending' with its
    // claim-time attempts increment compensated; a restart re-claims and
    // re-runs from scratch. Any partial draft is discarded (it was produced by
    // an aborted run); the session row records the interruption.
    if (agentError instanceof WorkerDrainAbortError) {
      await storage.updateAgentSessionStatus(syntheticSession.id, "interrupted", {
        completedAt: Date.now(),
        error: agentError.message,
      });
      await storage.returnSummarizationJobToPending(job.id);
      logger.info("summarization_drain_requeued", {
        jobId: job.id,
        level: job.level,
        attempt: job.attempts,
      });
      this.emit(job, "retried", "pending");
      return;
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
      this.emit(job, "completed", "complete");
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
        this.emit(job, "retried", "pending");
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
      this.emit(job, "failed", "failed");
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
      this.emit(job, "failed", "failed");
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
    // The job row is persisted as `complete` (insertSummaryWithLineage), even on
    // this best-effort truncation path — `truncated` is a *summaries-row* status,
    // never a summarization_jobs status. Emit the job status so the SSE event
    // matches what the DB-derived list/detail endpoints return; the truncated
    // nature is surfaced via the projected outputSummary, not the job status.
    this.emit(job, "completed", "complete");
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
      summaries,
    };
  }
}

/**
 * Neutral, level-appropriate kickoff used ONLY as a defensive fallback when a
 * generation build somehow emits no satellite final turn (spec
 * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.3). Unlike the removed "Summarize the
 * conversation shown above." turn, it does not call condense inputs "the
 * conversation". Never the common path — the satellite + `session_instruction`
 * fully specify the task.
 */
function neutralKickoffFor(level: number): string {
  return level === 1
    ? "Summarize the messages shown above using the summary_tool."
    : "Condense the lower-level summaries shown above into a single higher-level summary using the summary_tool.";
}

/**
 * Declared-vs-rendered integrity assertion (spec
 * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1 / invariant 1). Throws when the set of
 * inputs the builder rendered as "material to reduce" differs from the job's
 * declared input set — order-independent set equality. The throw routes through
 * the worker's normal failure path (retry → fail), so a divergence becomes a
 * loud, attributable failure that commits no mislabeled artifact, never silent
 * corruption (P1/P2). For a condense build the two are equal by construction
 * (input-addressed render); for a level-1 build this is the guarantee that the
 * cutoff/coverage re-query rendered exactly the declared event range.
 */
function assertDeclaredInputsRendered(
  job: SummarizationJob,
  declared: string[],
  rendered: string[],
): void {
  const declaredSet = new Set(declared);
  const renderedSet = new Set(rendered);
  const sameSize = declaredSet.size === renderedSet.size;
  const sameMembers = sameSize && [...declaredSet].every((id) => renderedSet.has(id));
  if (sameMembers) return;
  const missing = [...declaredSet].filter((id) => !renderedSet.has(id));
  const extra = [...renderedSet].filter((id) => !declaredSet.has(id));
  throw new Error(
    `summarization input integrity violation (job ${job.id}, level ${job.level}): ` +
      `rendered inputs do not match declared inputs — ` +
      `${missing.length} declared-but-not-rendered [${missing.slice(0, 8).join(", ")}], ` +
      `${extra.length} rendered-but-not-declared [${extra.slice(0, 8).join(", ")}]`,
  );
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
