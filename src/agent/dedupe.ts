export function normalizeForDedupe(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function wasAlreadySent(finalText: string, sentMessages: string[]): boolean {
  const normalized = normalizeForDedupe(finalText);
  return sentMessages.some((message) => normalizeForDedupe(message) === normalized);
}

