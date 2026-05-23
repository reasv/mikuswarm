import type { Storage } from "../storage/index.js";
import type { ConcurrencyLimitedInferenceClient } from "./inference-client.js";
import { CaptionWorker } from "./worker.js";

export interface CaptionConfig {
  worker_count?: number;
  inference_concurrency?: number;
  caption_all?: boolean;
  caption_model?: string;
  trigger_wait_timeout_ms?: number;
  max_retries?: number;
  image_resize?: {
    max_width?: number;
    max_height?: number;
    max_bytes?: number;
  };
}

export interface CaptionWorkerPoolOptions {
  storage: Storage;
  inferenceClient: ConcurrencyLimitedInferenceClient;
  workspaceRoot: string;
  config: CaptionConfig;
  onComplete?: (eventId: string) => void;
  onError?: (assetId: string, error: unknown) => void;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export class CaptionWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  private readonly failureCounts = new Map<string, number>();
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
      this.wakeResolve();
      this.wakeResolve = undefined;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
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
    const claimed = await this.options.storage.claimPendingCaptions(available, captionAll);
    if (claimed.length === 0) {
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        this.schedulePoll(2000);
      });
      return;
    }

    const worker = new CaptionWorker({
      storage: this.options.storage,
      inferenceClient: this.options.inferenceClient,
      workspaceRoot: this.options.workspaceRoot,
      imageResize: {
        maxWidth: this.options.config.image_resize?.max_width ?? 1280,
        maxHeight: this.options.config.image_resize?.max_height ?? 720,
        maxBytes: this.options.config.image_resize?.max_bytes ?? 1_048_576,
      },
    });

    for (const asset of claimed) {
      const work = worker.process(asset)
        .then((eventId) => this.options.onComplete?.(eventId))
        .catch((error) => this.handleWorkerError(asset.id, error))
        .finally(() => {
          this.activeWorkers.delete(work);
          if (this.running) this.schedulePoll(0);
        });
      this.activeWorkers.add(work);
    }

    if (this.running) this.schedulePoll(500);
  }

  private async handleWorkerError(assetId: string, error: unknown): Promise<void> {
    const count = (this.failureCounts.get(assetId) ?? 0) + 1;
    this.failureCounts.set(assetId, count);
    const maxRetries = this.options.config.max_retries ?? 2;

    if (count >= maxRetries) {
      await this.options.storage.setCaptionStatus(
        assetId, "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.options.onError?.(assetId, error);
    } else {
      await this.options.storage.setCaptionStatus(assetId, "pending");
    }
  }
}
