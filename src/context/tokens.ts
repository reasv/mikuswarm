import { encode } from "gpt-tokenizer/model/gpt-4o";

export function estimateTokens(input: string): number {
  if (!input) return 0;
  return encode(input).length;
}

export function estimateObjectTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}
