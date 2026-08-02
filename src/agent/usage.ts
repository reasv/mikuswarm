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
 * agent. Constructed in `app.ts` (which owns seed computation) and passed into
 * {@link AgentSessionFactory}; seedable for resume-in-place so a resumed session
 * continues accumulating from its persisted totals rather than resetting
 * (spec TOKEN-USAGE-TRACKING §4.3 / SESSION-COST-LIMITS §4).
 *
 * Holds two cost lanes that are summed ONLY in-memory, never in storage (the
 * §8c §4 invariant): the agent-loop lane (`totals.cost`, persisted to
 * `agent_sessions.usage_*`) and a separate `toolCost` lane (this session's
 * `tool_invocations` spend, persisted in that ledger — NOT in `usage_*`). The
 * per-session cost ceiling (SESSION-COST-LIMITS) is enforced against their sum
 * via {@link combinedCost}.
 */
export class SessionUsageTracker {
  private totals: SessionUsageTotals;
  /**
   * Cumulative tool-use cost (USD) for this session run — the §8c lane. Kept
   * OUT of {@link SessionUsageTotals} (whose shape maps 1:1 to the agent-loop
   * `usage_*` columns) so persistence stays agent-loop-pure; combined only at
   * the enforcement gate / presentation layer.
   */
  private toolCost: number;
  /**
   * The LAST committed request's upstream wire model id (spec
   * TOKEN-USAGE-TRACKING §4.3) — the model actually billed, which under model
   * fallback or per-user model selection is NOT the session type's configured
   * model. Kept OUT of {@link SessionUsageTotals} (whose shape maps 1:1 to the
   * `usage_*` columns) and read separately by the persistence subscriber, so
   * `agent_sessions.model_id` matches the ledger's `agent_loop` rows. null
   * until the first request of THIS run commits — including on a seeded resume,
   * whose seed carries totals but no model.
   */
  private lastModel: string | null = null;
  /** Persistence + agent-loop-driven subscribers; fires on `record()` only. */
  private readonly listeners = new Set<(totals: SessionUsageTotals) => void>();
  /**
   * Combined-cost subscribers (spec SESSION-COST-LIMITS §4); fires on BOTH
   * `record()` and `recordToolCost()`, so a budget crossing driven by either
   * lane is observed. Passed the current {@link combinedCost}.
   */
  private readonly budgetListeners = new Set<(combinedCost: number) => void>();

  constructor(seed?: SessionUsageTotals, toolCostSeed = 0) {
    this.totals = seed ? { ...seed } : emptyUsageTotals();
    this.toolCost = toolCostSeed > 0 ? toolCostSeed : 0;
  }

  /**
   * Accumulate one committed request's usage and set `contextTokens` to its
   * `totalTokens` (the new current size — never assumed monotonic, §2.1).
   * Notifies `onUpdate` listeners with a fresh snapshot and `onBudgetChange`
   * listeners with the new combined cost.
   *
   * `modelId` is the upstream wire id this request was actually billed against
   * (the commit point's `message.model ?? model.id` — the same value the ledger
   * row carries). Optional so non-agent-loop callers and tests need not supply
   * it; omitted or null leaves the previously recorded model in place rather
   * than clearing it.
   */
  record(usage: Usage, modelId?: string | null): void {
    if (modelId) this.lastModel = modelId;
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
    this.notifyBudget();
  }

  /**
   * Accumulate one auxiliary tool call's cost (USD) into the §8c lane (spec
   * SESSION-COST-LIMITS §4). Fires `onBudgetChange` only — never the agent-loop
   * `onUpdate` persistence channel, so a tool call does not redundantly re-write
   * the `usage_*` columns. A non-positive cost is a no-op.
   */
  recordToolCost(cost: number): void {
    if (!(cost > 0)) return;
    this.toolCost += cost;
    this.notifyBudget();
  }

  /** Combined cost (USD) across both lanes — the ceiling's enforcement basis. */
  combinedCost(): number {
    return this.totals.cost + this.toolCost;
  }

  /** Defensive copy of the agent-loop totals. */
  snapshot(): SessionUsageTotals {
    return { ...this.totals };
  }

  /**
   * The last committed request's billed wire model id, or null before this run
   * commits anything. The persistence subscriber prefers this over the session
   * type's configured model so the durable row records what was actually used.
   */
  lastModelId(): string | null {
    return this.lastModel;
  }

  /** Subscribe to post-record agent-loop snapshots; returns an unsubscribe fn. */
  onUpdate(listener: (totals: SessionUsageTotals) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to combined-cost changes (either lane); returns an unsubscribe fn.
   * Used by the soft-budget-warn watcher (spec SESSION-COST-LIMITS §2.1).
   */
  onBudgetChange(listener: (combinedCost: number) => void): () => void {
    this.budgetListeners.add(listener);
    return () => {
      this.budgetListeners.delete(listener);
    };
  }

  private notifyBudget(): void {
    const combined = this.combinedCost();
    for (const listener of this.budgetListeners) {
      try {
        listener(combined);
      } catch {
        /* a budget subscriber must never break the accounting path */
      }
    }
  }
}

// =============================================================================
// Auxiliary (out-of-loop) usage cost helper (spec AUXILIARY-USAGE-TRACKING §5).
//
// A pure, I/O-free cost calculator for provider calls made OUTSIDE the agent
// runner (raw `fetch`, no pi-ai `withRequestRetry` / model descriptor) — today
// captioning (src/captioning) and the image_generate tool (src/tools/image-gen).
// pi-ai computes cost from a model descriptor during `streamSimple`; these paths
// never construct one, so we compute locally from config rates. Keeping the
// formula here — `rate / 1e6 * tokens`, identical to pi-ai's `calculateCost` —
// guarantees parity with the §8b agent-loop accounting. Auxiliary spend is
// accounted in a SEPARATE lane and is NEVER folded into SessionUsageTracker /
// `agent_sessions.usage_*` (spec §4 invariant).
// =============================================================================

/** Cost rates in USD per 1,000,000 tokens (same scale as §8b / `[models.*].cost`). */
export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Flat USD added per generated image (image-gen only); ignored elsewhere. */
  perImage?: number;
}

/** Provider-reported token counts for one auxiliary call. */
export interface RawTokenUsage {
  /** Uncached prompt tokens (provider total minus cached). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Count of generated images (image-gen only); drives `perImage`. */
  images?: number;
}

/** Per-component + total cost (USD) for one auxiliary call. */
export interface ComputedCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  image: number;
  total: number;
}

/**
 * Compute USD cost for one auxiliary call from config rates and provider-reported
 * token counts. Mirrors pi-ai's `calculateCost` (`rate / 1e6 * tokens`) per
 * component and adds a flat `perImage * images` charge. Unset rates are 0, so an
 * unconfigured cost block yields `total: 0` (rendered as "untracked"/"—" by the
 * cost-hidden-when-zero convention) rather than a misleading non-zero figure.
 * Every rate and token field is coalesced to 0, so a partially-populated rates
 * object can never let `NaN` reach the cost columns.
 */
export function computeUsageCost(rates: CostRates, u: RawTokenUsage): ComputedCost {
  const input = ((rates.input ?? 0) / 1e6) * (u.input ?? 0);
  const output = ((rates.output ?? 0) / 1e6) * (u.output ?? 0);
  const cacheRead = ((rates.cacheRead ?? 0) / 1e6) * (u.cacheRead ?? 0);
  const cacheWrite = ((rates.cacheWrite ?? 0) / 1e6) * (u.cacheWrite ?? 0);
  const image = (rates.perImage ?? 0) * (u.images ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    image,
    total: input + output + cacheRead + cacheWrite + image,
  };
}
