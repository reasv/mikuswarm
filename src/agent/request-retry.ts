import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import type { LlmRequestRecord, LlmRequestRing } from "./request-ring.js";
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
// This wrapper does NOT distinguish a 429 originating at the LLM gateway
// (which already retries internally) from a 429 at the true upstream: it backs off
// and retries either way, which is always safe (spec §5.3 — 429 backoff is an
// unconditional invariant).
// =============================================================================

/**
 * Abort reason Layer 0 attaches when the wall-clock budget cuts short an
 * attempt that was IN FLIGHT and had produced zero tokens (a stall). The
 * admission wrapper reads it off the attempt signal and counts the attempt as an
 * ENVIRONMENTAL failure of that model: a silent hang is an outage, not a neutral
 * teardown. The caller's own abort (drain / Stop) never carries it.
 */
export const LLM_STALL_ABORT_REASON = "mikuswarm:llm-stall";

/** True when `signal` was aborted by Layer 0's wall-clock budget (a stall). */
export function isStallAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === LLM_STALL_ABORT_REASON;
}

/**
 * Per-REQUEST attempt bookkeeping shared between Layer 0 and the fallback
 * resolver (ARCHITECTURE.md §8a "One pass per request"). Layer 0 creates one per request and
 * threads it to every attempt under {@link REQUEST_ATTEMPT_STATE} on the stream
 * options; the resolver records each dispatch per failure domain so one request
 * walks the chain instead of re-hitting a member it already watched fail, and
 * flags when a failure will move to a different member (no local backoff then).
 */
export interface RequestAttemptState {
  /** Dispatches per model health key in the current pass over the chain. */
  attempts: Map<string, number>;
  /** Set at dispatch: should THIS attempt fail, the next goes to another member. */
  failoverOnFailure: boolean;
  /**
   * Health keys of the members that refused THIS request (class `refusal`).
   * Never re-hit within the request, across passes too (ARCHITECTURE.md §8a
   * "Refusals"). Layer 0 adds {@link servedKey} when an attempt is refused.
   */
  refused: Set<string>;
  /** Set at dispatch by the fallback resolver: the health key of the member serving this attempt. */
  servedKey?: string;
  /**
   * Set at dispatch by the fallback resolver: should THIS attempt be refused,
   * another member (not refused, healthy, in budget, fits) can take the request.
   */
  refusalFalloverAvailable: boolean;
  /**
   * True while THIS attempt waits for a scheduler slot (set by
   * `withSchedulerAdmission` around its acquire). An attempt aborted while it is
   * still true never reached the wire, so Layer 0 records no aborted request
   * for it (ARCHITECTURE.md §8b "Aborted requests"). Reset per attempt.
   */
  awaitingAdmission?: boolean;
}

export const REQUEST_ATTEMPT_STATE: unique symbol = Symbol("mikuswarm.requestAttemptState");

/** Read the per-request attempt state off stream options (undefined outside Layer 0). */
export function getRequestAttemptState(streamOptions: unknown): RequestAttemptState | undefined {
  if (!streamOptions || typeof streamOptions !== "object") return undefined;
  return (streamOptions as { [REQUEST_ATTEMPT_STATE]?: RequestAttemptState })[REQUEST_ATTEMPT_STATE];
}

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
  /**
   * Fired once per COMMITTED request (spec TOKEN-USAGE-TRACKING §3.1), with the
   * terminal `done` event's AssistantMessage (authoritative usage). Best-effort:
   * exceptions are swallowed; the hook can never affect the run. NOT fired for
   * terminal errors with zero-usage stubs —
   * this is the single authoritative usage capture point, distinct from the
   * observe-only `onAttemptEvent` tap (which also fires for discarded attempts).
   * Failed attempts with provider-reported usage (including refusals and aborts)
   * also fire exactly once, before retry/fallover/termination.
   */
  onRequestCommitted?: (message: AssistantMessage) => void;
  /**
   * Fired once for an attempt the CALLER aborted (the run's signal: operator
   * Stop, a redo, an interjection, a tool/turn cap) after the request reached
   * the wire — before or after its first stream event (ARCHITECTURE.md §8b
   * "Aborted requests"). The provider bills such a request although its stream
   * carries no (or only input) usage, so the hook records it with estimated
   * usage and returns that usage for the request ring. When wired, it replaces
   * the {@link onRequestCommitted} capture of an aborted attempt's reported
   * usage, so the attempt is counted exactly once. Best-effort: exceptions are
   * swallowed. Not fired for an attempt aborted while waiting for admission,
   * one whose signal was already aborted when it started, or a budget (stall)
   * abort, which is an environmental failure.
   */
  onRequestAborted?: (info: AbortedRequestInfo) => Usage | undefined;
  /**
   * Pre-flight context-budget check (spec TOKEN-USAGE-TRACKING §6.2). Evaluated
   * ONCE per request, before the first attempt (every Layer-0 attempt replays
   * the identical context, so per-attempt re-checking is meaningless). Returns a
   * violation message when the session must not issue this request (its observed
   * context already exceeds the effective limit); undefined otherwise. On a
   * violation the wrapper synthesizes a terminal error with that message,
   * classified `content` (deterministic on replay), and surfaces it WITHOUT
   * consuming any retry budget — reusing the content-class park/notice/worker-
   * retry machinery end to end. The hook owns its own logging (it has the
   * observed/limit numbers).
   */
  checkContextBudget?: () => string | undefined;
  /**
   * Pre-flight cost-budget check (spec SESSION-COST-LIMITS §2.2). Same contract
   * and timing as {@link checkContextBudget} — evaluated once before the first
   * attempt, returns a violation message when the session's combined (agent-loop
   * + tool) spend already meets the operative cost ceiling, undefined otherwise.
   * A violation is synthesized into the same `content`-class terminal error,
   * without consuming retry budget. The hook owns its own logging.
   */
  checkCostBudget?: () => string | undefined;
  /**
   * Budget-capped-truncation decision (spec PER-USER-LIMITS §5.4). Fired AFTER
   * {@link onRequestCommitted} when a clean `done` carries `stopReason: "length"`,
   * so the per-user counter already reflects the (real) truncated spend. The hook
   * decides whether that turn was a per-user BUDGET cap (the remaining headroom
   * could not buy a complete turn at this model) and, if so, re-selects a cheaper
   * model and returns `"reselect"` — the wrapper then DISCARDS the truncated turn
   * ("failed, not delivered") and re-issues on the re-selected model, which carries
   * the reserved headroom. Returns `"accept"` when the truncation is the model's own
   * `max_tokens` (a legitimate long answer) or no cheaper model remains (the floor).
   * Only wired for per-user sessions; bounded by the wrapper to avoid loops.
   */
  onBudgetTruncation?: (committed: AssistantMessage) => "reselect" | "accept";
  /**
   * Returns the LOGICAL id (config block name) of the chain member that
   * `buildModelFallback`'s `onResolve` resolved for the current attempt —
   * i.e., the model that actually dispatched the wire call. Absent getter or
   * `undefined` return = attempt never dispatched (budget violation, never
   * reached the fallback fn) or getter not wired (non-agent callers). Reset
   * between attempts via {@link resetServedModel}.
   */
  getServedModel?: () => string | undefined;
  /**
   * Called at the START of each retry-loop iteration to clear the per-attempt
   * served-model state, so a stale value from a prior attempt is never
   * accidentally read at the next attempt's settle (race-free within a session
   * because attempts are sequential, but the guard is cheap and explicit).
   */
  resetServedModel?: () => void;
  /**
   * Returns the LOGICAL id (config block name) of the REQUESTED model for
   * the current attempt (head or per-user selected). Absent getter = not
   * wired (callers that construct the retry context without wiring the getter;
   * no current production caller omits it); the ring record's `requestedModel`
   * field is then absent.
   */
  getRequestedModel?: () => string | undefined;
  /**
   * Whether a refused attempt may fall over to the next chain member, read once
   * per request (ARCHITECTURE.md §8a "Refusals"). Absent or true = fall over when
   * another member can serve; false = a refusal fails the request at once. The
   * session-record turn turns it off (spec SESSION-RECORDS §3.2).
   */
  refusalFallover?: () => boolean;
  /**
   * Refusal rules (spec REFUSAL-HANDLING §8.1): asked on every refused attempt,
   * after the refusing member was added to the request's `refused` set. Its
   * decision replaces the implicit chain fallover: `redo` re-issues the request
   * at once on the try the hook chose (a pinned rule entry, or the refusing model
   * again for a same-model retry), with the request's `refused` set and pass
   * cleared; `fallover` is the implicit fallover,
   * `fail` surfaces the refusal terminally, `withhold` settles the request as a
   * clean `NO_REPLY` turn with no failure. Absent or throwing = today's implicit
   * fallover. `log` fields join the `llm_refusal` line.
   */
  onRefusal?: (info: RefusalAttemptInfo) => RefusalDecision;
}

/** What Layer 0 knows about a refused attempt (see {@link RequestRetryContext.onRefusal}). */
/** What Layer 0 knows about a caller-aborted attempt ({@link RequestRetryContext.onRequestAborted}). */
export interface AbortedRequestInfo {
  /** The attempt's terminal `aborted` message; its usage is what the stream reported (often zeros). */
  message: AssistantMessage;
  /** Whether any stream event arrived before the abort (pi-ai's `start` follows the response headers). */
  firstEventSeen: boolean;
  /** The text, thinking and tool-call argument deltas streamed before the abort, concatenated. */
  streamedText: string;
  /** Milliseconds from the first stream event to the abort (0 when none arrived). */
  streamingMs?: number;
  /** 1-based attempt number within the request. */
  attempt: number;
}

export interface RefusalAttemptInfo {
  /** The refused attempt's terminal message: raw stop reason, category, usage, wire model. */
  message: AssistantMessage | undefined;
  /** Logical id of the member that refused (from `getServedModel`). */
  servedModel: string | undefined;
  /** 1-based attempt number within the request. */
  attempt: number;
  /** Health keys of every member that refused this request so far (the refusing one included). */
  refusedKeys: ReadonlySet<string>;
  /** Whether the implicit chain fallover would move this request to another member. */
  implicitFallover: boolean;
  /** Whether the wall-clock budget still allows re-issuing the request. */
  canReissue: boolean;
}

export type RefusalAction = "fallover" | "redo" | "fail" | "withhold";

export interface RefusalDecision {
  action: RefusalAction;
  /** Extra fields for the `llm_refusal` log line (check code, rule, outcome, target). */
  log?: Record<string, unknown>;
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
 * - `refusal` — the model or its provider's safety layer declined this request
 *   ({@link isRefusalSignal}). Not a health strike, never retried on the same
 *   member; Layer 0 falls over to another chain member when one can serve and
 *   the request allows it, else fails terminally. Content-like downstream.
 */
export type LlmErrorClass = "environmental" | "content" | "aborted" | "refusal";

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

const CLASS_MARKER_RE = /\[llm-request:(environmental|content|aborted|refusal)\]/;

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

// Raw provider stop reasons (pi-ai keeps them on `AssistantMessage.rawStopReason`,
// lower-cased here) that mean the model or the provider's safety layer declined
// the request. pi-ai maps each of them to `stopReason: "error"`.
const REFUSAL_RAW_STOP_REASONS = new Set([
  "refusal", // Anthropic Messages (`stop_details.explanation` becomes the error text)
  "sensitive", // Anthropic safety-filter stop
  "content_filter", // OpenAI chat completions and compatible gateways (`finish_reason`)
  "incomplete.content_filter", // OpenAI Responses: `${status}.${incomplete_details.reason}`
  "content_filtered", // Bedrock Converse
  "guardrail_intervened", // Bedrock Converse
  "safety", // Google (`finishReason`, upper-case on the wire)
  "prohibited_content", // Google
  "blocklist", // Google
  "spii", // Google
]);

// The error texts pi-ai writes for those stops, matched against the WHOLE
// de-tagged message (lower-cased). Only a fallback for when the raw stop reason
// is gone (a re-classification from the flattened string); kept exact so an
// ordinary error that merely mentions "refused" (e.g. "connection refused") or a
// content filter inside a longer body never matches. An Anthropic refusal with a
// `stop_details.explanation` is free text: only the raw stop reason detects it.
const REFUSAL_MESSAGE_RES = [
  /^the model refused to complete the request$/,
  /^provider stopped with: (sensitive|content_filtered|guardrail_intervened|safety|prohibited_content|blocklist|spii)$/,
  /^provider finish_reason: content_filter$/,
  /^response incomplete: content_filter$/,
];

/**
 * True when a failed request was a provider refusal (ARCHITECTURE.md §8a
 * "Refusals"): the structured raw stop reason first, else the exact error text
 * pi-ai writes for a refusal stop. Origin/class markers are ignored.
 */
export function isRefusalSignal(rawStopReason: string | undefined, errorMessage: string | undefined): boolean {
  if (rawStopReason && REFUSAL_RAW_STOP_REASONS.has(rawStopReason.trim().toLowerCase())) return true;
  const msg = stripLlmRequestTag(errorMessage ?? "").toLowerCase();
  return msg.length > 0 && REFUSAL_MESSAGE_RES.some((re) => re.test(msg));
}

/**
 * Classify an LLM stream failure (spec LLM-FAILURE-HANDLING §3):
 * `environmental` / `content` / `aborted` / `refusal`, replacing the old
 * retryable/fatal binary.
 *
 * Inputs are the terminal `error` AssistantMessage's `errorMessage` (a flattened
 * string — pi-ai stores `error.message` here, so an SDK `APIError` arrives status-
 * prefixed, e.g. `"429 {...}"`), its `stopReason`, and its `rawStopReason` (the
 * provider's own stop reason, when the provider stopped on its own).
 *
 * An intentional `aborted` (tool-call/turn cap, shutdown, scheduler stop) is
 * never retried. A `refusal` ({@link isRefusalSignal}) is checked next: it
 * carries no HTTP status. `content` requires positive evidence — a 400/413/422 status or
 * an explicit context-length keyword. EVERYTHING ELSE IS `environmental`:
 * timeouts, resets, empty streams, every other status (5xx, 429, and the
 * 401/403/404/405 endpoint-level failures), auth keywords, and anything
 * unparseable — mechanical blips dominate that path, and the scheduler's
 * model-health gating bounds the cost of a wrong guess.
 */
export function classifyLlmError(
  errorMessage: string | undefined,
  stopReason: string | undefined,
  rawStopReason?: string,
): LlmErrorClass {
  if (stopReason === "aborted") return "aborted";
  const msg = (errorMessage ?? "").toLowerCase();
  if (msg.includes(SCHEDULER_STOPPED_KEYWORD)) return "aborted";
  if (isRefusalSignal(rawStopReason, errorMessage)) return "refusal";

  const status = extractStatus(msg);
  if (status !== undefined && CONTENT_STATUSES.has(status)) return "content";
  if (CONTENT_KEYWORDS.some((keyword) => msg.includes(keyword))) return "content";
  // A parseable TRANSIENT status (429 or any 5xx) is authoritative: such a
  // failure is environmental and must stay retryable regardless of its body
  // text (#4). The pi-ai overflow augmentation below relies on body phrasing,
  // and its NON_OVERFLOW_PATTERNS exclude only the literal "rate limit" / "too
  // many requests" wordings — a 429 phrased "too many tokens in flight, retry
  // later" would otherwise be misread as overflow → `content` (non-retryable),
  // parking the session on a transient blip. So the augmentation is consulted
  // ONLY when the status is undefined or non-transient.
  const transient = status === 429 || (status !== undefined && status >= 500 && status < 600);
  if (!transient && isContextOverflow({
      role: "assistant",
      api: "anthropic-messages",
      provider: "unknown",
      model: "unknown",
      // Only reached for error/synthesized turns, so `stopReason` here is always
      // `error`; hard-coding it (ignoring the real arg) is safe (#5).
      stopReason: "error",
      errorMessage: errorMessage ?? "",
      content: [],
      timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    })
  ) {
    return "content";
  }
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
    /**
     * Record one settled attempt on the in-memory ring (spec §9.2). Returns the
     * stored record object (or undefined when no ring is wired / it threw) so a
     * caller can later mutate it in place — the ring keeps entries by reference,
     * so an in-place update is reflected by `list()` without appending a row.
     */
    const recordAttempt = (
      attempt: number,
      startedAt: number,
      outcome: "done" | "error" | "aborted",
      details?: {
        status?: number;
        cls?: LlmErrorClass;
        errorMessage?: string;
        usage?: LlmRequestRecord["usage"];
      },
    ): LlmRequestRecord | undefined => {
      try {
        const record: LlmRequestRecord = {
          ts: Date.now(),
          sessionId: ctx.sessionId,
          sessionType: ctx.sessionType,
          group: ctx.group,
          model: (model as { id?: string }).id ?? "unknown",
          requestedModel: ctx.getRequestedModel?.(),
          servedModel: ctx.getServedModel?.(),
          priority: ctx.priority,
          attempt,
          admissionWaitMs: ctx.takeAdmissionWaitMs?.(),
          durationMs: Date.now() - startedAt,
          outcome,
          status: details?.status,
          class: details?.cls,
          errorMessage: details?.errorMessage,
          usage: details?.usage,
        };
        ctx.ring?.record(record);
        return ctx.ring ? record : undefined;
      } catch {
        /* observe-only */
        return undefined;
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
        // Pre-flight context-budget check (spec TOKEN-USAGE-TRACKING §6.2):
        // evaluated ONCE, before any attempt. A violation pre-empts the request
        // — it synthesizes a `content`-class terminal error (the same shape a
        // provider "prompt is too long" rejection takes, which it pre-empts) and
        // surfaces it without consuming retry budget. The hook logs the
        // observed/limit numbers itself; here we only record + surface.
        //
        // Exception-isolated like every other hook: the factory-bound impl calls
        // `logger.warn(...)`, which can throw. An unguarded throw here would
        // escape the void-IIFE as an unhandled rejection (process-fatal) and
        // `outer` would never terminate (hung consumer) (#12). On a throw we
        // degrade to "no local block" — the provider remains authority on an
        // oversized request (the D3 fallback).
        let budgetViolation: string | undefined;
        try {
          // Both pre-flight budgets share this content-class synthesis path; the
          // first violation (context, then cost) wins. Either being undefined
          // (unwired or within limits) defers to the next / to issuing the request.
          budgetViolation = ctx.checkContextBudget?.() ?? ctx.checkCostBudget?.();
        } catch (err) {
          budgetViolation = undefined;
          try {
            ctx.logger?.warn("llm_request_budget_check_threw", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          } catch {
            /* the logger itself may be the thing that threw — never re-raise */
          }
        }
        if (budgetViolation !== undefined) {
          const violationStart = Date.now();
          const errorEvent = synthesizeErrorEvent(model, budgetViolation, "error");
          recordAttempt(1, violationStart, "error", {
            cls: "content",
            errorMessage: budgetViolation,
          });
          surface(errorEvent, "content");
          return;
        }
        // §5.4 budget-capped re-drive bound: a generous backstop in case the hook
        // ever fails to converge (it self-bounds by the preference-set size). No
        // realistic per-user model set degrades more times than this.
        let budgetReselects = 0;
        const maxBudgetReselects = 16;
        // One per request: the fallback resolver's per-request pass over the chain.
        const attemptState: RequestAttemptState = {
          attempts: new Map(),
          failoverOnFailure: false,
          refused: new Set(),
          refusalFalloverAvailable: false,
        };
        // Whether a refusal may move to another chain member, read once per
        // request (§8a "Refusals"); the record turn turns it off.
        let refusalFallover = true;
        try {
          refusalFallover = ctx.refusalFallover?.() !== false;
        } catch {
          /* a throwing getter keeps the default */
        }
        for (let attempt = 0; ; attempt++) {
          // Reset per-attempt served-model tracking so a stale value from a
          // prior attempt is never read at this attempt's settle (§ served-model
          // attribution). Safe: attempts within a session are sequential.
          ctx.resetServedModel?.();
          // A billed failed attempt can exhaust the budget before its retry.
          if (attempt > 0) {
            let violation: string | undefined;
            try { violation = ctx.checkCostBudget?.(); } catch { /* same best-effort policy as initial pre-flight */ }
            if (violation !== undefined) {
              const error = synthesizeErrorEvent(model, violation, "error");
              recordAttempt(attempt + 1, Date.now(), "error", { cls: "content" });
              surface(error, "content");
              return;
            }
          }
          const attemptStart = Date.now();
          const buffered: AssistantMessageEvent[] = [];
          let errorEvent: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
          let producedTokens = false;
          // Aborted-request accounting (§8b "Aborted requests"): a signal already
          // aborted at the attempt's start never reaches the wire; any stream
          // event marks the request as answered; the streamed deltas are the
          // basis of the output estimate (collected only when the hook is wired).
          const abortedAtStart = callerSignal?.aborted === true;
          let firstEventSeen = false;
          let firstEventAt: number | undefined;
          const streamedDeltas: string[] | undefined = ctx.onRequestAborted ? [] : undefined;

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
          // The budget's abort carries the stall marker: it only ever reaches an
          // attempt that has produced no tokens (see below), so the admission
          // wrapper counts an in-flight one as a failure of its model.
          const onBudgetAbort = () => attemptCtrl.abort(LLM_STALL_ABORT_REASON);
          if (callerSignal) {
            if (callerSignal.aborted) attemptCtrl.abort();
            else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
          }
          if (budgetSignal) {
            if (budgetSignal.aborted) attemptCtrl.abort(LLM_STALL_ABORT_REASON);
            else budgetSignal.addEventListener("abort", onBudgetAbort, { once: true });
          }
          const detachBudget = () => {
            budgetSignal?.removeEventListener("abort", onBudgetAbort);
          };
          const detachCaller = () => {
            callerSignal?.removeEventListener("abort", onCallerAbort);
          };
          attemptState.failoverOnFailure = false;
          attemptState.servedKey = undefined;
          attemptState.refusalFalloverAvailable = false;
          attemptState.awaitingAdmission = undefined;
          const attemptOptions = {
            ...((streamOptions as object | undefined) ?? {}),
            signal: attemptCtrl.signal,
            [REQUEST_ATTEMPT_STATE]: attemptState,
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
              if (!firstEventSeen) firstEventAt = Date.now();
              firstEventSeen = true;
              if (
                streamedDeltas &&
                (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
              ) {
                streamedDeltas.push(event.delta);
              }
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
              //
              // THE commit point (spec TOKEN-USAGE-TRACKING §3.1): the terminal
              // message carries authoritative usage. Record it on the ring and
              // fire the per-request capture hook (best-effort) before flushing.
              const committed = terminal.message;
              const usage = committed?.usage;
              recordAttempt(attempt + 1, attemptStart, "done", {
                usage: usage
                  ? {
                      input: usage.input,
                      output: usage.output,
                      cacheRead: usage.cacheRead,
                      cacheWrite: usage.cacheWrite,
                      totalTokens: usage.totalTokens,
                      cost: usage.cost?.total ?? 0,
                    }
                  : undefined,
              });
              // Only fire when authoritative usage is present — symmetric with
              // the ring branch above (#3). A `done` lacking `usage` would make
              // the factory-bound hook call `record(undefined)`, which throws;
              // the throw is swallowed below, silently dropping the request from
              // the tracker. Gating here keeps the two capture branches
              // consistent and avoids that hidden undercount.
              if (committed && usage) {
                try {
                  ctx.onRequestCommitted?.(committed);
                } catch {
                  /* best-effort: the capture hook can never affect the run */
                }
              }
              // §5.4: a per-user BUDGET-capped (output-truncated) turn is "failed,
              // not delivered" — `onRequestCommitted` above already recorded its
              // (real) spend, so the per-user counter now reflects it. Ask the hook
              // whether to re-select a cheaper model; on `"reselect"` DISCARD the
              // truncated buffer and re-issue (the outer selector dispatches the
              // re-selected model with its reserved headroom). Bounded; only fires
              // for per-user sessions (the hook is otherwise unset).
              if (
                committed?.stopReason === "length" &&
                ctx.onBudgetTruncation &&
                budgetReselects < maxBudgetReselects
              ) {
                let decision: "reselect" | "accept" = "accept";
                try {
                  decision = ctx.onBudgetTruncation(committed);
                } catch {
                  decision = "accept";
                }
                if (decision === "reselect") {
                  budgetReselects++;
                  tapDiscarded(attempt + 1, "budget-capped turn re-driven on a cheaper model");
                  continue; // re-issue with the re-selected model; truncated content dropped
                }
              }
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
          let verdict = classifyLlmError(failure?.errorMessage, failure?.stopReason, failure?.rawStopReason);

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
          const attemptRecord = recordAttempt(
            attempt + 1,
            attemptStart,
            verdict === "aborted" ? "aborted" : "error",
            {
              status: extractStatus((errorEvent.error?.errorMessage ?? "").toLowerCase()),
              cls: verdict,
              errorMessage: errorEvent.error?.errorMessage,
            },
          );

          // A request the CALLER aborted after it reached the wire is billed by
          // the provider although its stream reported little or no usage (§8b
          // "Aborted requests"): the hook records it once, with estimated usage,
          // in place of the reported-usage capture below. Never retried, so no
          // later attempt can count it again.
          const abortedOnWire =
            verdict === "aborted" &&
            callerSignal?.aborted === true &&
            !abortedAtStart &&
            attemptState.awaitingAdmission !== true &&
            ctx.onRequestAborted !== undefined;
          if (abortedOnWire) {
            let recorded: Usage | undefined;
            try {
              recorded = ctx.onRequestAborted!({
                message: failure,
                firstEventSeen,
                streamedText: streamedDeltas?.join("") ?? "",
                streamingMs: firstEventAt !== undefined ? Date.now() - firstEventAt : 0,
                attempt: attempt + 1,
              });
            } catch {
              /* best-effort: the capture hook can never affect the run */
            }
            if (attemptRecord && recorded) {
              attemptRecord.usage = {
                input: recorded.input,
                output: recorded.output,
                cacheRead: recorded.cacheRead,
                cacheWrite: recorded.cacheWrite,
                totalTokens: recorded.totalTokens,
                cost: recorded.cost?.total ?? 0,
              };
              attemptRecord.estimated = true;
            }
          }

          // Preserve provider-reported usage for EVERY failed attempt, including
          // aborted and retried streams. Zero-usage stubs are not estimates.
          const billedUsage = abortedOnWire ? undefined : failure?.usage;
          if (billedUsage && [billedUsage.totalTokens, billedUsage.input, billedUsage.output,
            billedUsage.cacheRead, billedUsage.cacheWrite, billedUsage.cost?.total ?? 0].some((n) => n > 0)) {
            if (attemptRecord) {
              attemptRecord.usage = {
                input: failure.usage.input,
                output: failure.usage.output,
                cacheRead: failure.usage.cacheRead,
                cacheWrite: failure.usage.cacheWrite,
                totalTokens: failure.usage.totalTokens,
                cost: failure.usage.cost?.total ?? 0,
              };
            }
            try {
              ctx.onRequestCommitted?.(failure);
            } catch {
              /* best-effort: the capture hook can never affect the run */
            }
          }

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
            // Nor when the next attempt fails over to a DIFFERENT chain member:
            // backoff paces re-hitting the same upstream, and moving on to a
            // working member must never wait (ARCHITECTURE.md §8a "One pass per request").
            let delay =
              attemptState.failoverOnFailure || ctx.isQueueWaitPoint?.()
                ? 0
                : backoffDelayMs(attempt, options.backoffBaseMs, options.backoffMaxMs);
            if (Number.isFinite(deadline)) delay = Math.min(delay, Math.max(0, deadline - Date.now()));
            try {
              await sleep(delay, sleepSignal);
            } catch {
              // Aborted mid-backoff. `sleepSignal` is (caller ∨ budget), so an
              // abort here is one of two distinct events that MUST be told apart
              // (issue #4):
              //
              //  - BUDGET expiry (caller did NOT abort): genuine wait-exhaustion,
              //    not a drain. Loop once more and exit via the wait-exhausted
              //    path above, preserving the environmental semantics (parks
              //    failed-resumable).
              //
              //  - CALLER abort (drain / operator Stop): this is an intentional
              //    abort. Surfacing the STALE environmental error here would make
              //    `wasRunAborted()` read false in the worker pools, sending a
              //    drained job down the SEMANTIC failure path — the claim-time
              //    attempts increment is then NOT compensated, and at the retry
              //    edge a routine restart can terminally fail a diary job or
              //    permanently commit a `truncated` summary (spec §6/§7). Instead
              //    synthesize an `aborted` event (matching the in-attempt
              //    AbortError path's `stopReason:"aborted"` + `[llm-request:aborted]`
              //    class marker), so the drain compensation fires.
              if (budgetCtrl?.signal.aborted === true && callerSignal?.aborted !== true) {
                continue;
              }
              if (callerSignal?.aborted === true) {
                const aborted = synthesizeErrorEvent(
                  model,
                  errorEvent.error?.errorMessage ?? "aborted",
                  "aborted",
                );
                // De-dupe (issue FU-B): this attempt's environmental wire result
                // was ALREADY recorded on the ring before the backoff sleep. The
                // drain landed during the inter-attempt wait — no NEW wire call
                // happened — so the terminal disposition of the SAME attempt
                // changed from environmental to aborted-on-drain. Update that row
                // in place (the ring holds it by reference) rather than appending
                // a duplicate row for the same attempt number.
                if (attemptRecord) {
                  attemptRecord.outcome = "aborted";
                  attemptRecord.class = "aborted";
                  attemptRecord.status = undefined;
                  attemptRecord.errorMessage = aborted.error?.errorMessage;
                  attemptRecord.ts = Date.now();
                  attemptRecord.durationMs = Date.now() - attemptStart;
                } else {
                  recordAttempt(attempt + 1, attemptStart, "aborted", {
                    cls: "aborted",
                    errorMessage: aborted.error?.errorMessage,
                  });
                }
                surface(aborted, "aborted");
                return;
              }
              surface(errorEvent, verdict);
              return;
            }
            continue;
          }

          if (verdict === "refusal") {
            // A refusal (§8a "Refusals") is not a health strike (the admission
            // wrapper notes it neutral) and is never re-sent to the member that
            // refused. It moves to another chain member that can serve now, with
            // no backoff, when the request allows it and the budget is not
            // spent; otherwise it fails at once, terminally — the wall-clock
            // loop never re-runs it.
            if (attemptState.servedKey !== undefined) attemptState.refused.add(attemptState.servedKey);
            const canReissue = !budgetExpired && Date.now() < deadline;
            const fallover = refusalFallover && attemptState.refusalFalloverAvailable && canReissue;
            const servedModel = ctx.getServedModel?.();
            // Refusal rules (spec REFUSAL-HANDLING §8.1): a matching rule
            // replaces the implicit fallover; no rule keeps it.
            let decision: RefusalDecision = { action: fallover ? "fallover" : "fail" };
            if (ctx.onRefusal) {
              try {
                decision = ctx.onRefusal({
                  message: failure,
                  servedModel,
                  attempt: attempt + 1,
                  refusedKeys: attemptState.refused,
                  implicitFallover: fallover,
                  canReissue,
                });
              } catch {
                /* a throwing hook keeps the implicit behaviour */
              }
            }
            const explanation = failure?.errorMessage ?? "";
            ctx.logger?.warn("llm_refusal", {
              sessionId: ctx.sessionId,
              timelineKey: ctx.timelineKey,
              sessionType: ctx.sessionType,
              group: ctx.group,
              member: servedModel,
              model: failure?.model ?? (model as { id?: string }).id,
              rawStopReason: failure?.rawStopReason,
              explanation: explanation.length > 300 ? `${explanation.slice(0, 300)}…` : explanation,
              attempt: attempt + 1,
              fallover: decision.action === "fallover",
              ...(decision.log ?? {}),
            });
            if (decision.action === "redo" && canReissue) {
              // A rule's try is a fresh request on its entry: it may re-send to
              // the member that refused (spec REFUSAL-HANDLING §8.1 tries), and
              // the new target starts a fresh pass over its own chain.
              attemptState.refused.clear();
              attemptState.attempts.clear();
            }
            if ((decision.action === "fallover" || decision.action === "redo") && canReissue) {
              tapDiscarded(attempt + 1, `refused: ${errorEvent.error?.errorMessage ?? "refusal"}`);
              continue;
            }
            if (decision.action === "withhold") {
              // The rule's entries are exhausted and the operator chose to send
              // nothing: the request settles as a clean NO_REPLY turn (no failure,
              // no notice), so the run ends the way an explicit NO_REPLY does.
              tapDiscarded(attempt + 1, `refused: ${errorEvent.error?.errorMessage ?? "refusal"}`);
              flush(outer, withheldTurnEvents(model, failure));
              return;
            }
            surface(errorEvent, verdict);
            return;
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
  const resolved = cls ?? classifyLlmError(failure?.errorMessage, failure?.stopReason, failure?.rawStopReason);
  return {
    ...event,
    error: { ...event.error, errorMessage: tagLlmRequestError(event.error?.errorMessage, resolved) },
  };
}

/**
 * The events of a harness-written `NO_REPLY` turn that stands in for a refused
 * request whose refusal rule withholds the reply (spec REFUSAL-HANDLING §8.2
 * `on_exhausted = "withhold"`). Zero usage: the refused attempts were already
 * billed through `onRequestCommitted`. Marked `harness: { kind:
 * "refusal_withheld" }` so it is never mistaken for the model's own output.
 */
function withheldTurnEvents(
  model: Parameters<StreamFn>[0],
  refused: AssistantMessage | undefined,
): AssistantMessageEvent[] {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "NO_REPLY" }],
    api: refused?.api ?? model.api,
    provider: refused?.provider ?? model.provider ?? "unknown",
    model: refused?.model ?? model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    harness: { kind: "refusal_withheld" },
  } as AssistantMessage;
  return [
    { type: "start", partial: message },
    { type: "done", reason: "stop", message },
  ];
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
