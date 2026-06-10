import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Logger } from "../../observability/logger.js";
import type { LlmScheduler } from "../../agent/scheduler.js";
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
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
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

  async embedQuery(text: string): Promise<Float32Array> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new Error("remote embeddings returned no vector for query");
    return vec;
  }

  private async embedBatch(input: string[], stopSignal?: AbortSignal): Promise<Float32Array[]> {
    const url = `${this.options.endpoint.replace(/\/$/, "")}/embeddings`;
    // Per-request timeout (always applies) combined with the optional external stop
    // signal (shutdown), so SIGTERM aborts an in-flight fetch without waiting the full
    // timeout, while a normal request still bounds itself by the timeout alone (#11).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const onStop = () => controller.abort();
    if (stopSignal) {
      if (stopSignal.aborted) controller.abort();
      else stopSignal.addEventListener("abort", onStop, { once: true });
    }
    // Scheduler admission (spec §5.4) around the network call; the group's
    // unconditional 429/503 backoff (§5.3) is fed with the response status.
    const group = this.options.rateLimitGroup ?? "default";
    const release = this.options.scheduler
      ? await this.options.scheduler.acquire({ group, priority: "background", signal: controller.signal })
      : undefined;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ model: this.options.id, input, encoding_format: "float" }),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      this.options.scheduler?.noteStatus(group, res.ok ? undefined : res.status);
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
      clearTimeout(timeout);
      if (stopSignal) stopSignal.removeEventListener("abort", onStop);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
