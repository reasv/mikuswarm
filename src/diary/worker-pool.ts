import { nanoid } from "nanoid";
import type { Storage, DiaryJob, MemoryFileWriter } from "../storage/index.js";
import {
  assertRunSettledCleanly,
  wasRunAborted,
  WorkerDrainAbortError,
  type AgentSessionFactory,
  type AgentSessionRecord,
} from "../agent/index.js";
import type { DiaryConfig } from "../config/index.js";
import type { Logger } from "../observability/index.js";
import type { PipelineActivityBus, PipelineActivityKind, PipelineStats } from "../observability/pipelines.js";
import type { CanonicalChatEvent } from "../types.js";
import { SummaryDraft, createDiaryTool } from "../tools/index.js";
import { roomIdFromTimelineKey } from "../timeline/index.js";
import { attachSessionCapture } from "../agent/session-capture.js";
import { agentDateStamp } from "../time/index.js";
import { buildDiaryHeader, draftBeginsWithHeader } from "./header.js";
import { recentMemoryWindow } from "./recent-window.js";

export interface DiaryWorkerPoolOptions {
  storage: Storage;
  factory: AgentSessionFactory;
  /** Single-writer FIFO for the day-file append (shared with `write_memory`, §9b). */
  memoryWriter: MemoryFileWriter;
  config: DiaryConfig;
  workspaceRoot: string;
  /**
   * Resolve a human channel label for a timeline (Matrix: `Room (Space)`). May
   * throw; the worker retries a few times and falls back to the room id parsed
   * from the timeline key, so the header (mandatory) never blocks a diary job.
   */
  resolveChannelLabel: (timelineKey: string) => Promise<string>;
  onComplete?: (summaryId: string) => void;
  onError?: (summaryId: string, error: Error) => void;
  /** Pipeline monitor activity bus (ARCHITECTURE.md §11); additive to the callbacks. */
  activityBus?: PipelineActivityBus;
  logger: Logger;
}

const DEFAULT_PER_SESSION_BUDGET = 1200;
const DEFAULT_RECENCY_MAX_TOKENS = 6000;
const DEFAULT_RECENCY_FILE_COUNT = 2;
const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_DIARY_INSTRUCTION = `Write a NEW first-person diary entry about YOUR OWN part in the conversation shown above (in {{room}}): what you said and did, how you reacted, opinions you formed, running bits, things you promised to do. A neutral record of the conversation exists elsewhere — do not recap the room; write only your own thread, in your own voice. Build on your existing recent memory shown above (don't restate it).

Begin your entry with EXACTLY this header line:
{{header}}

Then write your entry below it (markdown is fine; be concise). Use the diary_tool: \`create\` to start, then \`str_replace\`/\`insert\` to revise, and set \`finalize: true\` on your final call. If there is genuinely nothing worth recording, call diary_tool with command \`view\` and \`finalize: true\` on the empty draft to finish without writing anything.`;

/**
 * Diary worker pool (ARCHITECTURE.md §9c) — structurally identical to the
 * summarization pool. Polls level-1 summaries with `diary_status='pending'`, claims
 * via CAS, and spawns one diary session per range that writes a first-person entry
 * appended to the shared `memory/YYYY-MM-DD.md` store.
 */
export class DiaryWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  /** Live agents of in-flight runs, aborted at drain (spec LLM-FAILURE-HANDLING §7). */
  private readonly activeAgents = new Set<{ abort(): void }>();
  /**
   * Agents the drain sweep in {@link stop} actually aborted (issue #13). The
   * drain-vs-cap bifurcation tests membership HERE rather than inferring a drain
   * from `!running`, so a cap abort (runaway tool/turn loop) that settles while
   * `stop()` is in progress is not misread as a drain and refunded an attempt.
   */
  private readonly drainSwept = new WeakSet<{ abort(): void }>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeResolve?: () => void;

  constructor(private readonly options: DiaryWorkerPoolOptions) {}

  async start(): Promise<void> {
    this.running = true;
    const resetCount = await this.options.storage.resetStaleDiary();
    if (resetCount > 0) {
      this.options.logger.info("diary_reset_stale", { count: resetCount });
    }
    this.schedulePoll(100);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.wakeResolve) this.wakeResolve();
    // Abort in-flight runs (spec §7): background-class LLM requests retry
    // without bound at Layer-0, so an in-flight diary run could otherwise wait
    // out an outage in the admission queue and hang this stop() forever. The
    // abort surfaces as a drain abort → the job returns to 'pending' with its
    // claim-time diary_attempts increment compensated.
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

  /** Read-only stats seam for the pipeline monitor (ARCHITECTURE.md §11). */
  stats(): PipelineStats {
    return {
      pool: "diary",
      workerCount: this.options.config.worker_count ?? 1,
      maxRetries: this.options.config.max_retries ?? DEFAULT_MAX_RETRIES,
      inFlight: () => this.activeWorkers.size,
      notify: () => this.notifyNewWork(),
    };
  }

  /** Publish one pipeline-activity event (ARCHITECTURE.md §11); best-effort. */
  private emit(job: DiaryJob, kind: PipelineActivityKind, status: string): void {
    this.options.activityBus?.publish({
      pool: "diary",
      id: job.summaryId,
      kind,
      status,
      attempts: job.attempts,
      room: job.timelineKey,
      ts: Date.now(),
    });
  }

  /** Wake the pool immediately (e.g. when a new level-1 summary lands). */
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
        this.options.logger.error("diary_poll_error", {
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
      const job = await this.options.storage.claimNextDiaryJob();
      if (!job) break;
      claimedAny = true;
      this.emit(job, "claimed", "processing");
      const work = this.processJob(job)
        .catch((error) =>
          this.options.logger.error("diary_worker_error", {
            summaryId: job.summaryId,
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
   * Post-claim terminality guard, mirroring the summarization pool (spec §6.3
   * covers both pools): `runJob` terminalizes its own agent-run failures, but
   * its storage/filesystem awaits (insertAgentSession, updateAgentSessionStatus,
   * memoryWriter.appendEntry, recentMemoryWindow, …) can reject outside that
   * guarded path. Without this, poll()'s log-only catch swallows the rejection
   * and the summary row stays `diary_status='processing'` for the process
   * lifetime (only startup healing resets stale claims).
   */
  private async processJob(job: DiaryJob): Promise<void> {
    try {
      await this.runJob(job);
    } catch (err) {
      await this.terminalizeEscapedRejection(job, err);
    }
  }

  private async terminalizeEscapedRejection(job: DiaryJob, err: unknown): Promise<void> {
    const { storage, config, logger } = this.options;
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("diary_unexpected_rejection", {
      summaryId: job.summaryId,
      attempt: job.attempts,
      error: errMsg,
    });
    try {
      // The rejection may have escaped AFTER the row left 'processing' (e.g. a
      // late await rejected once the status was already written). Only a row
      // still claimed is stranded — never overwrite a terminal or re-pending row.
      if (storage.getDiaryStatus(job.summaryId) !== "processing") return;
      const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;
      if (job.attempts <= maxRetries) {
        await storage.setDiaryStatus(job.summaryId, "pending");
        this.emit(job, "retried", "pending");
      } else {
        await storage.setDiaryStatus(job.summaryId, "failed");
        this.options.onError?.(job.summaryId, new Error(errMsg));
        this.emit(job, "failed", "failed");
      }
    } catch (writeErr) {
      logger.error("diary_terminalize_write_failed", {
        summaryId: job.summaryId,
        originalError: errMsg,
        writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  private async runJob(job: DiaryJob): Promise<void> {
    const { storage, factory, memoryWriter, config, logger } = this.options;
    const started = Date.now();
    logger.debug("diary_job_claimed", {
      summaryId: job.summaryId,
      timelineKey: job.timelineKey,
      attempt: job.attempts,
    });

    const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

    // Load the range's events via lineage — consulted ONLY for the skip-gate
    // below; the session's context comes from the diary-range build, not from
    // lineage rendering (spec DIARY-CONTEXT-PARITY §3).
    const lineage = storage.getSummaryLineage(job.summaryId);
    const events = lineage.events;

    // Skip-gate (§5.3): a range with zero assistant (bot) messages never gets a
    // session. `skipped` is reserved exclusively for this case so observability can
    // distinguish it from an agent-judged empty `done`.
    if (!events.some((e) => e.role === "assistant")) {
      await storage.setDiaryStatus(job.summaryId, "skipped");
      logger.debug("diary_skipped_no_participation", { summaryId: job.summaryId, timelineKey: job.timelineKey });
      this.emit(job, "skipped", "skipped");
      return;
    }

    // Build the dictated header BEFORE spawning the session (the worker always
    // needs a label). Resolution never fails the job (retry + room-id fallback).
    const roomLabel = await this.resolveRoomLabel(job.timelineKey);
    const header = buildDiaryHeader({
      earliestTimestamp: job.earliestTimestamp,
      latestTimestamp: job.latestTimestamp,
      room: roomLabel,
    });
    const targetDate = agentDateStamp(job.latestTimestamp);

    // Read-only continuity context (§8/§9a): the recent-memory window anchored at
    // the range's last day, bounded by the same ceiling + header-trim as §10a.
    const continuity = await recentMemoryWindow({
      workspaceRoot: this.options.workspaceRoot,
      anchorDay: targetDate,
      ceilingTokens: config.recency_max_tokens ?? DEFAULT_RECENCY_MAX_TOKENS,
      fileCount: config.recency_file_count ?? DEFAULT_RECENCY_FILE_COUNT,
    });

    const perSessionBudget = config.per_session_budget_tokens ?? DEFAULT_PER_SESSION_BUDGET;
    const draft = new SummaryDraft();
    const diaryTool = createDiaryTool({ draft, perSessionBudget, requiredHeader: header });

    const syntheticTrigger: CanonicalChatEvent = {
      id: `diary:${job.summaryId}`,
      timelineKey: job.timelineKey,
      provider: "system",
      role: "user",
      sender: { id: "system", displayName: "Diary" },
      body: "Write your diary entry.",
      timestamp: job.latestTimestamp,
      receivedAt: Date.now(),
    };
    const syntheticSession: AgentSessionRecord = {
      // Unique per attempt: each diary run is a separately inspectable session, and
      // reusing the summary id across retries would collide on the PRIMARY KEY.
      id: `s-${nanoid(10)}`,
      timelineKey: job.timelineKey,
      sessionType: "diary",
      status: "running",
      trigger: {
        provider: "system",
        timelineKey: job.timelineKey,
        event: syntheticTrigger,
      },
      createdAt: Date.now(),
    };

    const modelId = factory.resolveModelId("diary");
    const sessionStartedAt = Date.now();
    await storage.insertAgentSession({
      id: syntheticSession.id,
      timelineKey: job.timelineKey,
      sessionType: "diary",
      status: "running",
      modelId,
      triggerEventId: syntheticTrigger.id,
      triggerBody: syntheticTrigger.body,
      createdAt: sessionStartedAt,
      startedAt: sessionStartedAt,
      updatedAt: sessionStartedAt,
    });

    const sessionType = factory.resolveSessionType("diary");
    const instruction = (sessionType?.session_instruction ?? DEFAULT_DIARY_INSTRUCTION)
      .replaceAll("{{room}}", roomLabel)
      .replaceAll("{{date}}", targetDate)
      .replaceAll("{{header}}", header);

    const continuityBlock = continuity.trim().length > 0 ? continuity : "(no earlier diary entries yet)";
    // The kickoff is recent-memory window + instruction only (spec
    // DIARY-CONTEXT-PARITY §3): the range's raw events live in the built
    // prefix as real chat turns, not rendered into this final turn. The
    // recent-diary window deliberately stays HERE (final-turn packaging),
    // not as the interactive-style diary layer after the system prompt —
    // maintainer decision; it keeps the generation builds' "no memory
    // entries in the prefix" rule clean.
    const kickoff =
      `<your_recent_memory>\n${continuityBlock}\n</your_recent_memory>\n\n` +
      instruction;

    let agentError: unknown;
    try {
      // Diary-range build (spec DIARY-CONTEXT-PARITY §3): the summarize-style
      // prefix — system prompt, prior chunks' summaries bounded at the range
      // START (the range's own already-persisted summary excluded), the range's
      // raw events as real chat turns — ending in a popped `satellite` final
      // turn, exactly like the summarize worker's cutoff build. The build also
      // yields a real snapshot, so diary sessions gain context_snapshot_json
      // observability parity with summarize sessions.
      const { agent, finalTurn, snapshot, tokenEstimate } = await factory.create(syntheticSession, [diaryTool], {
        diaryRange: {
          earliestTimestamp: job.earliestTimestamp,
          latestTimestamp: job.latestTimestamp,
          summaryId: job.summaryId,
        },
      });
      const capture = attachSessionCapture(agent, {
        storage,
        sessionId: syntheticSession.id,
        snapshot,
        tokenEstimate,
        logger,
      });
      this.activeAgents.add(agent);
      try {
        // Drain gate: stop() may have fired between create and prompt (the
        // agent was not yet in activeAgents for the abort sweep).
        if (!this.running) throw new WorkerDrainAbortError("pool draining before run start");
        // Deliver the popped satellite final turn followed by the kickoff,
        // mirroring the summarize worker's `[finalTurn, instruction]` shape.
        const promptInput = finalTurn
          ? [finalTurn, { role: "user", content: kickoff, timestamp: syntheticTrigger.timestamp }]
          : kickoff;
        await agent.prompt(promptInput as any);
        await agent.waitForIdle();
        // Outcome bifurcation (spec LLM-FAILURE-HANDLING §7): a DRAIN abort
        // (this agent was swept by stop()) returns the job to 'pending' with its
        // claim-time attempts increment compensated; a CAP abort stays semantic.
        // We test the explicit drain-swept set rather than `!this.running` so a
        // cap abort that settles WHILE stop() is in progress is not misread as a
        // drain (issue #13).
        if (wasRunAborted(agent) && this.drainSwept.has(agent)) {
          throw new WorkerDrainAbortError(agent.state.errorMessage ?? "pool draining");
        }
        // pi-agent-core resolves the run promise even when the cap-driven abort
        // (§8c) or a stream error fires — it synthesizes a final message with
        // stopReason "aborted"/"error" and sets `state.errorMessage` rather than
        // throwing. Surface that as a throw HERE so a runaway/errored run routes to
        // the failure → retry path below instead of committing a partial draft. A
        // clean completion (including the legitimate empty-draft skip) leaves
        // `errorMessage` unset and does not throw. Environmental LLM failures
        // can no longer reach this point — absorbed (unbounded) at Layer-0.
        assertRunSettledCleanly(agent);
      } catch (err) {
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

    // Drain abort (spec LLM-FAILURE-HANDLING §7): not judged — the job returns
    // to 'pending' with its claim-time diary_attempts increment compensated.
    if (agentError instanceof WorkerDrainAbortError) {
      await storage.updateAgentSessionStatus(syntheticSession.id, "interrupted", {
        completedAt: Date.now(),
        error: agentError.message,
      });
      await storage.returnDiaryJobToPending(job.summaryId);
      logger.info("diary_drain_requeued", {
        summaryId: job.summaryId,
        timelineKey: job.timelineKey,
        attempt: job.attempts,
      });
      this.emit(job, "retried", "pending");
      return;
    }

    const created = draft.isCreated();
    const content = draft.getContent();

    // Success / legitimate-skip path.
    if (!agentError && (!created || draftBeginsWithHeader(content, header))) {
      await storage.updateAgentSessionStatus(syntheticSession.id, "completed", { completedAt: Date.now() });
      if (created && content.trim().length > 0) {
        await memoryWriter.appendEntry(targetDate, content);
        logger.info("diary_entry_written", {
          summaryId: job.summaryId,
          timelineKey: job.timelineKey,
          date: targetDate,
          tokens: draft.getTokenCount(),
          elapsed: Date.now() - started,
        });
      } else {
        // finalize on an empty draft = the agent judged "nothing worth recording".
        logger.info("diary_entry_empty", { summaryId: job.summaryId, timelineKey: job.timelineKey });
      }
      await storage.setDiaryStatus(job.summaryId, "done");
      this.options.onComplete?.(job.summaryId);
      this.emit(job, "completed", "done");
      return;
    }

    // Failure path. `diary_attempts` was already incremented at claim time.
    const errMsg = agentError instanceof Error
      ? agentError.message
      : agentError != null
        ? String(agentError)
        : "diary draft missing or malformed header";
    await storage.updateAgentSessionStatus(syntheticSession.id, "discarded", {
      completedAt: Date.now(),
      error: errMsg,
    });
    logger.error("diary_failed", {
      summaryId: job.summaryId,
      timelineKey: job.timelineKey,
      attempt: job.attempts,
      error: errMsg,
    });

    try {
      if (job.attempts <= maxRetries) {
        await storage.setDiaryStatus(job.summaryId, "pending");
        this.emit(job, "retried", "pending");
      } else {
        // Terminal: a missing diary entry is acceptable (unlike a summary). No
        // truncation fallback — mark failed and move on.
        await storage.setDiaryStatus(job.summaryId, "failed");
        this.options.onError?.(job.summaryId, new Error(errMsg));
        this.emit(job, "failed", "failed");
      }
    } catch (writeErr) {
      logger.error("diary_status_write_failed", {
        summaryId: job.summaryId,
        originalError: errMsg,
        writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
  }

  /**
   * Resolve the channel label with a small bounded in-call retry, falling back to
   * the room id parsed from the timeline key. The header is mandatory and built
   * before the session spawns, so this MUST always return a usable token — the
   * diary job never fails on label resolution (§12.5). This in-call retry is
   * separate from the job-level `diary_attempts` retry.
   */
  private async resolveRoomLabel(timelineKey: string): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const label = await this.options.resolveChannelLabel(timelineKey);
        if (label && label.trim().length > 0) return label.trim();
      } catch (err) {
        this.options.logger.warn("diary_channel_label_failed", {
          timelineKey,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (attempt < 3) await delay(200 * attempt);
    }
    const roomId = roomIdFromTimelineKey(timelineKey);
    if (roomId === undefined) {
      // Double fallback: label resolution failed AND the timeline key didn't
      // parse to a room id, so the header gets the whole (unparseable) key. Still
      // regex-valid, but surface it so the malformed key is visible (#5).
      this.options.logger.warn("diary_channel_label_unparseable_key", { timelineKey });
      return timelineKey;
    }
    return roomId;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
