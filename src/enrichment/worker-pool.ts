import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import type { CanonicalChatEvent } from "../types.js";
import type { EnrichmentCapabilities, EnrichmentConfig } from "./types.js";
import type { ConcurrencyLimitedFetchClient } from "./fetch-client.js";
import { EnrichmentWorker } from "./worker.js";

export interface EnrichmentWorkerPoolOptions {
  storage: Storage;
  timeline: TimelineStore;
  providerCapabilities: Map<string, EnrichmentCapabilities>;
  fetchClient: ConcurrencyLimitedFetchClient;
  workspaceRoot: string;
  downloadSizeLimit?: number;
  config: EnrichmentConfig;
  onComplete?: (eventId: string) => void;
  onError?: (eventId: string, error: unknown) => void;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export class EnrichmentWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
  private readonly failureCounts = new Map<string, number>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private wakeResolve?: () => void;
  readonly options: EnrichmentWorkerPoolOptions;

  constructor(options: EnrichmentWorkerPoolOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.running = true;
    const resetCount = await this.options.storage.resetStaleEnrichment();
    if (resetCount > 0) {
      this.options.logger.info("enrichment_reset_stale", { count: resetCount });
    }

    const attachDir = path.join(this.options.workspaceRoot, "msg-attach");
    const tmpFiles = await readdir(attachDir).catch(() => [] as string[]);
    let tmpCleaned = 0;
    for (const f of tmpFiles) {
      if (f.startsWith(".tmp-")) {
        await unlink(path.join(attachDir, f)).catch(() => {});
        tmpCleaned++;
      }
    }
    if (tmpCleaned > 0) {
      this.options.logger.info("enrichment_cleanup_orphaned_tmp", { count: tmpCleaned });
    }

    this.schedulePoll(100);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.wakeResolve) this.wakeResolve();
    await Promise.allSettled([...this.activeWorkers]);
  }

  notifyNewEvent(_eventId: string): void {
    if (this.wakeResolve) {
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
      this.wakeResolve();
      this.wakeResolve = undefined;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().catch((error) =>
        this.options.logger.error("enrichment_poll_error", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    const workerCount = this.options.config.worker_count ?? 3;
    const available = workerCount - this.activeWorkers.size;
    if (available <= 0) {
      this.schedulePoll(100);
      return;
    }

    const claimed = await this.options.storage.claimPendingEnrichment(available);
    if (claimed.length === 0) {
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

    for (const eventId of claimed) {
      const work = this.processEvent(eventId)
        .catch((error) => this.handleWorkerError(eventId, error))
        .finally(() => {
          this.activeWorkers.delete(work);
          if (this.running) this.schedulePoll(0);
        });
      this.activeWorkers.add(work);
    }

    if (this.running) this.schedulePoll(100);
  }

  private async processEvent(eventId: string): Promise<void> {
    const event = this.options.storage.getTimelineEventById(eventId);
    if (!event) {
      await this.options.storage.setEnrichmentStatus(eventId, "failed", "Event not found");
      return;
    }

    const capabilityKey = this.resolveCapabilityKey(event);
    const capabilities = this.options.providerCapabilities.get(capabilityKey);
    if (!capabilities) {
      await this.options.storage.setEnrichmentStatus(eventId, "failed", `No capabilities for ${capabilityKey}`);
      return;
    }

    const worker = new EnrichmentWorker({
      storage: this.options.storage,
      capabilities,
      fetchClient: this.options.fetchClient,
      workspaceRoot: this.options.workspaceRoot,
      maxPreviewsPerMessage: this.options.config.max_previews_per_message ?? 3,
      downloadSizeLimit: this.options.downloadSizeLimit,
    });

    await worker.process(event);
    this.options.onComplete?.(eventId);
  }

  private async handleWorkerError(eventId: string, error: unknown): Promise<void> {
    const count = (this.failureCounts.get(eventId) ?? 0) + 1;
    this.failureCounts.set(eventId, count);
    const maxRetries = this.options.config.max_retries ?? 3;

    if (count >= maxRetries) {
      this.failureCounts.delete(eventId);
      await this.options.storage.setEnrichmentStatus(
        eventId, "failed",
        error instanceof Error ? error.message : String(error),
      );
      this.options.onError?.(eventId, error);
    } else {
      await this.options.storage.setEnrichmentStatus(eventId, "pending");
    }
  }

  private resolveCapabilityKey(event: CanonicalChatEvent): string {
    const parts = event.timelineKey.split(":");
    if (parts[0] === "matrix" && parts.length >= 2) {
      return `matrix:${parts[1]}`;
    }
    return event.provider;
  }
}
