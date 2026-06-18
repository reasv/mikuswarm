import { getPrimaryTokenizer } from "./tokenizer/registry.js";
import type { TokenWindow } from "./tokenizer/types.js";

export type { TokenWindow } from "./tokenizer/types.js";

/**
 * The token-estimation seam (spec/TOKENIZER-SWAP.md §3; ARCHITECTURE.md §9
 * "Tokenization"). These module-level functions are the ~30 chat/context/
 * summarization call sites' entry point; each now delegates to the configured
 * **primary** (chat-model) tokenizer from the registry. Selecting `gpt-tokenizer`
 * (the default) is behaviour-identical to the pre-swap code.
 *
 * The retrieval chunker does NOT use these — it measures against the
 * embedder-matched retrieval tokenizer, injected explicitly (§5.3). See
 * `src/retrieval/chunk.ts`.
 */

export function estimateTokens(input: string): number {
  if (!input) return 0;
  return getPrimaryTokenizer().count(input);
}

/**
 * Truncate text to at most `maxTokens` tokens using the real tokenizer. If the
 * text is already within budget, it is returned unchanged.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  return getPrimaryTokenizer().truncate(text, maxTokens);
}

export function estimateObjectTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Split `text` into overlapping windows of at most `size` tokens, advancing by
 * `size - overlap` tokens each step (each window carries its character offsets).
 * Retained as part of the seam's surface; the retrieval indexer chunks through the
 * injected retrieval tokenizer's `split` instead of this primary-bound helper.
 */
export function splitByTokens(text: string, size: number, overlap: number): TokenWindow[] {
  return getPrimaryTokenizer().split(text, size, overlap);
}
