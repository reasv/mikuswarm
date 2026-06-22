import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import { classifyLlmError, extractStatus, type LlmErrorClass } from "./request-retry.js";

// =============================================================================
// Local LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5 / Design A).
//
// The deployment's LLM budget is scarce and SHARED (one LlmGateway account ≈ 4 rpm
// spanning every agent session type plus the image-gen tool), and the upstream
// gateway queue is FIFO and provider-blind. Local priority can only mean anything
// if the number of outstanding (sent-but-unfinished) requests stays small — a
// shallow upstream queue (§2). So the scheduler is a per-GROUP admission gate:
//
//   - A **rate-limit group** names one shared upstream budget. Groups are never
//     derived from the endpoint host (a gateway multiplexes several provider
//     hosts onto one rate-limited account); everything lands in `default` unless
//     a model block opts into another group via `rate_limit_group` (§9.2).
//   - **`max_in_flight` per group** is the single lever: small for a scarce
//     budget, high for a generous one. It is admission concurrency, NOT a
//     min-interval throttle — an idle budget is never slowed down (§5.1).
//   - A **priority queue per group**: `interactive` > `proactive` > `background`
//     > `background_low`, FIFO within a class (§5.2). Group attaches to the
//     model; priority attaches to the session type / workload (§9.1).
//   - **Priority inheritance** is the one and only escalation (§5.2/§5.5):
//     `escalate(key, class)` raises a queued entry in place, is a no-op on an
//     in-flight entry, and is STICKY for a not-yet-registered key so an entry
//     that registers later (a retry attempt, a just-claimed job) adopts the
//     pinned class.
//   - **429/503 backoff is unconditional** (§5.3): a throttle observed on any
//     group's request pauses that group's admissions with exponential backoff,
//     whether or not any limits are configured. This is a code invariant, not
//     config.
//
// The scheduler does NOT retry anything (Layer-1 retry composes OUTSIDE the
// admission wrapper so each attempt re-acquires a fresh slot — see
// `withSchedulerAdmission`) and does NOT pace requests on an idle budget.
// =============================================================================

/** Priority class of a request within its group (§5.2). */
export type PriorityClass = "interactive" | "proactive" | "background" | "background_low";

const CLASS_RANK: Record<PriorityClass, number> = {
  interactive: 3,
  proactive: 2,
  background: 1,
  background_low: 0,
};

function rankOf(priority: PriorityClass): number {
  return CLASS_RANK[priority] ?? 0;
}

function classOfRank(rank: number): PriorityClass {
  for (const [cls, r] of Object.entries(CLASS_RANK) as Array<[PriorityClass, number]>) {
    if (r === rank) return cls;
  }
  return "background_low";
}

/**
 * Built-in priority defaults per session type (§9.3). Used when the session
 * type config carries no explicit `priority`, so existing configs need no change.
 * Unknown/custom session types default to `interactive` — they are user-facing
 * until configured otherwise.
 */
export function defaultPriorityForSessionType(sessionType: string): PriorityClass {
  switch (sessionType) {
    case "summarize":
    case "condense":
      return "background";
    case "diary":
      return "background_low";
    case "proactive":
      return "proactive";
    default:
      return "interactive";
  }
}

export interface LlmGroupConfig {
  /**
   * Admission concurrency: outstanding (sent-but-unfinished) requests held by
   * the group. Small keeps the upstream queue shallow so local priority is
   * meaningful (§2); high suits a generous budget.
   */
  max_in_flight?: number;
  /** 429/503 backoff tuning. Backoff itself is unconditional (§5.3). */
  backoff_base_ms?: number;
  backoff_max_ms?: number;
}

export interface LlmSchedulerOptions {
  /** Declared groups (`[rate_limits.llm.*]`). `default` is created regardless. */
  groups?: Record<string, LlmGroupConfig>;
  /** Per-model health tuning (spec LLM-FAILURE-HANDLING §5; `[recovery]`). */
  health?: ModelHealthOptions;
  logger?: Logger;
}

export interface ModelHealthOptions {
  /** Consecutive environmental failures before a model turns unhealthy. `recovery.llm_unhealthy_threshold`. */
  unhealthyThreshold?: number;
  /**
   * Probe cadence while unhealthy — a per-episode CAPPED EXPONENTIAL BACKOFF
   * (spec MODEL-FALLBACK §4.1, superseding the old fixed `llm_probe_interval_ms`).
   * The first probe fires `probeBackoffBaseMs` after the model turns unhealthy
   * (aggressive — catch a transient blip and return to the better model fast);
   * each failed probe doubles the delay, capped at `probeBackoffMaxMs`; recovery
   * resets it to base. With a fallback, traffic flows to `Y` meanwhile, so there
   * is no liveness pressure — base is short and the cap bounds the long-outage
   * tail. `recovery.llm_probe_backoff_base_ms` / `recovery.llm_probe_backoff_max_ms`.
   */
  probeBackoffBaseMs?: number;
  probeBackoffMaxMs?: number;
}

export interface AcquireOptions {
  /** Rate-limit group (budget). Unset = `default` (§9.2). */
  group?: string;
  /** Priority class within the group. Unset = `background`. */
  priority?: PriorityClass;
  /**
   * Stable escalation key (§5.5). A queued entry registered under a key can be
   * raised in place by `escalate(key, class)`; a sticky escalation recorded
   * before registration is adopted at acquire time.
   */
  key?: string;
  /**
   * Model-health key (spec LLM-FAILURE-HANDLING §5): the request's failure
   * domain, derived from `(endpoint/baseUrl, model id)` via
   * {@link modelHealthKey}. Entries without a key are always model-admissible
   * (health gating off — legacy callers, tests).
   */
  modelKey?: string;
  /**
   * Per-model override of the unhealthy-probe backoff ceiling (spec
   * MODEL-FALLBACK §4.1; config `models.*.llm_probe_backoff_max_ms`). Recorded
   * against `modelKey` on sight (idempotent, last-writer-wins) so the model's
   * probe backoff caps tighter than the global `probeBackoffMaxMs` — useful for
   * a model with an especially poor fallback. No-op without a `modelKey`.
   */
  probeBackoffMaxMs?: number;
  /** Attribution for the console scheduler view (spec §9.1). */
  sessionId?: string;
  /** Session type, or a pool label for non-session callers (captioning, …). */
  sessionType?: string;
  /** Abort waiting for a slot (shutdown / run abort). */
  signal?: AbortSignal;
}

/**
 * Derive a model's health key — the FAILURE DOMAIN, distinct from the
 * rate-limit group (the budget axis). `(endpoint/baseUrl, model id)` as
 * carried by the `Model` object every stream call already receives, so agent
 * sessions, captioning clients, image-gen, and remote embedding all land in
 * the correct domain with zero config plumbing, and config entries pointing
 * at the same upstream model share one health state (§5).
 */
export function modelHealthKey(model: { baseUrl?: string; id: string }): string {
  return `${model.baseUrl ?? "unknown"}::${model.id}`;
}

/** Idempotent slot release. MUST be called (in a `finally`) when the request settles. */
export type ReleaseFn = () => void;

/** Shape of {@link LlmScheduler.snapshot} (spec LLM-FAILURE-HANDLING §9.1). */
export interface LlmSchedulerSnapshot {
  groups: Array<{
    name: string;
    maxInFlight: number;
    /** Throttle backoff, epoch ms; 0 = none. */
    backoffUntil: number;
    active: Array<{
      sessionId: string | null;
      sessionType: string | null;
      model: string | null;
      priority: PriorityClass;
      key: string | null;
      heldMs: number;
    }>;
    queue: Array<{
      sessionId: string | null;
      sessionType: string | null;
      model: string | null;
      priority: PriorityClass;
      key: string | null;
      waitingMs: number;
    }>;
    stickyEscalations: Array<{ key: string; priority: PriorityClass }>;
  }>;
  models: Array<{
    key: string;
    health: "healthy" | "unhealthy";
    consecutiveFailures: number;
    probeInFlight: boolean;
    /** Epoch ms of the next admissible probe; 0 when healthy/immediate. */
    nextProbeAt: number;
    lastFailure: { ts: number; status?: number; class: LlmErrorClass } | null;
    waiters: number;
  }>;
}

interface QueueEntry {
  rank: number;
  seq: number;
  key?: string;
  modelKey?: string;
  sessionId?: string;
  sessionType?: string;
  enqueuedAt: number;
  resolve: (release: ReleaseFn) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** An admitted (in-flight) request, tracked for the console snapshot (§9.1). */
interface ActiveEntry {
  rank: number;
  key?: string;
  modelKey?: string;
  sessionId?: string;
  sessionType?: string;
  admittedAt: number;
}

interface GroupState {
  name: string;
  maxInFlight: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  active: number;
  /** In-flight entries (console attribution); size always equals `active`. */
  activeEntries: Set<ActiveEntry>;
  queue: QueueEntry[];
  /** Epoch ms before which no new admission may happen. 0 = none. */
  backoffUntil: number;
  consecutiveThrottles: number;
  backoffTimer?: ReturnType<typeof setTimeout>;
  /** Re-pump when the earliest blocked model's probe window opens (§5.2). */
  probeTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Per-model health state (spec LLM-FAILURE-HANDLING §5.1). The model — not the
 * group — is the failure domain: one broken model must never gate healthy
 * models sharing its budget, and a gateway 429 says nothing about a model's
 * health.
 */
interface ModelHealthState {
  key: string;
  state: "healthy" | "unhealthy";
  /** Consecutive environmental failures (429s excluded — budget, not health). */
  consecutiveFailures: number;
  /** True while the single half-open probe request is in flight. */
  probeInFlight: boolean;
  /** Epoch ms before which no probe may be admitted. 0 = immediately. */
  nextProbeAt: number;
  /**
   * Current per-episode probe backoff delay (ms) — set to the base when the
   * model turns unhealthy, doubled (capped) on each failed probe, reset to base
   * on recovery (spec MODEL-FALLBACK §4.1). `nextProbeAt` is `settleTs + this`.
   */
  probeDelayMs: number;
  /** Epoch ms the model turned unhealthy (for recovery logging). 0 = healthy. */
  unhealthySince: number;
  lastFailure?: { ts: number; status?: number; class: LlmErrorClass };
}

const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_UNHEALTHY_THRESHOLD = 3;
// Capped-backoff probe cadence (spec MODEL-FALLBACK §4.1). Base is well under
// the old fixed 60s so a quick recovery is caught fast (work is on the fallback
// meanwhile); the cap bounds the long-outage tail.
const DEFAULT_PROBE_BACKOFF_BASE_MS = 10_000;
const DEFAULT_PROBE_BACKOFF_MAX_MS = 300_000;

function abortError(): Error {
  const error = new Error("LLM scheduler wait aborted");
  error.name = "AbortError";
  return error;
}

export class LlmScheduler {
  private readonly groups = new Map<string, GroupState>();
  /** Per-model health, independent of (alongside) the groups (§5). */
  private readonly health = new Map<string, ModelHealthState>();
  private readonly unhealthyThreshold: number;
  private readonly probeBackoffBaseMs: number;
  private readonly probeBackoffMaxMs: number;
  /**
   * Per-model probe-backoff-cap overrides (spec MODEL-FALLBACK §4.1), keyed by
   * model health key, recorded from `acquire`'s `probeBackoffMaxMs`. Kept apart
   * from the health map so an override survives even before/after a model has a
   * health entry and never pollutes the (failed-models-only) snapshot.
   */
  private readonly probeMaxOverrides = new Map<string, number>();
  private readonly logger?: Logger;
  /** Sticky escalations for keys not yet registered (§5.5). */
  private readonly stickyEscalations = new Map<string, PriorityClass>();
  private seqCounter = 0;
  private stopped = false;

  constructor(options: LlmSchedulerOptions = {}) {
    this.logger = options.logger;
    this.unhealthyThreshold = options.health?.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
    this.probeBackoffBaseMs = options.health?.probeBackoffBaseMs ?? DEFAULT_PROBE_BACKOFF_BASE_MS;
    this.probeBackoffMaxMs = options.health?.probeBackoffMaxMs ?? DEFAULT_PROBE_BACKOFF_MAX_MS;
    for (const [name, cfg] of Object.entries(options.groups ?? {})) {
      this.groups.set(name, this.makeGroup(name, cfg));
    }
    if (!this.groups.has("default")) {
      this.groups.set("default", this.makeGroup("default", {}));
    }
  }

  private makeGroup(name: string, cfg: LlmGroupConfig): GroupState {
    return {
      name,
      maxInFlight: cfg.max_in_flight ?? DEFAULT_MAX_IN_FLIGHT,
      backoffBaseMs: cfg.backoff_base_ms ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: cfg.backoff_max_ms ?? DEFAULT_BACKOFF_MAX_MS,
      active: 0,
      activeEntries: new Set(),
      queue: [],
      backoffUntil: 0,
      consecutiveThrottles: 0,
    };
  }

  /** True when the group name was declared (or is `default`). */
  hasGroup(name: string): boolean {
    return this.groups.has(name);
  }

  private getGroup(name: string): GroupState {
    const group = this.groups.get(name);
    if (group) return group;
    // Undeclared group names are rejected at config validation (§9.7); reaching
    // here means a programming error, but degrading to a private group is safer
    // than throwing from inside a stream function.
    this.logger?.warn("llm_scheduler_unknown_group", { group: name });
    const created = this.makeGroup(name, {});
    this.groups.set(name, created);
    return created;
  }

  /**
   * Acquire a slot in the request's group, waiting (by priority, FIFO within a
   * class) while the group is at `max_in_flight` or backing off. Resolves to an
   * idempotent release fn; rejects with `AbortError` if `signal` aborts first.
   */
  acquire(opts: AcquireOptions = {}): Promise<ReleaseFn> {
    const group = this.getGroup(opts.group ?? "default");
    // Record any per-model probe-backoff-cap override on sight (spec §4.1).
    if (opts.modelKey && opts.probeBackoffMaxMs !== undefined) {
      this.probeMaxOverrides.set(opts.modelKey, opts.probeBackoffMaxMs);
    }
    const requested = opts.priority ?? "background";
    // A sticky escalation recorded before this entry registered (§5.5) is
    // adopted now — the priority is the max of requested and pinned.
    const sticky = opts.key ? this.stickyEscalations.get(opts.key) : undefined;
    const rank = Math.max(rankOf(requested), sticky ? rankOf(sticky) : -1);

    return new Promise<ReleaseFn>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("LLM scheduler stopped"));
        return;
      }
      if (opts.signal?.aborted) {
        reject(abortError());
        return;
      }
      const entry: QueueEntry = {
        rank,
        seq: this.seqCounter++,
        key: opts.key,
        modelKey: opts.modelKey,
        sessionId: opts.sessionId,
        sessionType: opts.sessionType,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        signal: opts.signal,
      };
      if (opts.signal) {
        entry.onAbort = () => {
          const idx = group.queue.indexOf(entry);
          if (idx >= 0) {
            group.queue.splice(idx, 1);
            reject(abortError());
          }
        };
        opts.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      group.queue.push(entry);
      this.pump(group);
    });
  }

  /**
   * Priority inheritance (§5.2/§5.5): raise the class of the entry registered
   * under `key`. Queued → re-ranked in place; in-flight → no-op (already
   * running); not-yet-registered → sticky, adopted when the key registers.
   * Escalation only ever raises — a lower class never demotes.
   */
  escalate(key: string, priority: PriorityClass): void {
    const existing = this.stickyEscalations.get(key);
    if (!existing || rankOf(priority) > rankOf(existing)) {
      this.stickyEscalations.set(key, priority);
    }
    const rank = rankOf(this.stickyEscalations.get(key)!);
    for (const group of this.groups.values()) {
      let changed = false;
      for (const entry of group.queue) {
        if (entry.key === key && entry.rank < rank) {
          entry.rank = rank;
          changed = true;
        }
      }
      if (changed) {
        this.logger?.info("llm_scheduler_escalated", { key, priority, group: group.name });
        this.pump(group);
      }
    }
  }

  /**
   * Drop a sticky escalation once its subject reached a terminal state (the
   * summarization worker calls this when a job completes/fails), so the map
   * cannot grow unboundedly across the process lifetime.
   */
  clearEscalation(key: string): void {
    this.stickyEscalations.delete(key);
  }

  /**
   * Observe a request outcome for backoff purposes — the GROUP (budget) axis
   * only. A 429/503 (parsed from the flattened error message — pi-ai surfaces
   * SDK errors status-prefixed) pauses the group's admissions with exponential
   * backoff + jitter; any other outcome resets the group's throttle streak.
   * Unconditional (§5.3): always applied, independent of config. This is the
   * string-sniffing FALLBACK seam — the Anthropic provider is SDK-based and
   * throws on non-2xx before pi-ai's `onResponse` hook fires, so its 429s only
   * ever arrive here as flattened messages (no headers, so no `Retry-After`).
   * Callers that also hold the model key use {@link noteOutcome} so the
   * failure feeds the model-health axis too.
   */
  noteResult(groupName: string, errorMessage?: string): void {
    const status = errorMessage ? extractStatus(errorMessage.toLowerCase()) : undefined;
    this.noteStatus(groupName, status);
  }

  /**
   * Like {@link noteResult}, for callers that hold the HTTP status directly.
   * When the response carried a `Retry-After`/`retry-after-ms` (parsed via
   * {@link parseRetryAfterMs}), the server-specified wait replaces the
   * exponential window — clamped to the group's `backoff_max_ms` so a hostile
   * or absurd header can never black-hole the group beyond what config allows
   * the exponential path itself (§5.3). Group axis only.
   */
  noteStatus(groupName: string, status: number | undefined, retryAfterMs?: number): void {
    this.noteOutcome(groupName, undefined, status === undefined ? undefined : "environmental", status, retryAfterMs);
  }

  /**
   * Observe a settled request on BOTH axes (spec LLM-FAILURE-HANDLING §5):
   *
   * - **Group (budget):** a 429/503 status pauses the group's admissions
   *   (throttle backoff, `Retry-After` honoured, clamped) — unchanged shipped
   *   behaviour; any other outcome resets the throttle streak.
   * - **Model (failure domain), when `modelKey` is given:** a clean success
   *   (`classification === undefined`) resets the model's consecutive-failure
   *   streak and re-awakens an unhealthy model (the mass resume — all waiters
   *   become admissible, paced by group `max_in_flight`). An `environmental`
   *   failure feeds the streak — EXCEPT a plain 429, which is the shared
   *   budget talking, not evidence the model is unwell (503/529 feed both
   *   axes). At `llm_unhealthy_threshold` consecutive failures the model turns
   *   unhealthy: half-open admission, one probe per window where the window is a
   *   per-episode CAPPED EXPONENTIAL BACKOFF (`llm_probe_backoff_base_ms` →
   *   ×2-per-failed-probe → `llm_probe_backoff_max_ms`; spec MODEL-FALLBACK
   *   §4.1, superseding the old fixed `llm_probe_interval_ms`).
   *   `content`/`aborted` outcomes are neutral — neither count
   *   nor reset (one session's oversized context must not pause the model).
   */
  noteOutcome(
    groupName: string,
    modelKey: string | undefined,
    classification: LlmErrorClass | undefined,
    status?: number,
    retryAfterMs?: number,
  ): void {
    const group = this.getGroup(groupName);
    if (status === 429 || status === 503) {
      group.consecutiveThrottles += 1;
      let backoffMs: number;
      if (retryAfterMs !== undefined) {
        // Honour the server's requested wait (spec §5.3), clamped (see docstring).
        backoffMs = Math.min(retryAfterMs, group.backoffMaxMs);
      } else {
        const ceiling = Math.min(
          group.backoffMaxMs,
          group.backoffBaseMs * 2 ** (group.consecutiveThrottles - 1),
        );
        // Partial jitter with a floor of half the ceiling, mirroring the HTTP
        // limiter, so backoff never collapses to ~0.
        backoffMs = ceiling / 2 + Math.random() * (ceiling / 2);
      }
      group.backoffUntil = Math.max(group.backoffUntil, Date.now() + backoffMs);
      this.logger?.warn("llm_scheduler_backoff", {
        group: group.name,
        status,
        retryAfterMs,
        backoffMs: Math.round(backoffMs),
        consecutiveThrottles: group.consecutiveThrottles,
      });
      this.armBackoffTimer(group);
    } else {
      group.consecutiveThrottles = 0;
    }

    if (modelKey !== undefined) {
      this.noteModelOutcome(modelKey, classification, status);
    }
  }

  /** The model-health half of {@link noteOutcome}. */
  private noteModelOutcome(
    modelKey: string,
    classification: LlmErrorClass | undefined,
    status?: number,
  ): void {
    const now = Date.now();
    let health = this.health.get(modelKey);

    if (classification === undefined) {
      // Clean success: streak reset; an unhealthy model recovers — the probe
      // succeeded (or a pre-outage straggler came back clean, equally good
      // evidence). All of the model's waiters become admissible and drain in
      // priority order, paced by their groups' max_in_flight (the mass resume).
      if (!health) return;
      health.consecutiveFailures = 0;
      health.probeInFlight = false;
      if (health.state === "unhealthy") {
        const outageMs = health.unhealthySince > 0 ? now - health.unhealthySince : 0;
        health.state = "healthy";
        health.unhealthySince = 0;
        health.nextProbeAt = 0;
        this.logger?.info("llm_model_recovered", {
          model: modelKey,
          outageMs,
          waiters: this.countModelWaiters(modelKey),
        });
        for (const group of this.groups.values()) this.pump(group);
      }
      return;
    }

    if (classification === "content" || classification === "aborted") {
      // Neutral (§3): neither counts nor resets. If this settled the probe,
      // the probe was inconclusive — clear the in-flight flag; `nextProbeAt`
      // is left as-is (already elapsed), so the next pump re-probes promptly.
      if (health?.probeInFlight) health.probeInFlight = false;
      return;
    }

    // Environmental failure. A plain 429 feeds only the group's throttle
    // backoff — shared-budget pressure is not evidence the model is unwell —
    // but it still settles an in-flight probe inconclusively (next window). An
    // inconclusive settle reschedules at the CURRENT delay (no growth — a 429 is
    // not failed-probe evidence, §4.1).
    if (status === 429) {
      if (health?.probeInFlight) {
        health.probeInFlight = false;
        this.rescheduleProbe(health, now);
      }
      return;
    }

    if (!health) {
      health = {
        key: modelKey,
        state: "healthy",
        consecutiveFailures: 0,
        probeInFlight: false,
        nextProbeAt: 0,
        probeDelayMs: this.probeBackoffBaseMs,
        unhealthySince: 0,
      };
      this.health.set(modelKey, health);
    }
    health.consecutiveFailures += 1;
    health.lastFailure = { ts: now, status, class: classification };

    if (health.state === "healthy") {
      if (health.consecutiveFailures >= this.unhealthyThreshold) {
        health.state = "unhealthy";
        health.unhealthySince = now;
        health.probeInFlight = false;
        // First probe window: aggressive (the base), to catch a quick recovery.
        health.probeDelayMs = this.probeBackoffBaseMs;
        health.nextProbeAt = now + health.probeDelayMs;
        this.logger?.warn("llm_model_unhealthy", {
          model: modelKey,
          consecutiveFailures: health.consecutiveFailures,
          status,
          nextProbeAt: health.nextProbeAt,
          waiters: this.countModelWaiters(modelKey),
        });
      }
      return;
    }

    // Already unhealthy: this settles the probe (the half-open admission rule
    // means at most one in-flight request exists for the model, so the settling
    // failure IS the probe — a pre-outage straggler failing here merely
    // schedules the next window a little later, which is harmless). A FAILED
    // probe grows the delay (×2, capped) — a sustained outage rapidly stops
    // wasting calls (§4.1).
    health.probeInFlight = false;
    this.failProbe(health, now);
    this.logger?.warn("llm_model_probe", {
      model: modelKey,
      success: false,
      status,
      nextProbeAt: health.nextProbeAt,
      probeDelayMs: health.probeDelayMs,
      waiters: this.countModelWaiters(modelKey),
    });
  }

  /** Effective probe-backoff ceiling for a model (per-model override → global). */
  private effectiveProbeMax(modelKey: string): number {
    return this.probeMaxOverrides.get(modelKey) ?? this.probeBackoffMaxMs;
  }

  /**
   * Advance the probe window after a FAILED probe (spec §4.1): double the delay,
   * capped at the effective max, and schedule the next window from `now`.
   */
  private failProbe(health: ModelHealthState, now: number): void {
    health.probeDelayMs = Math.min(health.probeDelayMs * 2, this.effectiveProbeMax(health.key));
    health.nextProbeAt = now + health.probeDelayMs;
  }

  /**
   * Reschedule the probe window WITHOUT growing the delay, for an inconclusive
   * settle (a 429 absorbed the probe slot, or a stale-on-release safety net) —
   * not failed-probe evidence, so the backoff must not grow (§4.1).
   */
  private rescheduleProbe(health: ModelHealthState, now: number): void {
    health.nextProbeAt = now + health.probeDelayMs;
  }

  /**
   * Probe-settle safety net (#1): if a model's half-open probe is still marked
   * in-flight when its slot is released, settle it as an inconclusive
   * (neutral/environmental) probe outcome and re-arm the next probe window.
   * Called from `release()` for a slot admitted AS the probe, so a missing or
   * forgotten `noteOutcome` at any call site can never permanently gate the
   * model. Idempotent with {@link noteModelOutcome}: when the normal path
   * already cleared `probeInFlight`, this is a no-op (no double-settle).
   */
  private settleStaleProbe(modelKey: string): void {
    const health = this.health.get(modelKey);
    if (!health || health.state !== "unhealthy" || !health.probeInFlight) return;
    const now = Date.now();
    health.probeInFlight = false;
    // Inconclusive (no terminal outcome reached the streak) — reschedule at the
    // current delay without growing it (§4.1).
    this.rescheduleProbe(health, now);
    this.logger?.warn("llm_model_probe", {
      model: modelKey,
      success: false,
      phase: "settled_on_release",
      nextProbeAt: health.nextProbeAt,
      waiters: this.countModelWaiters(modelKey),
    });
  }

  /**
   * Read-only health state of a model (spec MODEL-FALLBACK §3): the per-attempt
   * fallback resolver consults this to skip an unhealthy chain head. Untracked
   * (never failed) models are `healthy`. No mutation — the resolver only reads.
   */
  modelHealth(modelKey: string): "healthy" | "unhealthy" {
    return this.health.get(modelKey)?.state ?? "healthy";
  }

  /**
   * Read-only: is this model's half-open probe window open right now (spec
   * MODEL-FALLBACK §3/§4)? True iff unhealthy, no probe in flight, and the
   * backoff window has elapsed — the resolver routes the next attempt to the
   * head AS the canary when this holds. Reads the same `probeInFlight` /
   * `nextProbeAt` gate the pump uses, so resolver and pump agree.
   */
  isProbeDue(modelKey: string): boolean {
    const health = this.health.get(modelKey);
    return (
      !!health &&
      health.state === "unhealthy" &&
      !health.probeInFlight &&
      Date.now() >= health.nextProbeAt
    );
  }

  /**
   * True when waiting in the admission queue is the effective wait point for
   * this (group, model): the group is in throttle backoff or the model is
   * unhealthy. Layer-0 collapses its local inter-attempt backoff to ~0 then —
   * the queue already paces re-admission, and sleeping locally on top would
   * double-wait (spec §4.3).
   */
  isQueueWaitPoint(groupName: string, modelKey?: string): boolean {
    const group = this.groups.get(groupName);
    if (group && group.backoffUntil > Date.now()) return true;
    if (modelKey) {
      const health = this.health.get(modelKey);
      if (health && health.state === "unhealthy") return true;
    }
    return false;
  }

  /** Count queued entries (across groups) waiting on the given model. */
  private countModelWaiters(modelKey: string): number {
    let count = 0;
    for (const group of this.groups.values()) {
      for (const entry of group.queue) {
        if (entry.modelKey === modelKey) count += 1;
      }
    }
    return count;
  }

  /**
   * Point-in-time snapshot for the console scheduler view (spec
   * LLM-FAILURE-HANDLING §9.1): per-group budget state (active/queued entries
   * with attribution, throttle backoff, sticky escalations) beside per-model
   * health (streak, probe state, waiter counts). Read-only; safe to call from
   * the console request path.
   */
  snapshot(): LlmSchedulerSnapshot {
    const now = Date.now();
    return {
      groups: [...this.groups.values()].map((group) => {
        // `stickyEscalations` is one scheduler-wide map (a key registers in
        // exactly one group at a time), so emitting the whole map under every
        // group would misattribute every escalation to every group card
        // (#10). Restrict it to the keys with an active or queued entry in
        // THIS group — the wire shape (per-group array) is unchanged, so the
        // console schema needs no migration.
        const groupKeys = new Set<string>();
        for (const entry of group.activeEntries) if (entry.key) groupKeys.add(entry.key);
        for (const entry of group.queue) if (entry.key) groupKeys.add(entry.key);
        return {
          name: group.name,
          maxInFlight: group.maxInFlight,
          backoffUntil: group.backoffUntil > now ? group.backoffUntil : 0,
          active: [...group.activeEntries].map((entry) => ({
            sessionId: entry.sessionId ?? null,
            sessionType: entry.sessionType ?? null,
            model: entry.modelKey ?? null,
            priority: classOfRank(entry.rank),
            key: entry.key ?? null,
            heldMs: now - entry.admittedAt,
          })),
          queue: [...group.queue]
            .sort((a, b) => (b.rank - a.rank) || (a.seq - b.seq))
            .map((entry) => ({
              sessionId: entry.sessionId ?? null,
              sessionType: entry.sessionType ?? null,
              model: entry.modelKey ?? null,
              priority: classOfRank(entry.rank),
              key: entry.key ?? null,
              waitingMs: now - entry.enqueuedAt,
            })),
          stickyEscalations: [...this.stickyEscalations.entries()]
            .filter(([key]) => groupKeys.has(key))
            .map(([key, priority]) => ({
              key,
              priority,
            })),
        };
      }),
      models: [...this.health.values()].map((health) => ({
        key: health.key,
        health: health.state,
        consecutiveFailures: health.consecutiveFailures,
        probeInFlight: health.probeInFlight,
        nextProbeAt: health.state === "unhealthy" ? health.nextProbeAt : 0,
        lastFailure: health.lastFailure ?? null,
        waiters: this.countModelWaiters(health.key),
      })),
    };
  }

  /** Reject all queued waiters (shutdown). In-flight requests are unaffected. */
  stop(): void {
    this.stopped = true;
    for (const group of this.groups.values()) {
      if (group.backoffTimer) clearTimeout(group.backoffTimer);
      if (group.probeTimer) clearTimeout(group.probeTimer);
      const queued = group.queue.splice(0);
      for (const entry of queued) {
        entry.signal?.removeEventListener("abort", entry.onAbort!);
        entry.reject(new Error("LLM scheduler stopped"));
      }
    }
  }

  /** Re-pump a group when its backoff window expires. */
  private armBackoffTimer(group: GroupState): void {
    if (group.backoffTimer) clearTimeout(group.backoffTimer);
    const waitMs = Math.max(0, group.backoffUntil - Date.now());
    group.backoffTimer = setTimeout(() => {
      group.backoffTimer = undefined;
      this.pump(group);
    }, waitMs + 1);
    // Never hold the process open just for a pending pump.
    group.backoffTimer.unref?.();
  }

  /**
   * True when an entry's model permits admission right now (§5.2): healthy (or
   * untracked / no key), or unhealthy with no probe in flight and an elapsed
   * probe window — in which case the admission IS the probe.
   */
  private modelAdmissible(modelKey: string | undefined, now: number): boolean {
    if (!modelKey) return true;
    const health = this.health.get(modelKey);
    if (!health || health.state === "healthy") return true;
    return !health.probeInFlight && now >= health.nextProbeAt;
  }

  /** Admit queued entries while capacity allows and no backoff is active. */
  private pump(group: GroupState): void {
    for (;;) {
      if (group.queue.length === 0) return;
      if (group.active >= group.maxInFlight) return;
      const now = Date.now();
      if (group.backoffUntil > now) {
        this.armBackoffTimer(group);
        return;
      }
      // Per-entry admissibility selection (§5.2): highest rank wins, FIFO
      // (lowest seq) within a rank — among ADMISSIBLE entries only. An
      // unhealthy model's waiters are skipped over, not waited behind, so they
      // never head-of-line-block healthy models sharing the group. Queues are
      // tiny (a handful of pending requests), so a linear scan is the simplest
      // correct structure.
      let best = -1;
      for (let i = 0; i < group.queue.length; i++) {
        const candidate = group.queue[i]!;
        if (!this.modelAdmissible(candidate.modelKey, now)) continue;
        if (best === -1) {
          best = i;
          continue;
        }
        const current = group.queue[best]!;
        if (candidate.rank > current.rank || (candidate.rank === current.rank && candidate.seq < current.seq)) {
          best = i;
        }
      }
      if (best === -1) {
        // Every queued entry is gated behind an unhealthy model's probe
        // window. Arm a timer for the earliest window so the pump re-runs
        // exactly when the next probe becomes admissible.
        this.armProbeTimer(group, now);
        return;
      }
      const entry = group.queue.splice(best, 1)[0]!;
      entry.signal?.removeEventListener("abort", entry.onAbort!);
      // Admitting a waiter of an UNHEALTHY model makes this request the probe
      // (§5.1): the highest-priority waiter for the model, at most one in
      // flight, regardless of its class (a background waiter probes when no
      // interactive one is queued — open question resolved as proposed).
      let admittedAsProbe = false;
      if (entry.modelKey) {
        const health = this.health.get(entry.modelKey);
        if (health && health.state === "unhealthy") {
          health.probeInFlight = true;
          admittedAsProbe = true;
          this.logger?.info("llm_model_probe", {
            model: entry.modelKey,
            success: undefined,
            phase: "launched",
            waiters: this.countModelWaiters(entry.modelKey),
          });
        }
      }
      group.active += 1;
      const activeEntry: ActiveEntry = {
        rank: entry.rank,
        key: entry.key,
        modelKey: entry.modelKey,
        sessionId: entry.sessionId,
        sessionType: entry.sessionType,
        admittedAt: now,
      };
      group.activeEntries.add(activeEntry);
      let released = false;
      const release: ReleaseFn = () => {
        if (released) return;
        released = true;
        group.active = Math.max(0, group.active - 1);
        group.activeEntries.delete(activeEntry);
        // Probe-settle safety net (#1): a slot admitted AS the half-open probe
        // must ALWAYS settle that probe when released, even if no `noteOutcome`
        // ever ran for it (a forgotten/missing call site, an empty-ending
        // stream that bypassed counting). Without this, `probeInFlight` stays
        // set and `modelAdmissible` rejects every waiter for the model until
        // restart. This is idempotent with the normal path: if `noteOutcome`
        // already settled the probe, `probeInFlight` is already false and this
        // is a no-op — no double-settle.
        if (admittedAsProbe && entry.modelKey) {
          this.settleStaleProbe(entry.modelKey);
        }
        this.pump(group);
      };
      entry.resolve(release);
    }
  }

  /** Re-pump when the earliest blocked probe window opens (§5.2). */
  private armProbeTimer(group: GroupState, now: number): void {
    let earliest = Infinity;
    for (const entry of group.queue) {
      if (!entry.modelKey) continue;
      const health = this.health.get(entry.modelKey);
      if (!health || health.state !== "unhealthy" || health.probeInFlight) continue;
      earliest = Math.min(earliest, health.nextProbeAt);
    }
    if (!Number.isFinite(earliest)) return; // blocked on in-flight probes → their settle pumps
    if (group.probeTimer) clearTimeout(group.probeTimer);
    group.probeTimer = setTimeout(() => {
      group.probeTimer = undefined;
      this.pump(group);
    }, Math.max(0, earliest - now) + 1);
    group.probeTimer.unref?.();
  }
}

export interface AdmissionOptions {
  group: string;
  priority: PriorityClass;
  /** Escalation key registered for the whole wait (§5.5). */
  key?: string;
  /** Per-model probe-backoff-cap override (spec MODEL-FALLBACK §4.1). */
  probeBackoffMaxMs?: number;
  /** Attribution for the console scheduler view (spec §9.1). */
  sessionId?: string;
  sessionType?: string;
  /**
   * Called with the admission-queue wait of each attempt (ms), right after a
   * slot is acquired. The factory uses it to stamp `admissionWaitMs` onto the
   * request ring entry (spec §9.2) — the one number llm-gateway cannot see.
   */
  onAdmissionWait?: (waitMs: number) => void;
}

/**
 * Parse a `Retry-After`/`retry-after-ms` header pair into milliseconds.
 * Accepts either a `Headers`-like object (`.get(name)`) or a plain lowercased
 * record (the shape pi-ai's `onResponse` hook delivers). `retry-after-ms`
 * (non-standard, milliseconds) wins over `retry-after` (delta-seconds or an
 * HTTP-date). Returns `undefined` when neither header parses.
 */
export function parseRetryAfterMs(
  headers: Record<string, string> | { get(name: string): string | null } | undefined,
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === "function") {
      return (headers as { get(name: string): string | null }).get(name) ?? undefined;
    }
    return (headers as Record<string, string>)[name];
  };
  const ms = get("retry-after-ms");
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = get("retry-after");
  if (ra !== undefined) {
    const seconds = Number(ra);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

/**
 * Wrap a {@link StreamFn} with scheduler admission: acquire a slot in the
 * request's group before invoking the base fn, release when the stream settles,
 * and report the outcome for the group's unconditional 429/503 backoff (§5.3).
 *
 * Composition order is load-bearing (§5.4): admission wraps the BASE fn,
 * *inside* `withRequestRetry` — `withRequestRetry(withSchedulerAdmission(base))`
 * — so each Layer-1 retry attempt re-acquires a fresh slot at the same
 * `(group, priority)` and no slot is held across backoff sleeps (which would
 * defeat the shallow-queue invariant of §2).
 *
 * Backoff feeding is two-tier. The wrapper injects a pi-ai `onResponse` hook so
 * a throttle response observed at the HTTP layer reports its PRECISE status and
 * `Retry-After` to the group (fetch-based providers surface error statuses
 * there). The terminal-`error`-event path stays as the fallback for providers
 * whose SDK throws before the hook fires (Anthropic), where only the flattened,
 * status-prefixed message survives — string-sniffed by `noteResult`, with no
 * `Retry-After` available. A throttle already counted via the hook is NOT
 * counted again when its terminal error event arrives.
 */
export function withSchedulerAdmission(
  base: StreamFn,
  scheduler: LlmScheduler,
  options: AdmissionOptions,
): StreamFn {
  return (model, context, streamOptions) => {
    const outer = createAssistantMessageEventStream();
    const opts = streamOptions as SimpleStreamOptions | undefined;
    const signal = opts?.signal;

    // The failure domain (§5): derived from the Model object in hand at call
    // time — zero config plumbing, and every Layer-0 retry attempt re-enters
    // admission under the same key (this is what makes N waiting sessions
    // produce one probe during an outage instead of N retry loops).
    const modelKey = modelHealthKey(model);

    void (async () => {
      let release: ReleaseFn;
      const acquireStart = Date.now();
      try {
        release = await scheduler.acquire({
          group: options.group,
          priority: options.priority,
          key: options.key,
          modelKey,
          probeBackoffMaxMs: options.probeBackoffMaxMs,
          sessionId: options.sessionId,
          sessionType: options.sessionType,
          signal,
        });
        try {
          options.onAdmissionWait?.(Date.now() - acquireStart);
        } catch {
          /* observe-only */
        }
      } catch (err) {
        // Admission failed without any request being issued. An aborted wait
        // (run abort / drain) synthesizes `stopReason:"aborted"` and a scheduler
        // stop a "scheduler stopped" message — both classified FATAL by Layer-1
        // (`classifyLlmError`), so shutdown never burns futile backed-off
        // re-acquire cycles on a gate that can only reject (#11). These
        // synthesized errors COUNT as LLM-request-layer errors for Layer-2
        // classification (Decision C / #14): admission composes INSIDE
        // `withRequestRetry`, so they flow through it and receive the
        // `LLM_REQUEST_FAILURE_MARKER` tag there — no tagging needed here.
        const aborted = err instanceof Error && err.name === "AbortError";
        outer.push(
          synthesizeErrorEvent(
            model,
            err instanceof Error ? err.message : String(err),
            aborted ? "aborted" : "error",
          ),
        );
        return;
      }
      // Precise throttle observation (§5.3): pi-ai invokes `onResponse` with the
      // HTTP status + lowercased headers before consuming the body, so a 429/503
      // reaching it feeds the group backoff with the real status AND the
      // server's `Retry-After` — no string sniffing. Chained in front of any
      // caller-provided hook.
      let throttleNoted = false;
      const prevOnResponse = opts?.onResponse;
      const innerOptions: SimpleStreamOptions = {
        ...opts,
        onResponse: (response, responseModel) => {
          if (response.status === 429 || response.status === 503) {
            throttleNoted = true;
            // Both axes (§5): 503 feeds the model streak too; a plain 429 is
            // excluded from the streak inside noteOutcome (budget, not health).
            scheduler.noteOutcome(
              options.group,
              modelKey,
              "environmental",
              response.status,
              parseRetryAfterMs(response.headers),
            );
          }
          return prevOnResponse?.(response, responseModel);
        },
      };
      try {
        const inner = await base(model, context, innerOptions);
        let sawTerminal = false;
        for await (const event of inner) {
          if (event.type === "error") {
            sawTerminal = true;
            // Skip the fallback when the hook already counted this request's
            // throttle — double-counting would inflate the exponential streak
            // (and the model streak alike).
            if (!throttleNoted) {
              const failure = event.error;
              const message = failure?.errorMessage;
              scheduler.noteOutcome(
                options.group,
                modelKey,
                classifyLlmError(message, failure?.stopReason),
                message ? extractStatus(message.toLowerCase()) : undefined,
              );
            }
          } else if (event.type === "done") {
            sawTerminal = true;
            scheduler.noteOutcome(options.group, modelKey, undefined);
          }
          outer.push(event);
        }
        if (!sawTerminal) {
          // The base stream ENDED without forwarding a terminal `done`/`error`
          // event (an "empty stream", classified environmental §3). pi-ai's
          // EventStream only terminates on a terminal push or `end()`, so
          // without a synthesized terminal here `outer` never finalizes and the
          // consumer (the retry wrapper, the runner) blocks forever — and if
          // this admission was the half-open probe, `noteOutcome` was never
          // called, so `probeInFlight` stays set and `modelAdmissible` would
          // reject every waiter for the model until restart (#1). Feed the
          // environmental streak (settling the probe) AND push a terminal error
          // so `outer` finalizes and the retry wrapper's environmental path
          // takes over.
          if (!throttleNoted) {
            scheduler.noteOutcome(options.group, modelKey, "environmental");
          }
          outer.push(synthesizeErrorEvent(model, "stream ended without a terminal event"));
        }
      } catch (err) {
        // The base fn itself threw (not via a terminal `error` event). Surface a
        // terminal error so the consumer always sees one, and count it for backoff.
        // A thrown AbortError (or a request that aborts via the caller's signal)
        // is intentional teardown, NOT an environmental failure: mirror the retry
        // wrapper (request-retry.ts) — synthesize `stopReason:"aborted"` and pass
        // a NEUTRAL outcome to `noteOutcome` so it neither feeds the model streak
        // nor triggers a futile re-admission (#8). Defensive: pi-ai providers emit
        // `aborted` internally today, so this catch rarely sees a raw AbortError.
        const message = err instanceof Error ? err.message : String(err);
        const aborted = (err instanceof Error && err.name === "AbortError") || signal?.aborted === true;
        if (!throttleNoted) {
          scheduler.noteOutcome(
            options.group,
            modelKey,
            aborted ? "aborted" : classifyLlmError(message, undefined),
            aborted ? undefined : extractStatus(message.toLowerCase()),
          );
        }
        outer.push(synthesizeErrorEvent(model, message, aborted ? "aborted" : "error"));
      } finally {
        release();
      }
    })();

    return outer;
  };
}

/** Build a terminal `error` event mirroring the shape pi-ai providers emit. */
function synthesizeErrorEvent(
  model: Parameters<StreamFn>[0],
  message: string,
  stopReason: "error" | "aborted" = "error",
): Extract<AssistantMessageEvent, { type: "error" }> {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider ?? "unknown",
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
  return { type: "error", reason: stopReason, error };
}
