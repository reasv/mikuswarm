import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { LlmScheduler } from "../agent/scheduler.js";
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
  /** LLM scheduler — joined only by the remote provider (spec §5.4). */
  scheduler?: LlmScheduler;
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

  // Likely-misconfiguration warn (#14): explicit `provider="local"` honors the knob and
  // runs local, but a populated [remote] block alongside it is silently inert — the
  // operator probably meant to use it. Warn (not fatal — local still wins) so the
  // asymmetry with the remote-without-block fail-fast above is visible.
  if (config.embedding.provider === "local" && config.embedding.remote) {
    logger?.warn("retrieval_remote_block_ignored", {
      remoteModel: config.embedding.remote.id,
      note: "provider is 'local' so the configured [retrieval.embedding.remote] block is ignored; set provider='remote' (or unset it) to use the remote model",
    });
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
    // Lexical-only when no provider came up: stamp new chunks 'skip' so the embed
    // queue doesn't grow unbounded (#2). Read live (closure over `provider`) so a
    // provider that comes up below flips this without re-wiring the indexer.
    embeddingsActive: () => provider !== undefined,
  });

  // Is the *remote* provider the active one? `createEmbeddingProvider` returns the
  // local provider both when `provider="local"` and as the fallback when a remote
  // block is absent — so "remote configured" is specifically provider==="remote" AND
  // a resolvable [remote] block (the no-block case already fail-fasts above).
  const remoteActive = config.embedding.provider === "remote" && !!config.embedding.remote;

  // Bring up the semantic half. Loading sqlite-vec is the failure point if the native
  // dep is missing; on any failure we log and run lexical-only (§4 graceful degrade).
  try {
    const cacheDir = path.join(opts.dataDir, "models", "fastembed");
    await mkdir(cacheDir, { recursive: true });
    const p = createEmbeddingProvider(config, {
      cacheDir,
      httpProxyUrl: opts.httpProxyUrl,
      scheduler: opts.scheduler,
      logger,
    });

    // Boot-probe vs runtime-degrade (#19): a configured REMOTE endpoint that is
    // unreachable/misconfigured must fail startup loudly (explicit-deployment-config
    // / fail-fast), not silently degrade to lexical-only. Probe it once here and
    // rethrow on failure. This is distinct from the runtime *query-time* degrade
    // (MemorySearch catches a remote embedQuery failure and falls back to lexical for
    // that one query) — that path stays graceful. We deliberately do NOT probe the
    // LOCAL provider: its first-run weight download / native-dep load failing is the
    // documented graceful-degrade path (§4), not a boot error.
    if (remoteActive) {
      try {
        await p.embedQuery("probe");
      } catch (probeError) {
        const detail = probeError instanceof Error ? probeError.message : String(probeError);
        await p.close().catch(() => {});
        throw new Error(
          `retrieval.embedding remote provider '${p.modelId}' is configured but unreachable: ${detail}`,
        );
      }
    }

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
    // A configured remote provider failing here is fatal (#19) — rethrow rather than
    // swallowing into lexical-only. Local/sqlite-vec failures stay graceful (§4).
    if (remoteActive) throw error;
    logger?.warn("retrieval_semantic_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (provider) await provider.close().catch(() => {});
    provider = undefined;
    vectorStore = undefined;
    embedWorker = undefined;
    // No provider will ever process the queue: convert any 'pending' chunks left from
    // a prior provider-present run to 'skip' so the queue doesn't read as "queued
    // forever" (#2). resetAllEmbeddings() re-queues them if a provider returns (§5a).
    const skipped = await storage.skipPendingEmbedding();
    if (skipped > 0) logger?.info("embed_skip_lexical_only", { skipped });
  }

  const search = new MemorySearch(storage, indexer, config, { provider, vectorStore, logger });

  return {
    indexer,
    search,
    onMemoryWrite: (absPath) => indexer.enqueueReconcile(absPath),
    start: async () => {
      // Orphan-vector sweep (#8): a chunk deleted by reconcile after `pruneVectors`
      // but before the embed worker's `upsert` leaves a `memory_vec` row with no
      // owning `memory_chunks` row — harmless but an unbounded space leak. Sweep once
      // at startup, alongside the embed worker's `resetStaleEmbedding`. No-op when the
      // vector table doesn't exist (lexical-only).
      const orphans = await storage.sweepOrphanVectors();
      if (orphans > 0) logger?.info("embed_orphan_vectors_swept", { count: orphans });

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
