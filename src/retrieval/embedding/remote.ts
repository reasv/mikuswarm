import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Logger } from "../../observability/logger.js";
import { parseRetryAfterMs, type LlmScheduler } from "../../agent/scheduler.js";
import {
  runFetchWithFallback,
  type ModelChainEntry,
  type FetchChainMember,
} from "../../agent/model-fallback.js";
import { type EmbeddingProvider, l2normalize } from "./provider.js";

export interface RemoteProviderOptions {
  /**
   * Resolved embedding model chain (spec MODEL-FALLBACK §2.3/§6): the referenced
   * `[models.*]` head plus any `fallback` members (connection / rate-limit group /
   * cost.input = USD per 1M input tokens, all on each block). The head's wire id
   * is the cache/index key. A fallback member MUST be vector-compatible (same `dim`
   * AND embedding space) — the dim check rejects a wrong width; a same-dim
   * different-space model would corrupt the cache, so point fallback at the same
   * model on a different endpoint.
   */
  chain: ModelChainEntry[];
  dim: number;
  batchSize: number;
  httpProxyUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
  /**
   * LLM request scheduler (spec §5.4): remote embedding draws on a real upstream
   * budget, so each attempt acquires a slot at `background` priority (per-member
   * group). The local ONNX provider never touches the scheduler (no network).
   */
  scheduler?: LlmScheduler;
  /** Budget availability by logical id (spec §3/§7) — skips an over-cap member. */
  isModelAvailable?: (logicalId: string) => boolean;
  /** Chars-per-token estimate when the response omits a token count (§9, default 4). */
  charsPerToken?: number;
  /**
   * Unified-ledger sink (spec USAGE-COST-LIMITS §9): called once per embedded
   * batch with the prompt-token count, the computed USD cost, and the BILLED
   * member's logical/upstream ids, so a class='embedding' `usage_events` row can
   * be emitted with exact model attribution (spec MODEL-FALLBACK §2.2).
   */
  onUsage?: (info: { promptTokens: number; costUsd: number; logicalModelId: string; modelId: string }) => void;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  /** OpenAI-compatible usage block (OpenRouter returns it); absent → estimate (§9). */
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Upper bound on a buffered embeddings response (16 MiB). Generous for any legitimate
 * batch (a few thousand float vectors as JSON) but small enough to reject a runaway
 * body before reading it. The per-request abort timeout bounds time, not bytes (#7).
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Remote embedding provider (ARCHITECTURE.md §9d / design §5d): an OpenRouter/OpenAI
 * -compatible `POST {endpoint}/embeddings` (`{ model, input, encoding_format:"float" }`
 * → `{ data: [{ embedding, index }] }`). `input` accepts an array, so documents embed
 * in batches; queries embed singly. Vectors are L2-normalized to match the local
 * provider and the cosine index. Remote models are symmetric, so query == document.
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;
  private readonly options: RemoteProviderOptions;
  private readonly dispatcher?: Dispatcher;

  constructor(options: RemoteProviderOptions) {
    this.options = options;
    // The head's wire id is the stable cache/index key; fallback members must be
    // vector-compatible (see RemoteProviderOptions.chain).
    this.modelId = options.chain[0]!.config.id;
    this.dim = options.dim;
    this.dispatcher = options.httpProxyUrl ? new ProxyAgent(options.httpProxyUrl) : undefined;
  }

  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.options.batchSize) {
      const batch = texts.slice(i, i + this.options.batchSize);
      const vectors = await this.embedBatch(batch, signal);
      out.push(...vectors);
    }
    return out;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    // The `signal` (interactive build deadline, §9d #7) flows into `embedBatch`
    // as its `stopSignal`: it aborts the admission wait and the in-flight fetch
    // alike, so an embed-model outage degrades the inline auto-retrieval query
    // to lexical-only instead of blocking the build. A stop-signal abort is
    // NEUTRAL — it never feeds the model-health streak (see embedBatch).
    const [vec] = await this.embedBatch([text], signal);
    if (!vec) throw new Error("remote embeddings returned no vector for query");
    return vec;
  }

  private async embedBatch(input: string[], stopSignal?: AbortSignal): Promise<Float32Array[]> {
    // Transparent embedding-model fallback (spec MODEL-FALLBACK §6): the chain is
    // tried in order, each member's endpoint/id/api_key/cost used per attempt.
    // `runFetchWithFallback` owns admission (background, per-member group/health),
    // both-axes noteOutcome, and the canary. The external stop signal aborts both
    // the admission wait and the in-flight fetch; a stop-abort surfaces as an
    // AbortError the helper treats as NEUTRAL (never a health-streak hit, #5).
    let billed: FetchChainMember | undefined;
    let billedPromptTokens = 0;
    const vectors = await runFetchWithFallback<Float32Array[]>(
      this.options.chain,
      {
        consumer: "embedding",
        priority: "background",
        scheduler: this.options.scheduler,
        isModelAvailable: this.options.isModelAvailable,
        probeBackoffMaxMs: (cfg) => cfg.llm_probe_backoff_max_ms,
        signal: stopSignal,
      },
      async (member) => {
        const url = `${member.config.endpoint.replace(/\/$/, "")}/embeddings`;
        // Per-request timeout composed with the external stop signal (#11).
        const controller = new AbortController();
        const onStop = () => controller.abort();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (stopSignal) {
          if (stopSignal.aborted) controller.abort();
          else stopSignal.addEventListener("abort", onStop, { once: true });
        }
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
        try {
          let res: Awaited<ReturnType<typeof fetch>>;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${member.config.api_key}`,
              },
              body: JSON.stringify({ model: member.config.id, input, encoding_format: "float" }),
              signal: controller.signal,
              dispatcher: this.dispatcher,
            });
          } catch (err) {
            // A stop-signal abort is a neutral teardown — propagate so the helper
            // classifies it `aborted`. Other throws (reset/DNS/timeout) fall over.
            if (stopSignal?.aborted) throw err;
            return { ok: false as const, kind: "environmental" as const, error: err };
          }
          if (!res.ok) {
            const status = res.status;
            const retryAfterMs = parseRetryAfterMs(res.headers) ?? undefined;
            const text = (await res.text()).slice(0, 200);
            return {
              ok: false as const,
              kind: "environmental" as const,
              status,
              retryAfterMs,
              error: new Error(`embeddings endpoint status ${status}: ${text}`),
            };
          }
          try {
            const out = await this.parseEmbeddings(res, input, member.config.id);
            // Usage accounting (spec USAGE-COST-LIMITS §9): prompt tokens reported,
            // else estimated from input chars ÷ chars-per-token; captured for the
            // post-success onUsage with the billed member's per-MTok cost.input.
            billed = member;
            billedPromptTokens = out.promptTokens;
            return { ok: true as const, value: out.vectors };
          } catch (err) {
            // A malformed/short/dim-mismatched response (silent-corruption guard):
            // fall over rather than mis-map vectors to content hashes.
            return { ok: false as const, kind: "environmental" as const, error: err };
          }
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          if (stopSignal) stopSignal.removeEventListener("abort", onStop);
        }
      },
    );

    if (this.options.onUsage && billed) {
      const cost = (billedPromptTokens / 1e6) * (billed.config.cost?.input ?? 0);
      this.options.onUsage({
        promptTokens: billedPromptTokens,
        costUsd: cost,
        logicalModelId: billed.logicalId,
        modelId: billed.config.id,
      });
    }
    return vectors;
  }

  /**
   * Parse + validate an embeddings response into a complete 0..n-1 permutation of
   * `input`-aligned, L2-normalized vectors (spec §5d). Any short/partial/
   * duplicate-index/wrong-dim response throws (silent-corruption guard) — the
   * caller routes that to fallover. Also returns the prompt-token count (reported
   * or estimated) for usage accounting.
   */
  private async parseEmbeddings(
    res: Awaited<ReturnType<typeof fetch>>,
    input: string[],
    modelId: string,
  ): Promise<{ vectors: Float32Array[]; promptTokens: number }> {
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error(`embeddings endpoint response too large: ${declaredLength} bytes > ${MAX_RESPONSE_BYTES} (${modelId})`);
    }
    const json = (await res.json()) as EmbeddingsResponse;
    const reported = json.usage?.prompt_tokens ?? json.usage?.total_tokens;
    const promptTokens =
      reported ?? Math.ceil(input.reduce((sum, s) => sum + s.length, 0) / (this.options.charsPerToken ?? 4));
    const data = json.data ?? [];
    if (data.length !== input.length) {
      throw new Error(`embeddings endpoint returned ${data.length} vectors for ${input.length} inputs (${modelId})`);
    }
    const out = new Array<Float32Array | undefined>(input.length);
    for (const d of data) {
      if (!Number.isInteger(d.index) || d.index < 0 || d.index >= input.length) {
        throw new Error(`embeddings endpoint returned out-of-range index ${d.index} for ${input.length} inputs (${modelId})`);
      }
      if (out[d.index] !== undefined) {
        throw new Error(`embeddings endpoint returned duplicate index ${d.index} (${modelId})`);
      }
      if (!Array.isArray(d.embedding)) {
        throw new Error(`embeddings endpoint returned a malformed embedding element at index ${d.index} (${modelId})`);
      }
      if (d.embedding.length !== this.dim) {
        throw new Error(`embedding dim ${d.embedding.length} != configured ${this.dim} for ${modelId}`);
      }
      out[d.index] = l2normalize(d.embedding);
    }
    return { vectors: out.map((v) => v!), promptTokens };
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
