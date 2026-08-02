import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { ContextMessage } from "../context/builder.js";
import type { SessionUsageTracker } from "./usage.js";
import { redactSecrets } from "../config/redaction.js";

/**
 * Session capture (Phase 1, Step 2).
 *
 * Persists the frozen context snapshot (once, on attach) and the live transcript
 * (flushed on every `turn_end` / `agent_end`) for a session, with image base64
 * payloads externalized to refs and secrets redacted. This helper is content-only
 * — it NEVER touches session status (that is the caller's concern in Step 3).
 *
 * Both the chat path and the summarization path use this in Step 3.
 */

export interface SessionCaptureContext {
  storage: Storage;
  sessionId: string;
  /** Frozen context prefix from CreatedAgent (includes system + tier metadata). */
  snapshot?: ContextMessage[];
  tokenEstimate?: number;
  /** context_dump_path for parity; may be undefined. */
  dumpPath?: string;
  /**
   * Per-session-run usage accumulator (spec TOKEN-USAGE-TRACKING §4.3). When
   * provided, the session's actuals aggregate is persisted on every committed
   * request via a tracker subscription (`onUpdate` → `updateAgentSessionUsage`),
   * unsubscribed on {@link SessionCaptureHandle.detach}. Absent (tests/headless)
   * = no usage persistence.
   */
  usage?: SessionUsageTracker;
  /**
   * Attribution for the `session_usage` settle log (spec TOKEN-USAGE-TRACKING
   * §8): one greppable line at detach carrying the totals snapshot. Optional —
   * absent fields are simply omitted from the log.
   */
  timelineKey?: string;
  sessionType?: string;
  /**
   * The session type's CONFIGURED model, resolved once at wiring time. It is
   * the pre-commit fallback only: once a request commits, the tracker's billed
   * model wins for both the durable row and the settle log, because fallback
   * and per-user selection can serve a different model than this one.
   */
  model?: string;
  /**
   * Resolved per-session cost ceiling (USD) for this run (spec
   * SESSION-COST-LIMITS §6) — `factory.resolveSessionCostCeiling(sessionType)`,
   * resolved ONCE per session at the wiring site (shared with the soft-warn
   * watcher) and threaded through, not re-resolved here. Emitted in the
   * `session_usage` settle log alongside `combinedCost` so that greppable line
   * is self-contained (spend vs. the ceiling it was measured against). Absent =
   * unlimited (or a call site with no ceiling) → logged as `null`.
   */
  maxSessionCostUsd?: number;
  logger?: Logger;
}

/**
 * Minimal structural slice of the pi-agent-core `Agent` we depend on, so tests
 * can supply a lightweight stub. Structurally compatible with the real `Agent`
 * (`subscribe` at agent.d.ts:66, `state.messages` an `AgentMessage[]`).
 */
export interface CapturableAgent {
  subscribe(
    listener: (
      event: { type: string; messages?: AgentMessage[] },
      signal: AbortSignal,
    ) => void | Promise<void>,
  ): () => void;
  state: { messages: AgentMessage[]; errorMessage?: string };
}

/**
 * Handle returned by {@link attachSessionCapture}.
 *
 * - `detach()` unsubscribes the agent listener (the live transcript stops being
 *   flushed). It does NOT write anything.
 * - `flushNow()` performs a best-effort, one-shot serialize of the current
 *   `agent.state.messages` → `saveAgentSessionTranscript`. It is used by the
 *   error/abort paths (issue #1) to durably capture the kickoff turn (and any
 *   partial assistant message) even when the run rejects before any `turn_end`
 *   fires. It never throws — failures are logged and swallowed so they cannot
 *   mask the original error.
 */
export interface SessionCaptureHandle {
  detach(): void;
  flushNow(): Promise<void>;
}

/**
 * Reference left in persisted JSON where a base64 image payload used to live.
 * For ContextMessage image blocks we can recover the bytes later via the media
 * endpoint using `eventId`/`attachmentId`; for inline content-block images we
 * only retain mime/size (best-effort, per spec §3).
 */
export interface ImageRef {
  __imageRef: true;
  eventId?: string;
  attachmentId?: string;
  mimeType?: string;
  sizeBytes: number;
}

/**
 * Decoded byte length of a base64 payload, computed arithmetically — without
 * allocating/decoding the whole payload (issue #9). Strips an optional `data:`
 * URI prefix and all whitespace, then derives `floor(len * 3 / 4) - padding`,
 * where `padding` is the count of trailing `=`. Malformed input (non-base64
 * characters, lengths that aren't a valid base64 length) yields 0 so a bad
 * payload can never throw out of the capture path.
 *
 * @internal Exported for testing.
 */
export function base64ByteLength(b64: string): number {
  if (typeof b64 !== "string" || b64.length === 0) return 0;
  // Strip any data: URI prefix before measuring.
  const comma = b64.indexOf(",");
  const withoutPrefix =
    comma >= 0 && b64.slice(0, comma).includes("base64") ? b64.slice(comma + 1) : b64;
  // Remove all whitespace (base64 may be line-wrapped).
  const raw = withoutPrefix.replace(/\s/g, "");
  if (raw.length === 0) return 0;
  // A valid base64 string (no padding stripped) has length divisible by 4.
  // Unpadded base64 has length % 4 ∈ {2, 3}; length % 4 === 1 is impossible.
  const rem = raw.length % 4;
  if (rem === 1) return 0;
  // Reject anything that isn't base64 (incl. base64url, which we don't emit).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return 0;
  let padding = 0;
  if (raw.endsWith("==")) padding = 2;
  else if (raw.endsWith("=")) padding = 1;
  // For padded input (length a multiple of 4) `floor(len*3/4)` counts the
  // padding bytes, so subtract them. For unpadded input there is no padding to
  // remove and `floor(len*3/4)` already yields the decoded length directly.
  const bytes = Math.floor((raw.length * 3) / 4) - padding;
  return bytes < 0 ? 0 : bytes;
}

/**
 * Matches an inline `data:[<mediatype>][;base64],<payload>` URI anywhere inside a
 * string. We only externalize the base64-encoded variant — that is the only one
 * that carries a heavy binary payload worth stripping (and the only one that can
 * leak raw image bytes into persisted JSON, issue #8).
 */
const DATA_URI_RE = /data:([\w.+-]+\/[\w.+-]+)?;base64,([A-Za-z0-9+/]+={0,2})/g;

/**
 * Replace every `data:[mime];base64,<...>` substring in a string with a compact,
 * lossless-enough marker (`data:[mime];base64,<imageRef sizeBytes=N>`), so no raw
 * base64 survives serialization even when it is embedded inside text content
 * rather than a structured image block. Returns the input unchanged when it holds
 * no base64 data URI.
 */
function stripDataUris(text: string): string {
  if (!text.includes(";base64,")) return text;
  return text.replace(DATA_URI_RE, (_match, mime: string | undefined, payload: string) => {
    const size = base64ByteLength(payload);
    const mimePart = mime ? `${mime};` : "";
    return `data:${mimePart}base64,<imageRef sizeBytes=${size}>`;
  });
}

/**
 * Pure deep-clone that replaces every base64 image payload with an {@link ImageRef}.
 * Never mutates the input (the live `agent.state.messages` / `snapshot` arrays).
 *
 * Exhaustive across the shapes any layer can emit (issue #8):
 *  - ContextMessage `imageBlocks`: `{ eventId, attachmentId, mediaType, dataBase64 }`
 *  - Anthropic image content block: `{ type: "image", source: { type: "base64", media_type, data } }`
 *    (incl. tool_result content arrays).
 *  - pi-ai inline image content block: `{ type: "image", data: <base64>, mimeType }`
 *    (no `source` wrapper; used in UserMessage/ToolResultMessage content arrays).
 *  - OpenAI-style image block: `{ type: "image_url", image_url: { url } }` or a
 *    bare `{ url }` block, where `url` is a `data:...;base64,` URI.
 *  - As a structural backstop, any `source` object whose `type === "base64"` and
 *    that carries a `data` string is externalized regardless of the parent shape.
 *  - As a final string-level backstop, any `data:[mime];base64,<...>` substring
 *    inside ANY string in the tree is stripped, so raw base64 can never survive
 *    serialization even when embedded in free text.
 *
 * Where derivable, refs record `mimeType` + `sizeBytes` (plus `eventId`/
 * `attachmentId` for ContextMessage blocks) so the record stays lossless enough
 * to rehydrate on resume.
 */
export function externalizeImages<T>(value: T): T {
  return externalize(value) as T;
}

/** Parse a `data:[mime];base64,<payload>` URI into a ref, or null if not one. */
function dataUriToRef(url: string): ImageRef | null {
  if (typeof url !== "string") return null;
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0 || !url.slice(0, comma).includes("base64")) {
    return null;
  }
  const header = url.slice("data:".length, comma); // e.g. "image/png;base64"
  const mime = header.split(";")[0];
  return {
    __imageRef: true,
    mimeType: mime && mime.length > 0 ? mime : undefined,
    sizeBytes: base64ByteLength(url),
  };
}

function externalize(value: unknown): unknown {
  if (typeof value === "string") {
    // String-level backstop: strip any embedded base64 data URI.
    return stripDataUris(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(externalize);
  }

  const obj = value as Record<string, unknown>;

  // ContextMessage image block: { eventId, attachmentId, mediaType, dataBase64 }
  if (typeof obj.dataBase64 === "string") {
    const ref: ImageRef = {
      __imageRef: true,
      eventId: typeof obj.eventId === "string" ? obj.eventId : undefined,
      attachmentId: typeof obj.attachmentId === "string" ? obj.attachmentId : undefined,
      mimeType: typeof obj.mediaType === "string" ? obj.mediaType : undefined,
      sizeBytes: base64ByteLength(obj.dataBase64),
    };
    return ref;
  }

  // Anthropic image content block: { type: "image", source: { type: "base64", media_type, data } }
  if (obj.type === "image" && obj.source && typeof obj.source === "object") {
    const source = obj.source as Record<string, unknown>;
    if (typeof source.data === "string") {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "source") continue;
        rest[k] = externalize(v);
      }
      const ref: ImageRef = {
        __imageRef: true,
        mimeType: typeof source.media_type === "string" ? source.media_type : undefined,
        sizeBytes: base64ByteLength(source.data),
      };
      return { ...rest, source: ref };
    }
  }

  // pi-ai inline image content block: { type: "image", data: <base64>, mimeType }
  // (pi-ai `ImageContent`, used in UserMessage/ToolResultMessage content arrays).
  // Distinct from the Anthropic shape above, which wraps the payload in `source`;
  // guarding on the ABSENCE of `source` keeps the two branches from colliding.
  if (obj.type === "image" && typeof obj.data === "string" && obj.source === undefined) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "data") continue;
      rest[k] = externalize(v);
    }
    const ref: ImageRef = {
      __imageRef: true,
      mimeType: typeof obj.mimeType === "string" ? obj.mimeType : undefined,
      sizeBytes: base64ByteLength(obj.data),
    };
    return { ...rest, data: ref };
  }

  // OpenAI-style image block: { type: "image_url", image_url: { url } } — the url
  // is typically a `data:...;base64,` URI. Externalize the nested url when so.
  if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
    const imageUrl = obj.image_url as Record<string, unknown>;
    if (typeof imageUrl.url === "string") {
      const ref = dataUriToRef(imageUrl.url);
      if (ref) {
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === "image_url") continue;
          rest[k] = externalize(v);
        }
        // Preserve any sibling fields on image_url (e.g. detail) while replacing url.
        const restImageUrl: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(imageUrl)) {
          if (k === "url") continue;
          restImageUrl[k] = externalize(v);
        }
        return { ...rest, image_url: { ...restImageUrl, url: ref } };
      }
    }
  }

  // Bare `{ url: "data:...;base64,..." }` block (no recognized wrapper type).
  if (typeof obj.url === "string") {
    const ref = dataUriToRef(obj.url);
    if (ref) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "url") continue;
        rest[k] = externalize(v);
      }
      return { ...rest, url: ref };
    }
  }

  // Generic recursion, with a backstop for any stray base64 `data` under a base64 source.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === "source" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (v as Record<string, unknown>).type === "base64" &&
      typeof (v as Record<string, unknown>).data === "string"
    ) {
      const src = v as Record<string, unknown>;
      const ref: ImageRef = {
        __imageRef: true,
        mimeType: typeof src.media_type === "string" ? src.media_type : undefined,
        sizeBytes: base64ByteLength(src.data as string),
      };
      out[k] = ref;
      continue;
    }
    out[k] = externalize(v);
  }
  return out;
}

function serialize(value: unknown): string {
  return redactSecrets(JSON.stringify(externalizeImages(value)));
}

/**
 * Attach snapshot + transcript capture to an agent.
 *
 * 1. Snapshot is written once, immediately. The snapshot write is *enqueued*
 *    before any transcript write: the first transcript flush (whether from a
 *    `turn_end`/`agent_end` event or from {@link SessionCaptureHandle.flushNow})
 *    is chained behind the snapshot-enqueue promise (issue #10). This guarantees
 *    the documented "snapshot written first" invariant — a reader observing a
 *    transcript can rely on the snapshot row having been enqueued. The chaining
 *    does not block the agent loop: the snapshot enqueue is itself async and the
 *    listener awaits a settled promise, not synchronous work.
 * 2. Transcript is flushed on every `turn_end` / `agent_end`, and on demand via
 *    `flushNow()` (used by error/abort paths, issue #1).
 *
 * Returns a {@link SessionCaptureHandle} (`detach` + `flushNow`).
 */
export function attachSessionCapture(
  agent: CapturableAgent,
  ctx: SessionCaptureContext,
): SessionCaptureHandle {
  // 1. Snapshot — enqueue once. Hold the promise so the first transcript flush
  //    can be chained behind it (issue #10). Resolves even on failure (logged).
  const snapshotDone: Promise<void> =
    ctx.snapshot === undefined
      ? Promise.resolve()
      : (async () => {
          try {
            const snapshotJson = serialize(ctx.snapshot);
            await ctx.storage.saveAgentSessionSnapshot(ctx.sessionId, {
              snapshotJson,
              dumpPath: ctx.dumpPath ?? null,
              tokenEstimate: ctx.tokenEstimate ?? null,
            });
          } catch (err) {
            ctx.logger?.error("session capture: snapshot write failed", {
              sessionId: ctx.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();

  // Serializes transcript writes so flushNow() and the listener never interleave,
  // and so the very first transcript write is ordered after the snapshot enqueue.
  let transcriptChain: Promise<void> = snapshotDone;

  /**
   * Best-effort transcript flush. `messages` lets callers supply the canonical
   * source (e.g. the `agent_end { messages }` payload, issue #12); when absent we
   * fall back to the live `agent.state.messages`. Never throws.
   */
  const flushTranscript = (messages: AgentMessage[], context: string): Promise<void> => {
    transcriptChain = transcriptChain.then(async () => {
      try {
        const transcriptJson = serialize(messages);
        await ctx.storage.saveAgentSessionTranscript(ctx.sessionId, transcriptJson);
      } catch (err) {
        // Never throw out of the listener / flushNow.
        ctx.logger?.error("session capture: transcript write failed", {
          sessionId: ctx.sessionId,
          context,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return transcriptChain;
  };

  // 2. Transcript — flush on turn_end / agent_end, always from the live
  // `state.messages`. The `agent_end` event's `{ messages }` payload is
  // run-scoped — pi-agent-core's loop emits only the messages produced by THAT
  // `prompt()`/`continue()` call (agent-loop `newMessages`), and
  // `handleRunFailure` emits `[failureMessage]` alone. Preferring the payload
  // would overwrite the transcript with the latest run only, silently dropping
  // every earlier turn of a multi-prompt session (e.g. the trigger turn once a
  // forced-completion follow-up fires). `state.messages` is canonical in every
  // path: the loop pushes each message (including the synthesized failure
  // message) into state via `message_end` before `agent_end` reaches listeners.
  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type !== "turn_end" && event.type !== "agent_end") {
      return;
    }
    await flushTranscript(agent.state.messages, event.type);
  });

  // 3. Usage actuals (spec TOKEN-USAGE-TRACKING §4.3): persist the session-level
  // aggregate on every committed request. The tracker fires `onUpdate` once per
  // commit; sessions make single-digit-to-low-tens of requests, so one enqueued
  // write per commit is negligible (no debounce). The write is fire-and-forget
  // on the single-writer queue; an error there is logged by the storage layer.
  const unsubscribeUsage = ctx.usage?.onUpdate((totals) => {
    // Persist the model alongside usage on every committed request (spec
    // TOKEN-USAGE-TRACKING §4.3). The tracker's last committed model is the one
    // ACTUALLY billed, so the durable `agent_sessions.model_id` matches the
    // ledger's agent_loop rows even when fallback or per-user model selection
    // served something other than the session type's configured model — which
    // `ctx.model` alone is, and which is therefore only the pre-commit fallback.
    // `coalesce` in the writer means a null here never clobbers a recorded model.
    const billedModel = ctx.usage?.lastModelId() ?? ctx.model ?? null;
    void ctx.storage.updateAgentSessionUsage(ctx.sessionId, totals, billedModel);
  });

  return {
    detach: () => {
      unsubscribe();
      unsubscribeUsage?.();
      // Settle log (spec TOKEN-USAGE-TRACKING §8): one greppable line per
      // session run at detach, carrying the final totals snapshot. Detach is
      // called in every run path's finally (completed / parked / interrupted /
      // worker finalize/failure), so this fires uniformly. Only emitted when a
      // usage tracker was wired (tests/headless skip it).
      //
      // Best-effort: this log additionally requires a logger. The persistence
      // subscription above gates ONLY on `ctx.usage` (logger is optional in the
      // ctx type), so a call site wiring `usage` but omitting `logger` still
      // persists every commit — it just drops this settle line. Persistence
      // does not depend on the log.
      if (ctx.usage && ctx.logger) {
        ctx.logger.info("session_usage", {
          sessionId: ctx.sessionId,
          timelineKey: ctx.timelineKey,
          sessionType: ctx.sessionType,
          // Billed model when this run committed anything, else the configured
          // one — same precedence as the durable row above, so the settle line
          // and `agent_sessions.model_id` never disagree.
          model: ctx.usage.lastModelId() ?? ctx.model,
          ...ctx.usage.snapshot(),
          // Combined (agent-loop + tool) spend (spec SESSION-COST-LIMITS §6) — the
          // cost-ceiling basis; `cost` above is the agent-loop lane alone.
          combinedCost: ctx.usage.combinedCost(),
          // The resolved ceiling combinedCost was measured against (§6), so this
          // line is self-contained even if config changes between run and later
          // analysis. null = unlimited.
          maxSessionCostUsd: ctx.maxSessionCostUsd ?? null,
        });
      }
    },
    // One-shot best-effort flush of the current live messages (issue #1).
    flushNow: () => flushTranscript(agent.state.messages, "flushNow"),
  };
}
