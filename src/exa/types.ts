/** Official Exa native API contracts; optional fields retain upstream evidence. */
export const EXA_SEARCH_MODES = ["auto", "fast", "instant", "deep", "deep-reasoning"] as const;
export type ExaSearchMode = typeof EXA_SEARCH_MODES[number];
export const EXA_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ExaEffort = typeof EXA_EFFORTS[number];
export const EXA_CATEGORIES = ["company", "publication", "news", "personal site", "financial report", "people"] as const;
export type ExaCategory = typeof EXA_CATEGORIES[number];
export type ExaScope = "search" | "contents" | "research-create" | "research-collection";
export interface ExaContentOptions { text?: { maxCharacters: number }; highlights?: { maxCharacters: number }; maxAgeHours?: number; livecrawlTimeout?: number }
export interface ExaSearchRequest {
  query: string; type?: ExaSearchMode; numResults?: number; contents?: ExaContentOptions;
  category?: ExaCategory; includeDomains?: string[]; excludeDomains?: string[];
  startPublishedDate?: string; endPublishedDate?: string; userLocation?: string;
  outputSchema?: Record<string, unknown>; systemPrompt?: string;
}
export interface ExaContentsRequest extends ExaContentOptions { urls: string[] }
export interface ExaResult {
  url: string; id?: string; title?: string; publishedDate?: string; author?: string;
  text?: string; highlights?: string[];
}
export interface ExaCost { total: number; [key: string]: unknown }
export interface ExaRetrievalResponse {
  results: ExaResult[]; requestId?: string; costDollars?: ExaCost;
  statuses?: Array<{ id: string; status: string; error?: unknown }>;
  output?: { content?: unknown; grounding?: unknown }; resolvedSearchType?: string;
}
export interface ExaResearchRequest {
  query: string; effort: ExaEffort; systemPrompt?: string; outputSchema?: Record<string, unknown>;
  input?: { data?: Record<string, unknown>[]; exclusion?: Record<string, unknown>[] };
  previousRunId?: string; dataSources?: Array<{ provider: string }>;
}
export type ExaRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface ExaRun {
  id: string; status: ExaRunStatus; stopReason?: string; createdAt?: string; completedAt?: string;
  output?: { text?: string; structured?: unknown; grounding?: unknown };
  costDollars?: ExaCost; error?: unknown; request?: unknown;
}
