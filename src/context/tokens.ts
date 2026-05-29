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
