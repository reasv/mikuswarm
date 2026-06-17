import { decode, encode } from "gpt-tokenizer/model/gpt-4o";
import { splitWith, truncateWith } from "./algorithms.js";
import type { Tokenizer, TokenWindow } from "./types.js";

/**
 * The shipped default tokenizer (spec/TOKENIZER-SWAP.md §5.1): `gpt-tokenizer`
 * pinned to the gpt-4o BPE. Pure JS, synchronous, ~2 µs per small encode — fast
 * enough that no async escape hatch is worthwhile, so `countAsync` is intentionally
 * omitted (callers fall back to sync `count`).
 *
 * Behaviour is identical to the pre-swap `estimateTokens`/`truncateToTokens`/
 * `splitByTokens`, so selecting `gpt-tokenizer` (the default) is a no-op.
 */
export class GptTokenizer implements Tokenizer {
  count(text: string): number {
    if (!text) return 0;
    return encode(text).length;
  }

  truncate(text: string, maxTokens: number): string {
    return truncateWith(encode, decode, text, maxTokens);
  }

  split(text: string, size: number, overlap: number): TokenWindow[] {
    return splitWith(encode, decode, text, size, overlap);
  }
}
