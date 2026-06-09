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
   * `retries + 1`. `0` disables retry (the base stream function is returned
   * unwrapped). Maps to `recovery.llm_request_retries`.
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
}

export type LlmErrorClass = "retryable" | "fatal";

// 4xx that indicate a request the model/gateway will reject identically on replay
// (auth, malformed, not-found, payload-too-large, unprocessable). Never retried.
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);
// Transient statuses worth re-issuing: request timeout, conflict, too-early,
// rate-limit, and the 5xx family incl. Anthropic's 529 "overloaded".
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Substrings that mark a definitively fatal error even without a parseable status
// (e.g. an SDK auth error whose message carries no leading code).
const FATAL_KEYWORDS = [
  "invalid api key",
  "invalid x-api-key",
  "authentication",
  "unauthorized",
  "permission",
  "forbidden",
  "invalid_request_error",
];

/**
 * Classify an LLM stream failure as a mechanical (retryable) blip or a fatal error.
 *
 * Inputs are the terminal `error` AssistantMessage's `errorMessage` (a flattened
 * string — pi-ai stores `error.message` here, so an SDK `APIError` arrives status-
 * prefixed, e.g. `"429 {...}"`) and its `stopReason`.
 *
 * An intentional `aborted` (tool-call/turn cap, shutdown) is never retried. With a
 * parseable HTTP status we honour the known fatal/retryable sets (other 4xx → fatal,
 * other 5xx → retryable). With no status we treat explicit auth/validation keywords
 * as fatal and DEFAULT EVERYTHING ELSE TO RETRYABLE — mechanical failures (socket
 * resets, timeouts, transient parse errors, empty/unknown errors) dominate this path
 * and the bounded attempt count caps the cost of a wrong guess.
 */
export function classifyLlmError(
  errorMessage: string | undefined,
  stopReason: string | undefined,
): LlmErrorClass {
  if (stopReason === "aborted") return "fatal";
  const msg = (errorMessage ?? "").toLowerCase();

  const status = extractStatus(msg);
  if (status !== undefined) {
    if (RETRYABLE_STATUSES.has(status)) return "retryable";
    if (FATAL_STATUSES.has(status)) return "fatal";
    if (status >= 400 && status < 500) return "fatal";
    if (status >= 500) return "retryable";
  }

  if (FATAL_KEYWORDS.some((keyword) => msg.includes(keyword))) return "fatal";
  return "retryable";
}

/**
 * Extract an HTTP status from a flattened error message, conservatively. The
 * Anthropic SDK prefixes its `APIError.message` with the status code, so we trust
 * a leading 3-digit token; we also accept an explicit `status: NNN` / `status code
 * NNN` label. We deliberately do NOT scan arbitrary embedded numbers (a JSON body
 * may contain unrelated 3-digit values), to avoid a false fatal/retryable verdict.
 */
function extractStatus(msg: string): number | undefined {
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
 * Wrap a {@link StreamFn} with Layer-1 transparent request retry. When `retries`
 * is `0` the base function is returned unwrapped (no overhead, no behaviour change).
 */
export function withRequestRetry(
  base: StreamFn,
  options: RequestRetryOptions,
  ctx: RequestRetryContext = {},
): StreamFn {
  const maxAttempts = Math.max(1, Math.floor(options.retries) + 1);
  if (maxAttempts === 1) return base;

  return (model, context, streamOptions) => {
    const outer = createAssistantMessageEventStream();
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;

    void (async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const inner = await base(model, context, streamOptions);
        let committed = false;
        const buffered: AssistantMessageEvent[] = [];
        let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;

        for await (const event of inner) {
          if (committed) {
            // Past the commit point: forward verbatim. A terminal `done`/`error`
            // here auto-finalizes `outer` (EventStream.push resolves on it).
            outer.push(event);
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

        if (committed) return; // terminal already forwarded → `outer` is complete

        if (errorEvent) {
          const failure = errorEvent.error;
          const verdict = classifyLlmError(failure?.errorMessage, failure?.stopReason);
          const lastAttempt = attempt >= maxAttempts - 1;
          if (verdict === "retryable" && !lastAttempt) {
            const delay = backoffDelayMs(attempt, options.backoffBaseMs, options.backoffMaxMs);
            ctx.logger?.warn("llm_request_retry", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              attempt: attempt + 1,
              maxAttempts,
              delayMs: Math.round(delay),
              errorMessage: failure?.errorMessage,
            });
            try {
              await sleep(delay, signal);
            } catch {
              // Aborted mid-backoff (shutdown / cap): surface the original error.
              flush(outer, buffered);
              outer.push(errorEvent);
              return;
            }
            continue;
          }
          if (verdict === "retryable") {
            ctx.logger?.warn("llm_request_retries_exhausted", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              attempts: maxAttempts,
              errorMessage: failure?.errorMessage,
            });
          }
          flush(outer, buffered);
          outer.push(errorEvent);
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
        outer.push(synthesizeErrorEvent(model, "stream ended without a terminal event"));
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

/** Build a terminal `error` event mirroring the shape pi-ai providers emit. */
function synthesizeErrorEvent(
  model: Parameters<StreamFn>[0],
  message: string,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider ?? "unknown",
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error };
}
