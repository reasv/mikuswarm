import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { Logger } from "../../observability/logger.js";
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
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

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

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.options.batchSize) {
      const batch = texts.slice(i, i + this.options.batchSize);
      const vectors = await this.embedBatch(batch);
      out.push(...vectors);
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vec] = await this.embedBatch([text]);
    if (!vec) throw new Error("remote embeddings returned no vector for query");
    return vec;
  }

  private async embedBatch(input: string[]): Promise<Float32Array[]> {
    const url = `${this.options.endpoint.replace(/\/$/, "")}/embeddings`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
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
      if (!res.ok) {
        throw new Error(`embeddings endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
