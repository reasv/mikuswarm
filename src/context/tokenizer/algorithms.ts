import type { TokenWindow } from "./types.js";

/**
 * Token-id sequences as returned by the two backends: `gpt-tokenizer` yields a
 * `number[]`, the native `glm` tokenizer a `Uint32Array`. Both support `.length`
 * and a type-preserving `.slice()`, which is all the algorithms below need; an
 * impl's `decode` is always paired with its own `encode`, so the sliced type
 * matches what `decode` expects.
 */
export type TokenIds = number[] | Uint32Array;

/**
 * Truncate `text` to at most `maxTokens` tokens using a real encode/decode round
 * trip. Returns `text` unchanged when already within budget. Shared by every
 * `Tokenizer` impl so truncation is identical across backends (mirrors the
 * original `truncateToTokens`, spec §3).
 */
export function truncateWith<T extends TokenIds>(
  encode: (text: string) => T,
  decode: (ids: T) => string,
  text: string,
  maxTokens: number,
): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;
  return decode(tokens.slice(0, maxTokens) as T);
}

/**
 * Split `text` into overlapping windows of at most `size` tokens, advancing by
 * `size - overlap` tokens each step (mirrors the original `splitByTokens`, spec
 * §3/§9d). Each window carries its character offsets so the retrieval indexer can
 * map it back to 1-indexed line ranges for citation.
 *
 * Offsets are derived from cumulative decoded prefixes (`decode(tokens[0..k])`),
 * which is always a prefix of the full text, so each window's `text` is an exact
 * substring of the input (a multi-byte char split across the boundary token may
 * shift a boundary by at most one character — immaterial for line-range citation).
 */
export function splitWith<T extends TokenIds>(
  encode: (text: string) => T,
  decode: (ids: T) => string,
  text: string,
  size: number,
  overlap: number,
): TokenWindow[] {
  if (!text) return [];
  const tokens = encode(text);
  if (tokens.length <= size) {
    return [{ text, charStart: 0, charEnd: text.length }];
  }
  const step = Math.max(1, size - Math.max(0, overlap));
  const windows: TokenWindow[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + size, tokens.length);
    const charStart = decode(tokens.slice(0, start) as T).length;
    const prefixEnd = decode(tokens.slice(0, end) as T);
    windows.push({ text: prefixEnd.slice(charStart), charStart, charEnd: prefixEnd.length });
    if (end >= tokens.length) break;
  }
  return windows;
}
