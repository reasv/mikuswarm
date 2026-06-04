import type { RetrievalConfig } from "../config/index.js";

/**
 * Resolved memory-retrieval settings (ARCHITECTURE.md §9d). The TypeBox schema
 * keeps every field optional so configs stay terse; this resolver applies the
 * canonical defaults once, in one place, so the indexer, ranker, tool, and
 * auto-retrieval all agree. The defaults here mirror what `00-defaults.toml` ships
 * (memory: feedback_explicit_deployment_config — defaults live in code AND are set
 * explicitly in deployment config).
 */
export interface ResolvedRetrievalConfig {
  enabled: boolean;
  autoRetrieval: boolean;
  index: {
    workerCount: number;
    maxRetries: number;
    embedBatchSize: number;
    maxChunkTokens: number;
    fallbackChunkTokens: number;
    fallbackChunkOverlap: number;
  };
  query: {
    maxResults: number;
    minScore: number;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
    mmrEnabled: boolean;
    mmrLambda: number;
    temporalDecayEnabled: boolean;
    temporalDecayHalfLifeDays: number;
  };
  auto: {
    maxResults: number;
    minScore: number;
    maxTokens: number;
    dedupAgainstRecency: boolean;
  };
  embedding: {
    /** Resolved active provider: remote iff a remote block is configured (§5a). */
    provider: "local" | "remote";
    local: { model: string; dim: number };
    remote: { id: string; endpoint: string; apiKey: string; dim: number } | null;
  };
}

const DEFAULT_LOCAL_MODEL = "bge-small-en-v1.5";
const DEFAULT_LOCAL_DIM = 384;

export function resolveRetrievalConfig(config: RetrievalConfig | undefined): ResolvedRetrievalConfig {
  const index = config?.index ?? {};
  const query = config?.query ?? {};
  const auto = config?.auto ?? {};
  const embedding = config?.embedding ?? {};
  const remoteBlock = embedding.remote;

  // Active-model resolution (§5a): a configured remote block wins; otherwise local.
  // An explicit `provider="remote"` with no resolvable block is a fail-fast handled
  // by the caller (§10), not silently downgraded here.
  const provider: "local" | "remote" =
    embedding.provider === "remote" || (embedding.provider === undefined && remoteBlock)
      ? "remote"
      : "local";

  return {
    // Absent section → disabled (an existing programmatic config that never mentions
    // retrieval stays off); the shipped 00-defaults.toml turns it on explicitly.
    enabled: config?.enabled ?? false,
    autoRetrieval: config?.auto_retrieval ?? true,
    index: {
      workerCount: index.worker_count ?? 1,
      maxRetries: index.max_retries ?? 3,
      embedBatchSize: index.embed_batch_size ?? 32,
      maxChunkTokens: index.max_chunk_tokens ?? 512,
      fallbackChunkTokens: index.fallback_chunk_tokens ?? 400,
      fallbackChunkOverlap: index.fallback_chunk_overlap ?? 80,
    },
    query: {
      maxResults: query.max_results ?? 6,
      minScore: query.min_score ?? 0.35,
      vectorWeight: query.vector_weight ?? 0.7,
      textWeight: query.text_weight ?? 0.3,
      candidateMultiplier: query.candidate_multiplier ?? 4,
      mmrEnabled: query.mmr_enabled ?? false,
      mmrLambda: query.mmr_lambda ?? 0.7,
      temporalDecayEnabled: query.temporal_decay_enabled ?? true,
      temporalDecayHalfLifeDays: query.temporal_decay_half_life_days ?? 45,
    },
    auto: {
      maxResults: auto.max_results ?? 3,
      minScore: auto.min_score ?? 0.45,
      maxTokens: auto.max_tokens ?? 600,
      dedupAgainstRecency: auto.dedup_against_recency ?? true,
    },
    embedding: {
      provider,
      local: {
        model: embedding.local?.model ?? DEFAULT_LOCAL_MODEL,
        dim: embedding.local?.dim ?? DEFAULT_LOCAL_DIM,
      },
      remote: remoteBlock
        ? {
            id: remoteBlock.id,
            endpoint: remoteBlock.endpoint,
            apiKey: remoteBlock.api_key,
            dim: remoteBlock.dim,
          }
        : null,
    },
  };
}

/** The dimension of the currently-active embedding model (§5a/§6). */
export function activeEmbeddingDim(resolved: ResolvedRetrievalConfig): number {
  return resolved.embedding.provider === "remote" && resolved.embedding.remote
    ? resolved.embedding.remote.dim
    : resolved.embedding.local.dim;
}

/** The id of the currently-active embedding model, for `index_meta`/`model_id`. */
export function activeEmbeddingModelId(resolved: ResolvedRetrievalConfig): string {
  return resolved.embedding.provider === "remote" && resolved.embedding.remote
    ? resolved.embedding.remote.id
    : `local:${resolved.embedding.local.model}`;
}
