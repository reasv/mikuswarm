import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Logger } from "../../observability/logger.js";
import { modelHealthKey, parseRetryAfterMs, type LlmScheduler } from "../../agent/scheduler.js";
import { classifyLlmError } from "../../agent/request-retry.js";
import { type EmbeddingProvider, l2normalize } from "./provider.js";

export interface RemoteProviderOptions {
  id: string;
  endpoint: string;
  apiKey: string;
  dim: number;
  batchSize: number;
  httpProxyUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
  /**
   * LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5.4): remote
   * embedding draws on a real upstream budget, so each batch acquires a slot in
   * `rateLimitGroup` at `background` priority. The local ONNX provider never
   * touches the scheduler (no network).
   */
  scheduler?: LlmScheduler;
  /** Rate-limit group for embedding requests. Unset = `default`. */
  rateLimitGroup?: string;
  /** USD per 1M input tokens (spec USAGE-COST-LIMITS §9). Unset/0 = untracked. */
  costPerMtok?: number;
  /** Chars-per-token estimate when the response omits a token count (§9, default 4). */
  charsPerToken?: number;
  /**
   * Unified-ledger sink (spec USAGE-COST-LIMITS §9): called once per embedded
   * batch with the prompt-token count (provider-reported, else estimated) and the
   * computed USD cost, so a class='embedding' `usage_events` row can be emitted.
   */
  onUsage?: (promptTokens: number, costUsd: number) => void;
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
    this.modelId = options.id;
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
    const url = `${this.options.endpoint.replace(/\/$/, "")}/embeddings`;
    // Scheduler admission (spec §5.4) FIRST, before the HTTP timeout is armed: a
    // queue wait or group backoff under contention must not burn the request's
    // wall-clock budget (a long wait would otherwise abort the fetch the moment
    // it was finally admitted). The external stop signal (shutdown) is the only
    // thing that can abort the admission wait; a rejected acquire arms nothing,
    // so there is no timer or listener to leak on that path (#10).
    const group = this.options.rateLimitGroup ?? "default";
    // Health key (spec LLM-FAILURE-HANDLING §5): the embedding model's failure
    // domain, derived the same way as agent sessions' — endpoint + model id.
    const healthKey = modelHealthKey({ baseUrl: this.options.endpoint, id: this.options.id });
    const release = this.options.scheduler
      ? await this.options.scheduler.acquire({ group, priority: "background", modelKey: healthKey, signal: stopSignal })
      : undefined;
    // Per-request timeout (armed only once admitted) combined with the optional
    // external stop signal, so SIGTERM aborts an in-flight fetch without waiting
    // the full timeout, while a normal request still bounds itself by the
    // timeout alone (#11). Everything armed below is torn down in `finally`.
    const controller = new AbortController();
    // Track whether the EXTERNAL stop signal (shutdown) caused the abort. A
    // fetch that throws because of the stop signal is a NEUTRAL shutdown event,
    // not an environmental streak hit (#5) — the per-request timeout abort, by
    // contrast, IS environmental and must feed the model health streak.
    let stopAborted = false;
    const onStop = () => {
      stopAborted = true;
      controller.abort();
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (stopSignal) {
        if (stopSignal.aborted) {
          stopAborted = true;
          controller.abort();
        } else {
          stopSignal.addEventListener("abort", onStop, { once: true });
        }
      }
      timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({ model: this.options.id, input, encoding_format: "float" }),
          signal: controller.signal,
          dispatcher: this.dispatcher,
        });
      } catch (err) {
        // A THROWN fetch (connection refused/reset, DNS failure, or a timeout
        // abort) never reaches the response-path noteOutcome below, so a
        // hard-down endpoint would otherwise never accrue a health streak or
        // trip half-open probing (#5). Feed the model-health streak with an
        // environmental outcome and re-throw — EXCEPT when the external stop
        // signal caused the abort: shutdown is neutral, not a streak hit. The
        // post-response validation throws (dim mismatch, short response) are
        // unaffected — they happen AFTER the early-success noteOutcome below
        // and are never counted here.
        if (!stopAborted) {
          const message = err instanceof Error ? err.message : String(err);
          this.options.scheduler?.noteOutcome(group, healthKey, classifyLlmError(message, undefined));
        }
        throw err;
      }
      // Feed BOTH scheduler axes (spec LLM-FAILURE-HANDLING §5) with the
      // response status — the group's unconditional 429/503 throttle backoff
      // (with the server's Retry-After, clamped to the group's backoff_max_ms)
      // and the embedding model's health streak (429 excluded inside).
      this.options.scheduler?.noteOutcome(
        group,
        healthKey,
        res.ok ? undefined : classifyLlmError(`${res.status} embeddings request failed`, undefined),
        res.ok ? undefined : res.status,
        res.ok ? undefined : parseRetryAfterMs(res.headers),
      );
      if (!res.ok) {
        throw new Error(`embeddings endpoint status ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      // Lightweight response-size guard: the abort timeout bounds wall-clock, not
      // bytes. A misbehaving (operator-configured) endpoint advertising an absurd
      // body would otherwise balloon memory while we buffer it. Reject before reading
      // when the declared content-length is implausible for an embeddings response.
      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error(
          `embeddings endpoint response too large: ${declaredLength} bytes > ${MAX_RESPONSE_BYTES} (${this.options.id})`,
        );
      }
      const json = (await res.json()) as EmbeddingsResponse;
      // Usage accounting (spec USAGE-COST-LIMITS §9): prefer the provider-reported
      // prompt-token count; else estimate from input character length ÷ a configured
      // chars-per-token factor. Cost = tokens / 1e6 × the configured rate (0 when
      // unset → a zero-cost row, counted in the console but invisible to budgets).
      if (this.options.onUsage) {
        const reported = json.usage?.prompt_tokens ?? json.usage?.total_tokens;
        const promptTokens =
          reported ??
          Math.ceil(
            input.reduce((sum, s) => sum + s.length, 0) / (this.options.charsPerToken ?? 4),
          );
        const cost = (promptTokens / 1e6) * (this.options.costPerMtok ?? 0);
        this.options.onUsage(promptTokens, cost);
      }
      const data = json.data ?? [];
      // The response must be a complete 0..n-1 permutation of the input: one vector
      // per input, every index in range, no gaps or dupes. A short/partial/duplicated
      // -index response would otherwise misalign vectors with content-hashes (silent
      // corruption of memory_vec + embedding_cache). Validate and route any mismatch
      // through the normal retry/failed path by throwing, rather than mis-mapping.
      if (data.length !== input.length) {
        throw new Error(
          `embeddings endpoint returned ${data.length} vectors for ${input.length} inputs (${this.options.id})`,
        );
      }
      const out = new Array<Float32Array | undefined>(input.length);
      for (const d of data) {
        if (!Number.isInteger(d.index) || d.index < 0 || d.index >= input.length) {
          throw new Error(
            `embeddings endpoint returned out-of-range index ${d.index} for ${input.length} inputs (${this.options.id})`,
          );
        }
        if (out[d.index] !== undefined) {
          throw new Error(
            `embeddings endpoint returned duplicate index ${d.index} (${this.options.id})`,
          );
        }
        // A malformed element (missing/non-array `embedding`) would otherwise raw-
        // TypeError on `.length`; throw the same descriptive style so it routes
        // through the normal retry path with a clear log.
        if (!Array.isArray(d.embedding)) {
          throw new Error(
            `embeddings endpoint returned a malformed embedding element at index ${d.index} (${this.options.id})`,
          );
        }
        if (d.embedding.length !== this.dim) {
          throw new Error(
            `embedding dim ${d.embedding.length} != configured ${this.dim} for ${this.options.id}`,
          );
        }
        out[d.index] = l2normalize(d.embedding);
      }
      // Every slot is now filled: length matches and indices are a no-gap, no-dupe
      // permutation, so the non-null assertion is safe.
      return out.map((v) => v!);
    } finally {
      release?.();
      if (timeout !== undefined) clearTimeout(timeout);
      if (stopSignal) stopSignal.removeEventListener("abort", onStop);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
