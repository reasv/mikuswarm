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
    remote: {
      id: string;
      endpoint: string;
      apiKey: string;
      dim: number;
      /** LLM rate-limit group (spec §9.4); unset = `default`. */
      rateLimitGroup?: string;
    } | null;
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

  // Active-model resolution (§5a): an explicit `provider` wins; an unset `provider`
  // defaults to remote when a resolvable `[remote]` block is present, else local. So
  // `provider="local"` with a populated `[remote]` block runs local (the explicit knob
  // is honored) — `createRetrievalSubsystem` warns about that likely-misconfiguration
  // without being fatal (#14). An explicit `provider="remote"` with no resolvable block
  // is a fail-fast handled by the caller (§10), not silently downgraded here.
  const provider: "local" | "remote" =
    embedding.provider === "remote" || (embedding.provider === undefined && remoteBlock)
      ? "remote"
      : "local";

  return {
    // Absent section → disabled (an existing programmatic config that never mentions
    // retrieval stays off); the shipped 00-defaults.toml turns it on explicitly.
    enabled: config?.enabled ?? false,
    autoRetrieval: config?.auto_retrieval ?? true,
    index: resolveIndex(index),
    query: resolveQuery(query),
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
            rateLimitGroup: remoteBlock.rate_limit_group,
          }
        : null,
    },
  };
}

/**
 * Resolve the `[retrieval.index]` block and fail fast when `fallback_chunk_tokens`
 * exceeds `max_chunk_tokens` (review issue #14). The chunker sub-splits an oversized
 * block (> maxChunkTokens) using fallbackChunkTokens as the window; a fallback larger
 * than the max would yield sub-chunks still over the threshold the split exists to
 * enforce (possibly over the embedder's input limit). The two knobs have independent
 * per-field bounds in the TypeBox schema, which can't express this cross-field
 * relation — so reject it here at config-resolve time rather than silently clamping,
 * per the project's explicit-deployment-config / fail-fast preference.
 */
function resolveIndex(
  index: NonNullable<RetrievalConfig["index"]>,
): ResolvedRetrievalConfig["index"] {
  const maxChunkTokens = index.max_chunk_tokens ?? 512;
  const fallbackChunkTokens = index.fallback_chunk_tokens ?? 400;
  if (fallbackChunkTokens > maxChunkTokens) {
    throw new Error(
      "Invalid [retrieval.index]: fallback_chunk_tokens " +
        `(${fallbackChunkTokens}) must be <= max_chunk_tokens (${maxChunkTokens}); ` +
        "a larger fallback window defeats the oversized-block sub-split and can emit " +
        "chunks over the embedder's input limit.",
    );
  }
  return {
    workerCount: index.worker_count ?? 1,
    maxRetries: index.max_retries ?? 3,
    embedBatchSize: index.embed_batch_size ?? 32,
    maxChunkTokens,
    fallbackChunkTokens,
    fallbackChunkOverlap: index.fallback_chunk_overlap ?? 80,
  };
}

/**
 * Resolve the `[retrieval.query]` block and fail fast on a zero-sum hybrid weight pair
 * (review issue #6). With `vector_weight + text_weight == 0` every hybrid score would
 * collapse to 0 and silently return no results; reject it at config time per the
 * project's explicit-deployment-config / fail-fast preference.
 */
function resolveQuery(
  query: NonNullable<RetrievalConfig["query"]>,
): ResolvedRetrievalConfig["query"] {
  const vectorWeight = query.vector_weight ?? 0.7;
  const textWeight = query.text_weight ?? 0.3;
  if (vectorWeight + textWeight <= 0) {
    throw new Error(
      "Invalid [retrieval.query]: vector_weight + text_weight must be > 0 " +
        `(got vector_weight=${vectorWeight}, text_weight=${textWeight}); a zero-sum ` +
        "weight pair makes every hybrid score 0 and returns no results.",
    );
  }
  return {
    maxResults: query.max_results ?? 6,
    minScore: query.min_score ?? 0.35,
    vectorWeight,
    textWeight,
    candidateMultiplier: query.candidate_multiplier ?? 4,
    mmrEnabled: query.mmr_enabled ?? false,
    mmrLambda: query.mmr_lambda ?? 0.7,
    temporalDecayEnabled: query.temporal_decay_enabled ?? true,
    temporalDecayHalfLifeDays: query.temporal_decay_half_life_days ?? 45,
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
