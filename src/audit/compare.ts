/**
 * The mechanical half of "what happened to the message" (spec
 * REFUSAL-HANDLING §7.3), always computed: the message the model first tried to
 * deliver against the message it sent after the corrective prompts.
 *
 * - **normalized equality**: equal after Unicode NFKC, case folding and
 *   whitespace collapsing;
 * - **edit-similarity ratio**: `1 - levenshtein(a, b) / max(|a|, |b|)` over the
 *   normalized texts (1 = identical, 0 = nothing in common), in characters;
 *   texts longer than {@link MAX_COMPARE_CHARS} are compared by words instead
 *   (over their first `4 × MAX_COMPARE_CHARS` characters), so the cost stays
 *   bounded;
 * - **length ratio**: `|sent| / |first|` over the normalized texts.
 */

/** Above this many characters (either side) the ratio is computed over words. */
export const MAX_COMPARE_CHARS = 6000;

export interface MessageComparison {
  normalizedEqual: boolean;
  /** 0..1, rounded to 3 decimals. */
  similarity: number;
  /** sent / first, rounded to 3 decimals; null when the first text is empty. */
  lengthRatio: number | null;
}

export function normalizeForComparison(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Levenshtein distance between two sequences (two-row dynamic programming). */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function compareMessages(first: string, sent: string): MessageComparison {
  const a = normalizeForComparison(first);
  const b = normalizeForComparison(sent);
  const normalizedEqual = a === b;
  let similarity: number;
  if (normalizedEqual) {
    similarity = 1;
  } else if (a.length <= MAX_COMPARE_CHARS && b.length <= MAX_COMPARE_CHARS) {
    const ca = Array.from(a);
    const cb = Array.from(b);
    similarity = 1 - editDistance(ca, cb) / Math.max(ca.length, cb.length);
  } else {
    // Very long texts: words, over a bounded prefix.
    const wa = a.slice(0, MAX_COMPARE_CHARS * 4).split(" ");
    const wb = b.slice(0, MAX_COMPARE_CHARS * 4).split(" ");
    similarity = 1 - editDistance(wa, wb) / Math.max(wa.length, wb.length);
  }
  return {
    normalizedEqual,
    similarity: round3(similarity),
    lengthRatio: a.length > 0 ? round3(b.length / a.length) : null,
  };
}
