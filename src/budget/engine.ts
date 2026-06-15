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
  modelId: string;
  provider?: string;
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
}

export interface BudgetEngineOptions {
  rules: LimitRule[];
  /** Σ `cost_usd` of the ledger rows matching a selector within a window. */
  sumUsageCost: (filter: {
    since: number;
    until?: number;
    classes?: string[];
    sessionTypes?: string[];
    tools?: string[];
    models?: string[];
  }) => number;
  /** Model ids whose configured cost rate is zero (§2.2). */
  zeroCostModelIds: Set<string>;
  /**
   * Structural dependency cascade (§2.1): session type → prerequisite session
   * types that must be available for it to be admitted.
   */
  dependencies: Record<string, string[]>;
  /** Resolve a session type's model id (for dependency descriptors). */
  resolveModelId: (sessionType: string) => string | undefined;
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
    this.nearThreshold = options.nearThreshold ?? 0.8;
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
   * Reconcile every rule's window + total. Calendar rules reseed only when their
   * boundary has passed; rolling rules recompute every tick from the ledger
   * (cheap via `idx_usage_events_ts`) to shed aged-out spend (§6.1).
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

  private selectorMatches(rule: LimitRule, d: SpendDescriptor): boolean {
    const s = rule.selector;
    if (s.classes && !s.classes.includes(d.class)) return false;
    if (s.sessionTypes && (d.sessionType === undefined || !s.sessionTypes.includes(d.sessionType)))
      return false;
    if (s.tools && (d.tool === undefined || !s.tools.includes(d.tool))) return false;
    if (s.models && !s.models.includes(d.modelId)) return false;
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
    if (this.isZeroCost(descriptor.modelId)) {
      return { allowed: true, blockingRules: [] };
    }
    const blocking: BlockingRule[] = [];
    for (const state of this.states) {
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
    return this.check({ class: "agent_loop", sessionType, modelId }).allowed;
  }

  /** Is the named model currently within budget (hook for deferred fallback, §6.2)? */
  isModelAvailable(modelId: string): boolean {
    if (this.isZeroCost(modelId)) return true;
    for (const state of this.states) {
      const s = state.rule.selector;
      if (s.models && s.models.includes(modelId) && state.spent >= state.rule.maxUsd) return false;
    }
    return true;
  }

  /**
   * Session-admission check combining the session's own covering rules with the
   * structural dependency cascade (§2.1): a dependent session also requires every
   * class it depends on to be available. Used at the triggered/proactive gates.
   */
  checkAdmission(sessionType: string, modelId: string): AdmissionResult {
    const own = this.check({ class: "agent_loop", sessionType, modelId });
    if (!own.allowed) {
      return { allowed: false, ownBlocking: own.blockingRules, primary: own.primary };
    }
    const deps = this.options.dependencies[sessionType] ?? [];
    for (const dep of deps) {
      const depModel = this.options.resolveModelId(dep);
      if (depModel === undefined) continue;
      const depCheck = this.check({ class: "agent_loop", sessionType: dep, modelId: depModel });
      if (!depCheck.allowed) {
        return {
          allowed: false,
          ownBlocking: [],
          dependency: { sessionType: dep, blocking: depCheck.blockingRules },
          primary: depCheck.primary,
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
    if (event.costUsd <= 0) return;
    const descriptor: SpendDescriptor = {
      class: event.class,
      sessionType: event.sessionType ?? undefined,
      tool: event.toolName ?? undefined,
      modelId: event.modelId,
      provider: event.provider ?? undefined,
    };
    const now = this.now();
    for (const state of this.states) {
      // Lazily roll a calendar window whose boundary passed since the last tick,
      // so a spend that lands just after midnight doesn't accrue to yesterday.
      if (state.rule.window.type === "calendar" && now >= state.resetsAt) {
        const w = resolveWindow(state.rule.window, now);
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.sumRule(state.rule, w.start);
      }
      if (this.selectorMatches(state.rule, descriptor)) state.spent += event.costUsd;
    }
  }

  /** One status entry per configured rule (never filtered) for the console (§6.2). */
  ruleStatuses(): RuleStatus[] {
    return this.states.map((state) => {
      const cap = state.rule.maxUsd;
      const fraction = cap > 0 ? state.spent / cap : state.spent > 0 ? Infinity : 1;
      const blocked = state.spent >= cap;
      const near = !blocked && fraction >= this.nearThreshold;
      const w = state.rule.window;
      const window =
        w.type === "rolling"
          ? ({ type: "rolling", duration: w.duration } as const)
          : ({ type: "calendar", period: w.period, tz: w.tz } as const);
      return {
        name: state.rule.name,
        spentUsd: state.spent,
        capUsd: cap,
        fraction: Number.isFinite(fraction) ? fraction : 1,
        state: blocked ? "blocked" : near ? "near" : "ok",
        window,
        resetsAt: state.resetsAt,
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
