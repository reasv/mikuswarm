import type { Logger } from "../../observability/logger.js";

/**
 * The embedding-provider seam (ARCHITECTURE.md §9d / design §5). A single provider
 * is active at a time (§5a); its `modelId`/`dim` govern the entire vector index.
 * Document and query embeddings are L2-normalized so cosine distance is meaningful.
 */
export interface EmbeddingProvider {
  /** Identity recorded in `index_meta`/`memory_chunks.model_id` (§5a/§6). */
  readonly modelId: string;
  readonly dim: number;
  /** Embed documents (passage side for asymmetric retrieval models). */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  /** Embed a single query (query side). */
  embedQuery(text: string): Promise<Float32Array>;
  close(): Promise<void>;
}

/** L2-normalize a raw embedding into a Float32Array (§5e). */
export function l2normalize(values: number[] | Float32Array): Float32Array {
  let sumSq = 0;
  for (const x of values) sumSq += x * x;
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm;
  return out;
}

/** Map a config model name to a fastembed model id string (§5c). */
function fastembedModelId(name: string): string {
  switch (name) {
    case "bge-small-en-v1.5":
      return "fast-bge-small-en-v1.5";
    case "bge-small-en":
      return "fast-bge-small-en";
    case "all-MiniLM-L6-v2":
      return "fast-all-MiniLM-L6-v2";
    case "bge-base-en-v1.5":
      return "fast-bge-base-en-v1.5";
    default:
      // Unknown → assume it is already a fastembed id; let init fail loudly if not.
      return name;
  }
}

export interface LocalProviderOptions {
  model: string;
  dim: number;
  /** Where fastembed downloads/caches ONNX weights (first run only). */
  cacheDir: string;
  logger?: Logger;
}

/**
 * Local in-process embedder backed by fastembed (onnxruntime-node). The native
 * module and model weights load lazily on the first embed call — first-run download
 * happens in the background indexer, never on a user trigger (§5c). Asymmetric
 * retrieval: documents via `passageEmbed`, queries via `queryEmbed` (the model's
 * trained prefixes), both within the SAME model so the spaces stay comparable (§5a).
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;
  private readonly options: LocalProviderOptions;
  // fastembed's FlagEmbedding instance, lazily created. Untyped to keep the native
  // dependency out of the type graph (it is dynamically imported).
  private flag: Promise<any> | null = null;

  constructor(options: LocalProviderOptions) {
    this.options = options;
    this.modelId = `local:${options.model}`;
    this.dim = options.dim;
  }

  private async embedding(): Promise<any> {
    if (!this.flag) {
      this.flag = (async () => {
        const fastembed: any = await import("fastembed");
        this.options.logger?.info("embedding_model_init", { model: this.options.model });
        return fastembed.FlagEmbedding.init({
          model: fastembedModelId(this.options.model),
          cacheDir: this.options.cacheDir,
          showDownloadProgress: false,
        });
      })().catch((error) => {
        this.flag = null; // allow retry on a transient init failure
        throw error;
      });
    }
    return this.flag;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const flag = await this.embedding();
    const out: Float32Array[] = [];
    // passageEmbed yields batches of number[][]; flatten and normalize.
    for await (const batch of flag.passageEmbed(texts, texts.length) as AsyncGenerator<number[][]>) {
      for (const vec of batch) out.push(l2normalize(vec));
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const flag = await this.embedding();
    const vec: number[] = await flag.queryEmbed(text);
    return l2normalize(vec);
  }

  async close(): Promise<void> {
    this.flag = null;
  }
}
