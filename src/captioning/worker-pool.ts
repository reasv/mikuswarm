import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { InferenceClient } from "./inference-client.js";
import type { MediaModality } from "./describe.js";
import type { PipelineActivityBus, PipelineActivityKind, PipelineStats } from "../observability/pipelines.js";
import { CaptionWorker } from "./worker.js";
import type { BudgetHooks } from "../budget/index.js";

export interface CaptionConfig {
  worker_count?: number;
  caption_all?: boolean;
  caption_assistant_messages?: boolean;
  trigger_wait_timeout_ms?: number;
  max_retries?: number;
}

export interface CaptionWorkerPoolOptions {
  storage: Storage;
  clients: Map<MediaModality, InferenceClient>;
  workspaceRoot: string;
  /**
   * Per-asset workspace resolver (spec MULTI-AGENT-SUPPORT §7.4). When
   * provided the pool is in agents mode: at caption time it resolves the
   * owning agent's workspace root from the asset's `timeline_key` so the
   * `local_path` is resolved under the correct agent's workspace.
   * Absent → legacy mode, `workspaceRoot` is used for every asset.
   * Unresolvable account → §4.3 skip (fail asset without retry, warn).
   */
  resolveWorkspaceRoot?: (timelineKey: string) => string | undefined;
  config: CaptionConfig;
  onComplete?: (eventId: string) => void;
  onError?: (assetId: string, error: unknown) => void;
  /** Pipeline monitor activity bus (ARCHITECTURE.md §11); additive to the callbacks. */
  activityBus?: PipelineActivityBus;
  /**
   * Period cost limits (spec USAGE-COST-LIMITS §6). `budget.record` emits the
   * class='caption' ledger row; `budget.engine` + `captionModelIds` drive the
   * claim gate (§6.3): the pool stops claiming while the caption class is over
   * budget and resumes after the window rolls. Absent = no budgeting.
   */
  budget?: BudgetHooks;
  /**
   * Representative caption fallback chain as LOGICAL ids, head-first (spec
   * MODEL-FALLBACK §2.3/§6). The claim gate parks only when EVERY member is over
   * budget — a model-scoped cap on the head just falls to the next member at attempt
   * time (mirrors the image-gen/x_search `chain.some` tool gates). An empty/absent
   * list = no gate (no budgeting).
   */
  captionModelIds?: string[];
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export class CaptionWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeResolve?: () => void;
  /** Last `caption_pool_budget_paused` log (ms) — rate-limited to one/minute (§6.4). */
  private lastPauseLog = 0;

  constructor(private readonly options: CaptionWorkerPoolOptions) {}

  /**
   * Budget claim gate (spec USAGE-COST-LIMITS §6.3, MODEL-FALLBACK §6): true only
   * while EVERY chain member is over budget, so the pool parks (stops claiming) and
   * resumes after the window rolls. A cap on the head alone does NOT park — the
   * per-attempt resolver falls to the next in-budget member (mirrors the image-gen/
   * x_search `chain.some` tool gates). Free-model captioning short-circuits inside
   * `engine.check`. The pause log names the rules blocking the HEAD (the canonical
   * refusal context for the chain).
   */
  private shouldPauseForBudget(): boolean {
    const engine = this.options.budget?.engine;
    const chain = this.options.captionModelIds;
    if (!engine || !chain || chain.length === 0) return false;
    const available = chain.some((modelId) => engine.check({ class: "caption", modelId }).allowed);
    if (!available) {
      const headId = chain[0]!;
      const result = engine.check({ class: "caption", modelId: headId });
      const now = Date.now();
      if (now - this.lastPauseLog > 60_000) {
        this.lastPauseLog = now;
        engine.logBlocked("worker_claim", result.blockingRules, { class: "caption", modelId: headId });
      }
      return true;
    }
    return false;
  }

  async start(): Promise<void> {
    this.running = true;
    const resetCount = await this.options.storage.resetStaleCaptions();
    if (resetCount > 0) {
      this.options.logger.info("caption_reset_stale", { count: resetCount });
    }
    this.schedulePoll(500);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.wakeResolve) this.wakeResolve();
    await Promise.allSettled([...this.activeWorkers]);
  }

  notifyNewWork(): void {
    if (this.wakeResolve) {
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
      this.wakeResolve();
      this.wakeResolve = undefined;
    }
  }

  /** Read-only stats seam for the pipeline monitor (ARCHITECTURE.md §11). */
  stats(): PipelineStats {
    return {
      pool: "captioning",
      workerCount: this.options.config.worker_count ?? 2,
      maxRetries: this.options.config.max_retries ?? 2,
      inFlight: () => this.activeWorkers.size,
      notify: () => this.notifyNewWork(),
      // Mirrors the claim gate in poll(): the monitor uses this to mark the pending
      // assets the pool would never claim under the current config as `deferred`.
      captionEligibility: {
        captionAll: this.options.config.caption_all ?? false,
        captionAssistant:
          (this.options.config.caption_all ?? false) ||
          (this.options.config.caption_assistant_messages ?? false),
      },
    };
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll().catch((error) =>
        this.options.logger.error("caption_poll_error", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    const workerCount = this.options.config.worker_count ?? 2;
    const available = workerCount - this.activeWorkers.size;
    if (available <= 0) {
      this.schedulePoll(500);
      return;
    }

    // Budget claim gate (§6.3): park without claiming while the caption class is
    // over budget; the periodic re-poll resumes work once the window rolls.
    if (this.shouldPauseForBudget()) {
      this.schedulePoll(30_000);
      return;
    }

    const captionAll = this.options.config.caption_all ?? false;
    const captionAssistant = captionAll || (this.options.config.caption_assistant_messages ?? false);
    const claimed = await this.options.storage.claimPendingCaptions(available, captionAll, captionAssistant);
    if (claimed.length === 0) {
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        this.pollTimer = setTimeout(() => {
          this.wakeResolve = undefined;
          resolve();
        }, 2000);
      });
      if (!this.running) return;
      this.schedulePoll(0);
      return;
    }

    const record = this.options.budget?.record;
    const worker = new CaptionWorker({
      storage: this.options.storage,
      clients: this.options.clients,
      workspaceRoot: this.options.workspaceRoot,
      recordUsage: record
        ? (result, asset) =>
            record({
              class: "caption",
              modelId: result.model,
              // Logical id of the billed chain member (spec MODEL-FALLBACK §2.2) —
              // the budget/grouping dimension, distinct from the upstream wire id.
              logicalModelId: result.logicalModelId,
              // Provider + channel attribution (parity with tool/agent_loop rows):
              // provider from the caption client's model config; timeline_key
              // recovered by claimPendingCaptions' event_id → timeline_events join.
              provider: result.provider ?? null,
              timelineKey: asset.timeline_key ?? null,
              inputTokens: result.usage?.input ?? null,
              outputTokens: result.usage?.output ?? null,
              cacheReadTokens: result.usage?.cacheRead ?? null,
              images: result.usage?.images ?? null,
              costUsd: result.cost ?? 0,
            })
        : undefined,
    });

    for (const asset of claimed) {
      this.emit("claimed", asset.id, "processing", asset.caption_attempts ?? 0);

      // Per-asset workspace resolution (spec MULTI-AGENT-SUPPORT §7.4): in agents
      // mode, resolve the owning agent's root from the asset's timeline_key so the
      // stored local_path is expanded against the correct workspace.
      let assetWorkspaceRoot: string | undefined;
      if (this.options.resolveWorkspaceRoot) {
        // In agents mode, a missing timeline_key is treated identically to an
        // unresolvable account: no resolver may guess a default agent (§4.3).
        // This closes the gap where a NULL join-populated timeline_key would
        // silently fall through to worker.process(asset, undefined) and expand
        // local_path under the first-agent fallback root — a §4.3 violation.
        const resolved = asset.timeline_key
          ? this.options.resolveWorkspaceRoot(asset.timeline_key)
          : undefined;
        if (!resolved) {
          // §4.3: account no longer in config, or timeline_key missing —
          // fail the asset without retry.
          this.options.logger.warn("caption_workspace_unresolvable", {
            assetId: asset.id,
            timelineKey: asset.timeline_key ?? null,
            message: asset.timeline_key
              ? "account not in config — skipping caption (§4.3)"
              : "timeline_key missing in agents mode — skipping caption (§4.3)",
          });
          const work = this.options.storage.setCaptionStatus(
            asset.id,
            "failed",
            asset.timeline_key
              ? "workspace unresolvable: account no longer in config"
              : "workspace unresolvable: timeline_key missing in agents mode",
          ).then(() => {
            this.options.onError?.(asset.id, new Error("workspace unresolvable"));
            this.emit("failed", asset.id, "failed", asset.caption_attempts ?? 0);
          }).finally(() => {
            this.activeWorkers.delete(work);
            if (this.running) this.schedulePoll(0);
          });
          this.activeWorkers.add(work);
          continue;
        }
        assetWorkspaceRoot = resolved;
      }

      const work = worker.process(asset, assetWorkspaceRoot)
        .then((eventId) => {
          this.options.onComplete?.(eventId);
          this.emit("completed", asset.id, "complete", asset.caption_attempts ?? 0);
        })
        .catch((error) => this.handleWorkerError(asset, error))
        .finally(() => {
          this.activeWorkers.delete(work);
          if (this.running) this.schedulePoll(0);
        });
      this.activeWorkers.add(work);
    }

    if (this.running) this.schedulePoll(500);
  }

  /**
   * Failure handler. The retry counter (`caption_attempts`) is now durable: it was
   * already incremented inside the claim CAS, so `asset.caption_attempts` holds the
   * post-increment count for this attempt. Fail terminally once it reaches
   * `max_retries` (preserving the prior semantics where `max_retries` bounds total
   * attempts), otherwise reset to `pending` for re-claim.
   */
  private async handleWorkerError(asset: MediaAssetRow, error: unknown): Promise<void> {
    const attempts = asset.caption_attempts ?? 1;
    const maxRetries = this.options.config.max_retries ?? 2;

    if (attempts >= maxRetries) {
      await this.options.storage.setCaptionStatus(
        asset.id, "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.options.onError?.(asset.id, error);
      this.emit("failed", asset.id, "failed", attempts);
    } else {
      await this.options.storage.setCaptionStatus(asset.id, "pending");
      this.emit("retried", asset.id, "pending", attempts);
    }
  }

  /** Publish one pipeline-activity event (ARCHITECTURE.md §11); best-effort. */
  private emit(kind: PipelineActivityKind, assetId: string, status: string, attempts: number): void {
    this.options.activityBus?.publish({
      pool: "captioning",
      id: assetId,
      kind,
      status,
      attempts,
      room: null,
      ts: Date.now(),
    });
  }
}
