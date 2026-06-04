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
      // Sort by `index` so order matches the input array regardless of API ordering.
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => {
        if (d.embedding.length !== this.dim) {
          throw new Error(
            `embedding dim ${d.embedding.length} != configured ${this.dim} for ${this.options.id}`,
          );
        }
        return l2normalize(d.embedding);
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
