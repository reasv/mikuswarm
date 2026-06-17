import { splitWith, truncateWith } from "./algorithms.js";
import { NativeTokenizerBinding, type NativeTokenizer } from "./native-binding.js";
import type { Tokenizer, TokenWindow } from "./types.js";

/**
 * GLM-native tokenizer (spec/TOKENIZER-SWAP.md §5.2). Wraps a `NativeTokenizer`
 * (the Hugging Face `tokenizers` Rust crate over NAPI) loaded from the model's
 * `tokenizer.json`, so counts match exactly what GLM consumes. Opt-in via
 * `[tokenizer].primary = "glm"`; the shipped default stays `gpt-tokenizer`.
 *
 * `count`/`truncate`/`split` are synchronous (spec §4). `countAsync` is the one
 * escape hatch: it runs the encode on a libuv worker thread (native `encodeAsync`),
 * used only by the retrieval indexer's large-file path.
 */
export class GlmTokenizer implements Tokenizer {
  private constructor(private readonly native: NativeTokenizer) {}

  /** Load from a Hugging Face `tokenizer.json`. Throws (path included) on a
   *  missing/invalid file — fail-fast for a misconfigured `glm` asset. */
  static fromFile(path: string): GlmTokenizer {
    return new GlmTokenizer(NativeTokenizerBinding.fromFile(path));
  }

  count(text: string): number {
    if (!text) return 0;
    return this.native.countTokens(text);
  }

  truncate(text: string, maxTokens: number): string {
    return truncateWith(
      (t) => this.native.encode(t),
      (ids) => this.native.decode(ids),
      text,
      maxTokens,
    );
  }

  split(text: string, size: number, overlap: number): TokenWindow[] {
    return splitWith(
      (t) => this.native.encode(t),
      (ids) => this.native.decode(ids),
      text,
      size,
      overlap,
    );
  }

  async countAsync(text: string): Promise<number> {
    if (!text) return 0;
    const ids = await this.native.encodeAsync(text);
    return ids.length;
  }
}
