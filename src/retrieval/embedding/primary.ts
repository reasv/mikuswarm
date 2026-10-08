/**
 * The optional primary embedder and its own vector index (ARCHITECTURE.md §9d
 * "Two vector indexes").
 *
 * Query vectors and document vectors must come from the same model, so the
 * embedder cannot fall over per request the way a re-ranker can. Instead there
 * are two indexes: the built-in index (`memory_vec`, the in-process model) is
 * always maintained, and a primary embedder (a GPU server or a ZDR API, a
 * `[models.*]` chain whose members all serve the same model) keeps a second
 * index, `memory_vec_primary`. A query uses the primary index when it is
 * complete and its embedder answers within `timeout_ms`; otherwise the
 * built-in index. Re-embedding on a primary-model change clears and refills
 * the primary index only, while the built-in index keeps serving.
 */
import type { Storage } from "../../storage/index.js";
import type { MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import type { Logger } from "../../observability/logger.js";
import { textSimilarity, type QueryVectorIndex } from "../search.js";
import type { VectorStore } from "../vector-store.js";
import type { EmbeddingProvider } from "./provider.js";

export const PRIMARY_INDEX_SLUG = "primary";
const MAX_ATTEMPTS = 3;

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function vecFromBuffer(buf: Buffer): Float32Array {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

export interface PrimaryIndexOptions {
  storage: Storage;
  store: MemoryRetrievalStore;
  provider: EmbeddingProvider;
  vectorStore: VectorStore;
  timeoutMs: number;
  batchSize: number;
  /** Budget gate (remote embedding spend); true = pause. */
  shouldPause?: () => boolean;
  logger?: Logger;
  now?: () => number;
}

export class PrimaryIndex {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private pendingWake = false;
  private stopController = new AbortController();
  /** True once a pass found no chunk left to embed (the index is complete). */
  ready = false;
  private readonly indexName: string;

  constructor(readonly options: PrimaryIndexOptions) {
    this.indexName = `vec:${options.provider.modelId}`;
  }

  get modelId(): string {
    return this.options.provider.modelId;
  }

  /** Create / reconcile the table; a model change clears it (refilled in the background). */
  async init(): Promise<void> {
    const { recreated, modelChanged } = await this.options.vectorStore.ensureSchema(this.options.provider.dim, this.options.provider.modelId);
    if (recreated || modelChanged) {
      await this.options.store.clearIndexFailures(this.indexName);
      this.options.logger?.info("primary_embed_reindex", { model: this.options.provider.modelId });
    }
    const table = this.options.vectorStore.table;
    await this.options.storage.write((db) =>
      db.exec(`delete from ${table} where chunk_id not in (select rowid from memory_chunks)`),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopController.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
    await this.options.provider.close().catch(() => undefined);
  }

  notifyNewWork(): void {
    this.pendingWake = true;
    this.ready = false;
    this.wake?.();
  }

  remove(rowid: number): void {
    void this.options.vectorStore.remove(rowid).catch(() => undefined);
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
    while (this.running) {
      let n = 0;
      try {
        n = await this.batch();
      } catch (error) {
        this.options.logger?.warn("primary_embed_batch_error", { error: error instanceof Error ? error.message : String(error) });
      }
      if (!this.running) break;
      await this.idle(n > 0 ? 0 : 5000);
    }
  }

  /** Embed one batch of chunks missing from the primary index; returns how many were stored. */
  async batch(): Promise<number> {
    if (this.options.shouldPause?.()) return 0;
    const { storage, store, provider, vectorStore } = this.options;
    const missing = store.chunksMissingFromVectorTable(vectorStore.table, this.indexName, MAX_ATTEMPTS, this.options.batchSize);
    if (missing.length === 0) {
      if (!this.ready) this.options.logger?.info("primary_embed_index_ready", { model: provider.modelId });
      this.ready = true;
      return 0;
    }
    const byHash = new Map<string, Float32Array>();
    const toEmbed: Array<{ hash: string; text: string }> = [];
    for (const c of missing) {
      if (byHash.has(c.contentHash) || toEmbed.some((t) => t.hash === c.contentHash)) continue;
      const cached = storage.getCachedEmbedding(c.contentHash, provider.modelId);
      const vec = cached ? vecFromBuffer(cached) : undefined;
      if (vec && vec.length === provider.dim) byHash.set(c.contentHash, vec);
      else toEmbed.push({ hash: c.contentHash, text: c.text });
    }
    if (toEmbed.length > 0) {
      try {
        const vectors = await provider.embedDocuments(toEmbed.map((t) => t.text), this.stopController.signal);
        for (let i = 0; i < toEmbed.length; i++) {
          byHash.set(toEmbed[i]!.hash, vectors[i]!);
          await storage.putCachedEmbedding(toEmbed[i]!.hash, provider.modelId, vecToBuffer(vectors[i]!));
        }
      } catch (error) {
        if (this.stopController.signal.aborted) return 0;
        const message = error instanceof Error ? error.message : String(error);
        const now = (this.options.now ?? Date.now)();
        for (const t of toEmbed) await store.noteIndexFailure(this.indexName, t.hash, message, now);
        this.options.logger?.warn("primary_embed_failed", { count: toEmbed.length, error: message });
      }
    }
    let stored = 0;
    for (const c of missing) {
      const vec = byHash.get(c.contentHash);
      if (!vec) continue;
      await vectorStore.upsert(c.rowid, c.source, vec);
      stored += 1;
    }
    return stored;
  }
}

/**
 * The query-side seam over both indexes: the primary when it is complete and
 * answers within its deadline, else the built-in one. Logs a degrade once per
 * minute at most.
 */
export function dualVectorIndex(
  builtin: { provider: EmbeddingProvider; store: VectorStore } | undefined,
  primary: PrimaryIndex | undefined,
  logger?: Logger,
): QueryVectorIndex | undefined {
  if (!builtin && !primary) return undefined;
  let lastDegradeLog = 0;
  return {
    async query(text, k, signal) {
      if (primary?.ready) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), primary.options.timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const vector = await primary.options.provider.embedQuery(text, controller.signal);
          return { hits: primary.options.vectorStore.knn(vector, k, "memory"), store: primary.options.vectorStore, index: "primary", vector };
        } catch (error) {
          if (signal?.aborted) throw error;
          const now = Date.now();
          if (now - lastDegradeLog > 60_000) {
            lastDegradeLog = now;
            logger?.info("primary_embed_query_degraded", { error: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      }
      if (!builtin) return null;
      const vector = await builtin.provider.embedQuery(text, signal);
      return { hits: builtin.store.knn(vector, k, "memory"), store: builtin.store, index: "builtin", vector };
    },
    vectors: (store, rowids) => store.getVectors(rowids),
    // Excerpt windows use the built-in embedder (local, no network wait).
    ...(builtin ? { similarity: (query: string, texts: string[], signal?: AbortSignal) => textSimilarity(builtin.provider, query, texts, signal) } : {}),
  };
}
