import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import { extractStatus } from "./request-retry.js";

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
  logger?: Logger;
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
  /** Abort waiting for a slot (shutdown / run abort). */
  signal?: AbortSignal;
}

/** Idempotent slot release. MUST be called (in a `finally`) when the request settles. */
export type ReleaseFn = () => void;

interface QueueEntry {
  rank: number;
  seq: number;
  key?: string;
  resolve: (release: ReleaseFn) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface GroupState {
  name: string;
  maxInFlight: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  active: number;
  queue: QueueEntry[];
  /** Epoch ms before which no new admission may happen. 0 = none. */
  backoffUntil: number;
  consecutiveThrottles: number;
  backoffTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

function abortError(): Error {
  const error = new Error("LLM scheduler wait aborted");
  error.name = "AbortError";
  return error;
}

export class LlmScheduler {
  private readonly groups = new Map<string, GroupState>();
  private readonly logger?: Logger;
  /** Sticky escalations for keys not yet registered (§5.5). */
  private readonly stickyEscalations = new Map<string, PriorityClass>();
  private seqCounter = 0;
  private stopped = false;

  constructor(options: LlmSchedulerOptions = {}) {
    this.logger = options.logger;
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
   * Observe a request outcome for backoff purposes. A 429/503 (parsed from the
   * flattened error message — pi-ai surfaces SDK errors status-prefixed) pauses
   * the group's admissions with exponential backoff + jitter; any other outcome
   * resets the group's throttle streak. Unconditional (§5.3): always applied,
   * independent of config. This is the string-sniffing FALLBACK seam — the
   * Anthropic provider is SDK-based and throws on non-2xx before pi-ai's
   * `onResponse` hook fires, so its 429s only ever arrive here as flattened
   * messages (no headers, so no `Retry-After`). Callers that hold the actual
   * response use {@link noteStatus} with the parsed `Retry-After` instead.
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
   * the exponential path itself (§5.3).
   */
  noteStatus(groupName: string, status: number | undefined, retryAfterMs?: number): void {
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
  }

  /** Reject all queued waiters (shutdown). In-flight requests are unaffected. */
  stop(): void {
    this.stopped = true;
    for (const group of this.groups.values()) {
      if (group.backoffTimer) clearTimeout(group.backoffTimer);
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
      // Highest rank wins; FIFO (lowest seq) within a rank. Queues are tiny
      // (a handful of pending requests), so a linear scan is the simplest
      // correct structure.
      let best = 0;
      for (let i = 1; i < group.queue.length; i++) {
        const candidate = group.queue[i]!;
        const current = group.queue[best]!;
        if (candidate.rank > current.rank || (candidate.rank === current.rank && candidate.seq < current.seq)) {
          best = i;
        }
      }
      const entry = group.queue.splice(best, 1)[0]!;
      entry.signal?.removeEventListener("abort", entry.onAbort!);
      group.active += 1;
      let released = false;
      const release: ReleaseFn = () => {
        if (released) return;
        released = true;
        group.active = Math.max(0, group.active - 1);
        this.pump(group);
      };
      entry.resolve(release);
    }
  }
}

export interface AdmissionOptions {
  group: string;
  priority: PriorityClass;
  /** Escalation key registered for the whole wait (§5.5). */
  key?: string;
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

    void (async () => {
      let release: ReleaseFn;
      try {
        release = await scheduler.acquire({
          group: options.group,
          priority: options.priority,
          key: options.key,
          signal,
        });
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
            scheduler.noteStatus(options.group, response.status, parseRetryAfterMs(response.headers));
          }
          return prevOnResponse?.(response, responseModel);
        },
      };
      try {
        const inner = await base(model, context, innerOptions);
        for await (const event of inner) {
          if (event.type === "error") {
            // Skip the fallback when the hook already counted this request's
            // throttle — double-counting would inflate the exponential streak.
            if (!throttleNoted) scheduler.noteResult(options.group, event.error?.errorMessage);
          } else if (event.type === "done") {
            scheduler.noteResult(options.group);
          }
          outer.push(event);
        }
      } catch (err) {
        // The base fn itself threw (not via a terminal `error` event). Surface a
        // terminal error so the consumer always sees one, and count it for backoff.
        const message = err instanceof Error ? err.message : String(err);
        if (!throttleNoted) scheduler.noteResult(options.group, message);
        outer.push(synthesizeErrorEvent(model, message));
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
