import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import { MemoryIndexer } from "./indexer.js";
import { MemorySearch } from "./search.js";
import { EmbedWorkerPool } from "./embed-worker.js";
import { VectorStore } from "./vector-store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding/index.js";
import type { ResolvedRetrievalConfig } from "./config.js";

/**
 * The assembled memory-retrieval subsystem (ARCHITECTURE.md §9d): the reconciliation
 * indexer, the hybrid search engine behind `recall_memory` and auto-retrieval, and —
 * when embeddings are available — the background embedding worker. Owns startup
 * (corpus sweep + model/dim reconciliation) and shutdown.
 */
export interface RetrievalSubsystem {
  indexer: MemoryIndexer;
  search: MemorySearch;
  /** Hook for `MemoryFileWriter.onAfterWrite` — reconcile the touched file (§7). */
  onMemoryWrite(absPath: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSubsystemOptions {
  storage: Storage;
  workspaceRoot: string;
  /** App data dir; the local model's ONNX weights cache under `<dataDir>/models`. */
  dataDir: string;
  config: ResolvedRetrievalConfig;
  httpProxyUrl?: string;
  logger?: Logger;
}

export async function createRetrievalSubsystem(
  opts: CreateSubsystemOptions,
): Promise<RetrievalSubsystem> {
  const { storage, workspaceRoot, config, logger } = opts;

  // Fail-fast (§10): an explicit remote provider with no resolvable block is a
  // misconfiguration — don't silently downgrade to lexical-only.
  if (config.embedding.provider === "remote" && !config.embedding.remote) {
    throw new Error(
      "retrieval.embedding.provider is 'remote' but no resolvable [retrieval.embedding.remote] block " +
        "(need id, endpoint, api_key, dim)",
    );
  }

  let provider: EmbeddingProvider | undefined;
  let vectorStore: VectorStore | undefined;
  let embedWorker: EmbedWorkerPool | undefined;

  const indexer = new MemoryIndexer({
    storage,
    workspaceRoot,
    config,
    logger,
    pruneVectors: (rowids) => {
      for (const r of rowids) void vectorStore?.remove(r);
    },
    onChunksInserted: () => embedWorker?.notifyNewWork(),
  });

  // Bring up the semantic half. Loading sqlite-vec is the failure point if the native
  // dep is missing; on any failure we log and run lexical-only (§4 graceful degrade).
  try {
    const cacheDir = path.join(opts.dataDir, "models", "fastembed");
    await mkdir(cacheDir, { recursive: true });
    const p = createEmbeddingProvider(config, {
      cacheDir,
      httpProxyUrl: opts.httpProxyUrl,
      logger,
    });
    const vs = new VectorStore(storage, logger);
    const { recreated, modelChanged } = await vs.ensureSchema(p.dim, p.modelId);
    if (recreated || modelChanged) {
      const requeued = await storage.resetAllEmbeddings();
      logger?.info("embed_reindex_on_model_switch", { requeued, model: p.modelId });
    }
    provider = p;
    vectorStore = vs;
    embedWorker = new EmbedWorkerPool({ storage, vectorStore, provider, config, logger });
    logger?.info("retrieval_semantic_ready", { model: p.modelId, dim: p.dim });
  } catch (error) {
    logger?.warn("retrieval_semantic_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (provider) await provider.close().catch(() => {});
    provider = undefined;
    vectorStore = undefined;
    embedWorker = undefined;
  }

  const search = new MemorySearch(storage, indexer, config, { provider, vectorStore });

  return {
    indexer,
    search,
    onMemoryWrite: (absPath) => indexer.enqueueReconcile(absPath),
    start: async () => {
      // Startup full sweep (§7): fire-and-forget — lexical reconcile is cheap and the
      // lazy on-search check covers correctness; don't block boot. Wake the embed
      // worker once the sweep has queued pending chunks.
      void indexer
        .reconcileAll()
        .then(() => embedWorker?.notifyNewWork())
        .catch((error) =>
          logger?.warn("memory_index_sweep_failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      await embedWorker?.start();
    },
    stop: async () => {
      await embedWorker?.stop();
      await provider?.close().catch(() => {});
    },
  };
}
