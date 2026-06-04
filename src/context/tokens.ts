import { encode, decode } from "gpt-tokenizer/model/gpt-4o";

export function estimateTokens(input: string): number {
  if (!input) return 0;
  return encode(input).length;
}

/**
 * Truncate text to at most `maxTokens` BPE tokens using the real tokenizer.
 * If the text is already within budget, it is returned unchanged.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;
  return decode(tokens.slice(0, maxTokens));
}

export function estimateObjectTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

export interface TokenWindow {
  text: string;
  /** Character offset of this window's start within the original text. */
  charStart: number;
  /** Character offset one past this window's end within the original text. */
  charEnd: number;
}

/**
 * Split `text` into overlapping windows of at most `size` BPE tokens, advancing by
 * `size - overlap` tokens each step. Used by the memory-retrieval indexer to chunk
 * header-less legacy files and oversized diary blocks (ARCHITECTURE.md §9d / design
 * §3). Each window carries its character offsets so the indexer can map it back to
 * 1-indexed line ranges for citation.
 *
 * Offsets are derived from cumulative decoded prefixes (`decode(tokens[0..k])`),
 * which is always a prefix of the full text, so each window's `text` is an exact
 * substring of the input (a UTF-8 char split across the boundary token may shift a
 * boundary by at most one character — immaterial for line-range citation).
 */
export function splitByTokens(text: string, size: number, overlap: number): TokenWindow[] {
  if (!text) return [];
  const tokens = encode(text);
  if (tokens.length <= size) {
    return [{ text, charStart: 0, charEnd: text.length }];
  }
  const step = Math.max(1, size - Math.max(0, overlap));
  const windows: TokenWindow[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + size, tokens.length);
    const charStart = decode(tokens.slice(0, start)).length;
    const prefixEnd = decode(tokens.slice(0, end));
    windows.push({ text: prefixEnd.slice(charStart), charStart, charEnd: prefixEnd.length });
    if (end >= tokens.length) break;
  }
  return windows;
}
