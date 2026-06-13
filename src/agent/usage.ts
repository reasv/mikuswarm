import type { Usage } from "@earendil-works/pi-ai";

// =============================================================================
// Session usage tracker (spec TOKEN-USAGE-TRACKING §3.3).
//
// Pure in-memory accumulator of provider-reported token usage across the
// committed requests of ONE session run. Fed at the Layer-0 commit point
// (`withRequestRetry`'s terminal `done` branch, via `onRequestCommitted`), it
// holds the cumulative consumption and the LAST committed request's context
// size. No I/O — persistence is `session-capture`'s job (it subscribes to
// `onUpdate` and enqueues `storage.updateAgentSessionUsage`).
//
// Cost is already computed upstream by pi-ai (`usage.cost.total`, derived from
// the model's per-MTok factors in the descriptor); the tracker only sums it.
// =============================================================================

/**
 * Session-level usage aggregate (spec §3.3). All token fields are cumulative
 * Σ over the session's committed requests; `contextTokens` is the LAST
 * committed request's `totalTokens` (the session's "current size"), or null
 * before any request commits.
 */
export interface SessionUsageTotals {
  /** Committed requests (clean terminal `done` outcomes). */
  llmRequests: number;
  /** Σ usage.input (uncached input tokens). */
  inputTokens: number;
  /** Σ usage.output. */
  outputTokens: number;
  /** Σ usage.cacheRead. */
  cacheReadTokens: number;
  /** Σ usage.cacheWrite. */
  cacheWriteTokens: number;
  /** Σ usage.cost.total (USD). */
  cost: number;
  /**
   * LAST committed request's `totalTokens` — the current context size, the
   * value §6.2's pre-flight budget check compares against the effective limit.
   * null until the first request commits (no actuals exist yet).
   */
  contextTokens: number | null;
}

/** A zeroed totals snapshot — the pre-first-request state. */
export function emptyUsageTotals(): SessionUsageTotals {
  return {
    llmRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: null,
  };
}

/**
 * In-memory usage accumulator for one session run. One instance per created
 * agent, owned by {@link AgentSessionFactory}. Seedable for resume-in-place so
 * a resumed session continues accumulating from its persisted totals rather
 * than resetting (spec §4.3).
 */
export class SessionUsageTracker {
  private totals: SessionUsageTotals;
  private readonly listeners = new Set<(totals: SessionUsageTotals) => void>();

  constructor(seed?: SessionUsageTotals) {
    this.totals = seed ? { ...seed } : emptyUsageTotals();
  }

  /**
   * Accumulate one committed request's usage and set `contextTokens` to its
   * `totalTokens` (the new current size — never assumed monotonic, §2.1).
   * Notifies listeners with a fresh snapshot afterwards.
   */
  record(usage: Usage): void {
    this.totals = {
      llmRequests: this.totals.llmRequests + 1,
      inputTokens: this.totals.inputTokens + (usage.input ?? 0),
      outputTokens: this.totals.outputTokens + (usage.output ?? 0),
      cacheReadTokens: this.totals.cacheReadTokens + (usage.cacheRead ?? 0),
      cacheWriteTokens: this.totals.cacheWriteTokens + (usage.cacheWrite ?? 0),
      cost: this.totals.cost + (usage.cost?.total ?? 0),
      contextTokens: usage.totalTokens ?? this.totals.contextTokens,
    };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* a persistence subscriber must never break the accounting path */
      }
    }
  }

  /** Defensive copy of the current totals. */
  snapshot(): SessionUsageTotals {
    return { ...this.totals };
  }

  /** Subscribe to post-record snapshots; returns an unsubscribe fn. */
  onUpdate(listener: (totals: SessionUsageTotals) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
