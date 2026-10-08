/**
 * Operator memory filters: evaluation and enforcement (ARCHITECTURE.md §9c
 * "Memory filters").
 *
 * Order per block and filter: time scope first (free; an out-of-range block
 * never touches the filter), then the mechanical match (keyword / pattern),
 * which either hides the block on its own or, for a judged filter that has
 * one, is the pre-gate for judgement. Judged filters are evaluated lazily,
 * only where a block is about to be shown, and cached in
 * `memory_filter_verdicts` keyed by the filter's hash (an edited filter's
 * verdicts are stale). There is no corpus pass and no backfill.
 *
 * Judged filters need the `memory` decision point (its chain, or
 * `[retrieval.filters].model`). Without it they do not apply (startup warns);
 * mechanical filters always apply. An unavailable verdict (timeout, chain
 * outage) follows `pending` (`show` by default, or `hide`); cached verdicts
 * keep applying during an outage.
 */
import type { Logger } from "../../observability/logger.js";
import type { DecisionEngine, DecisionAttribution } from "../../decisions/registry.js";
import type { PriorityClass, SlotShare } from "../../agent/scheduler.js";
import type { AppConfig } from "../../config/index.js";
import { memoryFilterPoint, type MemoryFilterQuestion } from "../../decisions/points/memory.js";
import type { MemoryRetrievalStore, FilterVerdictRow } from "../../storage/memory-retrieval-store.js";
import { agentDateStamp } from "../../time/index.js";
import { cleanBlockText, formatCitation } from "../excerpt.js";
import { filterBoundTs, filtersFor, type ResolvedMemoryFilter, type ResolvedMemoryFilters } from "./config.js";

export type FilterSurface = "auto_retrieval" | "recency_layer" | "diary_writer" | "recall_memory" | "search_memory";

/** One block about to be shown, as the filters see it. */
export interface FilterBlock {
  contentHash: string;
  text: string;
  path: string;
  startLine: number;
  endLine: number;
  room: string | null;
  /** The block's entry time; null when it has none (no header and no dated file name). */
  entryTs: number | null;
}

export interface HiddenBy {
  key: string;
  kind: "keyword" | "pattern" | "judged";
  /** The matched keyword or pattern text. */
  detail?: string;
  probability?: number;
  /** True when hidden by the `pending = "hide"` policy, not a verdict. */
  pending?: true;
}

export interface BlockFilterState {
  hidden: boolean;
  hiddenBy?: HiddenBy;
  /** Judged filters that apply to the block and have no fresh verdict yet. */
  pendingJudged: MemoryFilterQuestion[];
}

export interface EnforceContext {
  surface: FilterSurface;
  attribution: DecisionAttribution;
  priority?: PriorityClass;
  /** The capped share of the decision group the judging calls count against. */
  share?: SlotShare;
  signal?: AbortSignal;
  /** Deadline of the judging calls (default the memory point's timeout). */
  timeoutMs?: number;
}

export interface MemoryFilterServiceOptions {
  config: AppConfig;
  store: MemoryRetrievalStore;
  /** The decision engine (read per call; absent = judged filters never apply). */
  engine?: () => DecisionEngine | undefined;
  logger?: Logger;
  now?: () => number;
}

const HIT_RECORD_INTERVAL_MS = 3600_000;

function inScope(f: ResolvedMemoryFilter, entryTs: number | null): boolean {
  if (!f.after && !f.before) return true;
  if (entryTs === null) return false;
  if (f.after) {
    const a = filterBoundTs(f.after);
    if (a !== null && entryTs < a) return false;
  }
  if (f.before) {
    const b = filterBoundTs(f.before);
    if (b !== null && entryTs >= b) return false;
  }
  return true;
}

function mechanicalMatch(f: ResolvedMemoryFilter, text: string): { kind: "keyword" | "pattern"; detail: string } | null {
  if (f.keywordRe) {
    const m = text.match(f.keywordRe);
    if (m) return { kind: "keyword", detail: m[0] };
  }
  for (const p of f.patterns) {
    const m = text.match(p);
    if (m) return { kind: "pattern", detail: p.source };
  }
  return null;
}

function hasMechanical(f: ResolvedMemoryFilter): boolean {
  return f.keywordRe !== undefined || f.patterns.length > 0;
}

export function toQuestion(f: ResolvedMemoryFilter): MemoryFilterQuestion {
  return {
    key: f.key,
    description: f.description!,
    examplesHide: f.examplesHide,
    examplesKeep: f.examplesKeep,
    threshold: f.threshold,
  };
}

export class MemoryFilterService {
  private readonly lastHit = new Map<string, number>();
  private readonly resolved = new Map<string, ResolvedMemoryFilters>();
  private readonly inflight = new Map<string, Promise<Record<string, { probability: number; hidden: boolean }> | null>>();

  constructor(private readonly options: MemoryFilterServiceOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The effective filters of an agent (memoized; config is fixed per process). */
  filters(agent: string | null): ResolvedMemoryFilters {
    const key = agent ?? "";
    let r = this.resolved.get(key);
    if (!r) {
      r = filtersFor(this.options.config, agent);
      this.resolved.set(key, r);
    }
    return r;
  }

  /** Enabled filters of an agent. */
  active(agent: string | null): ResolvedMemoryFilter[] {
    return this.filters(agent).filters.filter((f) => f.enabled);
  }

  hasFilters(agent: string | null): boolean {
    return this.active(agent).length > 0;
  }

  /** True when judged filters can run for this agent (the memory point is on). */
  canJudge(agent: string | null): boolean {
    return this.options.engine?.()?.isEnabled("memory", agent) ?? false;
  }

  /**
   * Mechanical matches and cached judged verdicts, no model call. Judged
   * filters without a fresh verdict come back in `pendingJudged`.
   */
  classify(agent: string | null, blocks: FilterBlock[]): Map<string, BlockFilterState> {
    const out = new Map<string, BlockFilterState>();
    const filters = this.active(agent);
    if (filters.length === 0) {
      for (const b of blocks) out.set(b.contentHash, { hidden: false, pendingJudged: [] });
      return out;
    }
    const judge = this.canJudge(agent);
    const verdicts = new Map<string, FilterVerdictRow>();
    if (judge && filters.some((f) => f.description)) {
      for (const v of this.options.store.filterVerdicts(agent, blocks.map((b) => b.contentHash))) {
        verdicts.set(`${v.contentHash}\0${v.filterKey}`, v);
      }
    }
    for (const b of blocks) {
      const state: BlockFilterState = { hidden: false, pendingJudged: [] };
      for (const f of filters) {
        if (!inScope(f, b.entryTs)) continue;
        const mech = hasMechanical(f) ? mechanicalMatch(f, b.text) : null;
        if (!f.description) {
          if (mech) {
            state.hidden = true;
            state.hiddenBy ??= { key: f.key, kind: mech.kind, detail: mech.detail };
          }
          continue;
        }
        // Judged filter: a mechanical part is its pre-gate.
        if (hasMechanical(f) && !mech) continue;
        if (!judge) continue;
        const cached = verdicts.get(`${b.contentHash}\0${f.key}`);
        if (cached && cached.filterHash === f.hash) {
          if (cached.hidden) {
            state.hidden = true;
            state.hiddenBy ??= { key: f.key, kind: "judged", ...(cached.probability !== null ? { probability: cached.probability } : {}) };
          }
          continue;
        }
        state.pendingJudged.push(toQuestion(f));
      }
      out.set(b.contentHash, state);
    }
    return out;
  }

  /** `pending` policy for an agent's unevaluated judged filters. */
  pendingPolicy(agent: string | null): "show" | "hide" {
    return this.filters(agent).pending;
  }

  /** The chain head for judged filters (`[retrieval.filters].model`), if set. */
  chainHead(agent: string | null): string | undefined {
    return this.filters(agent).model;
  }

  /**
   * Store verdicts that arrived with a relevance call (auto-retrieval) or a
   * filter call. `results` holds one entry per judged filter asked.
   */
  async storeVerdicts(
    agent: string | null,
    contentHash: string,
    results: Record<string, { probability: number; hidden: boolean }>,
    served: { model: string | null; version: string | null },
  ): Promise<void> {
    const byKey = new Map(this.active(agent).map((f) => [f.key, f]));
    const rows: FilterVerdictRow[] = [];
    const at = this.now();
    for (const [key, r] of Object.entries(results)) {
      const f = byKey.get(key);
      if (!f) continue;
      rows.push({
        contentHash,
        filterKey: key,
        filterHash: f.hash,
        probability: r.probability,
        hidden: r.hidden,
        model: served.model,
        servedVersion: served.version,
        evaluatedAt: at,
      });
    }
    try {
      await this.options.store.putFilterVerdicts(agent, rows);
    } catch (error) {
      this.options.logger?.warn("memory_filter_verdict_store_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Classify, judge every block that still has pending judged filters (one
   * request per block, in parallel, bounded by the point's timeout), store
   * the verdicts, and apply `pending` to what could not be judged. Returns the
   * final state per block and logs `memory_filter_hidden` (counts only).
   */
  async enforce(agent: string | null, blocks: FilterBlock[], ctx: EnforceContext): Promise<Map<string, BlockFilterState>> {
    const states = this.classify(agent, blocks);
    const engine = this.options.engine?.();
    const toJudge = blocks.filter((b) => {
      const s = states.get(b.contentHash)!;
      return !s.hidden && s.pendingJudged.length > 0;
    });
    if (toJudge.length > 0 && engine) {
      await Promise.all(
        toJudge.map(async (b) => {
          const state = states.get(b.contentHash)!;
          const clean = cleanBlockText(b.text).lines.join("\n");
          // One request per block and filter set at a time: concurrent surfaces
          // (the recency layer of two builds) share it instead of paying twice.
          const flightKey = `${agent ?? ""}\0${b.contentHash}\0${state.pendingJudged.map((q) => q.key).sort().join(",")}`;
          let flight = this.inflight.get(flightKey);
          if (!flight) {
            flight = engine
              .evaluate(
                memoryFilterPoint,
                {
                  entry: {
                    date: b.entryTs !== null ? agentDateStamp(b.entryTs) : "unknown",
                    room: b.room,
                    text: clean,
                  },
                  filters: state.pendingJudged,
                  meta: { citation: formatCitation({ ...b, entryTs: b.entryTs ?? 0 }), contentHash: b.contentHash, surface: ctx.surface },
                },
                {
                  agentName: agent,
                  attribution: ctx.attribution,
                  priority: ctx.priority ?? "background",
                  ...(ctx.share ? { share: ctx.share } : {}),
                  signal: ctx.signal,
                  ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
                  ...(this.chainHead(agent) ? { chainHead: this.chainHead(agent) } : {}),
                },
              )
              .then(async (outcome) => {
                const judged = outcome.source === "model" ? outcome.verdict.filters : null;
                if (judged) {
                  await this.storeVerdicts(agent, b.contentHash, judged, { model: outcome.servedModel ?? null, version: null });
                }
                return judged;
              })
              .catch(() => null)
              .finally(() => this.inflight.delete(flightKey));
            this.inflight.set(flightKey, flight);
          }
          const filters = await flight;
          if (filters) {
            this.applyJudged(state, filters);
          } else {
            this.applyPending(agent, state);
          }
        }),
      );
    } else {
      for (const b of toJudge) this.applyPending(agent, states.get(b.contentHash)!);
    }
    this.recordAndLog(agent, blocks, states, ctx.surface);
    return states;
  }

  /** Fold judged results into a block's state. */
  applyJudged(state: BlockFilterState, results: Record<string, { probability: number; hidden: boolean }>): void {
    for (const [key, r] of Object.entries(results)) {
      if (!r.hidden) continue;
      state.hidden = true;
      state.hiddenBy ??= { key, kind: "judged", probability: r.probability };
    }
    state.pendingJudged = [];
  }

  /** No verdict could be had: the `pending` policy decides (judged filters only). */
  applyPending(agent: string | null, state: BlockFilterState): void {
    if (state.pendingJudged.length > 0 && this.pendingPolicy(agent) === "hide" && !state.hidden) {
      state.hidden = true;
      state.hiddenBy = { key: state.pendingJudged[0]!.key, kind: "judged", pending: true };
    }
    state.pendingJudged = [];
  }

  /** Audit trail (throttled per block and filter) and the counts-only log line. */
  recordAndLog(agent: string | null, blocks: FilterBlock[], states: Map<string, BlockFilterState>, surface: FilterSurface): void {
    const byFilter: Record<string, number> = {};
    const hits: Parameters<MemoryRetrievalStore["recordFilterHits"]>[0] = [];
    const now = this.now();
    for (const b of blocks) {
      const s = states.get(b.contentHash);
      if (!s?.hidden || !s.hiddenBy) continue;
      byFilter[s.hiddenBy.key] = (byFilter[s.hiddenBy.key] ?? 0) + 1;
      if (s.hiddenBy.pending) continue;
      const throttleKey = `${agent ?? ""}\0${b.contentHash}\0${s.hiddenBy.key}`;
      const last = this.lastHit.get(throttleKey);
      if (last !== undefined && now - last < HIT_RECORD_INTERVAL_MS) continue;
      this.lastHit.set(throttleKey, now);
      if (this.lastHit.size > 20_000) this.lastHit.clear();
      const f = this.active(agent).find((x) => x.key === s.hiddenBy!.key);
      hits.push({
        agent,
        contentHash: b.contentHash,
        filterKey: s.hiddenBy.key,
        filterHash: f?.hash ?? "",
        kind: s.hiddenBy.kind,
        detail: s.hiddenBy.detail ?? null,
        probability: s.hiddenBy.probability ?? null,
        path: b.path,
        startLine: b.startLine,
        endLine: b.endLine,
        surface,
        at: now,
      });
    }
    const total = Object.values(byFilter).reduce((a, b) => a + b, 0);
    if (total > 0) {
      this.options.logger?.info("memory_filter_hidden", { surface, agent: agent ?? undefined, hidden: total, byFilter });
    }
    if (hits.length > 0) {
      void this.options.store.recordFilterHits(hits).catch((error) =>
        this.options.logger?.warn("memory_filter_hits_store_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/**
 * Startup warning (spec §10): judged filters are configured for an agent whose
 * `memory` decision point cannot run, so they will not apply.
 */
export function warnFiltersWithoutDecisions(
  config: AppConfig,
  canJudge: (agent: string | null) => boolean,
  logger?: Logger,
): void {
  const agents: Array<string | null> = Object.keys(config.agents ?? {}).length > 0 ? Object.keys(config.agents ?? {}) : [null];
  for (const agent of agents) {
    const judged = filtersFor(config, agent).filters.filter((f) => f.enabled && f.description).map((f) => f.key);
    if (judged.length === 0 || canJudge(agent)) continue;
    logger?.warn("memory_filters_without_decisions", {
      agent: agent ?? undefined,
      filters: judged,
      note:
        "judged memory filters need the memory decision point ([decisions] on with a model, [decisions.memory] not disabled); " +
        "until then they do not apply. Keyword and pattern filters apply regardless.",
    });
  }
}
