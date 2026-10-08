/**
 * The optional primary embedder and its own vector index (ARCHITECTURE.md §9d
 * "Two vector indexes").
 *
 * Query vectors and document vectors must come from the same model, so the
 * embedder cannot fall over per request the way a re-ranker can. Instead there
 * are two indexes: the built-in index (`memory_vec`, the in-process model) is
 * always maintained, and a primary embedder (a GPU server or a ZDR API, a
 * `[models.*]` chain whose members all serve the same model) keeps a second
 * index, `memory_vec_primary`. Re-embedding on a primary-model change clears
 * and refills the primary index only, while the built-in index keeps serving.
 *
 * Coverage: a query uses the primary index only while it covers every chunk
 * (the simplest rule that never loses a chunk, since the two indexes' scores
 * are not comparable and cannot be merged); otherwise the built-in index,
 * which is always complete. A failed batch is not blamed on every chunk in it
 * (`retrieval/isolate.ts`): a canary request tells an outage from a bad input,
 * and a bisect finds the chunks that fail on their own. An outage blames no
 * chunk; a run of failed batches slows the worker down (a request every few
 * minutes, not every few seconds). A chunk that fails on its own is retried
 * after a doubling backoff (1 min up to 1 h, `memory_index_failures`), and
 * after {@link INDEX_GIVE_UP_ATTEMPTS} such failures it is unembeddable for
 * this model: it counts as covered, so it never keeps the primary from
 * serving, and only the built-in index (and the lexical lane) can find it.
 *
 * Latency: the built-in query starts after a short hedge delay when the
 * primary has not answered, and whichever answers first is used; a primary
 * that failed or lost the race is skipped for a while, then probed by one
 * query at a time. A hanging primary never costs its full `timeout_ms` per query.
 */
import type { Storage } from "../../storage/index.js";
import { INDEX_GIVE_UP_ATTEMPTS, INDEX_RETRY_BASE_MS, INDEX_RETRY_MAX_MS, type MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import { CANARY_TEXT, runIsolating } from "../isolate.js";
import type { Logger } from "../../observability/logger.js";
import { textSimilarity, type QueryVectorIndex } from "../search.js";
import type { VectorStore } from "../vector-store.js";
import type { EmbeddingProvider } from "./provider.js";

export const PRIMARY_INDEX_SLUG = "primary";
/** Idle after a batch with nothing to do. */
const IDLE_MS = 5000;
/** Cap of the worker's slow-down after consecutive failed batches. */
const MAX_FAILURE_IDLE_MS = 5 * 60_000;
/** Built-in query start after this long without a primary answer (capped at the primary's timeout). */
export const PRIMARY_HEDGE_MS = 250;
/** How long a primary that failed or lost the race is skipped before one query probes it. */
export const PRIMARY_SKIP_MS = 30_000;

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
  /** First retry delay of a failed chunk (default 1 min), doubling up to `retryMaxMs` (default 1 h). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Isolated failures after which a chunk is unembeddable for this model (default 5). */
  giveUpAttempts?: number;
  logger?: Logger;
  now?: () => number;
}

export class PrimaryIndex {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private pendingWake = false;
  private stopController = new AbortController();
  /** True once the index covers every chunk (unembeddable ones count as covered). */
  ready = false;
  private readonly indexName: string;
  /** Consecutive failed batches (slows the worker down during an outage). */
  private failedBatches = 0;
  private lastIncomplete = -1;

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
        this.failedBatches++;
        this.options.logger?.warn("primary_embed_batch_error", { error: error instanceof Error ? error.message : String(error) });
      }
      if (!this.running) break;
      const backoff = this.failedBatches > 0 ? Math.min(MAX_FAILURE_IDLE_MS, IDLE_MS * 2 ** (this.failedBatches - 1)) : 0;
      if (backoff > 0) await this.sleep(backoff);
      else await this.idle(n > 0 ? 0 : IDLE_MS);
    }
  }

  /** A pause that new work does not cut short (only stop does). */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        if (this.running) return;
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = null;
  }

  /** Embed one batch of chunks missing from the primary index; returns how many were stored. */
  async batch(): Promise<number> {
    if (this.options.shouldPause?.()) return 0;
    const { storage, store, provider, vectorStore } = this.options;
    const now = (this.options.now ?? Date.now)();
    const giveUp = this.options.giveUpAttempts ?? INDEX_GIVE_UP_ATTEMPTS;
    const retry = { now, baseMs: this.options.retryBaseMs ?? INDEX_RETRY_BASE_MS, maxMs: this.options.retryMaxMs ?? INDEX_RETRY_MAX_MS, giveUpAttempts: giveUp };
    const missing = store.chunksMissingFromVectorTable(vectorStore.table, this.indexName, retry, this.options.batchSize);
    if (missing.length === 0) {
      // Nothing due; complete only when no chunk is missing (failed ones wait for
      // their retry; unembeddable ones count as covered).
      const left = store.countMissingFromVectorTable(vectorStore.table, this.indexName, giveUp);
      if (left === 0 && !this.ready) this.options.logger?.info("primary_embed_index_ready", { model: provider.modelId });
      if (left > 0 && left !== this.lastIncomplete) {
        this.options.logger?.warn("primary_embed_index_incomplete", {
          model: provider.modelId,
          missing: left,
          note: "failed chunks retry after a backoff; queries use the built-in index meanwhile",
        });
      }
      this.lastIncomplete = left;
      this.ready = left === 0;
      this.failedBatches = 0;
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
      const signal = this.stopController.signal;
      let result;
      try {
        result = await runIsolating(
          toEmbed,
          (list) => provider.embedDocuments(list.map((t) => t.text), signal),
          () => provider.embedDocuments([CANARY_TEXT], signal),
          signal,
        );
      } catch (error) {
        if (signal.aborted) return 0;
        throw error;
      }
      for (const { item, value } of result.ok) {
        byHash.set(item.hash, value);
        await storage.putCachedEmbedding(item.hash, provider.modelId, vecToBuffer(value));
      }
      if (result.outage !== undefined) {
        // The canary failed too: an outage, no chunk is blamed; the worker slows down.
        this.failedBatches++;
        this.options.logger?.warn("primary_embed_failed", { count: toEmbed.length, error: result.outage });
      } else {
        this.failedBatches = 0;
        for (const { item, error } of result.bad) {
          const attempts = await store.noteIndexFailure(this.indexName, item.hash, error, now);
          const unembeddable = attempts >= giveUp;
          this.options.logger?.warn(unembeddable ? "primary_embed_chunk_unembeddable" : "primary_embed_chunk_failed", {
            model: provider.modelId,
            contentHash: item.hash,
            attempts,
            error,
            ...(unembeddable ? { note: "never retried for this model; only the built-in index serves it" } : {}),
          });
        }
      }
    }
    let stored = 0;
    const done: string[] = [];
    for (const c of missing) {
      const vec = byHash.get(c.contentHash);
      if (!vec) continue;
      await vectorStore.upsert(c.rowid, c.source, vec);
      done.push(c.contentHash);
      stored += 1;
    }
    await store.clearIndexFailuresFor(this.indexName, done);
    return stored;
  }
}

/**
 * The query-side seam over both indexes: the primary while it covers every
 * chunk and answers first (the built-in query starts after a hedge delay),
 * else the built-in one. Without a built-in index the primary serves even
 * while incomplete. Logs a degrade once per minute at most.
 */
export function dualVectorIndex(
  builtin: { provider: EmbeddingProvider; store: VectorStore } | undefined,
  primary: PrimaryIndex | undefined,
  logger?: Logger,
  opts: { hedgeMs?: number; skipMs?: number; now?: () => number } = {},
): QueryVectorIndex | undefined {
  if (!builtin && !primary) return undefined;
  const now = opts.now ?? Date.now;
  let lastDegradeLog = 0;
  /** The primary is skipped until then (0 = healthy). */
  let skipUntil = 0;
  let probing = false;
  type Found = { hits: ReturnType<VectorStore["knn"]>; store: VectorStore; index: string; vector: Float32Array };
  const viaBuiltin = async (text: string, k: number, signal?: AbortSignal): Promise<Found | null> => {
    if (!builtin) return null;
    const vector = await builtin.provider.embedQuery(text, signal);
    return { hits: builtin.store.knn(vector, k, "memory"), store: builtin.store, index: "builtin", vector };
  };
  const degraded = (reason: string): void => {
    skipUntil = now() + (opts.skipMs ?? PRIMARY_SKIP_MS);
    const t = now();
    if (t - lastDegradeLog > 60_000) {
      lastDegradeLog = t;
      logger?.info("primary_embed_query_degraded", { error: reason });
    }
  };
  return {
    async query(text, k, signal) {
      if (!primary || !(primary.ready || !builtin)) return viaBuiltin(text, k, signal);
      if (skipUntil > 0) {
        // Skipped for a while after a failure; then one query at a time probes it.
        if (now() < skipUntil || probing) return viaBuiltin(text, k, signal);
        probing = true;
      }
      const isProbe = skipUntil > 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), primary.options.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const viaPrimary = (async (): Promise<Found> => {
        const vector = await primary.options.provider.embedQuery(text, controller.signal);
        return { hits: primary.options.vectorStore.knn(vector, k, "memory"), store: primary.options.vectorStore, index: "primary", vector };
      })();
      try {
        if (!builtin) return await viaPrimary;
        // Hedge: the built-in query starts if the primary has not answered soon.
        const hedgeMs = Math.min(opts.hedgeMs ?? PRIMARY_HEDGE_MS, primary.options.timeoutMs);
        let hedgeTimer: NodeJS.Timeout | undefined;
        const hedged = new Promise<"hedge">((resolve) => (hedgeTimer = setTimeout(() => resolve("hedge"), hedgeMs)));
        const first = await Promise.race([viaPrimary.then((r) => ({ r }), (e: unknown) => ({ e })), hedged]);
        clearTimeout(hedgeTimer);
        if (first !== "hedge" && "r" in first) {
          skipUntil = 0;
          return first.r;
        }
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        if (first !== "hedge") {
          degraded(first.e instanceof Error ? first.e.message : String(first.e));
          return await viaBuiltin(text, k, signal);
        }
        // Past the hedge: whichever answers first; the built-in one never waits on the primary.
        const fallback = viaBuiltin(text, k, signal);
        const winner = await Promise.race([
          viaPrimary.then((r) => ({ r, from: "primary" as const }), () => fallback.then((r) => ({ r, from: "builtin" as const }))),
          fallback.then((r) => ({ r, from: "builtin" as const })),
        ]);
        if (winner.from === "primary") {
          skipUntil = 0;
          return winner.r;
        }
        controller.abort();
        degraded(`slower than the built-in index (hedge ${hedgeMs} ms)`);
        return winner.r;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!builtin) return null;
        degraded(error instanceof Error ? error.message : String(error));
        return viaBuiltin(text, k, signal);
      } finally {
        if (isProbe) probing = false;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        viaPrimary.catch(() => undefined);
      }
    },
    vectors: (store, rowids) => store.getVectors(rowids),
    // Excerpt windows use the built-in embedder (local, no network wait).
    ...(builtin ? { similarity: (query: string, texts: string[], signal?: AbortSignal) => textSimilarity(builtin.provider, query, texts, signal) } : {}),
  };
}
