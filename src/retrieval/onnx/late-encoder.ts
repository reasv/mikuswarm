/**
 * The in-process late-interaction encoder (ARCHITECTURE.md §9d "Late
 * interaction"): a `local` {@link LateEncoder} running a ColBERT-style ONNX
 * model that returns one vector per token, in a worker process
 * (src/retrieval/onnx/onnx-worker.ts) so encoding never blocks the event loop.
 *
 * Text gets the provider's document or query prefix, is trimmed to the token
 * budget (special tokens kept), batched and padded; the token-vector output
 * ([B, T, D]) keeps only real (attention-mask 1) positions, each row
 * L2-normalized. A query model and a document model are separate providers,
 * so an index built by a large document model can be queried by a small model
 * sharing its space.
 */
import type { ResolvedModelProvider } from "../config.js";
import type { LateEncoder, TokenMatrix } from "../models/types.js";
import { throwIfAborted } from "./encoding.js";
import { LazyOnnxModel, lazyModelFor, type LocalOnnxProviderOptions } from "./session.js";

export interface LocalLateEncoderOptions extends LocalOnnxProviderOptions {
  /**
   * Intra-op threads of the document-side worker. Document encoding is
   * background work, so the default is 1.
   */
  threads?: number;
  /**
   * Intra-op threads for query encoding. When set (and different from
   * `threads`), queries run in a second worker with its own session, so a
   * query never waits behind a document batch; otherwise queries share the
   * document worker.
   */
  queryThreads?: number;
  /**
   * Run the (document) worker at low OS priority (niceness 10). Set it for an
   * instance that only encodes documents; implied when `queryThreads` splits
   * queries into their own worker.
   */
  lowPriority?: boolean;
}

export class LocalLateEncoder implements LateEncoder {
  readonly kind = "local" as const;
  readonly name: string;
  readonly model?: string;
  private readonly documents: LazyOnnxModel;
  private readonly queries: LazyOnnxModel;

  constructor(
    private readonly provider: ResolvedModelProvider,
    opts: LocalLateEncoderOptions,
  ) {
    this.name = provider.name;
    this.model = provider.model ?? provider.modelDir;
    const docThreads = opts.threads ?? 1;
    const separateQueries = opts.queryThreads !== undefined && opts.queryThreads !== docThreads;
    // A document-only worker runs at low OS priority; a shared one may serve queries.
    this.documents = lazyModelFor(provider, opts, docThreads, separateQueries || opts.lowPriority ? 10 : undefined);
    this.queries = separateQueries ? lazyModelFor(provider, opts, opts.queryThreads) : this.documents;
  }

  /** Loads the document side, and the query side when it has its own worker. */
  async warm(): Promise<void> {
    await this.documents.warm();
    if (this.queries !== this.documents) await this.queries.warm();
  }

  ready(): boolean {
    return this.documents.ready() && this.queries.ready();
  }

  async encodeDocuments(texts: string[], signal: AbortSignal): Promise<TokenMatrix[]> {
    if (texts.length === 0) return [];
    const model = this.documents.get();
    const batchSize = Math.max(1, this.provider.batchSize);
    const out: TokenMatrix[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      throwIfAborted(signal);
      const batch = texts.slice(start, start + batchSize).map((t) => this.provider.documentPrefix + t);
      out.push(...(await model.call<TokenMatrix[]>("lateEncode", { texts: batch, maxTokens: this.provider.maxTokens }, signal)));
    }
    return out;
  }

  async encodeQuery(text: string, maxTokens: number, signal: AbortSignal): Promise<TokenMatrix> {
    const model = this.queries.get();
    throwIfAborted(signal);
    const limit = Math.max(1, Math.min(maxTokens, this.provider.maxTokens));
    const [matrix] = await model.call<TokenMatrix[]>(
      "lateEncode",
      { texts: [this.provider.queryPrefix + text], maxTokens: limit },
      signal,
    );
    return matrix!;
  }

  async close(): Promise<void> {
    await this.documents.close();
    if (this.queries !== this.documents) await this.queries.close();
  }
}
