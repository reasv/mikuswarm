import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import type { CanonicalChatEvent } from "../types.js";
import type { EnrichmentCapabilities, EnrichmentConfig } from "./types.js";
import type { FetchClient } from "./fetch-client.js";
import type { FxTwitterClient } from "../fxtwitter/client.js";
import type { FxTwitterConfig } from "../fxtwitter/types.js";
import type { PipelineActivityBus, PipelineActivityKind, PipelineStats } from "../observability/pipelines.js";
import { EnrichmentWorker } from "./worker.js";
import { parseTimelineKey } from "../storage/timeline-key.js";
import type { AttachmentStore } from "./attachment-store.js";

export interface EnrichmentWorkerPoolOptions {
  storage: Storage;
  timeline: TimelineStore;
  providerCapabilities: Map<string, EnrichmentCapabilities>;
  fetchClient: FetchClient;
  /**
   * Workspace root used in legacy single-agent mode (and for startup temp
   * cleanup). In agents mode, the per-event resolver below supersedes it at
   * download time; the legacy root is kept so startup cleanup has a directory.
   */
  workspaceRoot: string;
  /**
   * All agent workspace roots (agents mode only). Startup temp cleanup scans
   * `.tmp-*` files under every root's `msg-attach/` subdir — not just the
   * legacy `workspaceRoot` — because in agents mode each agent's account-scoped
   * subdir (`msg-attach/<provider>.<accountKey>/`) is the download target.
   * Absent → legacy single-root cleanup (legacy mode unchanged).
   */
  agentWorkspaceRoots?: string[];
  /**
   * Per-event workspace resolver (spec MULTI-AGENT-SUPPORT §7.4). When
   * provided the pool is in agents mode: at download time it resolves the
   * owning agent's workspace root from the event's `timeline_key` and writes
   * to the account-scoped subdir `<agentRoot>/msg-attach/<provider>.<accountKey>/`.
   * Absent → legacy flat layout, byte-identical to pre-Phase-3 behaviour.
   * Unresolvable account → §4.3 skip (warn, no file downloads, DB-only ops proceed).
   */
  resolveWorkspaceRoot?: (timelineKey: string) => string | undefined;
  downloadSizeLimit?: number;
  /** X.com enrichment via FxTwitter (ARCHITECTURE.md §7a); unset = legacy Synapse-only previews. */
  fxtwitter?: { client: FxTwitterClient; config: FxTwitterConfig };
  /**
   * Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d).
   * When present and ready, each worker integrates downloaded files via the store.
   * Absent → byte-identical pre-Phase-5d behaviour.
   */
  store?: AttachmentStore;
  config: EnrichmentConfig;
  onComplete?: (eventId: string) => void;
  onError?: (eventId: string, error: unknown) => void;
  /** Pipeline monitor activity bus (ARCHITECTURE.md §11); additive to the callbacks. */
  activityBus?: PipelineActivityBus;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export class EnrichmentWorkerPool {
  private running = false;
  private readonly activeWorkers = new Set<Promise<void>>();
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

    // Startup temp-file cleanup: scan `.tmp-*` under every workspace root's
    // `msg-attach/` directory.  In agents mode, temps are written under every
    // agent's root (one per agent); in legacy mode there is exactly one root.
    const rootsToClean = this.options.agentWorkspaceRoots?.length
      ? this.options.agentWorkspaceRoots
      : [this.options.workspaceRoot];
    let tmpCleaned = 0;
    for (const wsRoot of rootsToClean) {
      const attachDir = path.join(wsRoot, "msg-attach");
      await mkdir(attachDir, { recursive: true });
      const tmpFiles = await readdir(attachDir).catch(() => [] as string[]);
      for (const f of tmpFiles) {
        if (f.startsWith(".tmp-")) {
          await unlink(path.join(attachDir, f)).catch(() => {});
          tmpCleaned++;
        }
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

  /** Read-only stats seam for the pipeline monitor (ARCHITECTURE.md §11). */
  stats(): PipelineStats {
    return {
      pool: "enrichment",
      workerCount: this.options.config.worker_count ?? 3,
      maxRetries: this.options.config.max_retries ?? 3,
      inFlight: () => this.activeWorkers.size,
      notify: () => this.notifyNewEvent("retry"),
    };
  }

  /** Publish one pipeline-activity event (ARCHITECTURE.md §11); best-effort. */
  private emit(
    kind: PipelineActivityKind,
    eventId: string,
    status: string,
    attempts: number,
    room: string | null,
  ): void {
    this.options.activityBus?.publish({
      pool: "enrichment",
      id: eventId,
      kind,
      status,
      attempts,
      room,
      ts: Date.now(),
    });
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
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
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
      this.emit("claimed", eventId, "processing", 0, null);
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

    // Per-event workspace resolution (spec MULTI-AGENT-SUPPORT §7.4):
    // In agents mode, resolve the owning agent's workspace root from the event's
    // timeline_key and compute the account-scoped subdir for msg-attach.
    // In legacy mode (no resolver), use the global workspaceRoot with no subdir.
    let effectiveWorkspaceRoot: string | null = this.options.workspaceRoot;
    let attachSubdir: string | undefined;

    if (this.options.resolveWorkspaceRoot) {
      const parsed = parseTimelineKey(event.timelineKey);
      const resolved = this.options.resolveWorkspaceRoot(event.timelineKey);
      if (!resolved) {
        // §4.3: account no longer in config — warn, skip file downloads,
        // still process DB-only enrichment (link previews, reply context).
        this.options.logger.warn("enrichment_workspace_unresolvable", {
          eventId,
          timelineKey: event.timelineKey,
          message: "account not in config — skipping file downloads (§4.3)",
        });
        effectiveWorkspaceRoot = null;
        // attachSubdir stays undefined; no file writes will occur.
      } else {
        effectiveWorkspaceRoot = resolved;
        if (parsed) {
          // "<provider>.<accountKey>" — the account-scoped subdir (§7.4).
          const candidate = `${parsed.provider}.${parsed.accountId}`;
          // Defense-in-depth (§1b): if the computed subdir contains a path
          // separator or a `..` segment it could nest directories or escape
          // msg-attach/.  Treat the event per §4.3 (skip downloads, warn)
          // rather than write.  Primary prevention is validateAgentConfig's
          // agents-mode hard error (§3); this guard is the secondary layer.
          if (candidate.includes("/") || candidate.includes("\\") || candidate.includes("..")) {
            this.options.logger.warn("enrichment_subdir_path_unsafe", {
              eventId,
              timelineKey: event.timelineKey,
              candidate,
              message: "computed msg-attach subdir contains a path-unsafe character — skipping file downloads (§4.3 §7.4)",
            });
            effectiveWorkspaceRoot = null;
            // attachSubdir stays undefined; no file writes will occur.
          } else {
            attachSubdir = candidate;
          }
        }
      }
    }

    const worker = new EnrichmentWorker({
      storage: this.options.storage,
      capabilities,
      fetchClient: this.options.fetchClient,
      workspaceRoot: effectiveWorkspaceRoot,
      attachSubdir,
      maxPreviewsPerMessage: this.options.config.max_previews_per_message ?? 3,
      downloadSizeLimit: this.options.downloadSizeLimit,
      fxtwitter: this.options.fxtwitter,
      store: this.options.store,
      logger: this.options.logger,
    });

    await worker.process(event);
    this.options.onComplete?.(eventId);
    this.emit("completed", eventId, "complete", 0, event.timelineKey);
  }

  private async handleWorkerError(eventId: string, error: unknown): Promise<void> {
    const count = this.options.storage.getEnrichmentRetries(eventId) + 1;
    const maxRetries = this.options.config.max_retries ?? 3;

    if (count >= maxRetries) {
      await this.options.storage.setEnrichmentStatus(
        eventId, "failed",
        error instanceof Error ? error.message : String(error),
        count,
      );
      this.options.onError?.(eventId, error);
      this.emit("failed", eventId, "failed", count, null);
    } else {
      await this.options.storage.setEnrichmentStatus(eventId, "pending", undefined, count);
      this.emit("retried", eventId, "pending", count, null);
    }
  }

  private resolveCapabilityKey(event: CanonicalChatEvent): string {
    // Use the shared grammar parser (not a naive split) to extract provider + accountId.
    // For Matrix, the capability is registered as "matrix:<accountId>"; for future providers
    // the registry key will follow the same "<provider>:<accountId>" pattern.
    const parsed = parseTimelineKey(event.timelineKey);
    if (parsed) {
      return `${parsed.provider}:${parsed.accountId}`;
    }
    // Key is present but malformed — fall through to provider-level capability.
    return event.provider;
  }
}
