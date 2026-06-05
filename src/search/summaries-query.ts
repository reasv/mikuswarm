import type { Storage, SummarySearchHit, SummarySearchResult } from "../storage/index.js";

export interface RunSummarySearchResult extends SummarySearchResult {
  elapsedMs: number;
  roomCount: number;
}

/**
 * Run a summary-content search (`search_messages(corpus:"summaries")`, §9e), timing it
 * for the agent-facing latency trailer. Unlike `runChatSearch` there is NO lazy index
 * catch-up: `summaries_fts` is kept live by SQL triggers on `summaries` insert/delete
 * (and summaries are written synchronously through `insertSummaryWithLineage`), so the
 * index is never behind the rows the way the chat projection can lag enrichment.
 */
export function runSummarySearch(
  storage: Storage,
  query: Parameters<Storage["searchSummaries"]>[0],
): RunSummarySearchResult {
  const startedAt = performance.now();
  const result = storage.searchSummaries(query);
  const elapsedMs = Math.round(performance.now() - startedAt);
  return {
    ...result,
    elapsedMs,
    roomCount: query.timelineKeys ? query.timelineKeys.length : -1,
  };
}

/** Keyset cursor for newest/oldest summary pages: `"<latestTimestamp>:<rowid>"`. */
export function encodeSummaryCursor(hit: SummarySearchHit): string {
  return `${hit.latestTimestamp}:${hit.rowid}`;
}
