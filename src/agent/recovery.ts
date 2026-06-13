import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRow } from "../storage/index.js";
import type { ContextMessage } from "../context/builder.js";
import type { Logger } from "../observability/logger.js";
import type { InboundChatEvent, SenderInfo } from "../types.js";
import { parseMatrixTimelineKey } from "../proactive/index.js";
import { mapBuiltMessages } from "./factory.js";
import type { AgentSessionRecord } from "./session-manager.js";
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
// It also owns the manual console resume (`createManualResumeSession`) — the
// SOLE resume path since the Layer-2 auto-resume loop was deleted (spec
// LLM-FAILURE-HANDLING §8.2) — extracted from `app.ts` so the park/discard/
// guard decisions are unit-testable with injected deps.
// =============================================================================

export interface ResumeMaterial {
  /** Frozen prefix in the agent message vocabulary (mapBuiltMessages-projected). */
  snapshot: AgentMessage[];
  /** Live transcript, stripped of the failed tail; ends user/tool-result-side. */
  transcript: AgentMessage[];
}

/**
 * Discriminated viability verdict of {@link loadResumeMaterial}. `continue`
 * carries the replay material; `fresh` means the transcript never flushed —
 * nothing committed, so the resume rebuilds the context from the durable
 * trigger row and re-runs like a launch (see the function doc).
 */
export type ResumeMaterialResult =
  | ({ mode: "continue" } & ResumeMaterial)
  | { mode: "fresh" };

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
 *
 * Three-way result:
 * - `{mode:"continue", snapshot, transcript}` — the normal replay material:
 *   re-create the agent from the persisted prefix + transcript and redo the
 *   failed request via continue-mode.
 * - `{mode:"fresh"}` — the transcript was NEVER flushed (a hard crash before
 *   the first `turn_end`/`flushNow`, e.g. a process kill mid-first-request).
 *   No turn ever committed, so there are no side effects to duplicate and no
 *   transcript to replay — but the session is still resumable: the durable
 *   row's trigger fields point at the original trigger event (still in the
 *   timeline store), so `resumeSessionRun` rebuilds the context fresh and
 *   re-runs the session like a launch, reusing the same row.
 * - `null` — genuinely nothing to redo or unusable: the transcript ends at a
 *   clean boundary (the run committed), corrupt persisted JSON, a transcript
 *   without its snapshot (violates the capture ordering — treat as corrupt,
 *   turns may have committed), or an unexpected rehydration failure. A null
 *   rejects/parks the session rather than issuing a doomed attempt.
 */
export async function loadResumeMaterial(
  row: AgentSessionRow,
  deps: ResumeMaterialDeps,
): Promise<ResumeMaterialResult | null> {
  if (!row.transcript_json) return { mode: "fresh" };
  // A transcript without a snapshot can't happen through capture (the first
  // transcript flush is chained behind the snapshot enqueue) — corruption, and
  // committed turns may exist, so neither replay nor fresh rebuild is safe.
  if (!row.context_snapshot_json) return null;

  let snapshotRaw: ContextMessage[];
  let transcriptRaw: AgentMessage[];
  try {
    snapshotRaw = JSON.parse(row.context_snapshot_json) as ContextMessage[];
    transcriptRaw = JSON.parse(row.transcript_json) as AgentMessage[];
  } catch {
    return null;
  }
  if (!Array.isArray(snapshotRaw) || !Array.isArray(transcriptRaw)) return null;
  // A flushed-but-empty transcript is the same "nothing ever committed" case
  // as a missing one.
  if (transcriptRaw.length === 0) return { mode: "fresh" };

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
    systemPromptSegments: [],
  });

  const transcript = stripFailedTail(transcriptRaw);
  // Only failed tails with no committed turn beneath — same as never-flushed.
  if (transcript.length === 0) return { mode: "fresh" };
  if (!endsAwaitingAssistant(transcript)) return null;

  return { mode: "continue", snapshot, transcript };
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

// ─── Resume attempt outcome vocabulary ───────────────────────────────────────────
//
// The Layer-2 AUTO-resume loop is deleted (spec LLM-FAILURE-HANDLING §8.2):
// Layer-0 now owns all in-run retrying (unbounded for background work,
// wall-clock-bounded for interactive), and once an interactive budget is
// exhausted the maintainer explicitly does NOT want delayed automatic replies
// (P3) — a bot answering long after it was asked is useless at best, and a
// herd of backed-up sessions resuming together is a disaster. The manual
// console resume below is the SOLE resume path for parked sessions.

/** Terminal verdict of one resume attempt (`resumeSessionRun` in app.ts). */
export interface ResumeAttemptResult {
  /**
   * `mechanical` — environmental LLM-layer failure (retry can fix);
   * `content` — non-environmental LLM-layer failure (deterministic on replay;
   * parks, never discards — spec LLM-FAILURE-HANDLING P5);
   * `fatal` — untagged failure (our own code threw);
   * `unresumable` — resume material missing/unusable.
   */
  outcome: "completed" | "mechanical" | "content" | "fatal" | "unresumable";
  error?: string;
}

// ─── Manual console resume (spec §6.2; issues #16–#20) ───────────────────────

/** Result envelope of a manual resume — mapped to HTTP by the console route. */
export interface ManualResumeResult {
  ok: boolean;
  /** The session's resulting (or current, on rejection) status. */
  status: string;
  reason?: string;
}

/**
 * Session statuses a manual resume accepts (Decision D): `failed-resumable`
 * (parked by Layer-2 exhaustion) and `interrupted` (healed by startup after a
 * crash) carry the same snapshot/transcript material; viability is decided by
 * `loadResumeMaterial`, not the status label. Auto-resume-on-startup stays off.
 */
export const MANUAL_RESUME_STATUSES: ReadonlySet<string> = new Set([
  "failed-resumable",
  "interrupted",
]);

/**
 * Session types whose `agent_sessions` rows are written directly by synthetic
 * worker pools — summarization (`"summarize"`/`"condense"`, §9b) and diary
 * (`"diary"`, §9c) — never by the chat launch path. These literals are
 * hardcoded at the pools' insertion sites (src/summarization/worker-pool.ts,
 * src/diary/worker-pool.ts), so a denylist keyed on them is exact and needs
 * no config plumbing (unlike an allowlist: the proactive type is a
 * configurable `session_types` key). A crash mid-worker-run leaves such a row
 * `running` → startup healing flips it `interrupted` — but resuming it here
 * would re-drive a summarization/diary transcript as a *chat* session (chat
 * tools, `send_message` into the real room, bot identity), so manual resume
 * rejects these types outright; the worker pools own their own job-level
 * retries. Unknown future types default to resumable (user-facing), matching
 * `defaultPriorityForSessionType`'s unknown → interactive rule.
 */
export const SYNTHETIC_SESSION_TYPES: ReadonlySet<string> = new Set([
  "summarize",
  "condense",
  "diary",
]);

export interface ManualResumeDeps {
  /** Live drain flag (read per decision point). */
  isDraining: () => boolean;
  /** Durable row read (storage.getAgentSession). */
  getSessionRow: (sessionId: string) => AgentSessionRow | undefined;
  /**
   * Viability gate: `loadResumeMaterial` bound to the app's media/workspace
   * deps. `null` means there is nothing to redo (transcript ends at a clean
   * boundary, or material is unusable) → the resume is rejected WITHOUT
   * touching the row's status. A `fresh` verdict (transcript never flushed)
   * is viable — `runAttempt` rebuilds the context and re-runs from scratch.
   */
  loadMaterial: (row: AgentSessionRow) => Promise<ResumeMaterialResult | null>;
  /**
   * True when the SessionManager already holds an in-memory record for the id
   * (a live run, or a resume mid-flight). Belt-and-suspenders next to the
   * factory's own in-flight set (issue #16).
   */
  hasLiveSession: (sessionId: string) => boolean;
  /** SessionManager.adopt — re-register the reconstructed record. */
  adopt: (record: AgentSessionRecord) => void;
  /**
   * Claim the per-timeline trigger slot (TriggerCoordinator.tryAcquire,
   * issue #17): a manual resume must never run concurrently with a live
   * session on the same timeline. `false` → 409 "timeline busy".
   */
  tryAcquireTimelineSlot: (timelineKey: string) => boolean;
  /**
   * Release the slot claimed above (TriggerCoordinator.complete) AND drain the
   * next queued trigger, mirroring `launchSession`'s `.finally` (app-side).
   */
  releaseTimelineSlot: (timelineKey: string) => void;
  /** Bot user id for a Matrix account (config.matrix.accounts[id].user_id). */
  selfUserIdForAccount: (accountId: string) => string | undefined;
  /** One resume attempt (app.ts `resumeSessionRun`, attempt 0). */
  runAttempt: (
    record: AgentSessionRecord,
    inbound: InboundChatEvent,
  ) => Promise<ResumeAttemptResult>;
  markFailedResumable: (sessionId: string, error?: string) => void;
  markDiscarded: (sessionId: string, error?: string) => void;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Build the manual-resume action (spec §6.2 "manual park" — the only operator
 * surface; there are no chat commands). Factory form so the double-POST guard
 * (the in-flight set, issue #16) is per-runtime state, and so the whole policy
 * is unit-testable with injected deps (issue #21).
 *
 * The returned function reconstructs the session record + a synthetic inbound
 * from the durable row alone (the original in-memory record was evicted,
 * possibly in a previous process), then redoes the same resume once:
 *
 * - **Double-POST guard (issue #16).** A synchronous in-memory check —
 *   in-flight set + SessionManager presence — rejects a concurrent resume of
 *   the same session before any async work (the durable status read alone
 *   cannot: `markRunning` commits through the async write queue).
 * - **Timeline slot (issue #17).** The per-timeline trigger slot is claimed
 *   via `tryAcquireTimelineSlot` (409 "timeline busy" when held) and released
 *   in a `finally` that also drains the queued trigger, so the resumed run
 *   can never post concurrently with a live session on its timeline.
 * - **Original sender identity (issue #18).** The synthetic inbound's sender
 *   is the PERSISTED trigger sender (`trigger_sender_id`/`…_display_name`),
 *   so sender-bound tools (user_profile_read/edit, recap's asker) bind to the
 *   same user the failed session had. `isSelf` is claimed only when that
 *   sender IS the bot (proactive sessions) — never for user-triggered ones.
 * - **Interrupted sessions (issue #19, Decision D).** `interrupted` rows are
 *   accepted alongside `failed-resumable` — same re-issue mechanism, no extra
 *   turn injected. Viability is gated up front by `loadMaterial`; a row with
 *   nothing to redo is rejected (409) with its status untouched. A row whose
 *   transcript never flushed (hard crash mid-first-request) is NOT rejected —
 *   it resumes in `fresh` mode (context rebuilt from the durable trigger row;
 *   see `loadResumeMaterial`).
 * - **Synthetic-session gate (issue #19 follow-up).** Rows whose
 *   `session_type` is a synthetic worker-pool type (`SYNTHETIC_SESSION_TYPES`:
 *   summarize/condense/diary) are rejected (409, status untouched) right
 *   after the status gate — a crash-interrupted worker row must not be
 *   re-driven as a chat session. The session-type column is the
 *   discriminator; sender columns are NOT (proactive legacy rows share NULL).
 * - **Shutdown safety (issue #20).** Draining rejects up front, and a `fatal`
 *   attempt outcome WHILE draining re-parks `failed-resumable` instead of
 *   discarding (the fatality is shutdown-caused — scheduler stopped — not
 *   content-caused; mirrors `autoResumeSession`'s park-over-discard rule).
 *
 * Outcomes: completed → `{ok:true}`; mechanical / unresumable → re-park
 * `failed-resumable`; fatal → discard (live) or re-park (draining).
 */
export function createManualResumeSession(
  deps: ManualResumeDeps,
): (sessionId: string) => Promise<ManualResumeResult> {
  const inFlight = new Set<string>();

  return async function manualResumeSession(sessionId: string): Promise<ManualResumeResult> {
    // Issue #16: synchronous guard FIRST — checked and inserted before any
    // await, so two near-simultaneous POSTs cannot both pass.
    if (inFlight.has(sessionId) || deps.hasLiveSession(sessionId)) {
      return {
        ok: false,
        status: "resuming",
        reason: "a resume (or live run) for this session is already in flight",
      };
    }
    inFlight.add(sessionId);
    try {
      const row = deps.getSessionRow(sessionId);
      if (!row) return { ok: false, status: "unknown", reason: `unknown session: ${sessionId}` };
      if (!MANUAL_RESUME_STATUSES.has(row.status)) {
        return {
          ok: false,
          status: row.status,
          reason: `session is '${row.status}', not resumable (failed-resumable | interrupted)`,
        };
      }
      // Session-type gate: synthetic worker-pool rows (summarize/condense/
      // diary) are never resumable as chat sessions — see
      // SYNTHETIC_SESSION_TYPES. Rejecting leaves the row's status untouched.
      if (SYNTHETIC_SESSION_TYPES.has(row.session_type)) {
        return {
          ok: false,
          status: row.status,
          reason: `synthetic ${row.session_type} session — not resumable (worker pools own their own retries)`,
        };
      }
      if (deps.isDraining()) {
        return { ok: false, status: row.status, reason: "runtime is shutting down" };
      }
      // Issue #19: viability gate. Rejecting here leaves the row's status
      // untouched — an interrupted session with nothing to redo stays
      // `interrupted`, it is NOT converted into a parked `failed-resumable`.
      const material = await deps.loadMaterial(row);
      if (!material) {
        return {
          ok: false,
          status: row.status,
          reason:
            "nothing to redo: the transcript ends at a clean boundary, or the resume material is unusable",
        };
      }
      const parsed = parseMatrixTimelineKey(row.timeline_key);
      const selfUserId = parsed ? deps.selfUserIdForAccount(parsed.accountId) : undefined;
      if (!parsed || !selfUserId) {
        return {
          ok: false,
          status: row.status,
          reason: "cannot reconstruct outbound target from timeline key",
        };
      }
      // Issue #17: claim the per-timeline trigger slot before running.
      if (!deps.tryAcquireTimelineSlot(row.timeline_key)) {
        return {
          ok: false,
          status: row.status,
          reason: "timeline busy: another session holds this timeline's slot",
        };
      }
      try {
        // Issue #18: the synthetic inbound carries the PERSISTED trigger
        // sender. The selfUserId fallback only covers pre-v18 rows (no
        // deployed instances; defensive) — and then isSelf is honestly true.
        const senderId = row.trigger_sender_id ?? selfUserId;
        const sender: SenderInfo = { id: senderId };
        if (row.trigger_sender_display_name) {
          sender.displayName = row.trigger_sender_display_name;
        }
        if (senderId === selfUserId) sender.isSelf = true;
        const now = Date.now();
        const inbound: InboundChatEvent = {
          provider: "matrix",
          timelineKey: row.timeline_key,
          event: {
            id: row.trigger_event_id ?? `resume-${sessionId}`,
            externalId: row.trigger_external_id ?? undefined,
            timelineKey: row.timeline_key,
            provider: "matrix",
            role: "user",
            sender,
            body: row.trigger_body ?? "",
            timestamp: now,
            receivedAt: now,
          },
          outboundTarget: {
            provider: "matrix",
            timelineKey: row.timeline_key,
            accountId: parsed.accountId,
            roomId: parsed.roomId,
            threadId: parsed.threadId,
          },
        };
        const record: AgentSessionRecord = {
          id: row.id,
          timelineKey: row.timeline_key,
          sessionType: row.session_type,
          status: "resuming",
          trigger: inbound,
          createdAt: row.created_at,
          startedAt: row.started_at ?? undefined,
        };
        deps.adopt(record);
        deps.logger.info("session_manual_resume_started", {
          sessionId,
          timelineKey: row.timeline_key,
          fromStatus: row.status,
          mode: material.mode,
        });
        // `runAttempt` (resumeSessionRun) returns a three-way outcome on the
        // happy path, but its pre-run wiring — markRunning/attachAgent/
        // attachSessionCapture — is NOT inside its own try/catch, so a throw
        // there escapes here. If we let it propagate, the `finally` blocks below
        // release the timeline slot and the in-flight guard, but the record we
        // `adopt`ed stays in the SessionManager forever — `hasLiveSession` would
        // then reject EVERY future resume of this session (console POST 500s)
        // until restart. So an escaping throw must route to the SAME eviction
        // path a `fatal` outcome takes (markDiscarded live, markFailedResumable
        // while draining — both evict the in-memory record). Treating an escaped
        // throw as `fatal` is correct: a thrown error here is our own code (not
        // an LLM-layer outcome), exactly the `fatal` class.
        let attemptResult: ResumeAttemptResult;
        try {
          attemptResult = await deps.runAttempt(record, inbound);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (deps.isDraining()) {
            deps.markFailedResumable(sessionId, message);
            return {
              ok: false,
              status: "failed-resumable",
              reason: `resume threw during shutdown: ${message}`,
            };
          }
          deps.markDiscarded(sessionId, message);
          return {
            ok: false,
            status: "discarded",
            reason: `resume threw before completing: ${message}`,
          };
        }
        const { outcome, error } = attemptResult;
        switch (outcome) {
          case "completed":
            return { ok: true, status: "completed" };
          case "mechanical":
            deps.markFailedResumable(sessionId, error);
            return {
              ok: false,
              status: "failed-resumable",
              reason: `resume failed mechanically again: ${error}`,
            };
          case "content":
            // Deterministic on replay (oversized/malformed request), but still
            // operator-/upstream-fixable: re-park, never discard (P5).
            deps.markFailedResumable(sessionId, error);
            return {
              ok: false,
              status: "failed-resumable",
              reason: `resume failed on request content: ${error}`,
            };
          case "unresumable":
            deps.markFailedResumable(sessionId, error);
            return { ok: false, status: "failed-resumable", reason: error };
          case "fatal":
            // Issue #20 (group-4 flagged hazard): a fatal outcome WHILE
            // draining is shutdown-caused (scheduler stopped) — re-park, the
            // material is intact. Only a live-runtime fatal discards.
            if (deps.isDraining()) {
              deps.markFailedResumable(sessionId, error);
              return {
                ok: false,
                status: "failed-resumable",
                reason: `resume aborted by shutdown: ${error}`,
              };
            }
            deps.markDiscarded(sessionId, error);
            return {
              ok: false,
              status: "discarded",
              reason: `resume failed (non-mechanical): ${error}`,
            };
        }
      } finally {
        deps.releaseTimelineSlot(row.timeline_key);
      }
    } finally {
      inFlight.delete(sessionId);
    }
  };
}
