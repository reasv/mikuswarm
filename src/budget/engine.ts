// =============================================================================
// BudgetEngine (spec USAGE-COST-LIMITS §6).
//
// A single in-memory engine, seeded from `usage_events` at startup, that answers
// admission / pre-flight / tool-gate questions WITHOUT a SQL SUM on the hot path
// (§6.5). Each rule keeps a running spend total for its current window plus the
// window's `resetsAt`; `check()` is O(#rules) in memory.
//
// Counting model (§2): every rule counts ONLY its own scope. A prospective spend
// is allowed iff every rule whose selector covers it has headroom. The
// "keep summaries running after sessions are suspended" behavior is an emergent
// consequence of layering a narrow rule under a broad one — NOT a counting mode.
//
// Zero-cost bypass (§2.2): if the descriptor's model has a zero configured rate,
// `check()` short-circuits to allowed — a free model can never move or be blocked
// by a budget rule. The bypass is budget-only; the dependency cascade (§2.1)
// still applies.
// =============================================================================

import type { Logger } from "../observability/logger.js";
import type { UsageEventInput } from "../storage/database.js";
import { type WindowSpec, resolveWindow } from "./window.js";

/** A budget rule's own-scope selector (omitted dimension = wildcard). */
export interface RuleSelector {
  classes?: string[];
  sessionTypes?: string[];
  tools?: string[];
  models?: string[];
  /**
   * Agent/account scope (spec MULTI-AGENT-SUPPORT §8): when set, this rule only
   * matches events whose `timeline_key` starts with one of these prefixes (format:
   * `"provider:accountKey"`). NULL `timeline_key` events (embedding lane) never match
   * a scoped rule. Absent = global (wildcard, exact current behaviour).
   */
  timelineKeyPrefixes?: string[];
}

/** A normalized budget rule (parsed from `[[limits]]`, spec §5.1). */
export interface LimitRule {
  name: string;
  maxUsd: number;
  window: WindowSpec;
  selector: RuleSelector;
  /** Templated with `{resets_at}`; posted on a refused human trigger (§6.3). */
  triggerRejectionMessage?: string;
}

/**
 * Late-bound budget wiring shared across consumers (factory, worker pools,
 * proactive scheduler, tool sink). A holder because the engine + the ledger
 * recorder are constructed AFTER those consumers during app wiring; both fields
 * are filled before any work runs. Absent fields = no budgeting (tests).
 */
export interface BudgetHooks {
  engine?: BudgetEngine;
  /** Append one `usage_events` row + increment the engine in-memory. */
  record?: (event: UsageEventInput) => void;
}

/** The prospective spend a gate is about to admit (spec §6.2). */
export interface SpendDescriptor {
  class: string;
  sessionType?: string;
  tool?: string;
  /** Upstream wire model id (provenance). */
  modelId: string;
  /**
   * LOGICAL model id (config block name; spec MODEL-FALLBACK §2.2) — the
   * dimension the `models` selector and the zero-cost bypass match on. Falls back
   * to `modelId` when omitted (the common no-virtual-model case).
   */
  logicalModelId?: string;
  provider?: string;
  /**
   * The session's `timeline_key` — used for agent/account-scoped rule matching
   * (spec MULTI-AGENT-SUPPORT §8). Absent for worker-pool claim gates (no per-session
   * context); scoped rules do NOT match when this is absent (safe).
   */
  timelineKey?: string;
}

/** One rule that is at or over its cap, surfaced in a block decision / log (§6.4). */
export interface BlockingRule {
  name: string;
  spentUsd: number;
  capUsd: number;
  window: WindowSpec;
  resetsAt: number;
  triggerRejectionMessage?: string;
}

/** The result of a single-event admission check (spec §6.2). */
export interface CheckResult {
  allowed: boolean;
  blockingRules: BlockingRule[];
  primary?: { name: string; resetsAt: number; triggerRejectionMessage?: string };
}

/** The result of a session-admission check, including the dependency cascade (§2.1). */
export interface AdmissionResult {
  allowed: boolean;
  /** Rules blocking the session's OWN spend. */
  ownBlocking: BlockingRule[];
  /** The first dependency that is unavailable, with the rule(s) blocking IT. */
  dependency?: { sessionType: string; blocking: BlockingRule[] };
  primary?: { name: string; resetsAt: number; triggerRejectionMessage?: string };
}

/** Per-rule status for the console Limits section (spec §6.2 / §7.1 #3). */
export interface RuleStatus {
  name: string;
  spentUsd: number;
  capUsd: number;
  fraction: number;
  state: "ok" | "near" | "blocked";
  window:
    | { type: "rolling"; duration: string }
    | { type: "calendar"; period: "day" | "week" | "month"; tz: string };
  resetsAt: number;
  scope: RuleSelector;
  /**
   * Per-model spend within the window, in `scope.models` order — present only for a
   * **multi-model** rule (≥2 models), so the console can render the bar as a segmented
   * composite (the same treatment as a per-user composite cap). Each entry is a ledger
   * `sumUsageCost` for that one model under the rule's other selector dimensions; the
   * entries sum to `spentUsd`. Off the hot path (`ruleStatuses` only). Undefined for a
   * single-model or model-agnostic rule (rendered as one plain health bar).
   */
  components?: { model: string; spentUsd: number }[];
}

/** The filter shape for `BudgetEngineOptions.sumUsageCost` / `minUsageTs`. */
export interface BudgetSeedFilter {
  since: number;
  until?: number;
  classes?: string[];
  sessionTypes?: string[];
  tools?: string[];
  models?: string[];
  /** Agent/account-scoped rule seeding (spec MULTI-AGENT-SUPPORT §8). */
  timelineKeyPrefixes?: string[];
}

export interface BudgetEngineOptions {
  rules: LimitRule[];
  /** Σ `cost_usd` of the ledger rows matching a selector within a window. */
  sumUsageCost: (filter: BudgetSeedFilter) => number;
  /**
   * Earliest `ts` of the ledger rows matching a selector within a window, or null
   * when none match. Used OFF the hot path (`ruleStatuses` + the refusal-message
   * path via `rollingResetsAt`) to compute an accurate rolling reset ETA (§5 #5);
   * NEVER consulted inside `check()`'s gate loop. Optional so tests/engines without
   * a ledger fall back to the cheap `now + duration` upper bound.
   */
  minUsageTs?: (filter: BudgetSeedFilter) => number | null;
  /** LOGICAL model ids whose configured cost rate is zero (§2.2; spec MODEL-FALLBACK §2.2). */
  zeroCostModelIds: Set<string>;
  /**
   * Structural dependency cascade (§2.1): session type → prerequisite session
   * types that must be available for it to be admitted.
   */
  dependencies: Record<string, string[]>;
  /** Resolve a session type's upstream model id (provenance on dependency descriptors). */
  resolveModelId: (sessionType: string) => string | undefined;
  /**
   * Resolve a session type's LOGICAL model id — the config block name a
   * `[[limits]].models` selector matches (spec MODEL-FALLBACK §2.2). Used by the
   * session-level gates so they scope on the same dimension the ledger records.
   * Absent → the session gate's logical dimension falls back to the upstream id.
   */
  resolveLogicalModelId?: (sessionType: string) => string | undefined;
  /**
   * Resolve a session type's FULL fallback chain as logical ids, head-first (spec
   * MODEL-FALLBACK §6.1). Used by the dependency cascade so a prerequisite is judged
   * unavailable only when EVERY chain member is over budget — a model-scoped cap on
   * the prerequisite's head must not refuse a dependent session that the prerequisite
   * could still serve on a fallback. Absent (or empty result) → the cascade falls
   * back to the head-only `resolveLogicalModelId` behavior.
   */
  resolveModelChainLogicalIds?: (sessionType: string) => string[];
  logger: Logger;
  now?: () => number;
  /** Fraction at which a rule is "near" its cap in the console (default 0.8). */
  nearThreshold?: number;
  /** Rolling-window recompute / calendar-roll tick (default 60_000 ms). */
  tickMs?: number;
}

interface RuleState {
  rule: LimitRule;
  spent: number;
  windowStart: number;
  resetsAt: number;
  /** Whether this rule was blocked at the last transition (for log rate-limiting). */
  wasBlocked: boolean;
}

export class BudgetEngine {
  private readonly states: RuleState[];
  private readonly now: () => number;
  private readonly nearThreshold: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: BudgetEngineOptions) {
    this.now = options.now ?? Date.now;
    // Clamp to the open interval (0,1): a 0 threshold would mark every rule with
    // any spend "near", and a ≥1 threshold would disable the "near" badge entirely
    // (both are nonsense for the console's headroom signal). Fall back to 0.8.
    this.nearThreshold = Math.min(0.999, Math.max(0.001, options.nearThreshold ?? 0.8));
    this.tickMs = options.tickMs ?? 60_000;
    const now = this.now();
    this.states = options.rules.map((rule) => {
      const w = resolveWindow(rule.window, now);
      return {
        rule,
        windowStart: w.start,
        resetsAt: w.resetsAt,
        spent: this.sumRule(rule, w.start),
        wasBlocked: false,
      };
    });
  }

  /** Begin the periodic roll / rolling-recompute tick. Idempotent. */
  start(): void {
    if (this.timer || this.states.length === 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private sumRule(rule: LimitRule, since: number): number {
    return this.options.sumUsageCost({ since, ...rule.selector });
  }

  /**
   * Roll a CALENDAR rule's window forward, in place and WITHOUT a SQL SUM, if its
   * boundary has passed at `now`. A fresh calendar window is empty at its start —
   * per-rule increments only ever happen via `record()`, which rolls-then-adds —
   * so resetting `spent` to 0 is exact, not a guess (§6.5: no SUM on the hot path).
   *
   * Called at the top of every read/decision path (`check`, `isClassAvailable`,
   * `ruleStatuses`) and inside `record()`'s loop, so a passed boundary is reflected
   * immediately rather than waiting up to one `tick()` (which would otherwise let a
   * rule that hit cap yesterday keep reporting blocked against a fresh-empty
   * window). Rolling windows are untouched here — they recompute exactly in
   * `tick()` (their total has no cheap closed-form roll).
   */
  private rollIfNeeded(state: RuleState, now: number): void {
    if (state.rule.window.type !== "calendar") return;
    if (now < state.resetsAt) return;
    const w = resolveWindow(state.rule.window, now);
    state.windowStart = w.start;
    state.resetsAt = w.resetsAt;
    state.spent = 0;
  }

  /**
   * Reconcile every rule's window + total from the ledger — the authoritative
   * periodic reconciler. Calendar rules re-SUM when their boundary has passed
   * (correcting any drift from the cheap `rollIfNeeded` zero-reset); rolling rules
   * recompute every tick (cheap via `idx_usage_events_ts`) to shed aged-out spend
   * (§6.1). This is the only place a calendar roll consults the ledger.
   */
  private tick(): void {
    const now = this.now();
    for (const state of this.states) {
      const w = resolveWindow(state.rule.window, now);
      if (state.rule.window.type === "rolling") {
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.sumRule(state.rule, w.start);
      } else if (w.start !== state.windowStart) {
        // Calendar boundary rolled: new window, reseed from the ledger.
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.sumRule(state.rule, w.start);
      }
    }
  }

  private isZeroCost(modelId: string): boolean {
    return this.options.zeroCostModelIds.has(modelId);
  }

  /**
   * The accurate "resets at" instant for a rule's CURRENT window (§5 #5).
   *
   * - Calendar: the fixed boundary already in `state.resetsAt`.
   * - Rolling: a trailing window has no fixed boundary; it is fully clear once its
   *   OLDEST contributing spend ages out, i.e. `min(ts in window) + durationMs`.
   *   `state.resetsAt` (`now + durationMs`) is only an UPPER bound — it pins at the
   *   full duration even when the oldest spend ages out in minutes, making the
   *   console countdown and the "back in 24h" refusal misleading. We query the
   *   earliest contributing `ts` off the hot path; with no contributing spend (or
   *   no ledger wired) we fall back to that upper bound.
   *
   * OFF the hot path only (`ruleStatuses` + `accurateResetsAt`); `check()` keeps
   * the cheap `state.resetsAt`.
   */
  private computeResetsAt(state: RuleState, now: number): number {
    if (state.rule.window.type !== "rolling") return state.resetsAt;
    const durationMs = state.rule.window.durationMs;
    const minTs = this.options.minUsageTs?.({ since: state.windowStart, ...state.rule.selector });
    if (minTs === undefined || minTs === null) return now + durationMs;
    return minTs + durationMs;
  }

  /**
   * The accurate reset instant for a named rule's current window (§5 #5), for the
   * human-facing refusal/defer message path in `app.ts`. Rolls a passed calendar
   * boundary first; for a rolling rule returns the `min(contributing ts) + duration`
   * ETA. Returns `undefined` for an unknown rule name so the caller can fall back.
   */
  accurateResetsAt(ruleName: string): number | undefined {
    const state = this.states.find((s) => s.rule.name === ruleName);
    if (!state) return undefined;
    const now = this.now();
    this.rollIfNeeded(state, now);
    return this.computeResetsAt(state, now);
  }

  private selectorMatches(rule: LimitRule, d: SpendDescriptor): boolean {
    const s = rule.selector;
    if (s.classes && !s.classes.includes(d.class)) return false;
    if (s.sessionTypes && (d.sessionType === undefined || !s.sessionTypes.includes(d.sessionType)))
      return false;
    if (s.tools && (d.tool === undefined || !s.tools.includes(d.tool))) return false;
    // `models` matches the LOGICAL id (spec MODEL-FALLBACK §2.2), falling back to
    // the upstream id when no logical id was supplied (block name == wire id).
    if (s.models && !s.models.includes(d.logicalModelId ?? d.modelId)) return false;
    // Agent/account scoping (spec MULTI-AGENT-SUPPORT §8): a scoped rule only matches
    // when the descriptor carries a `timelineKey` that starts with one of the rule's
    // account prefixes (format: `"provider:accountKey:…"`). When `timelineKey` is
    // absent (e.g. worker-pool claim gates have no per-session context) the rule does
    // NOT match — safe, since worker gates check classes the scoped rule likely doesn't
    // cover. NULL `timeline_key` events (embedding lane) also never carry a `timelineKey`.
    if (s.timelineKeyPrefixes) {
      if (!d.timelineKey) return false;
      if (!s.timelineKeyPrefixes.some((p) => d.timelineKey!.startsWith(`${p}:`))) return false;
    }
    return true;
  }

  private toBlocking(state: RuleState): BlockingRule {
    return {
      name: state.rule.name,
      spentUsd: state.spent,
      capUsd: state.rule.maxUsd,
      window: state.rule.window,
      resetsAt: state.resetsAt,
      triggerRejectionMessage: state.rule.triggerRejectionMessage,
    };
  }

  /**
   * Admission check for one prospective spend (spec §6.2). Short-circuits to
   * allowed for a zero-cost model. A rule blocks when its window total is at or
   * over the cap (cap 0 → always blocks any covered non-free spend).
   */
  check(descriptor: SpendDescriptor): CheckResult {
    if (this.isZeroCost(descriptor.logicalModelId ?? descriptor.modelId)) {
      return { allowed: true, blockingRules: [] };
    }
    const now = this.now();
    const blocking: BlockingRule[] = [];
    for (const state of this.states) {
      this.rollIfNeeded(state, now);
      if (!this.selectorMatches(state.rule, descriptor)) continue;
      if (state.spent >= state.rule.maxUsd) blocking.push(this.toBlocking(state));
    }
    if (blocking.length === 0) return { allowed: true, blockingRules: [] };
    const primary = blocking.reduce((earliest, r) => (r.resetsAt < earliest.resetsAt ? r : earliest));
    return {
      allowed: false,
      blockingRules: blocking,
      primary: {
        name: primary.name,
        resetsAt: primary.resetsAt,
        triggerRejectionMessage: primary.triggerRejectionMessage,
      },
    };
  }

  /** Is the named consumer class currently runnable (no covering rule over cap)? */
  isClassAvailable(sessionType: string): boolean {
    const modelId = this.options.resolveModelId(sessionType);
    if (modelId === undefined) return true; // unresolvable → don't block on it
    const logicalModelId = this.options.resolveLogicalModelId?.(sessionType);
    return this.check({ class: "agent_loop", sessionType, modelId, logicalModelId }).allowed;
  }

  /**
   * Is the named LOGICAL model currently within budget (spec MODEL-FALLBACK §3/§7
   * — the per-attempt fallback resolver drops a member that fails this)?
   *
   * Scoped rules (non-empty `timelineKeyPrefixes`) are skipped here because this
   * method has no `timelineKey` context — it is called by the per-attempt fallback
   * resolver which knows only a logical model id, not which agent's session is
   * requesting it. If a scoped rule were included, one agent's exhausted budget
   * would make the model "unavailable" process-wide, silently degrading every other
   * agent to a fallback model. Real enforcement of scoped rules stays at
   * `check()`/`checkAdmissionChain`, which thread the session's `timelineKey`.
   * A global rule (no `timelineKeyPrefixes`) still blocks correctly here.
   */
  isModelAvailable(modelId: string): boolean {
    if (this.isZeroCost(modelId)) return true;
    const now = this.now();
    for (const state of this.states) {
      this.rollIfNeeded(state, now);
      // Skip agent/account-scoped rules — they have no timelineKey to match against
      // here and must not influence process-wide model availability (see above).
      if (state.rule.selector.timelineKeyPrefixes?.length) continue;
      // A rule covers this model iff it either targets it explicitly OR has no
      // `models` selector (wildcard) — symmetric with `selectorMatches`. Without
      // the wildcard arm a global over-cap rule wrongly reports every model free,
      // contradicting `check()`.
      const s = state.rule.selector;
      if ((!s.models || s.models.includes(modelId)) && state.spent >= state.rule.maxUsd) return false;
    }
    return true;
  }

  /**
   * Session-admission check combining the session's own covering rules with the
   * structural dependency cascade (§2.1): a dependent session also requires every
   * class it depends on to be available. Used at the triggered/proactive gates.
   *
   * Gates on the session's HEAD logical id only. Prefer {@link checkAdmissionChain}
   * at the launch gate so a model-scoped cap on the primary doesn't refuse a session
   * for which an in-budget fallback exists (spec MODEL-FALLBACK §6.1).
   *
   * `timelineKey` — the session's timeline key, for agent/account-scoped rule matching
   * (spec MULTI-AGENT-SUPPORT §8). Absent ⇒ scoped rules never match.
   */
  checkAdmission(sessionType: string, modelId: string, timelineKey?: string): AdmissionResult {
    const head = this.options.resolveLogicalModelId?.(sessionType);
    return this.checkAdmissionChain(sessionType, modelId, head ? [head] : [], timelineKey);
  }

  /**
   * Chain-aware session-admission check (spec MODEL-FALLBACK §6.1). The session's
   * OWN spend is admissible iff ANY chain member's covering rules have headroom —
   * the per-attempt resolver would serve the first in-budget member, so refusing on
   * the primary's exhausted budget would wrongly drop a session a fallback could
   * serve. A WILDCARD (no `models` selector) rule at cap covers every member, so it
   * still refuses (correct: global exhaustion has no cheaper escape). The structural
   * dependency cascade (§2.1) is chain-aware too: a prerequisite is unavailable only
   * when EVERY member of ITS chain is over budget (via `resolveModelChainLogicalIds`),
   * so a model-scoped cap on a prerequisite's head does not refuse a dependent session
   * the prerequisite could still serve on a fallback.
   *
   * `chainLogicalIds` is head-first; an empty list falls back to gating on the
   * descriptor's upstream id (the no-virtual-model case). The reported `ownBlocking`
   * /`primary` come from the HEAD's check (the canonical refusal context) when the
   * whole chain is over budget.
   *
   * `timelineKey` — threaded into every `check()` descriptor for agent/account-scoped
   * rule matching (spec MULTI-AGENT-SUPPORT §8). Also used in the dependency cascade
   * so a scoped dependency (summarize/condense scoped to one agent) blocks only that
   * agent's sessions. Absent ⇒ scoped rules never match.
   */
  checkAdmissionChain(
    sessionType: string,
    modelId: string,
    chainLogicalIds: string[],
    timelineKey?: string,
  ): AdmissionResult {
    const logicalIds = chainLogicalIds.length > 0 ? chainLogicalIds : [undefined];
    let headCheck: CheckResult | undefined;
    let admitted = false;
    for (const logicalModelId of logicalIds) {
      const result = this.check({ class: "agent_loop", sessionType, modelId, logicalModelId, timelineKey });
      if (headCheck === undefined) headCheck = result;
      if (result.allowed) {
        admitted = true;
        break;
      }
    }
    if (!admitted) {
      const own = headCheck!;
      return { allowed: false, ownBlocking: own.blockingRules, primary: own.primary };
    }
    const deps = this.options.dependencies[sessionType] ?? [];
    for (const dep of deps) {
      const depModel = this.options.resolveModelId(dep);
      if (depModel === undefined) continue;
      // Chain-aware (spec MODEL-FALLBACK §6.1): the prerequisite is available iff ANY
      // of ITS chain members has headroom — the prerequisite's own worker pool serves
      // the first in-budget member (its claim gate is chain-aware too), so a cap on
      // the prerequisite's head (e.g. summarization on GLM) must not refuse a dependent
      // reply the prerequisite could still produce on a fallback (e.g. DeepSeek). A
      // WILDCARD rule covers every member and still refuses (global exhaustion has no
      // escape). Falls back to head-only when no chain resolver / empty chain.
      const depChain = this.options.resolveModelChainLogicalIds?.(dep) ?? [];
      const depLogicalIds: (string | undefined)[] =
        depChain.length > 0 ? depChain : [this.options.resolveLogicalModelId?.(dep)];
      let depHeadCheck: CheckResult | undefined;
      let depAdmitted = false;
      for (const logicalModelId of depLogicalIds) {
        const depCheck = this.check({
          class: "agent_loop",
          sessionType: dep,
          modelId: depModel,
          logicalModelId,
          timelineKey,
        });
        if (depHeadCheck === undefined) depHeadCheck = depCheck;
        if (depCheck.allowed) {
          depAdmitted = true;
          break;
        }
      }
      if (!depAdmitted) {
        return {
          allowed: false,
          ownBlocking: [],
          dependency: { sessionType: dep, blocking: depHeadCheck!.blockingRules },
          primary: depHeadCheck!.primary,
        };
      }
    }
    return { allowed: true, ownBlocking: [] };
  }

  /**
   * Record one committed billable event, incrementing every covering rule's
   * window total in memory (§6.1). Cheap and exact between rolling recomputes
   * (the increment-only total can briefly over-count aged-out spend — safe, it
   * never under-enforces).
   */
  record(event: UsageEventInput): void {
    // Reject NaN, 0, and negatives in one expression (same idiom as
    // normalize.ts:73). `NaN <= 0` is false, so the old `<= 0` form admitted a NaN
    // cost and poisoned `state.spent` (the rule then stops enforcing until the next
    // recompute); a negative would be dropped here but summed on the recompute path
    // → divergence. `!(x > 0)` rejects all three uniformly.
    if (!(event.costUsd > 0)) return;
    const descriptor: SpendDescriptor = {
      class: event.class,
      sessionType: event.sessionType ?? undefined,
      tool: event.toolName ?? undefined,
      modelId: event.modelId,
      logicalModelId: event.logicalModelId ?? undefined,
      provider: event.provider ?? undefined,
      timelineKey: event.timelineKey ?? undefined,
    };
    const now = this.now();
    for (const state of this.states) {
      // Roll a passed calendar boundary in place (no SUM, §6.5) before adding, so a
      // spend that lands just after midnight accrues to the new window, not
      // yesterday's. Rolling windows are reconciled by `tick()`.
      this.rollIfNeeded(state, now);
      if (this.selectorMatches(state.rule, descriptor)) state.spent += event.costUsd;
    }
  }

  /** One status entry per configured rule (never filtered) for the console (§6.2). */
  ruleStatuses(): RuleStatus[] {
    const now = this.now();
    return this.states.map((state) => {
      this.rollIfNeeded(state, now);
      const cap = state.rule.maxUsd;
      const fraction = cap > 0 ? state.spent / cap : state.spent > 0 ? Infinity : 1;
      const blocked = state.spent >= cap;
      const near = !blocked && fraction >= this.nearThreshold;
      const w = state.rule.window;
      const window =
        w.type === "rolling"
          ? ({ type: "rolling", duration: w.duration } as const)
          : ({ type: "calendar", period: w.period, tz: w.tz } as const);
      // Per-model breakdown for a multi-model rule, so the console can segment the bar
      // (composite composition) the same way a per-user composite cap does. Off the hot
      // path — one ledger sum per constituent model within the rule's other dimensions.
      const sel = state.rule.selector;
      const components =
        sel.models && sel.models.length >= 2
          ? sel.models.map((m) => ({
              model: m,
              spentUsd: this.options.sumUsageCost({
                since: state.windowStart,
                classes: sel.classes,
                sessionTypes: sel.sessionTypes,
                tools: sel.tools,
                models: [m],
                // Scope the per-model component sum to the same agent/account
                // prefixes as the rule itself, so the console breakdown for a
                // scoped multi-model rule shows only that agent's spend, not
                // all agents' combined spend on that model.
                timelineKeyPrefixes: sel.timelineKeyPrefixes,
              }),
            }))
          : undefined;
      return {
        name: state.rule.name,
        spentUsd: state.spent,
        capUsd: cap,
        fraction: Number.isFinite(fraction) ? fraction : 1,
        state: blocked ? "blocked" : near ? "near" : "ok",
        window,
        components,
        // Accurate reset for the console countdown: a rolling rule resets when its
        // oldest contributing spend ages out, not at the full-duration upper bound
        // (§5 #5). Off the hot path, so the `minUsageTs` query is fine here.
        resetsAt: this.computeResetsAt(state, now),
        scope: state.rule.selector,
      } satisfies RuleStatus;
    });
  }

  /**
   * Emit one structured `usage_limit_blocked` log naming EVERY hit rule (§6.4),
   * rate-limited to the blocked transition + periodic re-log per gate is the
   * caller's concern; this is the shared formatter.
   */
  logBlocked(
    gate: string,
    blocking: BlockingRule[],
    descriptor: SpendDescriptor,
    extra: Record<string, unknown> = {},
  ): void {
    if (blocking.length === 0) return;
    const primary = blocking.reduce((earliest, r) => (r.resetsAt < earliest.resetsAt ? r : earliest));
    this.options.logger.warn("usage_limit_blocked", {
      gate,
      limits: blocking.map((r) => ({
        name: r.name,
        spentUsd: r.spentUsd,
        capUsd: r.capUsd,
        window: r.window,
        resetsAt: r.resetsAt,
      })),
      primary: primary.name,
      descriptor: {
        class: descriptor.class,
        sessionType: descriptor.sessionType,
        tool: descriptor.tool,
        modelId: descriptor.modelId,
        provider: descriptor.provider,
      },
      ...extra,
    });
  }
}

/**
 * Build a worker-pool claim gate (spec USAGE-COST-LIMITS §6.3/§6.4, review #2): a
 * `() => boolean` that returns true (PARK the pool) while ANY of `descriptors` is
 * over budget, and — mirroring the caption pool — emits ONE rate-limited (≤1/min)
 * `usage_limit_blocked` log (gate `"worker_claim"`) naming the hit rules on pause.
 *
 * The summary/diary/embed pools all park silently before this (only caption logged),
 * masking the §6.4 invariant that every blocking gate names the rules it hit — worst
 * for summarization, whose pause transitively halts triggered/proactive sessions via
 * the dependency cascade (§2.1). The first over-budget descriptor wins the log
 * (conservative pause: any one over-budget descriptor parks the whole pool).
 *
 * `descriptors` is resolved lazily each call so a caller can recompute model ids the
 * way the engine does; an empty result (e.g. every session type unresolvable) never
 * parks. Each gate owns its own rate-limit clock — independent across pools.
 *
 * `engine` may be a concrete `BudgetEngine` (summary/diary call sites, constructed
 * after the engine) OR a late-bound source `() => BudgetEngine | undefined` for a
 * consumer wired BEFORE the engine exists (the embed worker, whose subsystem is
 * built ahead of the engine and reads it from the shared holder at call time —
 * finding #21). The source is resolved per call; while it is still undefined the
 * gate returns `false` (never park) and logs nothing — no embedding work runs
 * before startup completes anyway.
 */
export function makeRateLimitedClaimGate(opts: {
  engine: BudgetEngine | (() => BudgetEngine | undefined);
  /** The prospective spends to gate on (first blocked one wins the log). */
  descriptors: () => SpendDescriptor[];
  now?: () => number;
}): () => boolean {
  const now = opts.now ?? Date.now;
  const resolveEngine =
    typeof opts.engine === "function" ? opts.engine : () => opts.engine as BudgetEngine;
  let lastPauseLog = 0;
  return () => {
    const engine = resolveEngine();
    if (!engine) return false; // engine not yet wired → never park, never log
    for (const descriptor of opts.descriptors()) {
      const result = engine.check(descriptor);
      if (result.allowed) continue;
      const t = now();
      if (t - lastPauseLog > 60_000) {
        lastPauseLog = t;
        engine.logBlocked("worker_claim", result.blockingRules, descriptor);
      }
      return true;
    }
    return false;
  };
}

/**
 * Build a CHAIN-AWARE worker-pool claim gate (spec MODEL-FALLBACK §6): a
 * `() => boolean` that parks the pool ONLY when EVERY chain member is over budget —
 * the per-attempt resolver would serve the first in-budget member, so a head-only
 * cap must NOT park the pool. This is the worker-pool analogue of the image-gen/
 * x_search `chain.some((m) => !checkBudget(m))` tool gates, and the inverse of
 * {@link makeRateLimitedClaimGate} (which parks if ANY descriptor is over budget —
 * correct for distinct session types, wrong for fallback chain members).
 *
 * On pause it emits ONE rate-limited (≤1/min) `usage_limit_blocked` log naming the
 * rules blocking the HEAD member (the canonical refusal context for the chain).
 * `descriptors` is resolved lazily each call (head-first); an empty result never
 * parks. The `engine` may be a concrete engine or a late-bound source (the embed
 * pool, wired before the engine; while undefined the gate never parks).
 */
export function makeChainClaimGate(opts: {
  engine: BudgetEngine | (() => BudgetEngine | undefined);
  /** The chain members' prospective spends, head-first. */
  descriptors: () => SpendDescriptor[];
  now?: () => number;
}): () => boolean {
  const now = opts.now ?? Date.now;
  const resolveEngine =
    typeof opts.engine === "function" ? opts.engine : () => opts.engine as BudgetEngine;
  let lastPauseLog = 0;
  return () => {
    const engine = resolveEngine();
    if (!engine) return false; // engine not yet wired → never park, never log
    const chain = opts.descriptors();
    if (chain.length === 0) return false; // no chain → never park
    const available = chain.some((descriptor) => engine.check(descriptor).allowed);
    if (available) return false;
    const head = chain[0]!;
    const t = now();
    if (t - lastPauseLog > 60_000) {
      lastPauseLog = t;
      engine.logBlocked("worker_claim", engine.check(head).blockingRules, head);
    }
    return true;
  };
}

/**
 * Build a MULTI-LANE chain-aware claim gate (spec MODEL-FALLBACK §6): a pool that
 * serves several distinct session types (e.g. summarization does `summarize` +
 * `condense`) parks when ANY lane cannot make progress, where a lane is a session
 * type and can progress iff ANY member of ITS OWN fallback chain has headroom. This
 * is the per-lane {@link makeChainClaimGate} composed across lanes with the
 * distinct-session-type "park if any lane is stuck" conservatism of
 * {@link makeRateLimitedClaimGate} — but chain-aware, so a model-scoped cap on a
 * lane's HEAD (which the per-attempt resolver would fall past) never parks the pool.
 *
 * `lanes` is resolved lazily each call; each inner array is one lane's chain
 * descriptors, head-first. An empty lane (unresolvable session type) is skipped —
 * it never parks the pool. On pause it emits one rate-limited (≤1/min)
 * `usage_limit_blocked` log naming the rules blocking the stuck lane's HEAD.
 */
export function makeAgentLoopChainClaimGate(opts: {
  engine: BudgetEngine | (() => BudgetEngine | undefined);
  lanes: () => SpendDescriptor[][];
  now?: () => number;
}): () => boolean {
  const now = opts.now ?? Date.now;
  const resolveEngine =
    typeof opts.engine === "function" ? opts.engine : () => opts.engine as BudgetEngine;
  let lastPauseLog = 0;
  return () => {
    const engine = resolveEngine();
    if (!engine) return false; // engine not yet wired → never park, never log
    for (const chain of opts.lanes()) {
      if (chain.length === 0) continue; // unresolvable lane → don't park on it
      const available = chain.some((descriptor) => engine.check(descriptor).allowed);
      if (available) continue;
      const head = chain[0]!;
      const t = now();
      if (t - lastPauseLog > 60_000) {
        lastPauseLog = t;
        engine.logBlocked("worker_claim", engine.check(head).blockingRules, head);
      }
      return true;
    }
    return false;
  };
}
