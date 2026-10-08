/**
 * The late-interaction scan scorer seam (ARCHITECTURE.md §9d "Late
 * interaction"). Two backends implement it:
 *
 * - `exact` — fp32 MaxSim on the ONNX runtime in a worker thread (the
 *   portable fallback, src/retrieval/late/maxsim.ts);
 * - `turboquant` — TurboQuant 2–4-bit codes scanned by a fused SIMD kernel in
 *   the native N-API crate (src/retrieval/late/turboquant.ts), whose top
 *   blocks are then re-scored exactly from the stored fp16 vectors.
 *
 * Scores are MaxSim normalised by query length: for each query token the best
 * dot product over the block's tokens, summed over query tokens, divided by
 * the number of query tokens (the mean best-match cosine of unit vectors).
 */
import type { TokenMatrix } from "../models/types.js";

/** Token rows as stored (`memory_late_vectors`), decoded by the scorer off the event loop. */
export interface EncodedRows {
  dtype: "fp16" | "int8";
  dim: number;
  tokenCount: number;
  vectors: Uint8Array;
  scales: Uint8Array | null;
}

/** One document: decoded float32 rows, or the stored encoding (decoded off-thread). */
export type ScoredDoc = { key: string; matrix: TokenMatrix; encoded?: undefined } | { key: string; encoded: EncodedRows; matrix?: undefined };

export function docTokens(doc: ScoredDoc): number {
  return doc.matrix ? doc.matrix.tokens : doc.encoded.tokenCount;
}

export function docDim(doc: ScoredDoc): number {
  return doc.matrix ? doc.matrix.dim : doc.encoded.dim;
}

export interface ScoreTarget {
  /** A resident window set by {@link MaxSimScorer.setWindow}. */
  windowId?: string;
  /** Ad-hoc documents scored alongside (e.g. re-rank candidates beyond the window). */
  docs?: ScoredDoc[];
  /**
   * Approximate backends only: return just this many best keys of the
   * resident window (the rescoring shortlist). Exact backends ignore it and
   * score everything.
   */
  windowTopK?: number;
}

export interface MaxSimScorer {
  /** "exact" | "turboquant". */
  readonly backend: string;
  /** True when window scores are approximate (rescoring advised). */
  readonly approximate: boolean;
  /** Load (replace) a resident window. */
  setWindow(windowId: string, docs: ScoredDoc[]): Promise<void>;
  /** Add (or replace, by key) blocks of a resident window; an unknown window starts empty. */
  addToWindow(windowId: string, docs: ScoredDoc[]): Promise<void>;
  /** Remove blocks of a resident window by key (unknown keys are ignored). */
  removeFromWindow(windowId: string, keys: string[]): Promise<void>;
  /** True while the window is resident (false after a drop, or a worker restart lost it). */
  hasWindow(windowId: string): boolean;
  dropWindow(windowId: string): Promise<void>;
  /** Score the target for one query; rejects with an AbortError when `signal` aborts. */
  score(query: TokenMatrix, target: ScoreTarget, signal?: AbortSignal): Promise<Map<string, number>>;
  close(): Promise<void>;
}
