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
   * serve the request's FIXED needs (image blocks → multimodal; caption
   * modality; …). The head is never dropped — if the head fails capability the
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
  // Fall back to the head's window if none declared one (defensive; the agent
  // path requires context_window so this is the non-agent convenience case).
  if (!Number.isFinite(minWindow)) minWindow = head.config.context_window ?? 0;
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

  const scheduler = options.scheduler;
  let warnedThinking = false;

  const choose = (): { candidate: Candidate; reason: FallbackReason } => {
    const headCand = candidates[0]!;
    // Untracked / no scheduler = healthy.
    const headState = scheduler ? scheduler.modelHealth(headCand.healthKey) : "healthy";
    const viable = (c: Candidate): boolean => {
      const healthy = !scheduler || scheduler.modelHealth(c.healthKey) === "healthy";
      if (!healthy) return false;
      return !options.isModelAvailable || options.isModelAvailable(c.logicalId);
    };

    // Head viable → normal path.
    if (viable(headCand)) return { candidate: headCand, reason: "primary" };
    // Head unhealthy with an open probe window → THIS attempt is the canary
    // (§4): route to the head so §8a admits it as the half-open probe.
    if (headState === "unhealthy" && scheduler?.isProbeDue(headCand.healthKey)) {
      return { candidate: headCand, reason: "canary" };
    }
    // First downstream member that is healthy AND in-budget.
    for (const c of candidates) {
      if (viable(c)) {
        return {
          candidate: c,
          reason: headState === "unhealthy" ? "health-fallback" : "budget-fallback",
        };
      }
    }
    // Nothing healthy + in-budget — route to the head so it fails, Layer-0
    // retries, and the per-class budget decides whole-chain park/wait; the head
    // also gives §8a's organic admission-probe a real waiter to recover with.
    return { candidate: headCand, reason: "all-unhealthy" };
  };

  const streamFn: StreamFn = (model, context, streamOptions) => {
    const { candidate, reason } = choose();
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
