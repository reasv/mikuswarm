import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRow } from "../storage/index.js";
import type { ContextMessage } from "../context/builder.js";
import type { Logger } from "../observability/logger.js";
import { mapBuiltMessages } from "./factory.js";
import { isResumableRunError } from "./runner.js";
import type { ImageRef } from "./session-capture.js";

// =============================================================================
// Layer 2 — session resume-in-place (spec CONCURRENCY-AND-RATE-LIMITING §6.2).
//
// When Layer-1 request retry exhausts (or a run dies mechanically mid-stream),
// the session is NOT discarded: the persisted `agent_sessions` row already
// holds everything needed to redo the failed request — the frozen context
// snapshot (`context_snapshot_json`, written once at creation) and the
// transcript flushed up to and including the in-progress turn
// (`transcript_json`, captured by the failure-path `flushNow()`).
//
// This module prepares that material for `factory.create({ resume })`:
//
// - The snapshot is persisted as raw `ContextMessage[]` (system block + tier
//   metadata intact, for the verbatim renderer). The live runtime prefix is a
//   DIFFERENT projection — `mapBuiltMessages` drops the system block and folds
//   the summary layer into a user chatEvent — so the parsed snapshot MUST run
//   through `mapBuiltMessages` before seeding `resume.snapshot` (the factory's
//   documented vocabulary contract).
// - Persisted image payloads were EXTERNALIZED at capture time
//   (`session-capture.ts` `externalizeImages` replaces every base64 payload
//   with an `{__imageRef, eventId, attachmentId, …}` marker). Those refs MUST
//   be rehydrated back into real bytes before the material is re-issued —
//   a `{type:"image"}` block whose data is a ref object is a malformed request
//   the upstream 400s (a *fatal* classification that would discard the
//   session). Refs that carry an `attachmentId` are resolved through the media
//   store (`media_assets.local_path` under the workspace root — the same path
//   the context builder originally loaded); unresolvable refs are substituted
//   with a text placeholder (`[image omitted on resume]`) so the resumed
//   request stays valid.
// - The transcript's tail may carry the synthetic `stopReason:"error"` assistant
//   message pi-agent-core appended when the run failed (and, for a mid-stream
//   death, a partial assistant turn). Those are STRIPPED so the transcript ends
//   at the user/tool-result message whose answer never committed —
//   `agent.continue()` then re-issues exactly that request.
//
// It also owns the auto-resume policy loop (`autoResumeSession`) — extracted
// from `app.ts` so the park/discard decisions are unit-testable.
// =============================================================================

export interface ResumeMaterial {
  /** Frozen prefix in the agent message vocabulary (mapBuiltMessages-projected). */
  snapshot: AgentMessage[];
  /** Live transcript, stripped of the failed tail; ends user/tool-result-side. */
  transcript: AgentMessage[];
}

/** Text substituted wherever a persisted image ref cannot be rehydrated. */
export const RESUME_IMAGE_PLACEHOLDER = "[image omitted on resume]";

/** Structural slice of `MediaAssetRow` the rehydrator needs. */
export interface ResumeMediaAsset {
  local_path?: string | null;
  mime_type?: string | null;
}

/**
 * Dependencies for rehydrating externalized image refs (issue #13). `media` is
 * structurally satisfied by `Storage` (`getMediaAssetById`); `workspaceRoot`
 * anchors the asset's relative `local_path` (with a traversal guard, mirroring
 * the console's `GET /api/media/:ref`).
 */
export interface ResumeMaterialDeps {
  media: { getMediaAssetById(id: string): ResumeMediaAsset | undefined };
  workspaceRoot: string;
  logger?: Logger;
}

/**
 * Load and project a session row's persisted snapshot + transcript into the
 * shape `factory.create({ resume })` expects, rehydrating externalized image
 * refs back into base64 payloads (or text placeholders when unresolvable).
 * Returns null when the row cannot be resumed: missing/corrupt snapshot or
 * transcript, an unexpected rehydration failure, or a transcript that — after
 * stripping the failed tail — no longer ends at a user/tool-result message
 * (nothing to re-issue). A null parks the session rather than issuing a doomed
 * attempt.
 */
export async function loadResumeMaterial(
  row: AgentSessionRow,
  deps: ResumeMaterialDeps,
): Promise<ResumeMaterial | null> {
  if (!row.context_snapshot_json || !row.transcript_json) return null;

  let snapshotRaw: ContextMessage[];
  let transcriptRaw: AgentMessage[];
  try {
    snapshotRaw = JSON.parse(row.context_snapshot_json) as ContextMessage[];
    transcriptRaw = JSON.parse(row.transcript_json) as AgentMessage[];
  } catch {
    return null;
  }
  if (!Array.isArray(snapshotRaw) || !Array.isArray(transcriptRaw)) return null;

  // Rehydrate externalized image refs in BOTH trees (issue #13): the snapshot's
  // `imageBlocks` and the transcript's trigger/toolResult image blocks. An
  // unexpected walker failure makes the material fundamentally unusable —
  // return null (park) rather than re-issue a malformed request.
  const resolve = createImageRefResolver(deps);
  try {
    snapshotRaw = (await rehydrateImages(snapshotRaw, resolve)) as ContextMessage[];
    transcriptRaw = (await rehydrateImages(transcriptRaw, resolve)) as AgentMessage[];
  } catch (err) {
    deps.logger?.error("resume material: image rehydration failed", {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Vocabulary contract (factory `resume` docs): project the raw ContextMessage
  // snapshot into the runtime prefix shape. Token totals are irrelevant here.
  const snapshot = mapBuiltMessages({
    messages: snapshotRaw,
    tokenEstimate: 0,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  });

  const transcript = stripFailedTail(transcriptRaw);
  if (transcript.length === 0) return null;
  if (!endsAwaitingAssistant(transcript)) return null;

  return { snapshot, transcript };
}

/**
 * Drop the failed tail: trailing assistant messages that are the synthetic
 * error/aborted turn (or a partial that died mid-stream and carries an error
 * stopReason). A CLEAN trailing assistant message is left alone — that run
 * committed, and `endsAwaitingAssistant` will then reject the material (there
 * is no failed request to redo).
 */
export function stripFailedTail(transcript: AgentMessage[]): AgentMessage[] {
  const out = [...transcript];
  while (out.length > 0) {
    const last = out[out.length - 1] as { role?: string; stopReason?: string };
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/**
 * `agent.continue()` requires the transcript to end at a user or tool-result
 * message (an un-answered request). The transcript head can also be the typed
 * final-turn shapes (`triggerGroup`/`satellite`/`interjection`), which convert
 * to user turns — accept those too.
 */
function endsAwaitingAssistant(transcript: AgentMessage[]): boolean {
  const last = transcript[transcript.length - 1] as { role?: string; type?: string };
  if (!last) return false;
  if (last.role === "user" || last.role === "toolResult") return true;
  return last.type === "triggerGroup" || last.type === "satellite" || last.type === "interjection";
}

// ─── Image-ref rehydration (issue #13) ───────────────────────────────────────

/** Resolved image payload: ready to splice back into the persisted shapes. */
interface ResolvedImage {
  dataBase64: string;
  mediaType: string;
}

type ImageRefResolver = (ref: ImageRef) => Promise<ResolvedImage | null>;

function isImageRef(value: unknown): value is ImageRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { __imageRef?: unknown }).__imageRef === true
  );
}

/**
 * Build the per-load resolver: `attachmentId` → media-asset row → file bytes
 * under the workspace root (traversal-guarded, mirroring the console media
 * endpoint). Results (including failures) are memoized per load so repeated
 * refs to the same attachment read the file once. Refs without an
 * `attachmentId` — the inline content-block shapes externalize only
 * mime/size, by design (spec §3 best-effort) — are unresolvable.
 */
function createImageRefResolver(deps: ResumeMaterialDeps): ImageRefResolver {
  const cache = new Map<string, ResolvedImage | null>();
  return async (ref) => {
    const id = ref.attachmentId;
    if (!id) return null;
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    let resolved: ResolvedImage | null = null;
    try {
      const asset = deps.media.getMediaAssetById(id);
      const mediaType = asset?.mime_type ?? ref.mimeType;
      if (asset?.local_path && mediaType) {
        const root = path.resolve(deps.workspaceRoot);
        const abs = path.resolve(root, asset.local_path);
        if (abs.startsWith(root + path.sep)) {
          const bytes = await readFile(abs);
          resolved = { dataBase64: bytes.toString("base64"), mediaType };
        }
      }
    } catch {
      resolved = null;
    }
    if (!resolved) {
      deps.logger?.warn("resume material: image ref unresolvable, substituting placeholder", {
        attachmentId: id,
        eventId: ref.eventId,
      });
    }
    cache.set(id, resolved);
    return resolved;
  };
}

/**
 * Pure deep-clone that reverses `externalizeImages` (session-capture.ts):
 * every `{__imageRef}` marker is replaced with rehydrated bytes, or with a
 * text placeholder when unresolvable, mirroring the externalizer's shapes:
 *
 *  - `imageBlocks` arrays (ContextMessage / triggerGroup): a ref entry becomes
 *    `{eventId, attachmentId, mediaType, dataBase64}` again; unresolvable
 *    entries are DROPPED (the array shape admits no text block) and the
 *    placeholder is appended to the sibling string `content` instead.
 *  - pi-ai inline image `{type:"image", data: ref, mimeType}` → data restored;
 *    unresolvable → `{type:"text", text: placeholder}` content block.
 *  - Anthropic image `{type:"image", source: ref}` → base64 source restored;
 *    unresolvable → text content block.
 *  - OpenAI-style `{type:"image_url", image_url:{url: ref}}` → data URI
 *    restored; unresolvable → text content block.
 *  - Any other ref position (bare `url`, generic `source` backstop, stray ref)
 *    → data URI / base64 source when resolvable, placeholder string otherwise.
 *
 * @internal Exported for testing.
 */
export async function rehydrateImages(value: unknown, resolve: ImageRefResolver): Promise<unknown> {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await rehydrateImages(item, resolve));
    return out;
  }

  const obj = value as Record<string, unknown>;

  // A bare ref in an unknown position: inline data URI or placeholder string.
  if (isImageRef(obj)) {
    const img = await resolve(obj);
    return img ? `data:${img.mediaType};base64,${img.dataBase64}` : RESUME_IMAGE_PLACEHOLDER;
  }

  // pi-ai inline image content block: { type:"image", data: ref, mimeType }.
  if (obj.type === "image" && isImageRef(obj.data)) {
    const img = await resolve(obj.data);
    if (!img) return { type: "text", text: RESUME_IMAGE_PLACEHOLDER };
    return { ...obj, data: img.dataBase64, mimeType: typeof obj.mimeType === "string" ? obj.mimeType : img.mediaType };
  }

  // Anthropic image content block: { type:"image", source: ref }.
  if (obj.type === "image" && isImageRef(obj.source)) {
    const img = await resolve(obj.source);
    if (!img) return { type: "text", text: RESUME_IMAGE_PLACEHOLDER };
    return { ...obj, source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 } };
  }

  // OpenAI-style image block: { type:"image_url", image_url: { url: ref } }.
  if (obj.type === "image_url" && obj.image_url && typeof obj.image_url === "object") {
    const imageUrl = obj.image_url as Record<string, unknown>;
    if (isImageRef(imageUrl.url)) {
      const img = await resolve(imageUrl.url);
      if (!img) return { type: "text", text: RESUME_IMAGE_PLACEHOLDER };
      return {
        ...obj,
        image_url: { ...imageUrl, url: `data:${img.mediaType};base64,${img.dataBase64}` },
      };
    }
  }

  // Generic recursion, with the `imageBlocks` special case (drop + annotate).
  const out: Record<string, unknown> = {};
  let omittedBlocks = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "imageBlocks" && Array.isArray(v)) {
      const blocks: unknown[] = [];
      for (const entry of v) {
        if (!isImageRef(entry)) {
          blocks.push(await rehydrateImages(entry, resolve));
          continue;
        }
        const img = await resolve(entry);
        if (img) {
          blocks.push({
            eventId: entry.eventId ?? "",
            attachmentId: entry.attachmentId ?? "",
            mediaType: img.mediaType,
            dataBase64: img.dataBase64,
          });
        } else {
          omittedBlocks += 1;
        }
      }
      out[k] = blocks;
      continue;
    }
    if (isImageRef(v)) {
      const img = await resolve(v);
      if (k === "source") {
        // Generic base64-source backstop shape: restore the source object.
        out[k] = img
          ? { type: "base64", media_type: img.mediaType, data: img.dataBase64 }
          : RESUME_IMAGE_PLACEHOLDER;
      } else {
        out[k] = img ? `data:${img.mediaType};base64,${img.dataBase64}` : RESUME_IMAGE_PLACEHOLDER;
      }
      continue;
    }
    out[k] = await rehydrateImages(v, resolve);
  }
  if (omittedBlocks > 0 && typeof out.content === "string") {
    const note =
      omittedBlocks === 1 ? RESUME_IMAGE_PLACEHOLDER : `[${omittedBlocks} images omitted on resume]`;
    out.content = `${out.content}\n${note}`;
  }
  return out;
}

// ─── Auto-resume policy loop (spec §6.2; issue #15) ──────────────────────────

/** Terminal verdict of one resume attempt (`resumeSessionRun` in app.ts). */
export interface ResumeAttemptResult {
  outcome: "completed" | "mechanical" | "fatal" | "unresumable";
  error?: string;
}

export interface AutoResumeDeps {
  sessionId: string;
  timelineKey: string;
  /** `recovery.session_auto_resume_attempts`: 0 = park immediately (still manually resumable). */
  attempts: number;
  /** `recovery.session_auto_resume_backoff_ms` (exponential base). */
  backoffBaseMs: number;
  /** Live drain flag (read per decision point, not snapshotted at entry). */
  isDraining: () => boolean;
  /** Run one resume attempt (app.ts `resumeSessionRun`, bound to the session). */
  runAttempt: (attempt: number) => Promise<ResumeAttemptResult>;
  markResuming: (error: string) => void;
  markFailedResumable: (error: string) => void;
  markDiscarded: (error: string) => void;
  logger: Pick<Logger, "warn" | "error">;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Auto-resume (spec §6.2): bounded, backed-off resume attempts for a live run
 * that died mechanically (Layer-1 exhausted). Returns true when the failure was
 * handled here (resumed, parked, or discarded); false hands a NON-resumable
 * failure back to the caller's ordinary discard path.
 *
 * Park-over-discard rules (issue #15):
 * - `attempts <= 0` (auto-resume disabled) or draining at entry: a resumable
 *   failure parks `failed-resumable` immediately — never discarded — matching
 *   the config contract ("failures park immediately… still resumable manually").
 * - A `fatal` attempt outcome **while draining** also parks: shutdown kills the
 *   attempt's LLM request at the scheduler gate ("LLM scheduler stopped" /
 *   aborted admission), which Layer-1 deliberately classifies FATAL so teardown
 *   never spins futile retries — but that fatality is shutdown-caused, not
 *   content-caused, and the persisted resume material is intact. Only a fatal
 *   outcome on a live (non-draining) runtime discards.
 * - `unresumable` (material missing/unusable) always discards — the row cannot
 *   service a manual resume either, so parking would be a lie.
 */
export async function autoResumeSession(error: unknown, deps: AutoResumeDeps): Promise<boolean> {
  if (!isResumableRunError(error)) return false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const initialError = error instanceof Error ? error.message : String(error);

  if (deps.attempts <= 0 || deps.isDraining()) {
    deps.markFailedResumable(initialError);
    deps.logger.error("session_parked_failed_resumable", {
      sessionId: deps.sessionId,
      timelineKey: deps.timelineKey,
      error: initialError,
      reason: deps.attempts <= 0 ? "auto_resume_disabled" : "draining",
    });
    return true;
  }

  deps.markResuming(initialError);
  deps.logger.warn("session_auto_resume_started", {
    sessionId: deps.sessionId,
    timelineKey: deps.timelineKey,
    error: initialError,
  });

  let lastError = initialError;
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    await sleep(deps.backoffBaseMs * 2 ** (attempt - 1));
    if (deps.isDraining()) break; // park below — resumable after restart
    const { outcome, error: attemptError } = await deps.runAttempt(attempt);
    if (outcome === "completed") return true;
    lastError = attemptError ?? lastError;
    if (outcome === "unresumable" || (outcome === "fatal" && !deps.isDraining())) {
      deps.markDiscarded(lastError);
      deps.logger.error("session_resume_failed_terminal", {
        sessionId: deps.sessionId,
        attempt,
        outcome,
        error: lastError,
      });
      return true;
    }
    if (outcome === "fatal") break; // fatal-at-shutdown: park, material is intact
    // mechanical → another attempt (or park below)
    deps.markResuming(lastError);
    deps.logger.warn("session_auto_resume_retry", {
      sessionId: deps.sessionId,
      attempt,
      error: lastError,
    });
  }

  deps.markFailedResumable(lastError);
  deps.logger.error("session_parked_failed_resumable", {
    sessionId: deps.sessionId,
    timelineKey: deps.timelineKey,
    error: lastError,
  });
  return true;
}
