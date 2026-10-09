import type { RetrievalConfig } from "../config/index.js";
import { resolveLocalModel } from "./embedding/local-models.js";

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
  /** Days `memory_retrievals` rows are kept (0 = forever). */
  retrievalsRetentionDays: number;
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
    /** How the hybrid halves fuse: weighted score sum, or reciprocal-rank fusion. */
    fusion: "weighted" | "rrf";
    /** The RRF constant `k` (per lane `1 / (k + rank)`). */
    rrfK: number;
    candidateMultiplier: number;
    mmrEnabled: boolean;
    mmrLambda: number;
    temporalDecayEnabled: boolean;
    temporalDecayHalfLifeDays: number;
    /** recall_memory excerpt length in characters (match-centred). */
    excerptMaxChars: number;
  };
  auto: {
    /** Pack cap (judged and unjudged selections alike). */
    maxResults: number;
    /** Unjudged selection floor (today's topical floor). */
    minScore: number;
    maxTokens: number;
    dedupAgainstRecency: boolean;
    /** Use the `memory` decision point when [decisions] is on (§9d "Judged retrieval"). */
    judge: boolean;
    /**
     * How the judge's verdicts select (§9d "Judge mode"): `order` shows the
     * best passages by the judge's promotion and the cross-encoder, leaving out
     * only those judged neither relevant nor about a participant; `filter`
     * shows only the passages judged relevant (`relevance_threshold`).
     */
    judgeMode: "order" | "filter";
    /** Wide recall: candidates kept after fusing every query and lane. */
    candidates: number;
    /** Pre-decay relevance floor of the recall lanes. */
    candidateMinScore: number;
    /** Candidate slots reserved for user-lane hits. */
    userLaneCandidates: number;
    /** Messages of the conversation-window query. */
    queryMessages: number;
    /** A kept block up to this many tokens is shown whole. */
    excerptMaxTokens: number;
    /** Person-cued recall: newest tagged entries per active person, and the total cap. */
    personRecent: number;
    personRecentMax: number;
    /** Decision chain down: floor and cap of the fallback selection. */
    fallbackMinScore: number;
    fallbackMaxResults: number;
    /** Most passages one build sends to the memory point (person-cued included); the rest fall back. */
    maxJudged: number;
    /**
     * Most of a decision group's `max_in_flight` slots memory judging holds at
     * once, as a fraction (at least one slot), so routing, records and the
     * send/ending checks always find a free slot.
     */
    judgeSlotShare: number;
    /** User lane (§9d): lexical "history with this person" sub-search, by display name. */
    userLane: {
      enabled: boolean;
      maxResults: number;
      minScore: number;
      prefixEnabled: boolean;
      prefixMinChars: number;
    };
  };
  embedding: {
    /** Resolved active provider: remote iff a remote block is configured (§5a). */
    provider: "local" | "remote";
    local: {
      model: string;
      dim: number;
      /** Overrides of the model's built-in prefixes (embedding/local-models.ts); unset = built-in. */
      queryPrefix?: string;
      passagePrefix?: string;
    };
    remote: {
      /** `[models.*]` block name (spec MODEL-FALLBACK §2.3); the chain is resolved at app wiring. */
      model: string;
      dim: number;
      /** Chars-per-token estimate when the response omits a token count (§9). */
      charsPerToken?: number;
    } | null;
    /**
     * Optional primary embedder with its own vector index (§9d "Two vector
     * indexes"); null when not configured or disabled.
     */
    primary: {
      model: string;
      dim: number;
      timeoutMs: number;
      charsPerToken?: number;
      /** Prepended to the query text before embedding ("" = none). */
      queryPrefix: string;
      /** Prepended to each document text before embedding ("" = none). */
      documentPrefix: string;
    } | null;
  };
  /** Cross-encoder re-rank stage (§9d "Re-rank stages"). */
  rerank: {
    enabled: boolean;
    chain: string[];
    topN: number;
    timeoutMs: number;
    /** The query: the request alone, or the request plus a conversation tail. */
    query: "request" | "conversation";
    queryMaxChars: number;
    providers: Record<string, ResolvedModelProvider>;
  };
  /** Late-interaction stage (§9d "Late interaction"). */
  late: {
    enabled: boolean;
    model: string;
    /** Every model id sharing the index's space (the index model and its family). */
    family: string[];
    queryMaxTokens: number;
    /** Newest indexed blocks outside the recency layer scored exhaustively; Infinity = all. */
    exhaustiveBlocks: number;
    topN: number;
    timeoutMs: number;
    resident: boolean;
    quantization: "turboquant" | "none";
    bits: 2 | 3 | 4;
    rescore: number;
    chain: string[];
    queryChain: string[];
    dtype: "fp16" | "int8";
    indexBatchSize: number;
    calibration: Record<string, number>;
    providers: Record<string, ResolvedModelProvider>;
  };
}

/** One resolved re-rank / late-interaction provider (§9d). */
export interface ResolvedModelProvider {
  name: string;
  kind: "remote" | "local";
  enabled: boolean;
  endpoint?: string;
  path?: string;
  apiKey?: string;
  model?: string;
  zdr: boolean;
  selfHosted: boolean;
  requestFormat: "documents" | "texts";
  timeoutMs?: number;
  minScore?: number;
  modelDir?: string;
  /** local: the pinned Hugging Face revision (a commit) of a downloaded model. */
  revision?: string;
  /** local: expected sha256 per model file (relative path → hex digest). */
  sha256?: Record<string, string>;
  onnxFile: string;
  maxTokens: number;
  batchSize: number;
  queryPrefix: string;
  documentPrefix: string;
  inputTypeField: string;
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
    retrievalsRetentionDays: config?.retrievals_retention_days ?? 90,
    index: resolveIndex(index),
    query: resolveQuery(query),
    auto: {
      maxResults: auto.max_results ?? 4,
      minScore: auto.min_score ?? 0.45,
      maxTokens: auto.max_tokens ?? 2000,
      dedupAgainstRecency: auto.dedup_against_recency ?? true,
      judge: auto.judge ?? true,
      judgeMode: auto.judge_mode ?? "order",
      candidates: auto.candidates ?? 60,
      candidateMinScore: auto.candidate_min_score ?? 0.25,
      userLaneCandidates: auto.user_lane_candidates ?? 8,
      queryMessages: auto.query_messages ?? 6,
      excerptMaxTokens: auto.excerpt_max_tokens ?? 400,
      personRecent: auto.person_recent ?? 2,
      personRecentMax: auto.person_recent_max ?? 8,
      fallbackMinScore: auto.fallback_min_score ?? 0.6,
      fallbackMaxResults: auto.fallback_max_results ?? 2,
      maxJudged: auto.max_judged ?? 12,
      judgeSlotShare: auto.judge_slot_share ?? 0.5,
      userLane: {
        enabled: auto.user_lane_enabled ?? true,
        maxResults: auto.user_lane_max_results ?? 2,
        // Lower than auto.minScore (0.45): a single exact name-token hit lands ~0.45,
        // so a tighter floor would drop the very entries the lane exists to surface.
        minScore: auto.user_lane_min_score ?? 0.3,
        prefixEnabled: auto.user_lane_prefix_enabled ?? true,
        prefixMinChars: auto.user_lane_prefix_min_chars ?? 4,
      },
    },
    embedding: {
      provider,
      local: {
        model: embedding.local?.model ?? DEFAULT_LOCAL_MODEL,
        dim: embedding.local?.dim ?? DEFAULT_LOCAL_DIM,
        queryPrefix: embedding.local?.query_prefix,
        passagePrefix: embedding.local?.passage_prefix,
      },
      remote: remoteBlock
        ? {
            model: remoteBlock.model,
            dim: remoteBlock.dim,
            charsPerToken: remoteBlock.chars_per_token,
          }
        : null,
      primary: resolvePrimary(embedding.primary),
    },
    rerank: resolveRerank(config?.rerank),
    late: resolveLate(config?.late),
  };
}

type RawProvider = NonNullable<NonNullable<RetrievalConfig["rerank"]>["providers"]>[string];

function resolveProviders(
  section: string,
  raw: Record<string, RawProvider> | undefined,
): Record<string, ResolvedModelProvider> {
  const out: Record<string, ResolvedModelProvider> = {};
  for (const [name, p] of Object.entries(raw ?? {})) {
    const where = `[retrieval.${section}.providers.${name}]`;
    if (p.kind === "remote") {
      if (!p.endpoint) throw new Error(`${where}: a remote provider needs an endpoint`);
      // Diary text derives from user messages: a remote provider must be
      // self-hosted or a zero-data-retention route, and the operator says which.
      if (p.zdr !== true && p.self_hosted !== true) {
        throw new Error(`${where}: a remote provider must set zdr = true or self_hosted = true`);
      }
    } else if (!p.model && !p.model_dir) {
      throw new Error(
        `${where}: a local provider needs \`model\` (a Hugging Face repo id) or \`model_dir\`; no built-in default model is shipped yet`,
      );
    }
    out[name] = {
      name,
      kind: p.kind,
      enabled: p.enabled ?? true,
      endpoint: p.endpoint?.replace(/\/$/, ""),
      path: p.path,
      apiKey: p.api_key || undefined,
      model: p.model,
      zdr: p.zdr === true,
      selfHosted: p.self_hosted === true,
      requestFormat: p.request_format ?? "documents",
      timeoutMs: p.timeout_ms,
      minScore: p.min_score,
      modelDir: p.model_dir,
      revision: p.revision,
      sha256: p.sha256,
      onnxFile: p.onnx_file ?? "onnx/model.onnx",
      maxTokens: p.max_tokens ?? 512,
      batchSize: p.batch_size ?? 16,
      queryPrefix: p.query_prefix ?? "",
      documentPrefix: p.document_prefix ?? "",
      inputTypeField: p.input_type_field ?? "input_type",
    };
  }
  return out;
}

function checkChain(section: string, chain: string[], providers: Record<string, ResolvedModelProvider>): void {
  for (const name of chain) {
    if (!providers[name]) {
      throw new Error(`[retrieval.${section}].chain names "${name}", which is not a [retrieval.${section}.providers.*] block`);
    }
  }
}

function resolveRerank(raw: RetrievalConfig["rerank"]): ResolvedRetrievalConfig["rerank"] {
  const providers = resolveProviders("rerank", raw?.providers);
  const chain = raw?.chain ?? Object.keys(providers);
  const enabled = raw?.enabled ?? false;
  if (enabled) {
    checkChain("rerank", chain, providers);
    if (chain.length === 0) throw new Error("[retrieval.rerank] is enabled but its chain names no provider");
  }
  return {
    enabled,
    chain,
    topN: raw?.top_n ?? 8,
    timeoutMs: raw?.timeout_ms ?? 1500,
    query: raw?.query ?? "request",
    queryMaxChars: raw?.query_max_chars ?? 1200,
    providers,
  };
}

function resolveLate(raw: RetrievalConfig["late"]): ResolvedRetrievalConfig["late"] {
  const providers = resolveProviders("late", raw?.providers);
  const enabled = raw?.enabled ?? false;
  const model = raw?.model ?? "";
  const family = Array.from(new Set([model, ...(raw?.family ?? [])].filter((m) => m.length > 0)));
  const chain = raw?.chain ?? Object.keys(providers);
  const queryChain = raw?.query_chain ?? chain;
  if (enabled) {
    if (!model) throw new Error("[retrieval.late] is enabled but names no model");
    checkChain("late", chain, providers);
    checkChain("late", queryChain, providers);
    if (chain.length === 0) throw new Error("[retrieval.late] is enabled but its chain names no provider");
    // Every provider names the model it serves (a model_dir-only provider too):
    // document encoders exactly the index's model (the stored vectors are one
    // model's), query encoders the index model or its shared-space family.
    for (const name of new Set([...chain, ...queryChain])) {
      const served = providers[name]!.model;
      if (!served) {
        throw new Error(`[retrieval.late.providers.${name}]: set \`model\` to the model it serves (with model_dir, the id of the files)`);
      }
      if (chain.includes(name) && served !== model) {
        throw new Error(
          `[retrieval.late.providers.${name}] encodes documents with "${served}", but the index model is "${model}" ` +
            `(family models may only encode queries: list them in query_chain only)`,
        );
      }
      if (!family.includes(served)) {
        throw new Error(
          `[retrieval.late.providers.${name}] serves "${served}", which is not the index model "${model}" or of its family`,
        );
      }
    }
  }
  const exhaustive = raw?.exhaustive_blocks ?? 0;
  return {
    enabled,
    model,
    family,
    queryMaxTokens: raw?.query_max_tokens ?? 64,
    exhaustiveBlocks: exhaustive === "all" ? Number.POSITIVE_INFINITY : exhaustive,
    topN: raw?.top_n ?? 20,
    timeoutMs: raw?.timeout_ms ?? 300,
    resident: raw?.resident ?? true,
    quantization: raw?.quantization ?? "turboquant",
    bits: (raw?.bits ?? 4) as 2 | 3 | 4,
    rescore: raw?.rescore ?? 60,
    chain,
    queryChain,
    dtype: raw?.dtype ?? "fp16",
    indexBatchSize: raw?.index_batch_size ?? 4,
    calibration: raw?.calibration ?? {},
    providers,
  };
}

function resolvePrimary(
  raw: NonNullable<RetrievalConfig["embedding"]>["primary"],
): ResolvedRetrievalConfig["embedding"]["primary"] {
  if (!raw || raw.enabled === false) return null;
  if (raw.zdr !== true && raw.self_hosted !== true) {
    throw new Error("[retrieval.embedding.primary]: set zdr = true or self_hosted = true (diary text derives from user messages)");
  }
  return {
    model: raw.model,
    dim: raw.dim,
    timeoutMs: raw.timeout_ms ?? 1000,
    charsPerToken: raw.chars_per_token,
    queryPrefix: raw.query_prefix ?? "",
    documentPrefix: raw.document_prefix ?? "",
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
    fusion: query.fusion ?? "weighted",
    rrfK: query.rrf_k ?? 60,
    candidateMultiplier: query.candidate_multiplier ?? 4,
    mmrEnabled: query.mmr_enabled ?? false,
    mmrLambda: query.mmr_lambda ?? 0.7,
    temporalDecayEnabled: query.temporal_decay_enabled ?? true,
    temporalDecayHalfLifeDays: query.temporal_decay_half_life_days ?? 45,
    excerptMaxChars: query.excerpt_max_chars ?? 600,
  };
}

/** The dimension of the currently-active embedding model (§5a/§6). */
export function activeEmbeddingDim(resolved: ResolvedRetrievalConfig): number {
  return resolved.embedding.provider === "remote" && resolved.embedding.remote
    ? resolved.embedding.remote.dim
    : resolved.embedding.local.dim;
}

/**
 * Logical id of the currently-active embedding model, for display/index_meta. For
 * remote this is the `[models.*]` ref (spec MODEL-FALLBACK §2.3); the vector index
 * itself keys on the resolved head wire id (`provider.modelId`) at ensureSchema.
 */
export function activeEmbeddingModelId(resolved: ResolvedRetrievalConfig): string {
  return resolved.embedding.provider === "remote" && resolved.embedding.remote
    ? resolved.embedding.remote.model
    : resolveLocalModel(resolved.embedding.local.model, resolved.embedding.local).modelId;
}

/**
 * The re-rank cut before the decision model (§9d "Judged retrieval"): the
 * cross-encoder's `top_n` when it runs, else the late-interaction top 8
 * (vector-less blocks bypass it, up to 12 in all), else the hybrid top 12.
 * {@link judgedPerBuildMax} is the real per-build request count.
 */
export const JUDGED_AFTER_LATE = 8;
export const JUDGED_AFTER_HYBRID = 12;
export function judgedPassageCap(resolved: ResolvedRetrievalConfig): number {
  if (resolved.rerank.enabled) return resolved.rerank.topN;
  if (resolved.late.enabled) return Math.min(resolved.late.topN, JUDGED_AFTER_LATE);
  return JUDGED_AFTER_HYBRID;
}
/**
 * The most memory-point requests one build can send: the re-rank survivors
 * (the cross-encoder's `top_n`, or 12 when it is off or fails at runtime) plus
 * the person-cued candidates, capped by `auto.max_judged`.
 */
export function judgedPerBuildMax(resolved: ResolvedRetrievalConfig): number {
  const ranked = Math.max(resolved.rerank.enabled ? resolved.rerank.topN : 0, JUDGED_AFTER_HYBRID);
  const person = resolved.auto.personRecent > 0 ? resolved.auto.personRecentMax : 0;
  return Math.min(resolved.auto.maxJudged, ranked + person);
}
