/**
 * Pluggable tokenizer seam (spec/TOKENIZER-SWAP.md §5.1; ARCHITECTURE.md §9
 * "Tokenization"). One small synchronous interface with a config-selected
 * implementation — `gpt-tokenizer` (the shipped default) or the native `glm`
 * tokenizer. Every token-denominated budget in the app is measured through this.
 *
 * The interface is deliberately **synchronous** (spec §4): a tokenize is
 * microseconds, and the estimator sits in hot, deterministic render/compaction
 * paths where threading `Promise`s through would be a layer-wide refactor for no
 * gain (Node is single-threaded; wrapping a CPU loop in `async` still blocks the
 * loop). The single optional async method — `countAsync` — is the one escape hatch
 * (§4), wired only into the retrieval indexer's large-file path where an encode
 * crosses the multi-millisecond threshold that makes leaving the JS thread
 * worthwhile.
 */
export interface Tokenizer {
  /** Number of tokens `text` encodes to (no special tokens — parity with the
   *  gpt-4o counter, which adds nothing). `""` → 0. */
  count(text: string): number;
  /** `text` truncated to at most `maxTokens` tokens (unchanged if already within
   *  budget). An exact prefix of `text` for lossless (byte-level) tokenizers. */
  truncate(text: string, maxTokens: number): string;
  /** Overlapping token windows of at most `size` tokens, advancing by
   *  `size - overlap` each step, each carrying its character offsets. Retrieval
   *  chunker only. */
  split(text: string, size: number, overlap: number): TokenWindow[];
  /**
   * Optional, indexer-only async count (spec §4 escape hatch). The native `glm`
   * impl runs the encode on a libuv worker thread (`encodeAsync`); the pure-JS
   * `gpt-tokenizer` impl resolves synchronously (no thread hop is worthwhile for a
   * 2 µs encode). Callers fall back to sync `count` when absent.
   */
  countAsync?(text: string): Promise<number>;
}

export interface TokenWindow {
  text: string;
  /** Character offset of this window's start within the original text. */
  charStart: number;
  /** Character offset one past this window's end within the original text. */
  charEnd: number;
}

/** Config-selectable tokenizer implementations (`[tokenizer].primary`/`.retrieval`). */
export type TokenizerKind = "gpt-tokenizer" | "glm";
