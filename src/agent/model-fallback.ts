import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import {
  modelHealthKey,
  withSchedulerAdmission,
  type LlmScheduler,
  type PriorityClass,
} from "./scheduler.js";

// =============================================================================
// Transparent model fallback (spec MODEL-FALLBACK).
//
// A logical model `X` with a fallback chain `[X, Y, Z]` is a COMPOSITE model:
// a request to `X` is served by the first chain member that is up, and the
// caller never sees that `X` was unavailable. Fallback lives BELOW the
// failure-handling layer — resolution runs per Layer-0 attempt, inside the
// composed `streamFn` — so each attempt re-resolves the model, and the §8
// per-class wall-clock budgets now bound the COMPOSITE (§1).
//
// This module is the one shared helper (spec §3/§6): build time does only what
// must be fixed once (capability pre-filter, min-over-chain context ceiling,
// per-candidate dispatch pipelines), and the returned `streamFn` chooses one
// member per attempt. It builds NO new circuit breaker — it consumes §8a's
// per-model health (the breaker) via the two read-only methods `modelHealth` /
// `isProbeDue` and adds model SELECTION in front of it plus the canary policy.
// =============================================================================

type ModelConfig = AppConfig["models"]["default"];

/** One member of a resolved fallback chain (head first). */
export interface ModelChainEntry {
  /** Config block name — the LOGICAL id (budget scoping, ledger key, console). */
  logicalId: string;
  config: ModelConfig;
}

/** Why an attempt resolved to the member it did (observability, spec §8). */
export type FallbackReason =
  | "primary"
  | "budget-fallback"
  | "health-fallback"
  | "canary"
  | "all-unhealthy";

export interface BuildModelFallbackOptions {
  /** Consumer label for the `model_fallback_resolved` log (spec §8). */
  consumer: string;
  /** Build the base StreamFn for a member (streamSimple / wrapCompleteAsStream + SDK retries off). */
  makeBase: (config: ModelConfig) => StreamFn;
  /** Build the pi-ai Model descriptor for a member at the given operative context window. */
  makeModel: (config: ModelConfig, contextWindow: number) => Model<Api>;
  /**
   * Capability pre-filter (spec §3 build-time #1): drop members that cannot
   * serve the request's FIXED needs (image blocks → `input_modalities` includes
   * "image"; caption lane → includes its modality; …). The head is never dropped
   * — if the head fails capability the
   * whole composite is unusable and the caller's normal "model can't serve"
   * path applies. Returns true when the member can serve.
   */
  capability?: (config: ModelConfig) => boolean;
  /**
   * Per-session context override (`session_type.max_context_tokens`) min'd with
   * the min-over-chain `context_window` to form the operative ceiling (§3 #2).
   */
  contextOverride?: number;
  /** §8a scheduler — consumed for health reads + per-candidate admission. Absent = no scheduling. */
  scheduler?: LlmScheduler;
  /** Per-candidate admission parameters (group resolved per member from `rate_limit_group`). */
  admission?: {
    priority: PriorityClass;
    key?: string;
    sessionId?: string;
    sessionType?: string;
    onAdmissionWait?: (waitMs: number) => void;
  };
  /**
   * Budget availability by LOGICAL id (spec §3/§7): a member is skipped when its
   * covering period rule is at cap. Checked per attempt so a mid-session window
   * reset is picked up. Absent = no period budgeting.
   */
  isModelAvailable?: (logicalId: string) => boolean;
  logger?: Logger;
  /** Attribution echoed in the resolution log. */
  sessionId?: string;
  /**
   * Rate-limit gate for the resolution log (high-frequency consumers —
   * captioning/embedding). Returns true when a line may be emitted; absent =
   * always log.
   */
  rateLimitLog?: () => boolean;
  /**
   * Invoked at the start of every attempt with the LOGICAL id chosen for it
   * (spec §6.1). The agent path uses it to attribute the per-request ledger row
   * to the member actually about to be billed — exact even when `X` fell to `Y`.
   */
  onResolve?: (logicalId: string, reason: FallbackReason) => void;
}

export interface BuiltModelFallback {
  /** The per-attempt-resolving stream fn (wrap with `withRequestRetry`). */
  streamFn: StreamFn;
  /** Operative context ceiling valid for WHICHEVER member serves (min-over-chain, §3 #2). */
  operativeContextWindow: number;
  /** Head logical id (placeholder/ledger seed; the per-attempt billed id is exact). */
  headLogicalId: string;
  /** Surviving members' logical ids, head-first — for the chain-availability budget gate (§6.1). */
  survivorLogicalIds: string[];
}

interface Candidate {
  logicalId: string;
  model: Model<Api>;
  apiKey: string;
  healthKey: string;
  supportsThinking: boolean;
  dispatch: StreamFn;
}

/**
 * Build a composite fallback stream fn from a chain (head first). The chain is
 * exactly the one written on the head (spec §9, no deep-chain auto-splice); the
 * head is the implicit first member. A single-member chain returns the head's
 * dispatch directly (no health reads, no resolution log).
 */
export function buildModelFallback(
  chain: ModelChainEntry[],
  options: BuildModelFallbackOptions,
): BuiltModelFallback {
  if (chain.length === 0) throw new Error("buildModelFallback: empty chain");
  const head = chain[0]!;

  // Capability pre-filter (§3 #1) — never drops the head.
  const survivors = chain.filter(
    (entry, i) => i === 0 || !options.capability || options.capability(entry.config),
  );

  // Min-over-chain context ceiling (§3 #2): one conservative value valid for
  // whichever member serves a given attempt.
  let minWindow = Infinity;
  for (const entry of survivors) {
    const w = entry.config.context_window;
    if (typeof w === "number") minWindow = Math.min(minWindow, w);
  }
  // No member declares a context_window → a clear error rather than a silent 0
  // ceiling (which would later mis-judge every request as over the limit). This
  // mirrors the agent path's `resolveSessionContextCeiling` / `createModelFromConfig`
  // throw; app-wiring validation requires the window for session-resolved models,
  // so this is a defensive backstop never reached in normal operation.
  if (!Number.isFinite(minWindow)) {
    throw new Error(
      `buildModelFallback: no chain member declares a context_window ` +
        `(head "${head.logicalId}"); it is required to resolve the operative ceiling`,
    );
  }
  const operativeContextWindow =
    options.contextOverride !== undefined
      ? Math.min(minWindow, options.contextOverride)
      : minWindow;

  // Per-candidate dispatch pipelines (§3 #3).
  const candidates: Candidate[] = survivors.map((entry) => {
    const model = options.makeModel(entry.config, operativeContextWindow);
    const base = options.makeBase(entry.config);
    const group = entry.config.rate_limit_group ?? "default";
    const dispatch: StreamFn =
      options.scheduler && options.admission
        ? withSchedulerAdmission(base, options.scheduler, {
            group,
            priority: options.admission.priority,
            key: options.admission.key,
            probeBackoffMaxMs: entry.config.llm_probe_backoff_max_ms,
            sessionId: options.admission.sessionId,
            sessionType: options.admission.sessionType,
            onAdmissionWait: options.admission.onAdmissionWait,
          })
        : base;
    return {
      logicalId: entry.logicalId,
      model,
      apiKey: entry.config.api_key,
      healthKey: modelHealthKey(model),
      supportsThinking: entry.config.reasoning ?? true,
      dispatch,
    };
  });

  const survivorLogicalIds = candidates.map((c) => c.logicalId);

  // Single-member chain → no fallback machinery; dispatch the head directly.
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      streamFn: (model, context, streamOptions) => {
        options.onResolve?.(only.logicalId, "primary");
        return only.dispatch(only.model, context, adjustOptions(streamOptions, only));
      },
      operativeContextWindow,
      headLogicalId: head.logicalId,
      survivorLogicalIds,
    };
  }

  let warnedThinking = false;

  const streamFn: StreamFn = (model, context, streamOptions) => {
    const { index, reason } = chooseChainMember(candidates, {
      scheduler: options.scheduler,
      isModelAvailable: options.isModelAvailable,
    });
    const candidate = candidates[index]!;
    options.onResolve?.(candidate.logicalId, reason);
    if (reason !== "primary" && (!options.rateLimitLog || options.rateLimitLog())) {
      options.logger?.info("model_fallback_resolved", {
        consumer: options.consumer,
        sessionId: options.sessionId,
        chain: survivorLogicalIds,
        chosen: candidate.logicalId,
        reason,
      });
    }
    return candidate.dispatch(candidate.model, context, adjustOptions(streamOptions, candidate));
  };

  /**
   * Substitute the chosen member's API key, and degrade thinking to off when the
   * member lacks the `reasoning` capability (spec §3 #1 — thinking is NOT a
   * capability FILTER; a member without it warns and runs without thinking
   * rather than being dropped).
   */
  function adjustOptions(
    streamOptions: Parameters<StreamFn>[2],
    candidate: Candidate,
  ): Parameters<StreamFn>[2] {
    const opts = (streamOptions ?? {}) as SimpleStreamOptions;
    const next: SimpleStreamOptions = { ...opts, apiKey: candidate.apiKey };
    if (!candidate.supportsThinking && (next as { reasoning?: unknown }).reasoning) {
      (next as { reasoning?: unknown }).reasoning = undefined;
      if (!warnedThinking) {
        warnedThinking = true;
        options.logger?.warn("model_fallback_thinking_degraded", {
          consumer: options.consumer,
          model: candidate.logicalId,
        });
      }
    }
    return next as Parameters<StreamFn>[2];
  }

  return { streamFn, operativeContextWindow, headLogicalId: head.logicalId, survivorLogicalIds };
}

/**
 * Resolve a model's effective fallback chain from the config registry (spec
 * §2.1/§9): the head plus the logical ids named in its `fallback`, each looked
 * up in `[models.*]`. The chain is exactly the head's list — a member's OWN
 * `fallback` does not extend it. Unknown names throw (fail-fast at wiring); a
 * model with no `fallback` yields a single-member chain. Duplicates (incl. the
 * head re-listed) are dropped, preserving first-seen order.
 */
export function resolveModelChain(
  headLogicalId: string,
  models: Record<string, ModelConfig>,
): ModelChainEntry[] {
  const headConfig = models[headLogicalId];
  if (!headConfig) throw new Error(`model "${headLogicalId}" not found in config`);
  const seen = new Set<string>([headLogicalId]);
  const chain: ModelChainEntry[] = [{ logicalId: headLogicalId, config: headConfig }];
  for (const name of headConfig.fallback ?? []) {
    if (seen.has(name)) continue;
    const config = models[name];
    if (!config) {
      throw new Error(`model "${headLogicalId}" fallback references unknown model "${name}"`);
    }
    seen.add(name);
    chain.push({ logicalId: name, config });
  }
  return chain;
}

// ─── Shared chain-order selection ────────────────────────────────────────────

interface ChooseMember {
  logicalId: string;
  healthKey: string;
}

/**
 * Choose one chain member for an attempt (spec §3), shared by the StreamFn
 * resolver and the fetch-shaped one. Chain order, head special-cased for the
 * canary. A member is viable iff its model is healthy (untracked / no scheduler =
 * healthy) AND in-budget. Returns the index into `members` and the reason.
 */
export function chooseChainMember(
  members: ChooseMember[],
  deps: {
    scheduler?: LlmScheduler;
    isModelAvailable?: (logicalId: string) => boolean;
    /**
     * Members already attempted THIS call (fetch consumers, spec §6): excluded
     * from selection so each member is tried at most once per call and an
     * environmental failure falls over to the NEXT member rather than re-hitting
     * the same one. Omitted (the agent StreamFn path) → no exclusion, because
     * Layer-0 retry re-resolves across whole attempts and §8a health drives reuse.
     */
    tried?: Set<string>;
  },
): { index: number; reason: FallbackReason } {
  const scheduler = deps.scheduler;
  const tried = deps.tried;
  const head = members[0]!;
  const headState = scheduler ? scheduler.modelHealth(head.healthKey) : "healthy";
  const viable = (m: ChooseMember): boolean => {
    if (tried?.has(m.logicalId)) return false;
    const healthy = !scheduler || scheduler.modelHealth(m.healthKey) === "healthy";
    if (!healthy) return false;
    return !deps.isModelAvailable || deps.isModelAvailable(m.logicalId);
  };
  if (viable(head)) return { index: 0, reason: "primary" };
  // Head unhealthy with an open probe window → this attempt is the canary (§4).
  // Gated on budget: an over-budget head must not be canaried — a successful probe
  // can't lead to use while over budget (`viable()` requires in-budget), so the
  // probe would be wasted spend on a model deliberately shut off for cost. No
  // stranding: `nextProbeAt` only advances when a probe fires, so the head becomes
  // probe-due again as soon as the budget window resets and recovers then.
  if (
    !tried?.has(head.logicalId) &&
    headState === "unhealthy" &&
    scheduler?.isProbeDue(head.healthKey) &&
    (!deps.isModelAvailable || deps.isModelAvailable(head.logicalId))
  ) {
    return { index: 0, reason: "canary" };
  }
  for (let i = 0; i < members.length; i++) {
    if (viable(members[i]!)) {
      return { index: i, reason: headState === "unhealthy" ? "health-fallback" : "budget-fallback" };
    }
  }
  // Nothing healthy + in-budget — route to the head so it fails and the caller's
  // own budget/retry decides whole-chain park/wait, and §8a gets a probe waiter.
  return { index: 0, reason: "all-unhealthy" };
}

// ─── Fetch-shaped fallback (spec §6 rows 3-5) ────────────────────────────────
//
// The non-agent inference clients (captioning, image-gen, x_search, remote
// embedding) make raw fetches rather than going through pi-agent-core, so they
// can't compose the StreamFn resolver above. `runFetchWithFallback` is the
// fetch-shaped equivalent: it owns the same per-attempt member selection, the
// scheduler admission around each attempt, and the both-axes `noteOutcome`
// feeding — the consumer supplies only the per-member fetch via `attempt`.

/** A chain member resolved for a fetch consumer. */
export interface FetchChainMember {
  logicalId: string;
  config: ModelConfig;
  /** Health failure domain `(endpoint, id)` — the same key §8a derives from the Model. */
  healthKey: string;
  /** Rate-limit group (`rate_limit_group` ?? "default"). */
  group: string;
}

/** Outcome of one per-member fetch, mapped to the §3 failure taxonomy. */
export type FetchAttemptOutcome<T> =
  | { ok: true; value: T; status?: number }
  /** Environmental (5xx/timeout/reset/empty) — feeds the streak, falls over to the next member. */
  | { ok: false; kind: "environmental"; status?: number; retryAfterMs?: number; error: unknown }
  /** Content/fatal (4xx-from-this-request, bad input) — NEVER triggers fallback (§9); rethrown. */
  | { ok: false; kind: "content"; status?: number; error: unknown };

export interface RunFetchFallbackOptions {
  consumer: string;
  priority: PriorityClass;
  scheduler?: LlmScheduler;
  isModelAvailable?: (logicalId: string) => boolean;
  /** Drop incapable members (head retained); e.g. modality support. */
  capability?: (config: ModelConfig) => boolean;
  /** Per-model probe-backoff cap passthrough (from config). */
  probeBackoffMaxMs?: (config: ModelConfig) => number | undefined;
  signal?: AbortSignal;
  logger?: Logger;
  sessionId?: string;
  /** Rate-limit gate for the resolution log (high-frequency consumers). */
  rateLimitLog?: () => boolean;
}

/** Build the per-member runtime (capability-filtered, head retained) from a chain. */
export function buildFetchChain(
  chain: ModelChainEntry[],
  capability?: (config: ModelConfig) => boolean,
): FetchChainMember[] {
  return chain
    .filter((entry, i) => i === 0 || !capability || capability(entry.config))
    .map((entry) => ({
      logicalId: entry.logicalId,
      config: entry.config,
      healthKey: `${entry.config.endpoint ?? "unknown"}::${entry.config.id}`,
      group: entry.config.rate_limit_group ?? "default",
    }));
}

/**
 * Run `attempt` against the chain with transparent fallback (spec §6). Selects a
 * member per attempt (chain order; canary when the head's probe window is open),
 * acquires a scheduler slot keyed on that member, runs the fetch, and feeds the
 * outcome to §8a on both axes. An environmental failure falls over to the next
 * member; the loop runs at most `members.length` iterations, which suffices even
 * in the canary case because the canaried head occupies one of those iterations
 * (it is added to `tried`, so a failing canary falls through to a real fallback
 * within the same bound). A content failure is rethrown without falling over.
 * Returns the first member's successful value.
 */
export async function runFetchWithFallback<T>(
  chain: ModelChainEntry[],
  options: RunFetchFallbackOptions,
  attempt: (member: FetchChainMember) => Promise<FetchAttemptOutcome<T>>,
): Promise<T> {
  const members = buildFetchChain(chain, options.capability);
  const scheduler = options.scheduler;
  // Each member is attempted AT MOST ONCE per call (the consumer's own retry layer
  // re-drives across calls, by which point §8a health has shifted). An
  // environmental failure falls over to the NEXT viable member; a single-member
  // chain therefore makes exactly one attempt (no double-hit), and the canary case
  // (head probe-due → fall to a fallback when the probe fails) is covered because
  // the canaried head is added to `tried`.
  const tried = new Set<string>();
  let lastError: unknown;
  for (let n = 0; n < members.length; n++) {
    // Single-member chain → dispatch directly (no health reads), mirroring
    // buildModelFallback's single-candidate fast path.
    const { index, reason } =
      members.length === 1
        ? { index: 0, reason: "primary" as FallbackReason }
        : chooseChainMember(members, { scheduler, isModelAvailable: options.isModelAvailable, tried });
    const member = members[index]!;
    // No fresh member left (the resolver fell back to an already-tried head) → stop.
    if (tried.has(member.logicalId)) break;
    tried.add(member.logicalId);
    if (reason !== "primary" && (!options.rateLimitLog || options.rateLimitLog())) {
      options.logger?.info("model_fallback_resolved", {
        consumer: options.consumer,
        sessionId: options.sessionId,
        chain: members.map((m) => m.logicalId),
        chosen: member.logicalId,
        reason,
      });
    }
    const release = scheduler
      ? await scheduler.acquire({
          group: member.group,
          priority: options.priority,
          modelKey: member.healthKey,
          probeBackoffMaxMs: options.probeBackoffMaxMs?.(member.config),
          signal: options.signal,
        })
      : undefined;
    let outcome: FetchAttemptOutcome<T>;
    try {
      outcome = await attempt(member);
    } catch (error) {
      // The caller's abort is a NEUTRAL teardown — release and rethrow WITHOUT
      // feeding noteOutcome (never a model-health signal). Any other throw is
      // environmental and falls over to the next member.
      const aborted = error instanceof Error && error.name === "AbortError";
      if (aborted) {
        release?.();
        throw error;
      }
      scheduler?.noteOutcome(member.group, member.healthKey, "environmental");
      release?.();
      lastError = error;
      continue;
    }
    if (outcome.ok) {
      scheduler?.noteOutcome(member.group, member.healthKey, undefined, outcome.status);
      release?.();
      return outcome.value;
    }
    if (outcome.kind === "content") {
      // Content failures are deterministic on replay and never fall over (§9).
      scheduler?.noteOutcome(member.group, member.healthKey, "content", outcome.status);
      release?.();
      throw outcome.error;
    }
    scheduler?.noteOutcome(
      member.group,
      member.healthKey,
      "environmental",
      outcome.status,
      outcome.retryAfterMs,
    );
    release?.();
    lastError = outcome.error;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.consumer}: all fallback members failed`);
}
