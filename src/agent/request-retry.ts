import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";

// =============================================================================
// Layer 1 — transparent request-level LLM retry (mechanical failures).
//
// Spec: CONCURRENCY-AND-RATE-LIMITING §6.1. The agent's stream function
// (`streamSimple`, or `wrapCompleteAsStream` for non-streaming models) can fail
// for mechanical reasons that are frequent and normal: a connection reset, a
// timeout, a 5xx, an upstream 429. Today such a blip synthesizes a
// `stopReason:"error"` message, which discards a live session and burns a
// synthetic job's coarse semantic-retry attempt.
//
// `withRequestRetry` wraps any {@link StreamFn} so that, when the underlying
// stream terminates with an `error` event BEFORE producing any output, the exact
// same request is re-issued (bounded, with exponential backoff + jitter) before
// the failure is allowed to surface. This is invisible to the session and to
// pi-agent-core; a mechanical blip is absorbed here rather than escalating.
//
// Crucially it only retries failures that occur *before* the stream commits any
// content. Once tokens (or a tool call, or a clean `done`) have been forwarded to
// the consumer, the request is "committed" — a later mid-stream failure cannot be
// transparently replayed and is forwarded as-is. That mid-stream case is the
// province of Layer 2 (session resume-in-place, spec §6.2 — not yet wired).
//
// This wrapper does NOT distinguish a 429 originating at the gateway (LlmGateway,
// which already retries internally) from a 429 at the true upstream: it backs off
// and retries either way, which is always safe (spec §5.3 — 429 backoff is an
// unconditional invariant). The origin distinction (spec §6.1) is a deferred
// optimization, not a correctness requirement.
// =============================================================================

export interface RequestRetryOptions {
  /**
   * Number of *additional* attempts after the first. Total attempts =
   * `retries + 1`. `0` disables retry (a single attempt) — the wrapper still
   * applies, because it owns the Layer-1 origin tagging (see
   * {@link LLM_REQUEST_FAILURE_MARKER}) that Layer-2 resume classification
   * depends on. Maps to `recovery.llm_request_retries`.
   */
  retries: number;
  /** Base for exponential backoff between attempts. `recovery.llm_request_backoff_base_ms`. */
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
 * Wrap a {@link StreamFn} with Layer-1 transparent request retry. `retries: 0`
 * means a single attempt, but the wrapper still applies: every terminal error
 * it surfaces is tagged with {@link LLM_REQUEST_FAILURE_MARKER} (Decision C),
 * which Layer-2 resume classification depends on — returning the base fn
 * unwrapped would silently disable resume-in-place.
 */
export function withRequestRetry(
  base: StreamFn,
  options: RequestRetryOptions,
  ctx: RequestRetryContext = {},
): StreamFn {
  const maxAttempts = Math.max(1, Math.floor(options.retries) + 1);

  return (model, context, streamOptions) => {
    const outer = createAssistantMessageEventStream();
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;

    void (async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let committed = false;
        const buffered: AssistantMessageEvent[] = [];
        let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;

        try {
          const inner = await base(model, context, streamOptions);
          for await (const event of inner) {
            if (committed) {
              // Past the commit point: forward verbatim — except a terminal
              // `error` (a mid-stream death, Layer-2 territory), which is
              // tagged as LLM-request-layer-originated like every other
              // terminal error this wrapper emits. A terminal `done`/`error`
              // here auto-finalizes `outer` (EventStream.push resolves on it).
              outer.push(event.type === "error" ? tagErrorEvent(event) : event);
              continue;
            }
            if (event.type === "error") {
              errorEvent = event;
              break;
            }
            buffered.push(event);
            if (event.type !== "start") {
              // First real content (or a `done`): this attempt has produced output.
              // Commit — flush the buffered prologue and switch to pass-through.
              committed = true;
              flush(outer, buffered);
              buffered.length = 0;
            }
          }
        } catch (err) {
          // The base fn (or its stream iteration) THREW instead of emitting a
          // terminal `error` event — e.g. a synchronously-failing base in a
          // scheduler-less composition. Without this guard the throw escapes the
          // void-IIFE as an unhandled rejection (process-fatal) and `outer` never
          // terminates (hung consumer) (#12). Synthesize the terminal error and
          // feed it through the SAME classification/retry logic below; an
          // AbortError keeps its `aborted` stop reason (never retried).
          const message = err instanceof Error ? err.message : String(err);
          const aborted = err instanceof Error && err.name === "AbortError";
          errorEvent = synthesizeErrorEvent(model, message, aborted ? "aborted" : "error");
          if (committed) {
            // Content already forwarded — cannot replay (Layer-2 territory), but
            // the consumer still needs a terminal event.
            outer.push(tagErrorEvent(errorEvent));
            return;
          }
        }

        if (committed) return; // terminal already forwarded → `outer` is complete

        if (errorEvent) {
          const failure = errorEvent.error;
          const verdict = classifyLlmError(failure?.errorMessage, failure?.stopReason);
          // Every environmental failure is logged — including the first attempt
          // and the deterministic single-attempt path (spec §9.3 closes the
          // audit gap where first-attempt failures logged nothing).
          if (verdict === "environmental") {
            ctx.logger?.warn("llm_request_attempt_failed", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              group: ctx.group,
              class: verdict,
              status: extractStatus((failure?.errorMessage ?? "").toLowerCase()),
              attempt: attempt + 1,
              maxAttempts,
              errorMessage: failure?.errorMessage,
            });
          }
          const lastAttempt = attempt >= maxAttempts - 1;
          if (verdict === "environmental" && !lastAttempt) {
            const delay = backoffDelayMs(attempt, options.backoffBaseMs, options.backoffMaxMs);
            try {
              await sleep(delay, signal);
            } catch {
              // Aborted mid-backoff (shutdown / cap): surface the original error.
              flush(outer, buffered);
              outer.push(tagErrorEvent(errorEvent, verdict));
              return;
            }
            continue;
          }
          if (verdict === "environmental") {
            ctx.logger?.warn("llm_request_retries_exhausted", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              attempts: maxAttempts,
              errorMessage: failure?.errorMessage,
            });
          }
          flush(outer, buffered);
          outer.push(tagErrorEvent(errorEvent, verdict));
          return;
        }

        // Degenerate: the inner stream ended with neither content nor a terminal
        // event. Synthesize a terminal error so the consumer always sees one.
        ctx.logger?.warn("llm_request_empty_stream", {
          sessionId: ctx.sessionId,
          timelineKey: ctx.timelineKey,
          sessionType: ctx.sessionType,
        });
        flush(outer, buffered);
        outer.push(tagErrorEvent(synthesizeErrorEvent(model, "stream ended without a terminal event")));
        return;
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
