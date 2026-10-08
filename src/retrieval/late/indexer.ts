/**
 * Late-interaction indexing (ARCHITECTURE.md §9d "Late interaction"): a
 * low-priority background worker that encodes blocks without token vectors
 * for the index model through the document provider chain and stores them
 * (`memory_late_vectors`, one blob per block and model).
 *
 * Indexing is not latency-critical: the recency layer shows the newest blocks
 * in full, so a block only has to be retrievable once it leaves that layer.
 * Newest blocks are encoded first. The index belongs to one model: vectors of
 * any other model and of vanished blocks are pruned at start. The index is
 * keyed by {@link lateIndexKey}: the model plus every document-side setting
 * that shapes the vectors, so changing one re-indexes instead of mixing
 * spaces. A block whose encoding fails is retried after a doubling backoff
 * (`memory_index_failures`, capped at an hour), never every poll and never
 * dropped for good; its failure row is cleared once it is indexed.
 *
 * Index lag is a metric: the worker logs `late_index_lag` at start and hourly
 * (and warns when a block has left the recency layer without vectors).
 */
import type { Logger } from "../../observability/logger.js";
import { INDEX_RETRY_BASE_MS, INDEX_RETRY_MAX_MS, type MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import type { ResolvedRetrievalConfig } from "../config.js";
import { ChainUnavailableError, type ProviderChain } from "../models/chain.js";
import type { LateEncoder } from "../models/types.js";
import { encodeTokenMatrix } from "./codec.js";
import { lateIndexKey } from "./index-key.js";

export interface LateLag {
  /** Blocks (by content hash) without vectors. */
  missing: number;
  /** ... of which outside the recency layer: retrievable only by the other lanes. */
  outsideRecency: number;
}

export interface LateIndexWorkerOptions {
  store: MemoryRetrievalStore;
  config: ResolvedRetrievalConfig["late"];
  chain: ProviderChain<LateEncoder>;
  /** Paths the recency layer currently shows, per agent (null = legacy). */
  recencyPaths: (agent: string | null) => Promise<Set<string>>;
  logger?: Logger;
  now?: () => number;
  /** Idle poll interval. Default 30 s. */
  idleMs?: number;
  /** Pause between batches so indexing never hogs a core. Default 250 ms. */
  pauseMs?: number;
  /** Lag report interval. Default 1 h. */
  lagEveryMs?: number;
  /** Called after vectors were stored (resident windows update). */
  onIndexed?: () => void;
  /** First retry delay of a failed block (default 1 min), doubling up to `retryMaxMs` (default 1 h). */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class LateIndexWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private pendingWake = false;
  private stopController = new AbortController();
  private lastLag = 0;
  /** Bumps whenever vectors are added or pruned (resident windows key on it). */
  version = 0;
  private readonly indexName: string;
  /** The vector index key (`memory_late_vectors.model`). */
  readonly indexKey: string;

  constructor(private readonly options: LateIndexWorkerOptions) {
    this.indexKey = lateIndexKey(options.config);
    this.indexName = `late:${this.indexKey}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    const pruned = await this.options.store.pruneLateVectors(this.indexKey);
    if (pruned > 0) {
      this.version += 1;
      this.options.logger?.info("late_index_pruned", { model: this.options.config.model, index: this.indexKey, pruned });
    }
    this.options.chain.warmAll();
    await this.reportLag().catch(() => undefined);
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopController.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  notifyNewWork(): void {
    this.pendingWake = true;
    this.wake?.();
  }

  /** Blocks without vectors, and how many of them left the recency layer. */
  async lag(): Promise<LateLag> {
    const rows = this.options.store.lateIndexLag(this.indexKey);
    const byHash = new Map<string, { path: string; agent: string | null }[]>();
    for (const r of rows) {
      const list = byHash.get(r.contentHash) ?? [];
      list.push({ path: r.path, agent: r.agent });
      byHash.set(r.contentHash, list);
    }
    const recency = new Map<string, Set<string>>();
    let outside = 0;
    for (const places of byHash.values()) {
      let shown = false;
      for (const p of places) {
        const key = p.agent ?? "";
        if (!recency.has(key)) recency.set(key, await this.options.recencyPaths(p.agent));
        if (recency.get(key)!.has(p.path)) shown = true;
      }
      if (!shown) outside += 1;
    }
    return { missing: byHash.size, outsideRecency: outside };
  }

  private async reportLag(): Promise<void> {
    this.lastLag = this.now();
    const lag = await this.lag();
    const fields = { model: this.options.config.model, ...lag };
    if (lag.outsideRecency > 0) this.options.logger?.warn("late_index_lag", { ...fields, note: "blocks left the recency layer without late-interaction vectors" });
    else this.options.logger?.info("late_index_lag", fields);
  }

  private async idle(ms: number): Promise<void> {
    if (this.pendingWake) {
      this.pendingWake = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = null;
    this.pendingWake = false;
  }

  private async run(): Promise<void> {
    const idleMs = this.options.idleMs ?? 30_000;
    const pauseMs = this.options.pauseMs ?? 250;
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.batch();
      } catch (error) {
        this.options.logger?.warn("late_index_batch_error", { error: error instanceof Error ? error.message : String(error) });
      }
      if (!this.running) break;
      if (this.now() - this.lastLag >= (this.options.lagEveryMs ?? 3600_000)) await this.reportLag().catch(() => undefined);
      await this.idle(processed > 0 ? pauseMs : idleMs);
    }
  }

  /** Encode and store one batch; returns the number of blocks stored. */
  async batch(): Promise<number> {
    const { store, config } = this.options;
    const retry = { now: this.now(), baseMs: this.options.retryBaseMs ?? INDEX_RETRY_BASE_MS, maxMs: this.options.retryMaxMs ?? INDEX_RETRY_MAX_MS };
    const blocks = store.blocksMissingLateVectors(this.indexKey, this.indexName, retry, config.indexBatchSize);
    if (blocks.length === 0) return 0;
    let matrices;
    try {
      const out = await this.options.chain.run((p, signal) => p.encodeDocuments(blocks.map((b) => b.text), signal), {
        signal: this.stopController.signal,
      });
      matrices = out.value;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return 0;
      // Every member not ready yet (a local model still loading): try later, no strike.
      if (error instanceof ChainUnavailableError && error.attempts.every((a) => a.outcome === "not_ready" || a.outcome === "unhealthy")) {
        return 0;
      }
      const message = error instanceof Error ? error.message : String(error);
      for (const b of blocks) await store.noteIndexFailure(this.indexName, b.contentHash, message, this.now());
      return 0;
    }
    if (matrices.length !== blocks.length) {
      for (const b of blocks) await store.noteIndexFailure(this.indexName, b.contentHash, "encoder returned a wrong count", this.now());
      return 0;
    }
    const rows = blocks.map((b, i) => {
      const enc = encodeTokenMatrix(matrices[i]!, config.dtype);
      return { contentHash: b.contentHash, ...enc };
    });
    await store.putLateVectors(this.indexKey, rows, this.now());
    await store.clearIndexFailuresFor(this.indexName, rows.map((r) => r.contentHash));
    this.version += 1;
    this.options.onIndexed?.();
    this.options.logger?.debug("late_index_batch", { model: config.model, blocks: rows.length });
    return rows.length;
  }
}
