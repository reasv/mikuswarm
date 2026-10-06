import type { ExaCost, ExaSearchMode } from "./types.js";
export interface ExaUsageRecord {
  agentSessionId: string | null; toolName: string; toolCallId: string | null;
  modelId: string; provider: "exa"; cost: number;
  metadata: { requestId?: string; latencyMs: number; costProvenance: "reported" | "estimated"; estimateVersion?: string; mode?: string; reportedCost?: ExaCost };
}
/** Pricing snapshot 2026-10-06; estimates are explicitly identified, never credits. */
export function exaRetrievalCost(cost: ExaCost | undefined, kind: "search" | "contents", count: number, mode: ExaSearchMode = "auto") {
  if (cost) return { dollars: cost.total, provenance: "reported" as const };
  const dollars = kind === "contents" ? count * 0.001 : ({ auto: 0.007, fast: 0.007, instant: 0.004, deep: 0.012, "deep-reasoning": 0.015 }[mode] + Math.max(0, count - 10) * 0.001);
  return { dollars, provenance: "estimated" as const, estimateVersion: "exa-pricing-2026-10-06" };
}
