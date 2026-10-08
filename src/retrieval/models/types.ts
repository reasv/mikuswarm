/**
 * Model-provider seams of the re-rank stages (ARCHITECTURE.md §9d "Re-rank
 * stages"): cross-encoder re-rankers and late-interaction encoders, each kind
 * served by `remote` (HTTP) or `local` (in process, ONNX) providers that a
 * {@link ProviderChain} tries in order with health and fallover.
 */

/** One text encoded as one L2-normalized vector per token (row-major). */
export interface TokenMatrix {
  tokens: number;
  dim: number;
  /** `tokens × dim` floats, each row L2-normalized. */
  data: Float32Array;
}

/**
 * Thrown by a provider that cannot serve yet (a local model still loading or
 * downloading). Neutral for health: the chain skips the member without a
 * strike, so a cold start never marks the built-in rung unhealthy.
 */
export class ProviderNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNotReadyError";
  }
}

export interface ProviderBase {
  /** The `[retrieval.<stage>.providers.<name>]` key. */
  readonly name: string;
  readonly kind: "remote" | "local";
  /** The model it serves (remote: wire id; local: repo id or directory). */
  readonly model?: string;
  /** Start loading in the background (local models); never awaited on a trigger. */
  warm?(): Promise<void>;
  close(): Promise<void>;
}

/** A cross-encoder: one relevance score per (query, document) pair, same order. */
export interface RerankProvider extends ProviderBase {
  score(query: string, documents: string[], signal: AbortSignal): Promise<number[]>;
}

/** A late-interaction encoder (ColBERT-style multi-vector). */
export interface LateEncoder extends ProviderBase {
  /** Document side (background indexing). */
  encodeDocuments(texts: string[], signal: AbortSignal): Promise<TokenMatrix[]>;
  /** Query side, truncated to `maxTokens` tokens. */
  encodeQuery(text: string, maxTokens: number, signal: AbortSignal): Promise<TokenMatrix>;
}
