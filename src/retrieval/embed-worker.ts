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
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly options: EmbedWorkerOptions) {}

  async start(): Promise<void> {
    this.running = true;
    const reset = await this.options.storage.resetStaleEmbedding();
    if (reset > 0) this.options.logger?.info("embed_reset_stale", { count: reset });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop?.catch(() => {});
  }

  /** Wake the loop immediately (e.g. after a reconcile queued new chunks). */
  notifyNewWork(): void {
    this.wake?.();
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
      if (processed === 0) {
        // Idle: wait for a notify or a 5s poll, whichever comes first.
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, 5000);
        }).finally(() => {
          this.wake = undefined;
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
    try {
      // Resolve a vector per unique content hash: serve from cache, embed the rest.
      const byHash = new Map<string, Float32Array>();
      const missHashes: string[] = [];
      const missTexts: string[] = [];
      for (const c of claimed) {
        if (byHash.has(c.contentHash)) continue;
        const cached = storage.getCachedEmbedding(c.contentHash, modelId);
        if (cached) {
          byHash.set(c.contentHash, vecFromBuffer(cached));
        } else if (!missHashes.includes(c.contentHash)) {
          missHashes.push(c.contentHash);
          missTexts.push(c.text);
        }
      }
      if (missTexts.length > 0) {
        const vectors = await provider.embedDocuments(missTexts);
        for (let i = 0; i < missHashes.length; i++) {
          const vec = vectors[i]!;
          byHash.set(missHashes[i]!, vec);
          await storage.putCachedEmbedding(missHashes[i]!, modelId, vecToBuffer(vec));
        }
      }
      for (const c of claimed) {
        const vec = byHash.get(c.contentHash);
        if (!vec) throw new Error(`missing embedding for chunk ${c.id}`);
        await vectorStore.upsert(c.rowid, c.source, vec);
        await storage.setEmbedDone(c.rowid, modelId);
      }
      this.options.logger?.debug("embed_batch_done", { count: claimed.length });
    } catch (error) {
      this.options.logger?.warn("embed_batch_failed", {
        count: claimed.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const c of claimed) {
        await storage.setEmbedFailed(c.rowid, c.attempts, config.index.maxRetries);
      }
    }
    return claimed.length;
  }
}
