export function estimateTokens(input: string): number {
  if (!input) return 0;
  const ascii = input.replace(/[^\x00-\x7F]/g, "");
  const nonAscii = input.length - ascii.length;
  return Math.ceil(ascii.length / 4 + nonAscii / 2);
}

export function estimateObjectTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

