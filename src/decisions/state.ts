/**
 * Shared helpers for decision-point state builders (ARCHITECTURE.md §8h).
 * States are small, tailored, and packed to a token budget newest-first; every
 * count or elapsed time a question needs is a precomputed field, because
 * decision models cannot count or do date arithmetic.
 */

import { jsonTokens } from "./client.js";

/** Collapse whitespace and clip a chat text to `maxChars` (with an ellipsis). */
export function clipText(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= maxChars) return flat;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

/**
 * Keep the newest items (array order = oldest first) whose state fits the
 * budget: `build(kept)` must fit `budgetTokens`. Drops oldest-first; may return
 * an empty list when even the fixed part of the state fills the budget.
 */
export function packNewest<T>(items: readonly T[], budgetTokens: number, build: (kept: T[]) => unknown): T[] {
  let kept = [...items];
  // Estimate per item once, then verify the assembled state (cheap and exact).
  const sizes = kept.map((item) => jsonTokens(item) + 2);
  let total = jsonTokens(build(kept));
  while (kept.length > 0 && total > budgetTokens) {
    total -= sizes.shift()!;
    kept = kept.slice(1);
    if (total <= budgetTokens) total = jsonTokens(build(kept));
  }
  return kept;
}

/** "40s ago", "6m ago", "3h ago", "2d ago" — a label, never arithmetic input. */
export function ageLabel(nowMs: number, thenMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
