import { createRequire } from "node:module";

/**
 * NAPI surface of the native GLM tokenizer (spec/TOKENIZER-SWAP.md §5.2), exported
 * from the same `matrix-core` module as the Matrix client. One instance wraps one
 * loaded `tokenizer.json`. Counts use `addSpecialTokens = false` so per-string
 * counts don't absorb GLM's BOS/`[gMASK]`/`<sop>` overhead (parity with
 * `gpt-tokenizer`).
 */
export declare class NativeTokenizer {
  /** Load a Hugging Face `tokenizer.json` from disk. Throws (path included) on a
   *  missing/invalid file so a misconfigured `glm` asset fail-fasts at startup. */
  static fromFile(path: string): NativeTokenizer;
  /** Encode to token ids; `addSpecialTokens` defaults to false. */
  encode(text: string, addSpecialTokens?: boolean): Uint32Array;
  /** Decode ids back to text (special tokens not skipped → lossless round-trip
   *  for byte-level BPE). */
  decode(ids: Uint32Array): string;
  /** Token count with `addSpecialTokens = false`. */
  countTokens(text: string): number;
  /** Async encode on a libuv worker thread (the §4 escape hatch). */
  encodeAsync(text: string, addSpecialTokens?: boolean): Promise<Uint32Array>;
}

const require = createRequire(import.meta.url);
const binding = require("../../../npm/index.js") as {
  NativeTokenizer?: typeof NativeTokenizer;
};

if (!binding.NativeTokenizer) {
  // The prebuilt artifact predates the tokenizer export. Surfaced only when the
  // `glm` tokenizer is actually selected; the default `gpt-tokenizer` never loads
  // this module.
  throw new Error(
    "native module does not export NativeTokenizer — rebuild it with `pnpm build:native` " +
      "(spec/TOKENIZER-SWAP.md §5.2)",
  );
}

export const NativeTokenizerBinding = binding.NativeTokenizer;
