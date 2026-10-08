/**
 * The in-process CPU cross-encoder (ARCHITECTURE.md §9d "Re-rank stages"): a
 * `local` {@link RerankProvider} running an ONNX sequence-classification model
 * with its Hugging Face tokenizer, in its own worker process
 * (src/retrieval/onnx/onnx-worker.ts) so scoring never blocks the event loop.
 *
 * Each (query, document) pair is encoded as the model's pair template, trimmed
 * to `max_tokens` from the document's end (the query only when it alone exceeds
 * the budget), batched up to `batch_size` and padded to the batch's longest.
 * Scores are probabilities: sigmoid of a single logit, or the positive class's
 * softmax for a two-logit head.
 */
import { availableParallelism } from "node:os";
import type { ResolvedModelProvider } from "../config.js";
import type { RerankProvider } from "../models/types.js";
import { throwIfAborted } from "./encoding.js";
import { LazyOnnxModel, lazyModelFor, type LocalOnnxProviderOptions } from "./session.js";

export class LocalCrossEncoder implements RerankProvider {
  readonly kind = "local" as const;
  readonly name: string;
  readonly model?: string;
  private readonly lazy: LazyOnnxModel;

  /** `opts.threads`: the worker's intra-op threads (default min(4, cores); scoring is interactive). */
  constructor(
    private readonly provider: ResolvedModelProvider,
    opts: LocalOnnxProviderOptions,
  ) {
    this.name = provider.name;
    this.model = provider.model ?? provider.modelDir;
    this.lazy = lazyModelFor(provider, opts, opts.threads ?? Math.min(4, availableParallelism()));
  }

  warm(): Promise<void> {
    return this.lazy.warm();
  }

  ready(): boolean {
    return this.lazy.ready();
  }

  async score(query: string, documents: string[], signal: AbortSignal): Promise<number[]> {
    if (documents.length === 0) return [];
    const model = this.lazy.get(); // ProviderNotReadyError while loading
    const batchSize = Math.max(1, this.provider.batchSize);
    const out: number[] = [];
    for (let start = 0; start < documents.length; start += batchSize) {
      throwIfAborted(signal);
      const scores = await model.call<number[]>(
        "crossScore",
        { query, documents: documents.slice(start, start + batchSize), maxTokens: this.provider.maxTokens },
        signal,
      );
      out.push(...scores);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.lazy.close();
  }
}
