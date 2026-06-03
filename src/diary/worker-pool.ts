import { nanoid } from "nanoid";
import type { Storage, DiaryJob, MemoryFileWriter } from "../storage/index.js";
import { assertRunSettledCleanly, type AgentSessionFactory, type AgentSessionRecord } from "../agent/index.js";
import type { DiaryConfig } from "../config/index.js";
import type { Logger } from "../observability/index.js";
import type { CanonicalChatEvent } from "../types.js";
import { SummaryDraft, createDiaryTool } from "../tools/index.js";
import { renderRichMessage } from "../context/index.js";
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
    await Promise.allSettled([...this.activeWorkers]);
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

  private async processJob(job: DiaryJob): Promise<void> {
    const { storage, factory, memoryWriter, config, logger } = this.options;
    const started = Date.now();
    logger.debug("diary_job_claimed", {
      summaryId: job.summaryId,
      timelineKey: job.timelineKey,
      attempt: job.attempts,
    });

    const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

    // Load the range's events via lineage (ordered by ordinal).
    const lineage = storage.getSummaryLineage(job.summaryId);
    const events = lineage.events;

    // Skip-gate (§5.3): a range with zero assistant (bot) messages never gets a
    // session. `skipped` is reserved exclusively for this case so observability can
    // distinguish it from an agent-judged empty `done`.
    if (!events.some((e) => e.role === "assistant")) {
      await storage.setDiaryStatus(job.summaryId, "skipped");
      logger.debug("diary_skipped_no_participation", { summaryId: job.summaryId, timelineKey: job.timelineKey });
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

    const renderedConversation = events.map((e) => renderRichMessage(e)).join("\n\n---\n\n");
    const continuityBlock = continuity.trim().length > 0 ? continuity : "(no earlier diary entries yet)";
    const kickoff =
      `<your_recent_memory>\n${continuityBlock}\n</your_recent_memory>\n\n` +
      `<conversation room="${roomLabel}">\n${renderedConversation}\n</conversation>\n\n` +
      instruction;

    let agentError: unknown;
    try {
      // Resume mode (empty frozen prefix): ContextBuilder.build() is skipped, so the
      // diary session sees ONLY its system prompt (from the `diary` session type's
      // workspace files) plus the kickoff turn we deliver — the raw range events and
      // the continuity window ride in that last user turn (§8), NOT the normal
      // recency/summary layers. This is deliberately different from the chat-side
      // surfacing (§10a). Using the summarization cutoff path here would instead fold
      // the (already-persisted) range into its own summary layer — exactly wrong.
      const { agent, snapshot, tokenEstimate } = await factory.create(syntheticSession, [diaryTool], {
        resume: { snapshot: [] },
      });
      const capture = attachSessionCapture(agent, {
        storage,
        sessionId: syntheticSession.id,
        snapshot,
        tokenEstimate,
        logger,
      });
      try {
        await agent.prompt(kickoff);
        await agent.waitForIdle();
        // pi-agent-core resolves the run promise even when the cap-driven abort
        // (§8c) or a stream error fires — it synthesizes a final message with
        // stopReason "aborted"/"error" and sets `state.errorMessage` rather than
        // throwing. Surface that as a throw HERE so a runaway/errored run routes to
        // the failure → retry path below instead of committing a partial draft. A
        // clean completion (including the legitimate empty-draft skip) leaves
        // `errorMessage` unset and does not throw.
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
        capture.detach();
      }
    } catch (err) {
      agentError = err;
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
      } else {
        // Terminal: a missing diary entry is acceptable (unlike a summary). No
        // truncation fallback — mark failed and move on.
        await storage.setDiaryStatus(job.summaryId, "failed");
        this.options.onError?.(job.summaryId, new Error(errMsg));
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

/**
 * Parse the Matrix room id out of a timeline key
 * (`matrix:{account}:{room|dm}:{roomId}[:thread:{root}]`). The room id itself can
 * contain colons (`!abc:server`), so we take everything after the 3rd segment up to
 * an optional `:thread:` suffix.
 */
export function roomIdFromTimelineKey(timelineKey: string): string | undefined {
  const parts = timelineKey.split(":");
  if (parts.length < 4) return undefined;
  const afterKind = parts.slice(3).join(":");
  const threadIdx = afterKind.indexOf(":thread:");
  const roomId = threadIdx >= 0 ? afterKind.slice(0, threadIdx) : afterKind;
  return roomId.length > 0 ? roomId : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
