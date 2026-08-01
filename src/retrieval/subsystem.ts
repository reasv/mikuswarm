import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { LlmScheduler } from "../agent/scheduler.js";
import type { ModelChainEntry } from "../agent/model-fallback.js";
import type { Tokenizer } from "../context/tokenizer/types.js";
import { getRetrievalTokenizer } from "../context/tokenizer/registry.js";
import { MemoryIndexer } from "./indexer.js";
import { MemorySearch } from "./search.js";
import { EmbedWorkerPool } from "./embed-worker.js";
import { VectorStore } from "./vector-store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding/index.js";
import type { ResolvedRetrievalConfig } from "./config.js";
import { makeChainClaimGate, type BudgetHooks } from "../budget/index.js";

/**
 * The assembled memory-retrieval subsystem (ARCHITECTURE.md §9d): the reconciliation
 * indexer(s), the hybrid search engine behind `recall_memory` and auto-retrieval, and
 * — when embeddings are available — the background embedding worker. Owns startup
 * (corpus sweep + model/dim reconciliation) and shutdown.
 *
 * In agents mode there is one `MemoryIndexer` per configured agent workspace; in
 * legacy mode there is exactly one. `indexerForAgent` routes file-write hooks to the
 * correct indexer (spec MULTI-AGENT-SUPPORT §7.1).
 */
export interface RetrievalSubsystem {
  search: MemorySearch;
  /**
   * Return the `MemoryIndexer` that owns the given agent's workspace, or `undefined`
   * if the name isn't known. Pass `null` for the legacy / single-agent indexer.
   */
  indexerForAgent(agentName: string | null): MemoryIndexer | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSubsystemOptions {
  storage: Storage;
  workspaceRoot: string;
  /** App data dir; the local model's ONNX weights cache under `<dataDir>/models`. */
  dataDir: string;
  config: ResolvedRetrievalConfig;
  /**
   * Additional per-agent workspaces for agents mode (spec MULTI-AGENT-SUPPORT §7.1).
   * When present and non-empty, one `MemoryIndexer` is created per entry (in addition
   * to the primary `workspaceRoot` indexer). Empty / absent = legacy mode (single indexer).
   */
  agentWorkspaces?: Array<{ agentName: string; workspaceRoot: string }>;
  httpProxyUrl?: string;
  /** LLM scheduler — joined only by the remote provider (spec §5.4). */
  scheduler?: LlmScheduler;
  /**
   * Period cost limits (spec USAGE-COST-LIMITS §6/§9). `budget.record` emits the
   * class='embedding' ledger row for remote embeds; `budget.engine` drives the
   * embed-worker claim gate. Absent / local provider = no budgeting (zero cost).
   */
  budget?: BudgetHooks;
  /**
   * Resolved remote embedding chain (spec MODEL-FALLBACK §2.3): the `[models.*]`
   * head + any fallback members, resolved by app.ts (which holds `config.models`).
   * Required when the remote provider is active.
   */
  embeddingChain?: ModelChainEntry[];
  /** Budget availability by logical id (spec MODEL-FALLBACK §3/§7) for the remote chain. */
  isModelAvailable?: (logicalId: string) => boolean;
  /**
   * Embedder-matched tokenizer for chunking (spec/TOKENIZER-SWAP.md §5.3). Defaults
   * to the registry's retrieval tokenizer (`[tokenizer].retrieval`, default
   * `gpt-tokenizer`); injectable for tests.
   */
  tokenizer?: Tokenizer;
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
      remoteModel: config.embedding.remote.model,
      note: "provider is 'local' so the configured [retrieval.embedding.remote] block is ignored; set provider='remote' (or unset it) to use the remote model",
    });
  }

  let provider: EmbeddingProvider | undefined;
  let vectorStore: VectorStore | undefined;
  let embedWorker: EmbedWorkerPool | undefined;

  // Build one indexer per workspace. In agents mode `opts.agentWorkspaces` carries
  // each agent's name+root; in legacy mode we have exactly one entry built from
  // `workspaceRoot` (agentName = null → no stamping, no filtering).
  const agentWorkspaceEntries: Array<{ agentName: string | null; workspaceRoot: string }> =
    opts.agentWorkspaces && opts.agentWorkspaces.length > 0
      ? opts.agentWorkspaces.map((w) => ({ agentName: w.agentName, workspaceRoot: w.workspaceRoot }))
      : [{ agentName: null, workspaceRoot }];

  const indexers = agentWorkspaceEntries.map(
    (entry) =>
      new MemoryIndexer({
        storage,
        workspaceRoot: entry.workspaceRoot,
        config,
        tokenizer: opts.tokenizer ?? getRetrievalTokenizer(),
        logger,
        agentName: entry.agentName,
        pruneVectors: (rowids) => {
          for (const r of rowids) void vectorStore?.remove(r);
        },
        onChunksInserted: () => embedWorker?.notifyNewWork(),
        // Lexical-only when no provider came up: stamp new chunks 'skip' so the embed
        // queue doesn't grow unbounded (#2). Read live (closure over `provider`) so a
        // provider that comes up below flips this without re-wiring the indexer.
        embeddingsActive: () => provider !== undefined,
      }),
  );
  // Fast lookup: agentName → indexer. Normalized agentName (null for legacy sentinel).
  const indexerByAgent = new Map<string | null, MemoryIndexer>(
    indexers.map((idx) => [idx.agentName, idx]),
  );

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
    const remoteModelRef = config.embedding.remote?.model;
    const p = createEmbeddingProvider(config, {
      cacheDir,
      httpProxyUrl: opts.httpProxyUrl,
      scheduler: opts.scheduler,
      isModelAvailable: opts.isModelAvailable,
      // Resolved [models.*] chain (spec MODEL-FALLBACK §2.3), supplied by app.ts.
      embeddingChain: opts.embeddingChain,
      // Remote-embedding usage row (spec §9): the billed member's upstream id +
      // LOGICAL id (spec MODEL-FALLBACK §2.2) attribute the row exactly. No session
      // attribution (background enrichment). Local provider never calls this.
      // `budget.record` is read at CALL time, not construction time (finding #21).
      onEmbeddingUsage: remoteModelRef
        ? (info) => {
            opts.budget?.record?.({
              class: "embedding",
              modelId: info.modelId,
              logicalModelId: info.logicalModelId,
              inputTokens: info.promptTokens,
              costUsd: info.costUsd,
            });
          }
        : undefined,
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
    embedWorker = new EmbedWorkerPool({
      storage,
      vectorStore,
      provider,
      config,
      // Budget claim gate (§6.3): only the remote provider can cost money, so the
      // pause descriptor uses the remote model id; a local provider yields no
      // descriptor and is never paused (zero cost). On pause, emit one rate-limited
      // (≤1/min) `usage_limit_blocked` log naming the hit rules (§6.4, review #2),
      // mirroring the caption/summary/diary gates (shared `makeRateLimitedClaimGate`).
      //
      // The engine is LATE-BOUND (`() => opts.budget?.engine`), not read at
      // construction time (finding #21): app.ts builds this subsystem before the
      // BudgetEngine exists and fills the holder afterwards, so capturing
      // `opts.budget.engine` here would freeze the gate to `undefined` and leave the
      // embed lane permanently unbounded. `makeRateLimitedClaimGate` resolves the
      // source per call and never parks while it is still undefined — safe, since no
      // embedding work runs before startup completes.
      shouldPause:
        remoteActive && config.embedding.remote
          ? makeChainClaimGate({
              engine: () => opts.budget?.engine,
              // Chain-aware (spec MODEL-FALLBACK §6): one descriptor per chain member
              // (LOGICAL ids — the dimension budget rules match, §2.2), head-first.
              // The gate parks only when EVERY member is over budget; a head-only cap
              // lets the per-attempt resolver fall to the next in-budget member. Falls
              // back to the bare remote model ref if no chain was resolved.
              descriptors: () => {
                const chain = opts.embeddingChain;
                const ids =
                  chain && chain.length > 0
                    ? chain.map((m) => m.logicalId)
                    : [config.embedding.remote!.model];
                return ids.map((modelId) => ({ class: "embedding", modelId }));
              },
            })
          : undefined,
      logger,
    });
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

  const search = new MemorySearch(storage, indexers, config, { provider, vectorStore, logger });

  return {
    search,
    indexerForAgent: (agentName) => {
      // Normalize the legacy sentinel so map lookup works.
      const key = agentName === "__legacy__" ? null : agentName;
      return indexerByAgent.get(key);
    },
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
      // worker once ALL indexers have queued pending chunks.
      //
      // Sequential (not concurrent) in agents mode: each agent's walk stamps its
      // NULL-agent legacy rows in-place before the next agent walks, so no agent's
      // null-orphan sweep can delete a row that is not-yet-stamped but still on-disk
      // under another agent's root. After all walks complete, the subsystem does the
      // null-orphan sweep once, using the union of every agent's on-disk paths as the
      // truth: only paths absent from ALL roots are deleted (spec §7.1). In legacy
      // mode there is exactly one indexer (agentName=null) and no null-orphan sweep
      // needed — its per-agent prune already handles its own NULL rows.
      void (async () => {
        const agentsMode = indexers.some((idx) => idx.agentName !== null);
        const allOnDiskPaths = new Set<string>();
        for (const idx of indexers) {
          const onDisk = await idx.reconcileAll();
          for (const p of onDisk) allOnDiskPaths.add(p);
        }
        // Subsystem-level null-orphan sweep: delete NULL-agent rows for paths that no
        // longer exist under any walked root (spec §7.1 "NULL rows whose files no longer
        // exist under any root are deleted by the normal reconciliation diff").
        // Only runs in agents mode — in legacy mode the single indexer's per-agent
        // prune above already sweeps NULL rows for its own paths.
        if (agentsMode) {
          const nullPaths = storage.listMemoryChunkPaths(null);
          for (const nullPath of nullPaths) {
            if (!allOnDiskPaths.has(nullPath)) {
              const removed = await storage.deleteMemoryChunksForPath(nullPath, null);
              if (removed > 0) {
                logger?.info("memory_index_pruned_null_orphan", {
                  path: nullPath,
                  removed,
                });
              }
            }
          }
        }
        embedWorker?.notifyNewWork();
      })().catch((error) =>
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
