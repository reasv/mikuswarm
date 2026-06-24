import type { Logger } from "../observability/index.js";
import type {
  BackfetchJobInput,
  BackfetchJobRow,
  BackfetchJobStatus,
  Storage,
  TimelineCursor,
} from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import { applyEditToCanonical, editStatus, needsEnrichment } from "../timeline/index.js";
import type { CanonicalChatEvent } from "../types.js";
import type { MatrixMessageSummary } from "../matrix/native-types.js";
import { classifyForRoom } from "./classify.js";
import {
  paginateBackward,
  type BackfillReadClient,
  type BackwardPaginateStopReason,
  type MessageDisposition,
} from "./paginate.js";

/**
 * Message-only history backfetch coordinator (spec MESSAGE-BACKFETCH;
 * ARCHITECTURE.md §7d).
 *
 * Pages a room's history from BELOW its current oldest stored message into the
 * search-only region: every paged-in event is persisted, enriched, and indexed
 * into chat_index (so search/stat consumers find it) but is NEVER summarized,
 * journaled, embedded, or rendered in the live context. The boundary is the
 * per-timeline-key context floor (§4), pinned once to the key's current-oldest
 * before the first below-floor insert and never moved by this feature.
 *
 * Unlike the two existing backfills this fills *strictly below* everything the
 * live pipeline reads, which is why it needs neither a freeze nor an atomic
 * commit (§3): live ingestion and backfetch meet only in rowid-ordered
 * chat_index, and a partially-completed run is fully consistent (it just means
 * less searchable history). So it commits as it pages (insert-as-you-page) and is
 * incrementally resumable from a persisted backward continuation token — no
 * transaction boundary, restart simply continues from `cursor_token`.
 *
 * Operator-triggered (console only); single-flight per room keeps the cursor and
 * floor unambiguous.
 */

export interface MessageBackfetchConfig {
  enabled: boolean;
  /** /messages page size (clamped 1..1000). */
  pageSize: number;
  /** Pause paging while this many backfetch rows await enrichment (0 = no pause). */
  maxBacklog: number;
  /** Optional throttle between pages (ms). */
  pageMinIntervalMs: number;
  /** Default max stored per job for an unbounded ('beginning') target (0 = unbounded). */
  defaultSafetyCap: number;
  /** Default per-run wall-clock budget ms (0 = none). */
  defaultTimeoutMs: number;
  /** Consecutive-UTD halt for the 'oldest_decryptable' target. */
  utdHaltThreshold: number;
  /** Default value of a new job's `caption_after` toggle. */
  captionBackfetched: boolean;
}

export interface MessageBackfetchCoordinatorOptions {
  storage: Storage;
  timeline: TimelineStore;
  config: MessageBackfetchConfig;
  /** Resolve the native read client for an account (provider.getClient analogue). */
  getClient: (accountId: string) => BackfillReadClient;
  /** Bot's own Matrix user id per account, for role assignment / self-detection. */
  selfUserIds: Map<string, string>;
  /** Nudge the enrichment pool for a single committed event. */
  notifyEnrichment: (eventId: string) => void;
  /** Nudge the caption pool (drains all pending captions) — used after a promote. */
  notifyCaptions: () => void;
  /** Re-project a committed event into the chat-search index. */
  enqueueChatSearch: (eventId: string) => void;
  /**
   * True once the app has begun draining for shutdown. A running job persists its
   * cursor and parks as `paused`; the next startup resumes it from the cursor.
   */
  isDraining: () => boolean;
  logger: Logger;
  /** Injectable delay (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-job in-memory control flags, consulted at page boundaries. */
interface JobControl {
  paused: boolean;
  cancelled: boolean;
}

/** Thrown from the page hook to unwind pagination on a control/drain signal. */
class JobStopSignal extends Error {
  constructor(readonly outcome: "paused" | "cancelled") {
    super(outcome);
  }
}

const TIMELINE_KEY_RE = /^matrix:([^:]+):(room|dm):(.+?)(?::thread:(.*))?$/;

export class MessageBackfetchCoordinator {
  /** Control flags for jobs that are currently running (or about to). */
  private readonly controls = new Map<string, JobControl>();
  /** In-flight run promises, awaited on shutdown. Keyed by job id. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly opts: MessageBackfetchCoordinatorOptions) {}

  get enabled(): boolean {
    return this.opts.config.enabled;
  }

  /**
   * Resume jobs left `running` (interrupted) or `queued` (never started) at the
   * previous shutdown (spec §8.1). Each resumes from its persisted cursor. MUST
   * run after the scan-driven pools are up so committed rows are picked up; in
   * app wiring it is chained after startup gap backfetch settles (§10.2) so a
   * room is never backfetched while still frozen. No-op when disabled.
   */
  resumeAll(): void {
    if (!this.opts.config.enabled) return;
    if (this.opts.isDraining()) return;
    const jobs = this.opts.storage.listResumableBackfetchJobs();
    for (const job of jobs) this.launch(job);
    if (jobs.length > 0) this.opts.logger.info("message_backfetch_resumed", { jobs: jobs.length });
  }

  /**
   * Create + start a new job (console action). Enforces single-flight per room
   * (§8.2): rejects if a queued/running/paused job already exists for the room.
   */
  async startJob(
    input: BackfetchJobInput,
  ): Promise<{ ok: true; job: BackfetchJobRow } | { ok: false; reason: string }> {
    if (!this.opts.config.enabled) return { ok: false, reason: "backfetch disabled" };
    if (!this.opts.selfUserIds.has(input.accountId)) {
      return { ok: false, reason: `unknown account ${input.accountId}` };
    }
    // Atomic single-flight: the active-job check and the insert run in one
    // write-queue callback so two concurrent starts for a room can't both pass.
    const result = await this.opts.storage.insertBackfetchJobIfNoActive(input);
    if (!result.inserted) {
      return { ok: false, reason: `a job is already active for this room (${result.active.id})` };
    }
    this.launch(result.job);
    return { ok: true, job: result.job };
  }

  /** Pause a job. A running job parks at the next page; a queued one parks now. */
  async pauseJob(id: string): Promise<{ ok: boolean; reason?: string }> {
    const job = this.opts.storage.getBackfetchJob(id);
    if (!job) return { ok: false, reason: "no such job" };
    const ctl = this.controls.get(id);
    if (ctl && this.running.has(id)) {
      ctl.paused = true;
      return { ok: true };
    }
    if (job.status === "queued" || job.status === "running") {
      await this.opts.storage.updateBackfetchJob(id, { status: "paused" });
      return { ok: true };
    }
    return { ok: false, reason: `cannot pause a ${job.status} job` };
  }

  /** Resume a paused job from its cursor (single-flight re-checked). */
  async resumeJob(id: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.config.enabled) return { ok: false, reason: "backfetch disabled" };
    const job = this.opts.storage.getBackfetchJob(id);
    if (!job) return { ok: false, reason: "no such job" };
    if (job.status !== "paused") return { ok: false, reason: `cannot resume a ${job.status} job` };
    if (this.running.has(id)) return { ok: false, reason: "already running" };
    const active = this.opts.storage.getActiveBackfetchJobForRoom(job.roomId);
    if (active && active.id !== id) {
      return { ok: false, reason: `another job is active for this room (${active.id})` };
    }
    this.launch(job);
    return { ok: true };
  }

  /** Cancel a job. A running job unwinds at the next page; otherwise marked now. */
  async cancelJob(id: string): Promise<{ ok: boolean; reason?: string }> {
    const job = this.opts.storage.getBackfetchJob(id);
    if (!job) return { ok: false, reason: "no such job" };
    const ctl = this.controls.get(id);
    if (ctl && this.running.has(id)) {
      ctl.cancelled = true;
      return { ok: true };
    }
    if (job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
      return { ok: false, reason: `job already ${job.status}` };
    }
    await this.opts.storage.updateBackfetchJob(id, { status: "cancelled" });
    return { ok: true };
  }

  /**
   * Retroactively promote a room's deferred backfetched media to pending (§7.3),
   * optionally bounded to a date sub-range. Drains via the normal caption pool +
   * budget gate. Returns the number of assets promoted.
   */
  async promoteCaptions(
    timelineKey: string,
    range?: { fromTs?: number | null; toTs?: number | null },
  ): Promise<number> {
    const count = await this.opts.storage.promoteBackfetchedCaptions(timelineKey, range);
    if (count > 0) this.opts.notifyCaptions();
    this.opts.logger.info("message_backfetch_caption_promote", { timelineKey, promoted: count });
    return count;
  }

  /** Current jobs (newest first) for the console list — read straight from the DB. */
  snapshot(limit = 200): BackfetchJobRow[] {
    return this.opts.storage.listBackfetchJobs(limit);
  }

  /**
   * Await all in-flight jobs to park (shutdown). Re-snapshots in a loop so a job
   * launched after a prior snapshot (e.g. a late `resumeAll()` racing teardown) is
   * still awaited. Each run parks and removes itself from the running map, so the
   * loop terminates once no new jobs are launched (shutdown sets `isDraining()`).
   */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  // --- internals ---------------------------------------------------------------

  private launch(job: BackfetchJobRow): void {
    if (this.running.has(job.id)) return;
    const ctl: JobControl = { paused: false, cancelled: false };
    this.controls.set(job.id, ctl);
    const run = this.runJob(job, ctl)
      .catch((error) => {
        this.opts.logger.error("message_backfetch_job_error", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.running.delete(job.id);
        this.controls.delete(job.id);
      });
    this.running.set(job.id, run);
  }

  private async runJob(job: BackfetchJobRow, ctl: JobControl): Promise<void> {
    const { storage, timeline, config } = this.opts;
    const parsed = TIMELINE_KEY_RE.exec(job.timelineKey);
    const isDm = parsed?.[2] === "dm";
    const selfUserId = this.opts.selfUserIds.get(job.accountId);
    if (!selfUserId) {
      await storage.updateBackfetchJob(job.id, { status: "failed", error: "unknown self user" });
      return;
    }
    let client: BackfillReadClient;
    try {
      client = this.opts.getClient(job.accountId);
    } catch (error) {
      await storage.updateBackfetchJob(job.id, {
        status: "failed",
        error: `client unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    await storage.updateBackfetchJob(job.id, { status: "running", error: null });
    this.opts.logger.info("message_backfetch_start", {
      jobId: job.id,
      roomId: job.roomId,
      targetKind: job.targetKind,
      targetValue: job.targetValue,
      resumeFromCursor: job.cursorToken != null,
    });

    // Hydrate this room's history keys from the server-side key backup before the
    // descent so encrypted pre-device history decrypts inline instead of halting at
    // a UTD wall. Per-room (the `get_backup_keys_for_room` endpoint — bounded, works
    // for large accounts unlike `BackupDownloadStrategy::OneShot`), idempotent, and
    // non-fatal: a failure just falls back to the UTD-halt + re-decryption-sweeper
    // path. Only for the deep `oldest_decryptable` descent — date/count targets stay
    // lightweight and the optional-method guard keeps mock clients working.
    if (job.targetKind === "oldest_decryptable" && client.downloadRoomKeysForRoom) {
      try {
        await client.downloadRoomKeysForRoom(job.roomId);
        this.opts.logger.info("message_backfetch_keys_hydrated", {
          jobId: job.id,
          roomId: job.roomId,
        });
      } catch (error) {
        this.opts.logger.warn("message_backfetch_keys_hydrate_failed", {
          jobId: job.id,
          roomId: job.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Per-run target → stop-condition mapping (§6.3).
    const targetMs = job.targetKind === "date" ? Date.parse(job.targetValue ?? "") : NaN;
    const countTarget =
      job.targetKind === "count" ? Math.max(0, Number.parseInt(job.targetValue ?? "0", 10) || 0) : 0;
    const safetyCap = job.safetyCap > 0 ? job.safetyCap : config.defaultSafetyCap;
    // For a count target the cap is cross-run: subtract rows already stored by a
    // prior (paused/drained) run so a resume tops up to `countTarget` rather than
    // fetching the full count again. paginateBackward seeds its own counter to 0
    // each run, so it must be told only the *remaining* allowance.
    const remainingCount = job.targetKind === "count" ? Math.max(0, countTarget - job.stored) : 0;
    const maxMessages =
      job.targetKind === "count" ? remainingCount : safetyCap; // 0 ⇒ unbounded for the non-count targets
    const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : config.defaultTimeoutMs;
    const utdHaltThreshold = job.targetKind === "oldest_decryptable" ? config.utdHaltThreshold : 0;

    // Per-key boundary cache. The boundary is the key's current-oldest cursor at
    // job start; it pins the floor and gates which events are in-scope (§4.5).
    const boundaries = new Map<string, TimelineCursor | null>();
    let floorEventId: string | null = job.floorEventId;
    const ensureBoundary = async (key: string): Promise<TimelineCursor | undefined> => {
      const cached = boundaries.get(key);
      if (cached !== undefined) return cached ?? undefined;
      const oldestId = storage.getOldestEventId(key);
      const cursor = oldestId ? storage.getEventCursor(key, oldestId) : undefined;
      boundaries.set(key, cursor ?? null);
      if (cursor) {
        const res = await storage.setContextFloorIfUnset(key, cursor.id);
        if (!floorEventId) floorEventId = res.floorEventId;
      }
      return cursor;
    };

    // Incrementally-persisted progress (no atomicity — each committed row is
    // already consistent). Seeded from the resumed job so counters accumulate.
    let stored = job.stored;
    let fetched = job.fetched;
    let oldest: CanonicalChatEvent | undefined;

    const onMessage = async (
      summary: MatrixMessageSummary,
      timestamp: number,
    ): Promise<MessageDisposition> => {
      fetched++;
      // Date target: stop once we page below the requested instant.
      if (job.targetKind === "date" && Number.isFinite(targetMs) && timestamp < targetMs) {
        return "window";
      }
      const classified = classifyForRoom(summary, {
        accountId: job.accountId,
        selfUserId,
        baseTimelineKey: job.timelineKey,
        isDm,
        timestamp,
      });
      if (!classified) return "skip";

      if (classified.kind === "edit") {
        // Apply old-history edits in place (idempotent; latest-wins guard). Never
        // a standalone row. A target above the floor no-ops (already applied live);
        // a missing target parks in pending_edits and replays when it lands.
        const targetKey =
          timeline.resolveEditTargetTimelineKey("matrix", classified.targetExternalId, job.timelineKey) ??
          job.timelineKey;
        await timeline.applyEdit(
          "matrix",
          classified.targetExternalId,
          targetKey,
          classified.replacement,
          timestamp,
          (target) => applyEditToCanonical(target, classified.replacement),
          editStatus,
        );
        return "edit";
      }

      const event = classified.event;
      const boundary = await ensureBoundary(event.timelineKey);
      // At/above the key's current-oldest = already held, or a top-of-history gap
      // (startup gap backfetch's job, §7c). Either way out of scope here, and
      // skipping it preserves the "every backfetched event sorts below the floor"
      // invariant (§4.5). A brand-new thread key (no boundary) has no first-class
      // portion, so all its events are in-scope (floor left NULL, §10.2).
      if (boundary && !cursorStrictlyBelow(event, boundary)) return "duplicate";

      const isUtd = event.undecryptable != null;
      const status = isUtd ? "skipped" : needsEnrichment(event) ? "pending" : "skipped";
      const { duplicate } = await timeline.appendIfMissing(event, status, { isBackfetch: true });
      if (duplicate) return "duplicate";

      stored++;
      oldest = event;
      if (status === "pending") this.opts.notifyEnrichment(event.id);
      // Belt-and-suspenders chat-search projection (the lazy catch-up is the
      // backstop); idempotent by content_sig.
      this.opts.enqueueChatSearch(event.id);
      return isUtd ? "stored-utd" : "stored";
    };

    const onPage = async (nextBatch: string | null): Promise<void> => {
      await storage.updateBackfetchJob(job.id, {
        cursorToken: nextBatch,
        stored,
        fetched,
        oldestReachedEventId: oldest?.id ?? job.oldestReachedEventId ?? null,
        oldestReachedTs: oldest?.timestamp ?? job.oldestReachedTs ?? null,
        floorEventId,
      });
      if (ctl.cancelled) throw new JobStopSignal("cancelled");
      if (ctl.paused || this.opts.isDraining()) throw new JobStopSignal("paused");
      // Drain-aware pacing (§6.4): hold off while the backfetch enrichment backlog
      // is over the bound, so a single job can't flood the pool. Live work always
      // outranks backfetch (timestamp DESC), so this only protects backlog size.
      while (config.maxBacklog > 0 && storage.countPendingBackfetchEnrichment() > config.maxBacklog) {
        if (ctl.cancelled) throw new JobStopSignal("cancelled");
        if (ctl.paused || this.opts.isDraining()) throw new JobStopSignal("paused");
        await this.delay(500);
      }
      if (config.pageMinIntervalMs > 0) await this.delay(config.pageMinIntervalMs);
    };

    let stopReason: BackwardPaginateStopReason | undefined;
    let finalStatus: BackfetchJobStatus;
    let finalError: string | null = null;
    if (job.targetKind === "count" && remainingCount === 0) {
      // A resumed count job that already reached its target: complete without paging
      // (paginateBackward's per-run counter starts at 0 and would otherwise over-fetch).
      stopReason = "count";
      finalStatus = finalStatusFor(job.targetKind, "count");
    } else {
      try {
        const result = await paginateBackward({
          client,
          roomId: job.roomId,
          pageSize: config.pageSize,
          maxMessages,
          timeoutMs,
          utdHaltThreshold,
          logger: this.opts.logger,
          readFailedEvent: "message_backfetch_read_failed",
          logFields: { jobId: job.id, roomId: job.roomId },
          initialBefore: job.cursorToken ?? undefined,
          onMessage,
          onPage,
        });
        stopReason = result.stopReason;
        stored = result.stored > stored ? result.stored : stored; // engine count is authoritative for the run total
        finalStatus = finalStatusFor(job.targetKind, result.stopReason);
        if (result.errored) finalError = result.error ?? "read error";
      } catch (error) {
        if (error instanceof JobStopSignal) {
          finalStatus = error.outcome;
        } else {
          finalStatus = "failed";
          finalError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    await storage.updateBackfetchJob(job.id, {
      status: finalStatus,
      stored,
      fetched,
      stopReason: stopReason ?? null,
      oldestReachedEventId: oldest?.id ?? job.oldestReachedEventId ?? null,
      oldestReachedTs: oldest?.timestamp ?? job.oldestReachedTs ?? null,
      floorEventId,
      error: finalError,
    });

    // Caption-after sugar (§7.3): on a clean completion, promote this room's
    // deferred backfetched media for draining by the normal pool.
    if (finalStatus === "completed" && job.captionAfter) {
      try {
        await this.promoteCaptions(job.timelineKey);
      } catch (error) {
        this.opts.logger.warn("message_backfetch_caption_after_failed", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.opts.logger.info("message_backfetch_done", {
      jobId: job.id,
      status: finalStatus,
      stored,
      fetched,
      stopReason: stopReason ?? null,
      floorEventId,
    });
  }

  private delay(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Map a descent stop reason to the job's terminal status (§6.3). A read failure
 * fails; a timeout or a safety-cap hit on an unbounded target parks as `paused`
 * (resumable from the cursor); a primary-target stop (count reached, date
 * reached, history exhausted, oldest-decryptable reached) completes.
 */
function finalStatusFor(
  targetKind: BackfetchJobRow["targetKind"],
  stopReason: BackwardPaginateStopReason,
): BackfetchJobStatus {
  if (stopReason === "error") return "failed";
  if (stopReason === "timeout") return "paused";
  if (stopReason === "count") return targetKind === "count" ? "completed" : "paused";
  return "completed"; // exhausted | window | utd_halt | floor
}

/** True when `event` sorts strictly below `boundary` (timestamp, received_at, id). */
function cursorStrictlyBelow(event: CanonicalChatEvent, boundary: TimelineCursor): boolean {
  if (event.timestamp !== boundary.timestamp) return event.timestamp < boundary.timestamp;
  if (event.receivedAt !== boundary.receivedAt) return event.receivedAt < boundary.receivedAt;
  return event.id < boundary.id;
}
