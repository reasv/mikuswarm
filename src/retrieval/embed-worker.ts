import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import type { VectorStore } from "./vector-store.js";
import type { ResolvedRetrievalConfig } from "./config.js";

export interface EmbedWorkerOptions {
  storage: Storage;
  vectorStore: VectorStore;
  provider: EmbeddingProvider;
  config: ResolvedRetrievalConfig;
  logger?: Logger;
}

/** Reconstruct a Float32Array from a cached BLOB (copying off the pooled buffer). */
function vecFromBuffer(buf: Buffer): Float32Array {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Embedding worker pool (ARCHITECTURE.md §9d / design §7). The standard
 * poll-status-column idiom: `resetStaleEmbedding` at startup, claim a batch of
 * `embed_status='pending'` chunks (CAS → 'processing'), embed them (cache-checked,
 * batched), store the vectors, mark 'done'. Failures retry to `max_retries` then go
 * 'failed'; the lexical index is unaffected, so search degrades gracefully to BM25.
 *
 * Independent of the diary/reconcile pools: a fresh diary block flows diary-worker →
 * appendEntry → MemoryFileWriter hook → reconcile (`embed_status='pending'`) → here.
 */
export class EmbedWorkerPool {
  private running = false;
  /** One promise per concurrent `run()` loop (`index.worker_count` of them). */
  private loops: Promise<void>[] = [];
  /** Resolvers for loops currently parked in the idle wait. */
  private readonly waiters = new Set<() => void>();
  /**
   * Sticky "new work pending" flag (#8). `notifyNewWork()` sets it; each loop checks
   * and clears it *before* arming its idle wait, so a notify that lands while a batch
   * is processing (or in the gap before re-arming the wait) is not lost — the loop
   * skips idling and polls again immediately instead of waiting the full 5s.
   */
  private pendingWake = false;
  /**
   * Aborted in `stop()` to cancel an in-flight provider request (#11), so shutdown
   * doesn't block up to the remote per-request timeout. Recreated each `start()`.
   */
  private stopController = new AbortController();

  constructor(private readonly options: EmbedWorkerOptions) {}

  async start(): Promise<void> {
    this.running = true;
    this.stopController = new AbortController();
    const reset = await this.options.storage.resetStaleEmbedding();
    if (reset > 0) this.options.logger?.info("embed_reset_stale", { count: reset });
    // Honor `index.worker_count`: spawn N concurrent loops. The CAS claim
    // (`claimPendingEmbedChunks`, per-row `where embed_status='pending'` filtered on
    // `changes > 0`, run inside the single-writer queue) serializes claims, so two
    // loops never double-claim a chunk (#3).
    const workerCount = Math.max(1, this.options.config.index.workerCount);
    this.loops = [];
    for (let i = 0; i < workerCount; i++) this.loops.push(this.run());
  }

  async stop(): Promise<void> {
    this.running = false;
    // Abort any in-flight provider request before waking idle loops, so a loop mid-
    // `embedDocuments` on a slow remote call unblocks immediately (#11).
    this.stopController.abort();
    for (const wake of this.waiters) wake();
    const loops = this.loops;
    this.loops = [];
    await Promise.all(loops.map((l) => l.catch(() => {})));
  }

  /** Wake all idle loops immediately (e.g. after a reconcile queued new chunks). */
  notifyNewWork(): void {
    // Sticky so a notify during processing isn't dropped (#8).
    this.pendingWake = true;
    for (const wake of this.waiters) wake();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.processBatch();
      } catch (error) {
        this.options.logger?.error("embed_batch_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.running) break;
      // If a notify landed while we were processing, consume it and poll again
      // immediately rather than idling (#8).
      if (this.pendingWake) {
        this.pendingWake = false;
        continue;
      }
      if (processed === 0) {
        // Idle: wait for a notify or a 5s poll, whichever comes first.
        let wake!: () => void;
        await new Promise<void>((resolve) => {
          wake = resolve;
          this.waiters.add(resolve);
          setTimeout(resolve, 5000);
        }).finally(() => {
          this.waiters.delete(wake);
        });
      }
    }
  }

  /** Claim and embed one batch. Returns the number of chunks processed. */
  private async processBatch(): Promise<number> {
    const { storage, provider, vectorStore, config } = this.options;
    const claimed = await storage.claimPendingEmbedChunks(config.index.embedBatchSize);
    if (claimed.length === 0) return 0;

    const modelId = provider.modelId;
    // Resolve a vector per unique content hash: serve from cache, embed the rest.
    // `byHash` accumulates resolved vectors; a chunk is "cache-served" iff its hash is
    // in `byHash` *before* the provider call. On a provider error we must NOT punish
    // cache-served chunks (they never touched the provider) — they still succeed (#4).
    const byHash = new Map<string, Float32Array>();
    const missHashes: string[] = [];
    const missTexts: string[] = [];
    for (const c of claimed) {
      if (byHash.has(c.contentHash) || missHashes.includes(c.contentHash)) continue;
      const cached = storage.getCachedEmbedding(c.contentHash, modelId);
      // A remote `dim` change without a `model_id` change can leave a stale,
      // wrong-width BLOB cached under the same key. Validate the cached vector's
      // width against the active provider's dim (mirroring the remote provider's
      // response-dim check) — on mismatch, treat it as a miss so we re-embed and
      // overwrite the stale entry rather than upserting a wrong-width vector.
      if (cached) {
        const vec = vecFromBuffer(cached);
        if (vec.length === provider.dim) {
          byHash.set(c.contentHash, vec);
          continue;
        }
        this.options.logger?.warn("embed_cache_dim_mismatch", {
          modelId,
          cachedDim: vec.length,
          expectedDim: provider.dim,
        });
      }
      missHashes.push(c.contentHash);
      missTexts.push(c.text);
    }

    if (missTexts.length > 0) {
      try {
        const vectors = await provider.embedDocuments(missTexts, this.stopController.signal);
        for (let i = 0; i < missHashes.length; i++) {
          const vec = vectors[i]!;
          byHash.set(missHashes[i]!, vec);
          await storage.putCachedEmbedding(missHashes[i]!, modelId, vecToBuffer(vec));
        }
      } catch (error) {
        // Provider failed: only fail chunks whose embedding is actually missing
        // (the misses). Cache-served chunks (hash already in `byHash`) fall through
        // to the persist loop below and succeed as usual — they never touched the
        // provider, so burning their retries was the bug (#4).
        this.options.logger?.warn("embed_batch_failed", {
          count: claimed.length,
          misses: missTexts.length,
          error: error instanceof Error ? error.message : String(error),
        });
        for (const c of claimed) {
          if (!byHash.has(c.contentHash)) {
            await storage.setEmbedFailed(c.rowid, c.attempts, config.index.maxRetries);
          }
        }
      }
    }

    // Persist every chunk whose vector resolved (cache hits always; misses too when
    // the provider call succeeded). Chunks the provider failed to embed were already
    // routed to failed/retry above and are skipped here.
    let done = 0;
    for (const c of claimed) {
      const vec = byHash.get(c.contentHash);
      if (!vec) continue;
      await vectorStore.upsert(c.rowid, c.source, vec);
      await storage.setEmbedDone(c.rowid, modelId);
      done++;
    }
    if (done > 0) this.options.logger?.debug("embed_batch_done", { count: done });
    return claimed.length;
  }
}
