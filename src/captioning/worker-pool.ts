import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { InferenceClient } from "./inference-client.js";
import type { MediaModality } from "./describe.js";
import type { PipelineActivityBus, PipelineActivityKind, PipelineStats } from "../observability/pipelines.js";
import { CaptionWorker } from "./worker.js";

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
  config: CaptionConfig;
  onComplete?: (eventId: string) => void;
  onError?: (assetId: string, error: unknown) => void;
  /** Pipeline monitor activity bus (ARCHITECTURE.md §11); additive to the callbacks. */
  activityBus?: PipelineActivityBus;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export class CaptionWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeResolve?: () => void;

  constructor(private readonly options: CaptionWorkerPoolOptions) {}

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

    const worker = new CaptionWorker({
      storage: this.options.storage,
      clients: this.options.clients,
      workspaceRoot: this.options.workspaceRoot,
    });

    for (const asset of claimed) {
      this.emit("claimed", asset.id, "processing", asset.caption_attempts ?? 0);
      const work = worker.process(asset)
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
