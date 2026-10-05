/**
 * Hard-refusal classification (spec REFUSAL-HANDLING §4.2, §5.1): map a
 * provider's refusal stop reason and category to a check code and reason
 * through the catalogue's API signals, built-in and operator-mapped alike.
 */
import type { CheckCatalogue, CheckDefinition } from "../checks/types.js";

/** The built-in catch-all for refusal stops no other signal maps. */
export const UNCATEGORIZED_REFUSAL_CODE = "refusal_uncategorized";

export interface ApiRefusalInput {
  /** pi-ai api of the request (e.g. "anthropic-messages"). */
  api?: string;
  /** The provider's raw stop reason. */
  rawStopReason: string;
  /** The provider's refusal category; null/undefined/"" = none. */
  category?: string | null;
}

export interface ApiRefusalClassification {
  checkCode: string;
  reason: string;
  /** The category when the response carried one, else the raw stop reason. */
  subReason: string;
  /** `provider_category` when a signal matched the category itself. */
  method: "stop_reason" | "provider_category";
}

/**
 * Classify a hard refusal, or undefined when no refusal check maps it. The most
 * specific match wins: an exact category beats a category-less signal, and the
 * uncategorized check loses to every other check; then a signal naming the
 * request's api, then an operator check over a built-in one, then catalogue
 * order. API signals classify whether or not their check is enabled: a hard
 * refusal is a provider fact, and its statistics are always recorded.
 * Stop reasons and categories compare case-insensitively.
 */
export function classifyApiRefusal(
  catalogue: CheckCatalogue,
  input: ApiRefusalInput,
  agent?: string | null,
): ApiRefusalClassification | undefined {
  const stop = input.rawStopReason.trim().toLowerCase();
  const rawCategory = input.category?.trim() || null;
  const category = rawCategory?.toLowerCase() ?? null;
  let best: { check: CheckDefinition; categoryMatched: boolean; score: number[] } | undefined;
  for (const check of catalogue.all(agent)) {
    if (check.kind !== "refusal") continue;
    for (const signal of check.apiSignals) {
      if (signal.stopReason.trim().toLowerCase() !== stop) continue;
      const apiNamed = signal.api !== undefined;
      if (apiNamed && input.api !== undefined && signal.api !== input.api) continue;
      let categoryRank: number;
      if (signal.category === undefined) {
        categoryRank = 1;
      } else if (signal.category === null) {
        if (category !== null) continue;
        categoryRank = 2;
      } else {
        if (signal.category.trim().toLowerCase() !== category) continue;
        categoryRank = 2;
      }
      const score = [
        check.code === UNCATEGORIZED_REFUSAL_CODE ? 0 : 1,
        categoryRank,
        apiNamed && input.api !== undefined ? 1 : 0,
        check.builtin ? 0 : 1,
      ];
      if (!best || compareScores(score, best.score) > 0) {
        best = { check, categoryMatched: typeof signal.category === "string", score };
      }
    }
  }
  if (!best) return undefined;
  return {
    checkCode: best.check.code,
    reason: best.check.reason ?? "unclear",
    subReason: rawCategory ?? input.rawStopReason.trim(),
    method: best.categoryMatched ? "provider_category" : "stop_reason",
  };
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
