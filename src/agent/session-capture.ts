import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { ContextMessage } from "../context/builder.js";
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
  logger?: Logger;
}

/**
 * Minimal structural slice of the pi-agent-core `Agent` we depend on, so tests
 * can supply a lightweight stub. Structurally compatible with the real `Agent`
 * (`subscribe` at agent.d.ts:66, `state.messages` an `AgentMessage[]`).
 */
export interface CapturableAgent {
  subscribe(listener: (event: { type: string }, signal: AbortSignal) => void | Promise<void>): () => void;
  state: { messages: AgentMessage[] };
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

function base64ByteLength(b64: string): number {
  if (typeof b64 !== "string" || b64.length === 0) return 0;
  // Strip any data: URI prefix and whitespace before measuring.
  const comma = b64.indexOf(",");
  const raw = comma >= 0 && b64.slice(0, comma).includes("base64") ? b64.slice(comma + 1) : b64;
  try {
    return Buffer.from(raw, "base64").length;
  } catch {
    return 0;
  }
}

/**
 * Pure deep-clone that replaces every base64 image payload with an {@link ImageRef}.
 * Never mutates the input (the live `agent.state.messages` / `snapshot` arrays).
 *
 * Handles three shapes:
 *  - ContextMessage `imageBlocks`: `{ eventId, attachmentId, mediaType, dataBase64 }`
 *  - pi-core message `imageBlocks`: `{ type: "image", source: { media_type, data } }`
 *  - inline content blocks: `{ type: "image", source: { media_type, data } }`
 *    (incl. tool_result content arrays).
 *
 * As a backstop, any `source.data` / `dataBase64` string encountered anywhere in
 * the tree is replaced, so no raw base64 can survive serialization.
 */
export function externalizeImages<T>(value: T): T {
  return externalize(value) as T;
}

function externalize(value: unknown): unknown {
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

  // Inline image content block: { type: "image", source: { type: "base64", media_type, data } }
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
 * 1. Snapshot is written once, immediately (non-blocking async IIFE).
 * 2. Transcript is flushed on every `turn_end` / `agent_end`.
 *
 * Returns the unsubscribe function from `agent.subscribe`.
 */
export function attachSessionCapture(agent: CapturableAgent, ctx: SessionCaptureContext): () => void {
  // 1. Snapshot — fire-and-forget, but log failures.
  if (ctx.snapshot !== undefined) {
    void (async () => {
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
  }

  // 2. Transcript — flush on turn_end / agent_end.
  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type !== "turn_end" && event.type !== "agent_end") {
      return;
    }
    try {
      const transcriptJson = serialize(agent.state.messages);
      await ctx.storage.saveAgentSessionTranscript(ctx.sessionId, transcriptJson);
    } catch (err) {
      // Never throw out of the listener.
      ctx.logger?.error("session capture: transcript write failed", {
        sessionId: ctx.sessionId,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return unsubscribe;
}
