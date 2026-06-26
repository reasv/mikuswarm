// =============================================================================
// UserLimitEngine (spec PER-USER-LIMITS §8.2). A sibling to BudgetEngine for the
// HUMAN-triggered agent loop only — partitioned per-user / shared-pool counters,
// a per-field cascade, and the affordability estimate that drives per-attempt
// model selection / degradation.
//
// Three orthogonal layers (§2):
//   - Budget (§3): a partitioned constraint SET, ANDed. Fungible total + optional
//     per-model sub-caps; multi-window; per-`(meter)` running counters seeded from
//     the `usage_events` ledger. The partition template (§3.5) generalizes the
//     per-user `{user_id}` default to shared pools.
//   - Estimation (§5): given a model + the live counters, can it complete a turn
//     within remaining budget right now? Output is bounded by CAPPING, not
//     prediction (`max_tokens` ← remaining headroom); the only estimate is the
//     input cost, dominated by the measured prior context.
//   - Selection (§4): lives in the FACTORY (it owns health + fits + the built
//     fallbacks). This engine answers predicate 1 (affordable) via `affordable`;
//     the factory composes predicates 2 (healthy) + 3 (fits).
//
// Counting identity under fallback (§7): GATE on the requested virtual model,
// COUNT the actual served cost, key the partition on the requested model. The
// per-user counters therefore scope on `requested_model_id` (recorded by the
// agent loop), so an outage backup still counts toward its requested sub-cap.
// =============================================================================

import type { Logger } from "../observability/logger.js";
import type { UsageCostFilter } from "../storage/database.js";
import { type WindowSpec, resolveWindow } from "./window.js";

// ─── Trigger context (§10) ───────────────────────────────────────────────────

/** Built once at Gate A from `inbound` (spec §10); frozen on the session. */
export interface UserLimitContext {
  userId: string;
  roomId?: string;
  /** Phase 2 (§11) — always undefined in the first slice (space match is a fatal). */
  spaceId?: string;
}

// ─── Normalized rules (output of normalize-user-limits.ts) ────────────────────

/** One normalized constraint inside a rule's budget block (spec §3.1/§3.5). */
export interface NormalizedConstraint {
  /** Index within the rule (for stable diagnostics). */
  index: number;
  maxUsd: number;
  window: WindowSpec;
  /** Sub-cap model scope (REQUESTED virtual names). Undefined = fungible total. */
  models?: string[];
  /** Partition template (default `"{user_id}"`). */
  partition: string;
  /** True when `partition` is anything but the per-user `{user_id}` default. */
  shared: boolean;
}

/** A normalized `[[user_limits]]` rule (spec §8.1). */
export interface NormalizedUserLimitRule {
  /** Authored order (cascade precedence + stable meter/diagnostic ids). */
  order: number;
  /** Match globs (anchored fnmatch); undefined = wildcard. OR within a dimension. */
  user?: string[];
  room?: string[];
  space?: string[];
  /**
   * True when this rule carries a model-budget block (the `models`+`limits` unit,
   * incl. the `max_usd` shorthand or an explicit exempt). Drives the atomic
   * model-budget cascade (§8.1) — only a rule with a block contributes it.
   */
  hasBudgetBlock: boolean;
  /** Ordered preference set (REQUESTED registry names). Undefined = session default. */
  models?: string[];
  /** The constraint set (empty for an exempt block). */
  constraints: NormalizedConstraint[];
  /** Cascades INDEPENDENTLY of the budget block. */
  messageTemplate?: string;
}

// ─── Resolved (per-ctx) view ──────────────────────────────────────────────────

/** A constraint resolved against a concrete trigger ctx (partition rendered). */
export interface ResolvedConstraint {
  /** Global meter identity — same key ⇒ same shared counter (§3.5). */
  meterKey: string;
  cap: number;
  window: WindowSpec;
  /** Requested-model scope; undefined = fungible total (covers every model). */
  modelScope?: string[];
  /** Rendered partition key (e.g. `@alice:hs`, `staff`, `room:!x:hs`). */
  partitionKey: string;
  /** True when this is the per-user `{user_id}` partition (seeds off trigger_sender_id). */
  isUserPartition: boolean;
  /** Concrete room id when the rule is room-matched (sturdy room-narrowed seed, §16 Q2). */
  roomScope?: string;
  /** Source rule order + index (diagnostics / console). */
  source: { ruleOrder: number; index: number };
}

/** The cascade-resolved per-user budget + selection view for one trigger ctx. */
export interface UserLimitResolution {
  /** True when ANY rule matched the ctx (else the feature is inert for this user). */
  matched: boolean;
  /**
   * True when the per-user machinery is ACTIVE for this session: a covering rule
   * supplied a model set OR any constraint. False ⇒ default model, no per-user
   * caps (exempt or no covering budget block) — the factory takes its normal path.
   */
  active: boolean;
  /** Hard ban: a covering fungible total with cap 0, or an empty model set. */
  banned: boolean;
  /** Ordered preference set (REQUESTED names); undefined = session-type default. */
  models?: string[];
  constraints: ResolvedConstraint[];
  /**
   * The single shared-pool partition key to denormalize onto each ledger row
   * (§8.3); undefined when the session joins no shared pool. The Phase-1
   * normalizer guarantees ≤ 1 distinct non-`{user_id}` value per rule.
   */
  ledgerPartitionKey?: string;
  /** Templated refusal (§12), resolved independently. */
  messageTemplate?: string;
}

// ─── Affordability estimate (§5.3) ────────────────────────────────────────────

export interface AffordabilityEstimate {
  /**
   * Measured prior-context tokens (the last committed request's `totalTokens`),
   * or the initial context estimate for the first request. The dominant — and
   * essentially only — input term (§5.2); incremental new material is small and
   * folded in conservatively by pricing the whole basis at the uncached input rate.
   */
  priorContextTokens: number;
}

export interface AffordabilityResult {
  /** False ⇒ the model cannot complete a turn within remaining budget (UNAFFORDABLE). */
  ok: boolean;
  /** Budget-derived output cap to set as the request's `max_tokens` (when `ok`). */
  maxOutput: number;
  /** The constraint with the least headroom for this model (the binding one). */
  binding?: ResolvedConstraint;
  /** Remaining headroom (USD) of the binding constraint; +Inf when uncapped. */
  remainingUsd: number;
}

// ─── Per-model cost rates (face cost of the REQUESTED model, §7) ──────────────

/** Per-MTok USD rates for a model's face cost (the requested virtual model). */
export interface ModelCostRates {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface UserLimitEngineOptions {
  rules: NormalizedUserLimitRule[];
  /** Σ `cost_usd` of ledger rows matching a meter's seed filter within a window. */
  sumUsageCost: (filter: UsageCostFilter) => number;
  /** Earliest contributing `ts` for the accurate rolling reset ETA (off the hot path). */
  minUsageTs?: (filter: UsageCostFilter) => number | null;
  /** Face cost rates (per MTok) of a REQUESTED model, by logical id. */
  costRatesFor: (logicalId: string) => ModelCostRates | undefined;
  /** Model default `max_tokens`, by logical id — the upper bound on the output cap. */
  maxTokensFor: (logicalId: string) => number | undefined;
  /** Logical ids whose configured cost rate is zero (§5.3 bypass — always affordable). */
  zeroCostModelIds: Set<string>;
  /** Minimum affordable output below which a model can't complete a turn (§5.3). */
  viableMinOutputTokens: number;
  logger: Logger;
  now?: () => number;
  /** Fraction at which a meter is "near" its cap (console). Default 0.8. */
  nearThreshold?: number;
  /** Rolling-recompute / calendar-roll tick (default 60_000 ms). */
  tickMs?: number;
}

interface MeterState {
  spent: number;
  windowStart: number;
  resetsAt: number;
  window: WindowSpec;
  /** Ledger seed filter (window bounds added at seed/recompute). */
  seed: SeedFilter;
}

/** Seed/recompute filter for one meter (the dimensions identifying its spend). */
interface SeedFilter {
  triggerSenderIds?: string[];
  partitionKeys?: string[];
  roomIds?: string[];
  requestedModelIds?: string[];
}

/** Per-binding-constraint status for the console (spec §14). */
export interface UserLimitStatus {
  meterKey: string;
  partitionKey: string;
  isUserPartition: boolean;
  modelScope?: string[];
  spentUsd: number;
  capUsd: number;
  fraction: number;
  state: "ok" | "near" | "blocked";
  window:
    | { type: "rolling"; duration: string }
    | { type: "calendar"; period: "day" | "week" | "month"; tz: string };
  resetsAt: number;
}

// ─── Glob + partition-template helpers ────────────────────────────────────────

/**
 * Anchored fnmatch (spec §8.1): `*` matches any run (incl. empty); case-sensitive;
 * every other char literal. Compiled per glob; the rule set is small + static.
 */
export function compileGlob(glob: string): (value: string) => boolean {
  // Escape every regex metachar EXCEPT `*`, then turn `*` into `.*`. Anchored.
  const body = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  const re = new RegExp(`^${body}$`);
  return (value: string) => re.test(value);
}

/** True when ANY glob in `globs` matches `value` (OR within a dimension, §8.1). */
function matchDimension(globs: string[] | undefined, value: string | undefined): boolean {
  if (!globs) return true; // omitted dimension = wildcard
  if (value === undefined) return false; // a present dimension can't match an absent value
  return globs.some((g) => compileGlob(g)(value));
}

/** The homeserver suffix of a Matrix user id (`@a:hs.org` → `hs.org`), else "". */
export function homeserverOf(userId: string): string {
  const i = userId.indexOf(":");
  return i >= 0 ? userId.slice(i + 1) : "";
}

/**
 * Render a partition template (spec §3.5/§10) against a ctx. Known vars:
 * `{user_id}` / `{room_id}` / `{homeserver}` (and `{space_id}` in Phase 2). An
 * unresolved var renders empty — the normalizer has already rejected unknown
 * vars + Phase-2 `{space_id}`, so this only fires for a `{room_id}` template on a
 * trigger that somehow lacks a room (never in practice).
 */
export function renderPartition(template: string, ctx: UserLimitContext): string {
  return template.replace(/\{(user_id|room_id|homeserver|space_id)\}/g, (_m, key: string) => {
    switch (key) {
      case "user_id":
        return ctx.userId;
      case "room_id":
        return ctx.roomId ?? "";
      case "homeserver":
        return homeserverOf(ctx.userId);
      case "space_id":
        return ctx.spaceId ?? "";
      default:
        return "";
    }
  });
}

function windowKey(w: WindowSpec): string {
  return w.type === "rolling" ? `r:${w.duration}` : `c:${w.period}:${w.tz}`;
}

// =============================================================================

export class UserLimitEngine {
  private readonly rules: NormalizedUserLimitRule[];
  private readonly meters = new Map<string, MeterState>();
  private readonly now: () => number;
  private readonly nearThreshold: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: UserLimitEngineOptions) {
    this.rules = [...options.rules].sort((a, b) => a.order - b.order);
    this.now = options.now ?? Date.now;
    this.nearThreshold = Math.min(0.999, Math.max(0.001, options.nearThreshold ?? 0.8));
    this.tickMs = options.tickMs ?? 60_000;
  }

  /** True when any rule is configured (the feature is on). */
  get enabled(): boolean {
    return this.rules.length > 0;
  }

  start(): void {
    if (this.timer || this.rules.length === 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // ─── Cascade resolution (§8.1) ──────────────────────────────────────────────

  /**
   * Resolve the per-field cascade for a trigger ctx (spec §8.1). Collect matching
   * rules in authored order; take the model-budget block from the FIRST that has
   * one (atomic — `models` + `limits` together) and the refusal message from the
   * FIRST that supplies one (independently). Returns a resolution even when no
   * rule matches (`matched=false`, inert).
   */
  resolve(ctx: UserLimitContext): UserLimitResolution {
    const matching = this.rules.filter(
      (r) =>
        matchDimension(r.user, ctx.userId) &&
        matchDimension(r.room, ctx.roomId) &&
        matchDimension(r.space, ctx.spaceId),
    );
    if (matching.length === 0) {
      return { matched: false, active: false, banned: false, constraints: [] };
    }
    const budgetRule = matching.find((r) => r.hasBudgetBlock);
    const messageTemplate = matching.find((r) => r.messageTemplate !== undefined)?.messageTemplate;

    if (!budgetRule) {
      // Matched only message-override rules → no budget block ⇒ inert budget, but
      // the message still cascades (used only if some OTHER gate refuses; here none).
      return { matched: true, active: false, banned: false, constraints: [], messageTemplate };
    }

    const constraints: ResolvedConstraint[] = budgetRule.constraints.map((c) =>
      this.resolveConstraint(budgetRule, c, ctx),
    );
    // The single shared-pool key to denormalize (Phase-1: ≤ 1 distinct per rule).
    const ledgerPartitionKey = constraints.find((c) => !c.isUserPartition)?.partitionKey;
    const banned =
      budgetRule.models?.length === 0 ||
      constraints.some((c) => c.modelScope === undefined && c.cap === 0);
    const active = budgetRule.models !== undefined || constraints.length > 0;
    return {
      matched: true,
      active,
      banned,
      models: budgetRule.models,
      constraints,
      ledgerPartitionKey,
      messageTemplate,
    };
  }

  private resolveConstraint(
    rule: NormalizedUserLimitRule,
    c: NormalizedConstraint,
    ctx: UserLimitContext,
  ): ResolvedConstraint {
    const partitionKey = renderPartition(c.partition, ctx);
    const isUserPartition = !c.shared;
    // A room-matched rule narrows every meter to the trigger's room (sturdy
    // room-scoped seed via the derived room_id column, §16 Q2) — so a per-user or
    // pool counter on a room-scoped rule counts only that room's spend.
    const roomScope = rule.room ? ctx.roomId : undefined;
    const modelScope = c.models ? [...c.models].sort() : undefined;
    const meterKey = [
      isUserPartition ? "u" : "p",
      partitionKey,
      modelScope ? modelScope.join(",") : "*",
      windowKey(c.window),
      roomScope ?? "*",
    ].join("#");
    return {
      meterKey,
      cap: c.maxUsd,
      window: c.window,
      modelScope,
      partitionKey,
      isUserPartition,
      roomScope,
      source: { ruleOrder: rule.order, index: c.index },
    };
  }

  // ─── Meter materialization + window math ────────────────────────────────────

  private seedFilterFor(c: ResolvedConstraint): SeedFilter {
    const seed: SeedFilter = {};
    if (c.isUserPartition) seed.triggerSenderIds = [c.partitionKey];
    else seed.partitionKeys = [c.partitionKey];
    if (c.roomScope) seed.roomIds = [c.roomScope];
    if (c.modelScope) seed.requestedModelIds = c.modelScope;
    return seed;
  }

  private meterFor(c: ResolvedConstraint): MeterState {
    const existing = this.meters.get(c.meterKey);
    if (existing) {
      this.rollIfNeeded(existing);
      return existing;
    }
    const now = this.now();
    const w = resolveWindow(c.window, now);
    const seed = this.seedFilterFor(c);
    const state: MeterState = {
      spent: this.options.sumUsageCost({ since: w.start, ...seed }),
      windowStart: w.start,
      resetsAt: w.resetsAt,
      window: c.window,
      seed,
    };
    this.meters.set(c.meterKey, state);
    return state;
  }

  /** Roll a passed CALENDAR boundary in place (no SUM) — mirrors BudgetEngine. */
  private rollIfNeeded(state: MeterState): void {
    if (state.window.type !== "calendar") return;
    const now = this.now();
    if (now < state.resetsAt) return;
    const w = resolveWindow(state.window, now);
    state.windowStart = w.start;
    state.resetsAt = w.resetsAt;
    state.spent = 0;
  }

  /** Authoritative periodic reconcile — rolling re-SUM + calendar roll-with-reseed. */
  private tick(): void {
    const now = this.now();
    for (const state of this.meters.values()) {
      const w = resolveWindow(state.window, now);
      if (state.window.type === "rolling") {
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.options.sumUsageCost({ since: w.start, ...state.seed });
      } else if (w.start !== state.windowStart) {
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.options.sumUsageCost({ since: w.start, ...state.seed });
      }
    }
  }

  // ─── Affordability estimate (§5.3) ─────────────────────────────────────────

  /**
   * Can the REQUESTED model `requestedModelId` complete a turn for this resolution
   * within remaining budget right now (spec §5.3, predicate 1)? Prices the prior
   * context at the model's uncached input rate (conservative — never under-charges),
   * caps output at the headroom, and reports UNAFFORDABLE when that cap can't buy a
   * `viable_min` turn. A zero-cost model (or no covering constraint) is always
   * affordable. The `min` ranges over EVERY covering constraint — per-user and
   * shared-pool alike (§8.2).
   */
  affordable(
    resolution: UserLimitResolution,
    requestedModelId: string,
    estimate: AffordabilityEstimate,
  ): AffordabilityResult {
    const modelDefaultMax = this.options.maxTokensFor(requestedModelId);
    // Zero-cost bypass (§5.3): a free model can never move or be blocked.
    if (this.options.zeroCostModelIds.has(requestedModelId)) {
      return { ok: true, maxOutput: modelDefaultMax ?? this.options.viableMinOutputTokens, remainingUsd: Infinity };
    }
    const covering = resolution.constraints.filter(
      (c) => c.modelScope === undefined || c.modelScope.includes(requestedModelId),
    );
    if (covering.length === 0) {
      // Unconstrained (exempt / pure upgrade) → always affordable.
      return { ok: true, maxOutput: modelDefaultMax ?? this.options.viableMinOutputTokens, remainingUsd: Infinity };
    }
    let remaining = Infinity;
    let binding: ResolvedConstraint | undefined;
    for (const c of covering) {
      const meter = this.meterFor(c);
      const headroom = c.cap - meter.spent;
      if (headroom < remaining) {
        remaining = headroom;
        binding = c;
      }
    }
    const rates = this.options.costRatesFor(requestedModelId);
    // No rates known (shouldn't happen for a configured model) → treat as free to
    // avoid wrongly denying; the §8e/§8d gates still bound such a model elsewhere.
    if (!rates || rates.outputPerMTok <= 0) {
      const ok = remaining > 0;
      return {
        ok,
        maxOutput: ok ? modelDefaultMax ?? this.options.viableMinOutputTokens : 0,
        binding,
        remainingUsd: remaining,
      };
    }
    const inputCost = (estimate.priorContextTokens / 1_000_000) * rates.inputPerMTok;
    const outputPricePerToken = rates.outputPerMTok / 1_000_000;
    const affordableOutput = Math.floor((remaining - inputCost) / outputPricePerToken);
    if (!(affordableOutput > this.options.viableMinOutputTokens)) {
      return { ok: false, maxOutput: Math.max(0, affordableOutput), binding, remainingUsd: remaining };
    }
    const maxOutput = Math.min(modelDefaultMax ?? affordableOutput, affordableOutput);
    return { ok: true, maxOutput, binding, remainingUsd: remaining };
  }

  /**
   * Remaining headroom (USD) of the binding FUNGIBLE-TOTAL constraint(s) — the
   * dynamic §8d ceiling input (spec §6.3). The min over covering totals (no
   * `models` scope); undefined when the user has no total constraint (exempt /
   * pure upgrade) ⇒ ∞ headroom (no change to the static ceiling).
   */
  totalHeadroom(resolution: UserLimitResolution): number | undefined {
    const totals = resolution.constraints.filter((c) => c.modelScope === undefined);
    if (totals.length === 0) return undefined;
    let min = Infinity;
    for (const c of totals) {
      const meter = this.meterFor(c);
      min = Math.min(min, Math.max(0, c.cap - meter.spent));
    }
    return Number.isFinite(min) ? min : undefined;
  }

  // ─── Recording (§8.2) ───────────────────────────────────────────────────────

  /**
   * Record one committed agent-loop event against a session's FROZEN resolution
   * (spec §8.2). Increments every meter whose model scope covers the REQUESTED
   * model (the gate-on-virtual identity of §7) by the ACTUAL served cost. One event
   * thus updates several meters (per-user total, per-user sub-cap, shared pool, pool
   * sub-cap). No-op for a non-positive cost or an inactive resolution.
   */
  record(resolution: UserLimitResolution, requestedModelId: string, costUsd: number): void {
    if (!(costUsd > 0)) return;
    for (const c of resolution.constraints) {
      if (c.modelScope !== undefined && !c.modelScope.includes(requestedModelId)) continue;
      this.meterFor(c).spent += costUsd;
    }
  }

  // ─── Refusal-message support (§12) ─────────────────────────────────────────

  /**
   * The binding constraint for a refusal: the covering constraint with the least
   * headroom for `requestedModelId` (or, when omitted, across the whole resolution
   * — the soonest-resetting over-cap one). Used to populate the message tokens.
   */
  bindingConstraint(
    resolution: UserLimitResolution,
    requestedModelId?: string,
  ): ResolvedConstraint | undefined {
    const covering = resolution.constraints.filter(
      (c) =>
        requestedModelId === undefined ||
        c.modelScope === undefined ||
        c.modelScope.includes(requestedModelId),
    );
    let binding: ResolvedConstraint | undefined;
    let minHeadroom = Infinity;
    for (const c of covering) {
      const headroom = c.cap - this.meterFor(c).spent;
      if (headroom < minHeadroom) {
        minHeadroom = headroom;
        binding = c;
      }
    }
    return binding;
  }

  /**
   * Accurate reset instant for a resolved constraint's current window (§12 / §5 #5):
   * the fixed boundary for calendar; `min(contributing ts) + duration` for rolling
   * (off the hot path). Returns undefined for a cap-0 ban (no meaningful reset).
   */
  accurateResetsAt(c: ResolvedConstraint): number | undefined {
    if (c.cap === 0) return undefined;
    const meter = this.meterFor(c);
    if (c.window.type !== "rolling") return meter.resetsAt;
    const minTs = this.options.minUsageTs?.({ since: meter.windowStart, ...meter.seed });
    if (minTs === undefined || minTs === null) return this.now() + c.window.durationMs;
    return minTs + c.window.durationMs;
  }

  // ─── Console statuses (§14) ────────────────────────────────────────────────

  /** One status per currently-materialized meter (spec §14). */
  statuses(): UserLimitStatus[] {
    const out: UserLimitStatus[] = [];
    for (const [meterKey, state] of this.meters) {
      this.rollIfNeeded(state);
      const [kind, partitionKey, scope] = meterKey.split("#");
      const cap = capOfMeter(this.rules, meterKey) ?? 0;
      const fraction = cap > 0 ? state.spent / cap : state.spent > 0 ? Infinity : 1;
      const blocked = state.spent >= cap && cap >= 0;
      const near = !blocked && fraction >= this.nearThreshold;
      const w = state.window;
      out.push({
        meterKey,
        partitionKey: partitionKey ?? "",
        isUserPartition: kind === "u",
        modelScope: scope && scope !== "*" ? scope.split(",") : undefined,
        spentUsd: state.spent,
        capUsd: cap,
        fraction: Number.isFinite(fraction) ? fraction : 1,
        state: blocked ? "blocked" : near ? "near" : "ok",
        window:
          w.type === "rolling"
            ? { type: "rolling", duration: w.duration }
            : { type: "calendar", period: w.period, tz: w.tz },
        resetsAt: state.resetsAt,
      });
    }
    return out;
  }
}

/**
 * The cap of a meter, recovered from the rule set by its key (console only). A
 * meter can be referenced by several constraints; report the smallest cap (the
 * binding one) for the status badge. Returns undefined when no rule references it
 * (a meter materialized by a rule that has since changed — never in steady state).
 */
function capOfMeter(rules: NormalizedUserLimitRule[], meterKey: string): number | undefined {
  let min: number | undefined;
  for (const rule of rules) {
    for (const c of rule.constraints) {
      // Reconstruct the model-scope + window portion of the key (partition/room are
      // ctx-dependent, so match on the suffix that is intrinsic to the constraint).
      const scope = c.models ? [...c.models].sort().join(",") : "*";
      const wk = windowKey(c.window);
      if (meterKey.includes(`#${scope}#${wk}#`)) {
        min = min === undefined ? c.maxUsd : Math.min(min, c.maxUsd);
      }
    }
  }
  return min;
}
