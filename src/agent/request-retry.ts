import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import type { LlmRequestRing } from "./request-ring.js";
import type { PriorityClass } from "./scheduler.js";

// =============================================================================
// Layer 0 — transparent request-level LLM retry.
//
// Spec: LLM-FAILURE-HANDLING §4 (supersedes CONCURRENCY-AND-RATE-LIMITING
// §6.1's pre-commit-only retry). The agent's stream function (`streamSimple`,
// or `wrapCompleteAsStream` for non-streaming models) can fail for
// environmental reasons that are frequent and normal: a connection reset, a
// timeout, a 5xx, an upstream 429, a stream that starts producing tokens and
// dies in an error event. Inference failures must be invisible to the session
// (P1): the session's log and context are never modified by an API-level
// failure, and a success after N failed attempts is byte-equivalent to a
// success on the first attempt.
//
// `withRequestRetry` therefore buffers ALL events of an attempt and forwards
// them to the consumer (pi-agent-core) only when the attempt terminates in a
// clean `done` — the commit point IS the terminal event (§4.1). A terminal
// `error` at ANY point — before or after tokens were produced — discards the
// buffered partial and re-enters the retry loop as if the request had failed
// from the start. pi-agent-core never sees a failed attempt unless this layer
// gives up; the synthetic `stopReason:"error"` turn and the Layer-2 rebuild
// stop being the mid-stream recovery path. Buffering a full response is
// bounded by `max_tokens` — no meaningful memory concern.
//
// Live token streaming is preserved via the observability tap (§4.2): the
// context's `onAttemptEvent` is invoked synchronously with every raw event as
// it arrives (best-effort, exceptions swallowed — the tap can never affect the
// run), and `onAttemptDiscarded` fires when a partial attempt is thrown away,
// so the console can render tentative tokens and clear them on retry. Nothing
// product-level consumes partials.
//
// This wrapper does NOT distinguish a 429 originating at the gateway (LlmGateway,
// which already retries internally) from a 429 at the true upstream: it backs off
// and retries either way, which is always safe (spec §5.3 — 429 backoff is an
// unconditional invariant).
// =============================================================================

export interface RequestRetryOptions {
  /**
   * Wall-clock budget for environmental retries (spec LLM-FAILURE-HANDLING
   * §6), measured from the first attempt of the failing request. `undefined`
   * = UNBOUNDED — background-class work keeps re-entering admission until it
   * succeeds, is drained/aborted, or reclassifies (P3: downtime is routine
   * and background work waits it out). Interactive-class callers pass
   * `recovery.llm_request_max_wait_ms`. A fixed attempt count is meaningless
   * under scheduler gating — attempts can elapse in seconds or hours
   * depending on group/model state — so there is no `retries` knob anymore.
   */
  maxWaitMs?: number;
  /**
   * Base for the local inter-attempt backoff. Applies only while the request's
   * model is healthy and its group unthrottled — once the admission queue is
   * the wait point (`ctx.isQueueWaitPoint`), the local sleep collapses to ~0
   * (no double-waiting, §4.3). `recovery.llm_request_backoff_base_ms`.
   */
  backoffBaseMs: number;
  /** Ceiling for the (pre-jitter) backoff delay. `recovery.llm_request_backoff_max_ms`. */
  backoffMaxMs: number;
}

export interface RequestRetryContext {
  logger?: Logger;
  sessionId?: string;
  timelineKey?: string;
  sessionType?: string;
  /** Rate-limit group of the wrapped calls (for `llm_request_attempt_failed` logs). */
  group?: string;
  /**
   * Observability tap (spec LLM-FAILURE-HANDLING §4.2): invoked synchronously
   * with every raw event of every attempt as it arrives — including events of
   * attempts that are later discarded. Best-effort: exceptions are swallowed;
   * the tap can never affect the run. Attempt numbers are 1-based.
   */
  onAttemptEvent?: (attempt: number, event: AssistantMessageEvent) => void;
  /**
   * Fired when a (possibly partial) attempt is discarded and the request will
   * be retried — the console clears tentative tokens and shows
   * "attempt n failed (reason), retrying".
   */
  onAttemptDiscarded?: (attempt: number, reason: string) => void;
  /**
   * True when the admission queue is the effective wait point (group throttle
   * backoff active, or the model unhealthy): the local inter-attempt backoff
   * then collapses to ~0 so the wrapper never double-waits (§4.3). The
   * factory binds `LlmScheduler.isQueueWaitPoint(group, modelKey)`.
   */
  isQueueWaitPoint?: () => boolean;
  /** Priority class of the wrapped calls (ring attribution, spec §9.2). */
  priority?: PriorityClass;
  /** In-memory request ring; every settled attempt is recorded (spec §9.2). */
  ring?: LlmRequestRing;
  /**
   * Drain-and-reset read of the last attempt's admission-queue wait, filled by
   * `withSchedulerAdmission`'s `onAdmissionWait` via a factory-owned holder.
   */
  takeAdmissionWaitMs?: () => number | undefined;
}

/**
 * Failure class of an LLM request (spec LLM-FAILURE-HANDLING §3).
 *
 * - `environmental` — session-independent; the model/account/gateway is unwell
 *   or throttling. Expected to clear (possibly after operator action: an auth/
 *   grant failure is endpoint-level and fixed out-of-band, so 401/403 land here
 *   too — the fixed-cadence probe detects recovery automatically). Retried.
 * - `content` — caused by *this request's* content (oversized context,
 *   malformed payload); replay is deterministic. Never retried at this layer;
 *   escalated to the semantic layer.
 * - `aborted` — intentional (drain, operator Stop, tool/turn caps, scheduler
 *   stop). Never retried; surfaced as an abort.
 */
export type LlmErrorClass = "environmental" | "content" | "aborted";

// ─── Layer-1 origin tagging (Decision C / review issue #14) ──────────────────
//
// pi-agent-core's `handleRunFailure` catches ANY executor throw — including
// programming errors in `transformContext`/tool plumbing — and flattens it into
// the same `AgentState.errorMessage` string a genuine LLM failure lands in. By
// the time the SessionRunner inspects the failure, the string is ALL that
// survives (pi-ai stores `error.message`; pi-agent-core copies it verbatim at
// `turn_end`), so origin must be encoded in the string itself.
//
// `withRequestRetry` is the outermost wrapper of the LLM request layer: every
// terminal `error` event it emits — a provider/SDK failure, a scheduler
// admission failure synthesized by `withSchedulerAdmission` (composed INSIDE
// it, so those flow through and are tagged here too), or its own synthesized
// throw-guard/empty-stream errors — by definition originated in that layer. It
// appends this marker to the terminal error's `errorMessage`; the runner's
// mechanical classification (`throwIfMechanicalFailure`) treats ONLY tagged
// errors as resume candidates, so an our-own-code throw can never be
// misclassified as a mechanical upstream failure. The lean-retryable default of
// `classifyLlmError` is deliberately unchanged WITHIN tagged errors: ambiguous
// upstream failures stay resumable.
//
// The marker is a suffix so `extractStatus`'s leading-status parse still sees
// the SDK's status prefix, and its text deliberately matches no FATAL_KEYWORDS
// entry.

/** Marker appended to terminal error messages that originated in the LLM request layer. */
export const LLM_REQUEST_FAILURE_MARKER = "[llm-request]";

/**
 * Machine-readable class marker (spec LLM-FAILURE-HANDLING §4.3), e.g.
 * `[llm-request:content]`. A marker-in-string because pi-agent-core flattens
 * everything to `errorMessage` (Decision C) — a structured side-channel is not
 * available without forking the runtime.
 */
export function llmRequestClassMarker(cls: LlmErrorClass): string {
  return `[llm-request:${cls}]`;
}

const CLASS_MARKER_RE = /\[llm-request:(environmental|content|aborted)\]/;

/**
 * Append the Layer-1 origin marker, plus the machine-readable class marker when
 * a class is given (idempotent; an already-tagged message is never re-tagged,
 * so the FIRST classification at the surfacing point wins).
 */
export function tagLlmRequestError(message: string | undefined, cls?: LlmErrorClass): string {
  const msg = message ?? "";
  if (msg.includes(LLM_REQUEST_FAILURE_MARKER)) return msg;
  const markers = cls ? `${LLM_REQUEST_FAILURE_MARKER} ${llmRequestClassMarker(cls)}` : LLM_REQUEST_FAILURE_MARKER;
  return msg.length > 0 ? `${msg} ${markers}` : markers;
}

/** True when the flattened error message carries the Layer-1 origin marker. */
export function isLlmRequestError(message: string | undefined): boolean {
  return (message ?? "").includes(LLM_REQUEST_FAILURE_MARKER);
}

/** Parse the class marker out of a tagged error message, if present. */
export function extractLlmRequestClass(message: string | undefined): LlmErrorClass | undefined {
  const m = CLASS_MARKER_RE.exec(message ?? "");
  return m ? (m[1] as LlmErrorClass) : undefined;
}

/** Remove the Layer-1 origin + class markers for display/classification. */
export function stripLlmRequestTag(message: string): string {
  return message
    .replace(CLASS_MARKER_RE, "")
    .split(LLM_REQUEST_FAILURE_MARKER)
    .join("")
    .replace(/\s+$/, "")
    .trim();
}

// Statuses caused by THIS request's content — the upstream will reject an
// identical replay deterministically (malformed, payload-too-large,
// unprocessable). Everything else parseable is environmental (spec §3): the
// 408/409/425/429/5xx transients, but also 401/403/404/405 — an auth/grant
// failure is endpoint-level, fixed out-of-band, and recovery is detected by the
// model-health probe rather than by refusing to retry.
const CONTENT_STATUSES = new Set([400, 413, 422]);

// Substrings that positively identify a content failure even without a
// parseable status (context-length violations are the dominant real case).
const CONTENT_KEYWORDS = [
  "prompt is too long",
  "context_length_exceeded",
  "context length exceeded",
  "maximum context length",
  "request_too_large",
  "payload too large",
];

// Synthesized by withSchedulerAdmission when LlmScheduler.stop() rejects an
// admission wait at shutdown ("LLM scheduler stopped"). A stopped gate can only
// ever reject again, so this is intentional-teardown, classified `aborted` —
// retrying would spin out backed-off attempts per straggler during drain (#11).
const SCHEDULER_STOPPED_KEYWORD = "scheduler stopped";

/**
 * Classify an LLM stream failure (spec LLM-FAILURE-HANDLING §3): three-way
 * `environmental` / `content` / `aborted` replacing the old retryable/fatal
 * binary.
 *
 * Inputs are the terminal `error` AssistantMessage's `errorMessage` (a flattened
 * string — pi-ai stores `error.message` here, so an SDK `APIError` arrives status-
 * prefixed, e.g. `"429 {...}"`) and its `stopReason`.
 *
 * An intentional `aborted` (tool-call/turn cap, shutdown, scheduler stop) is
 * never retried. `content` requires positive evidence — a 400/413/422 status or
 * an explicit context-length keyword. EVERYTHING ELSE IS `environmental`:
 * timeouts, resets, empty streams, every other status (5xx, 429, and the
 * 401/403/404/405 endpoint-level failures), auth keywords, and anything
 * unparseable — mechanical blips dominate that path, and the scheduler's
 * model-health gating bounds the cost of a wrong guess.
 */
export function classifyLlmError(
  errorMessage: string | undefined,
  stopReason: string | undefined,
): LlmErrorClass {
  if (stopReason === "aborted") return "aborted";
  const msg = (errorMessage ?? "").toLowerCase();
  if (msg.includes(SCHEDULER_STOPPED_KEYWORD)) return "aborted";

  const status = extractStatus(msg);
  if (status !== undefined && CONTENT_STATUSES.has(status)) return "content";
  if (CONTENT_KEYWORDS.some((keyword) => msg.includes(keyword))) return "content";
  return "environmental";
}

/**
 * Extract an HTTP status from a flattened error message, conservatively. The
 * Anthropic SDK prefixes its `APIError.message` with the status code, so we trust
 * a leading 3-digit token; we also accept an explicit `status: NNN` / `status code
 * NNN` label. We deliberately do NOT scan arbitrary embedded numbers (a JSON body
 * may contain unrelated 3-digit values), to avoid a false fatal/retryable verdict.
 * Expects a lowercased message. Also used by the scheduler's unconditional 429/503
 * backoff (src/agent/scheduler.ts, spec §5.3) so both layers parse identically.
 */
export function extractStatus(msg: string): number | undefined {
  const leading = msg.match(/^\s*(\d{3})\b/);
  if (leading) {
    const n = Number(leading[1]);
    if (n >= 400 && n < 600) return n;
  }
  const labelled = msg.match(/status(?:\s*code)?[:\s]+(\d{3})\b/);
  if (labelled) {
    const n = Number(labelled[1]);
    if (n >= 400 && n < 600) return n;
  }
  return undefined;
}

/** Full-jitter exponential backoff: random in `[0, min(max, base * 2^attempt))`. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * Wrap a {@link StreamFn} with Layer-0 transparent request retry (spec
 * LLM-FAILURE-HANDLING §4/§6). The commit point is the TERMINAL event (§4.1):
 * all events of an attempt are buffered and forwarded only on a clean `done`;
 * a terminal `error` at any point — even after tokens streamed — discards the
 * buffered partial and retries as if the request had failed from the start.
 *
 * Retry budget (§6, maintainer decision): the wall-clock budget bounds only the
 * WAITING — admission-queue waits and inter-attempt backoff sleeps — and a
 * STUCK attempt that has produced zero tokens by the deadline. It NEVER aborts a
 * token-producing attempt: the first model-produced event of any kind (text,
 * reasoning/thinking, or tool-call delta — `start` is the opener, not content)
 * makes the attempt immune for the rest of its life, so a healthy generation of
 * any length completes. `maxWaitMs` unset = unbounded (background-class — an
 * outage is waited out); set = interactive-class, measured from the first
 * attempt. Expiry mid-admission-wait still aborts the acquire (the one wait the
 * spec sanctioned cutting short), so a request queued behind an unhealthy
 * model's probe window cannot overstay its budget before producing a token.
 *
 * The wrapper always applies: every terminal error it surfaces is tagged with
 * {@link LLM_REQUEST_FAILURE_MARKER} + the class marker (Decision C / §4.3),
 * which the runner's typed `phase:"llm"` rejection depends on.
 */
export function withRequestRetry(
  base: StreamFn,
  options: RequestRetryOptions,
  ctx: RequestRetryContext = {},
): StreamFn {
  return (model, context, streamOptions) => {
    const outer = createAssistantMessageEventStream();
    const callerSignal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;

    // Wall-clock budget (§6, maintainer decision). The budget bounds only the
    // WAITING — admission-queue waits and inter-attempt backoff sleeps — and a
    // STUCK attempt that produces zero tokens by the deadline. It must NEVER
    // abort an attempt that has produced ≥1 token (incl. reasoning/thinking):
    // a working generation may take arbitrarily long, and killing it mid-stream
    // discards a nearly-complete paid response. So the budget signal is NOT
    // composed unconditionally into every attempt. Instead each attempt gets its
    // own controller (`attemptCtrl`); the budget's abort is forwarded into it
    // only while the attempt has produced no tokens. The first token of any kind
    // detaches the budget listener for the rest of that attempt, making it
    // immune. The caller's own abort (drain/Stop) is always forwarded. The
    // surfaced budget abort is re-labelled as wait-exhaustion below (the caller
    // did not abort — the clock did).
    const maxWaitMs = options.maxWaitMs;
    const deadline = maxWaitMs === undefined ? Infinity : Date.now() + maxWaitMs;
    let budgetCtrl: AbortController | undefined;
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (maxWaitMs !== undefined) {
      budgetCtrl = new AbortController();
      budgetTimer = setTimeout(() => budgetCtrl!.abort(), maxWaitMs);
      budgetTimer.unref?.();
    }
    const budgetSignal = budgetCtrl?.signal;
    // The inter-attempt backoff sleep is pure waiting and produces no tokens, so
    // BOTH the caller's abort and the budget expiry must cut it short (§6). The
    // sleep is the one place the budget always composes — the immunity rule
    // applies only to a token-producing attempt, never to a wait.
    const sleepSignal =
      callerSignal && budgetSignal
        ? AbortSignal.any([callerSignal, budgetSignal])
        : (callerSignal ?? budgetSignal);

    const tap = (attempt: number, event: AssistantMessageEvent): void => {
      try {
        ctx.onAttemptEvent?.(attempt, event);
      } catch {
        /* observe-only: the tap can never affect the run */
      }
    };
    const tapDiscarded = (attempt: number, reason: string): void => {
      try {
        ctx.onAttemptDiscarded?.(attempt, reason);
      } catch {
        /* observe-only */
      }
    };
    /** Record one settled attempt on the in-memory ring (spec §9.2). */
    const recordAttempt = (
      attempt: number,
      startedAt: number,
      outcome: "done" | "error" | "aborted",
      details?: { status?: number; cls?: LlmErrorClass; errorMessage?: string },
    ): void => {
      try {
        ctx.ring?.record({
          ts: Date.now(),
          sessionId: ctx.sessionId,
          sessionType: ctx.sessionType,
          group: ctx.group,
          model: (model as { id?: string }).id ?? "unknown",
          priority: ctx.priority,
          attempt,
          admissionWaitMs: ctx.takeAdmissionWaitMs?.(),
          durationMs: Date.now() - startedAt,
          outcome,
          status: details?.status,
          class: details?.cls,
          errorMessage: details?.errorMessage,
        });
      } catch {
        /* observe-only */
      }
    };

    /** Surface the terminal error (tagged) and finalize `outer`. */
    const surface = (
      event: Extract<AssistantMessageEvent, { type: "error" }>,
      cls: LlmErrorClass,
    ): void => {
      outer.push(tagErrorEvent(event, cls));
    };

    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          const attemptStart = Date.now();
          const buffered: AssistantMessageEvent[] = [];
          let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
          let producedTokens = false;

          // Per-attempt abort: the caller's abort (drain/Stop) always reaches
          // the inner stream; the budget's abort reaches it ONLY while the
          // attempt has produced no tokens (a stuck/silent attempt). `start` is
          // the stream opener, not content; the first event of any other kind —
          // text, thinking/reasoning, or tool-call delta — is "first token" and
          // detaches the budget listener, making the attempt immune for the rest
          // of its life. The admission-queue wait happens inside `base` before
          // any event, so a budget expiry mid-admission still aborts the acquire
          // (the one wait the spec sanctioned cutting short).
          const attemptCtrl = new AbortController();
          const onCallerAbort = () => attemptCtrl.abort();
          const onBudgetAbort = () => attemptCtrl.abort();
          if (callerSignal) {
            if (callerSignal.aborted) attemptCtrl.abort();
            else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
          }
          if (budgetSignal) {
            if (budgetSignal.aborted) attemptCtrl.abort();
            else budgetSignal.addEventListener("abort", onBudgetAbort, { once: true });
          }
          const detachBudget = () => {
            budgetSignal?.removeEventListener("abort", onBudgetAbort);
          };
          const detachCaller = () => {
            callerSignal?.removeEventListener("abort", onCallerAbort);
          };
          const attemptOptions = {
            ...((streamOptions as object | undefined) ?? {}),
            signal: attemptCtrl.signal,
          } as typeof streamOptions;

          try {
            const inner = await base(model, context, attemptOptions);
            for await (const event of inner) {
              tap(attempt + 1, event);
              if (event.type === "error") {
                // Terminal error — before OR after tokens. The buffered partial
                // is discarded below; the retry loop owns recovery (§4.1).
                errorEvent = event;
                break;
              }
              buffered.push(event);
              if (event.type !== "start" && !producedTokens) {
                // First model-produced content of any kind (incl. reasoning):
                // the attempt is now immune to the wall-clock budget.
                producedTokens = true;
                detachBudget();
              }
              // A clean terminal `done` ends the inner iteration on its own.
            }
          } catch (err) {
            // The base fn (or its stream iteration) THREW instead of emitting a
            // terminal `error` event — e.g. a synchronously-failing base in a
            // scheduler-less composition. Without this guard the throw escapes
            // the void-IIFE as an unhandled rejection (process-fatal) and
            // `outer` never terminates (hung consumer) (#12). Synthesize the
            // terminal error and feed it through the SAME classification/retry
            // logic below; an AbortError keeps its `aborted` stop reason.
            const message = err instanceof Error ? err.message : String(err);
            const aborted = err instanceof Error && err.name === "AbortError";
            errorEvent = synthesizeErrorEvent(model, message, aborted ? "aborted" : "error");
            tap(attempt + 1, errorEvent);
          } finally {
            // Detach the per-attempt listeners so neither signal leaks across
            // the retry loop (the budget listener may already be detached if a
            // token arrived).
            detachBudget();
            detachCaller();
          }

          if (!errorEvent) {
            const terminal = buffered[buffered.length - 1];
            if (terminal && terminal.type === "done") {
              // Clean terminal `done`: the attempt commits as a whole (§4.1).
              // Flushing forwards the terminal event last, which finalizes
              // `outer` (EventStream.push resolves on it). A success after N
              // failed attempts is byte-equivalent to a first-attempt success.
              recordAttempt(attempt + 1, attemptStart, "done");
              flush(outer, buffered);
              return;
            }
            // Degenerate: the inner stream ended with no terminal event. An
            // "empty stream" is explicitly environmental (§3), so it re-enters
            // the same retry loop instead of surfacing immediately.
            ctx.logger?.warn("llm_request_empty_stream", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              attempt: attempt + 1,
            });
            errorEvent = synthesizeErrorEvent(model, "stream ended without a terminal event");
            tap(attempt + 1, errorEvent);
          }

          const failure = errorEvent.error;
          let verdict = classifyLlmError(failure?.errorMessage, failure?.stopReason);

          // Budget expiry on a ZERO-token attempt (a stuck/silent stream or a
          // mid-admission wait) arrives as an abort of the per-attempt signal.
          // When the CALLER did not abort, the clock did: re-label as
          // environmental wait-exhaustion rather than an intentional abort, so
          // the failure parks instead of settling. A token-producing attempt
          // detached the budget listener, so its abort never reaches here (§6).
          const budgetExpired = budgetCtrl?.signal.aborted === true && callerSignal?.aborted !== true;
          if (verdict === "aborted" && budgetExpired) {
            verdict = "environmental";
            errorEvent = synthesizeErrorEvent(
              model,
              `llm request wall-clock budget (${maxWaitMs}ms) exhausted: ${failure?.errorMessage ?? "aborted"}`,
            );
          }
          recordAttempt(attempt + 1, attemptStart, verdict === "aborted" ? "aborted" : "error", {
            status: extractStatus((errorEvent.error?.errorMessage ?? "").toLowerCase()),
            cls: verdict,
            errorMessage: errorEvent.error?.errorMessage,
          });

          if (verdict === "environmental") {
            // Every environmental failure is logged — including the first
            // attempt (spec §9.3 closes the audit gap where first-attempt
            // failures logged nothing).
            ctx.logger?.warn("llm_request_attempt_failed", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              group: ctx.group,
              class: verdict,
              status: extractStatus((errorEvent.error?.errorMessage ?? "").toLowerCase()),
              attempt: attempt + 1,
              producedTokens,
              errorMessage: errorEvent.error?.errorMessage,
            });
            if (Date.now() >= deadline || budgetExpired) {
              ctx.logger?.warn("llm_request_wait_exhausted", {
                sessionId: ctx.sessionId,
                timelineKey: ctx.timelineKey,
                sessionType: ctx.sessionType,
                maxWaitMs,
                attempts: attempt + 1,
                errorMessage: errorEvent.error?.errorMessage,
              });
              surface(errorEvent, verdict);
              return;
            }
            tapDiscarded(attempt + 1, errorEvent.error?.errorMessage ?? "request failed");
            // Local backoff applies only while the admission queue is NOT the
            // wait point (§4.3) — an unhealthy model / throttled group already
            // paces re-admission, and double-waiting would slow recovery.
            let delay = ctx.isQueueWaitPoint?.() ? 0 : backoffDelayMs(attempt, options.backoffBaseMs, options.backoffMaxMs);
            if (Number.isFinite(deadline)) delay = Math.min(delay, Math.max(0, deadline - Date.now()));
            try {
              await sleep(delay, sleepSignal);
            } catch {
              // Aborted mid-backoff. Caller abort (shutdown/Stop) surfaces the
              // original error; budget expiry loops once more and exits via
              // the wait-exhausted path above.
              if (budgetCtrl?.signal.aborted === true && callerSignal?.aborted !== true) {
                continue;
              }
              surface(errorEvent, verdict);
              return;
            }
            continue;
          }

          // `content` and `aborted` surface immediately — never retried (§4.3).
          surface(errorEvent, verdict);
          return;
        }
      } finally {
        if (budgetTimer) clearTimeout(budgetTimer);
      }
    })();

    return outer;
  };
}

function flush(outer: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
  for (const event of events) outer.push(event);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Copy a terminal `error` event with the Layer-1 origin marker (and the §4.3
 * class marker, when the class is known at the surfacing point) appended to its
 * `errorMessage` (Decision C / #14). Never mutates the provider's event.
 */
function tagErrorEvent(
  event: Extract<AssistantMessageEvent, { type: "error" }>,
  cls?: LlmErrorClass,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const failure = event.error;
  const resolved = cls ?? classifyLlmError(failure?.errorMessage, failure?.stopReason);
  return {
    ...event,
    error: { ...event.error, errorMessage: tagLlmRequestError(event.error?.errorMessage, resolved) },
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
