import { mediaToAttachment } from "../matrix/inbound.js";
import type { CanonicalChatEvent } from "../types.js";
import type { MatrixMessageSummary } from "../matrix/native-types.js";

/**
 * A `readMessages` summary classified for backfill: a kept event to store/buffer,
 * an `m.replace` edit to route through `store.applyEdit` (never a standalone row),
 * or dropped (undefined) when it does not belong to the scope being fetched.
 *
 * The canonical event id matches `normalizeMatrixInboundEvent`'s scheme
 * (`matrix:<account>:<eventId>`), so live and backfilled rows dedup via
 * `appendIfMissing`.
 */
export type ClassifiedSummary =
  | { kind: "event"; event: CanonicalChatEvent }
  | {
      kind: "edit";
      targetExternalId: string;
      replacement: { body: string; attachments: ReturnType<typeof mediaToAttachment>[] };
    };

interface CommonContext {
  /** Provider id (e.g. "matrix") — placed on every reconstructed event. */
  provider: string;
  accountId: string;
  selfUserId: string;
  timestamp: number;
}

/** Context for the single-timeline classifier (first-trigger initial backfill). */
export interface TimelineClassifyContext extends CommonContext {
  /** The timeline being activated (room, DM, or thread). */
  timelineKey: string;
}

/** Context for the whole-room classifier (startup gap backfetch). */
export interface RoomClassifyContext extends CommonContext {
  /**
   * The room's base (non-thread) timeline key — the `room:` or `dm:` key. Thread
   * events route to `${baseTimelineKey}:thread:<root>` for non-DM rooms; for DM
   * rooms everything routes to the dm key (DMs never get thread keys, mirroring
   * `timelineKeyForMatrixEvent`).
   */
  baseTimelineKey: string;
  isDm: boolean;
}

function editReplacement(summary: MatrixMessageSummary) {
  return {
    body: summary.body,
    attachments: (summary.media ?? []).map((media) => mediaToAttachment(summary.eventId, media)),
  };
}

function buildEvent(
  summary: MatrixMessageSummary,
  ctx: CommonContext,
  timelineKey: string,
  threadId: string | undefined,
  replyTo: { externalId: string } | undefined,
): CanonicalChatEvent {
  const isSelf = summary.sender === ctx.selfUserId;
  return {
    // TODO(phase6): event id format is Matrix-specific; classify.ts will receive
    // an injected id-constructor once HistoryClient is generalized (spec §11.3).
    id: `matrix:${ctx.accountId}:${summary.eventId}`,
    externalId: summary.eventId,
    timelineKey,
    provider: ctx.provider,
    role: isSelf ? "assistant" : "user",
    sender: { id: summary.sender, displayName: summary.senderName, isSelf },
    body: summary.body,
    timestamp: ctx.timestamp,
    receivedAt: Date.now(),
    // Emit the same attachment shape as the live path so backfilled media flows
    // through the identical download + caption pipeline (keyed by event ID).
    attachments: (summary.media ?? []).map((media) => mediaToAttachment(summary.eventId, media)),
    threadId,
    replyTo,
    undecryptable: undefined,
  };
}

function buildUtdEvent(
  summary: MatrixMessageSummary,
  ctx: CommonContext,
  roomTimelineKey: string,
): CanonicalChatEvent {
  const isSelf = summary.sender === ctx.selfUserId;
  return {
    // TODO(phase6): event id format is Matrix-specific; classify.ts will receive
    // an injected id-constructor once HistoryClient is generalized (spec §11.3).
    id: `matrix:${ctx.accountId}:${summary.eventId}`,
    externalId: summary.eventId,
    timelineKey: roomTimelineKey,
    provider: ctx.provider,
    role: isSelf ? "assistant" : "user",
    sender: { id: summary.sender, displayName: summary.senderName, isSelf },
    body: summary.body,
    timestamp: ctx.timestamp,
    receivedAt: Date.now(),
    attachments: [],
    threadId: undefined,
    replyTo: undefined,
    undecryptable: { sessionId: summary.sessionId, reason: summary.utdReason },
  };
}

/**
 * Classify a summary for single-timeline (first-trigger) backfill, or undefined
 * when it does not belong to the activated timeline (thread filtering). A UTD
 * summary carries no readable relation (its thread/edit metadata is
 * megolm-encrypted), so it is kept on the *room* timeline even when a thread is
 * being activated; the re-decryption sweeper re-homes it once keys arrive.
 */
export function classifyForTimeline(
  summary: MatrixMessageSummary,
  ctx: TimelineClassifyContext,
): ClassifiedSummary | undefined {
  const threadRootId = threadRootFromKey(ctx.timelineKey);
  const relType = summary.relatesTo?.relType ?? undefined;
  const relEventId = summary.relatesTo?.eventId ?? undefined;

  if (summary.undecryptable) {
    const roomKey = threadRootId ? roomTimelineKeyFromKey(ctx.timelineKey) : ctx.timelineKey;
    return { kind: "event", event: buildUtdEvent(summary, ctx, roomKey) };
  }

  if (relType === "m.replace") {
    if (!relEventId) return undefined; // malformed edit with no target — drop.
    return { kind: "edit", targetExternalId: relEventId, replacement: editReplacement(summary) };
  }

  const isThreadMessage = relType === "m.thread";
  if (threadRootId) {
    if (!isThreadMessage || relEventId !== threadRootId) return undefined;
  } else if (isThreadMessage) {
    return undefined;
  }

  const replyTo =
    !isThreadMessage && relType == null && relEventId ? { externalId: relEventId } : undefined;
  return {
    kind: "event",
    event: buildEvent(summary, ctx, ctx.timelineKey, threadRootId, replyTo),
  };
}

/**
 * Classify a summary for whole-room (startup gap backfetch) capture, routing each
 * event to its own derived timeline key (room / DM / thread). Unlike the
 * single-timeline classifier this never filters by thread membership — a thread
 * event is kept and routed to its thread key (non-DM rooms only). Returns
 * undefined only for a malformed edit with no target.
 */
export function classifyForRoom(
  summary: MatrixMessageSummary,
  ctx: RoomClassifyContext,
): ClassifiedSummary | undefined {
  const relType = summary.relatesTo?.relType ?? undefined;
  const relEventId = summary.relatesTo?.eventId ?? undefined;

  // A UTD event has no decryptable relation; land it on the base room/DM key
  // (mirrors the live UTD path). The sweeper re-homes it to a thread on decrypt.
  if (summary.undecryptable) {
    return { kind: "event", event: buildUtdEvent(summary, ctx, ctx.baseTimelineKey) };
  }

  if (relType === "m.replace") {
    if (!relEventId) return undefined; // malformed edit with no target — drop.
    return { kind: "edit", targetExternalId: relEventId, replacement: editReplacement(summary) };
  }

  const isThreadMessage = relType === "m.thread" && Boolean(relEventId);
  // DMs never get thread timeline keys (timelineKeyForMatrixEvent routes a direct
  // chat to its dm key regardless of any thread relation), so only non-DM rooms
  // split thread events into a thread key.
  if (isThreadMessage && !ctx.isDm) {
    const timelineKey = `${ctx.baseTimelineKey}:thread:${relEventId}`;
    return { kind: "event", event: buildEvent(summary, ctx, timelineKey, relEventId, undefined) };
  }

  const replyTo =
    !isThreadMessage && relType == null && relEventId ? { externalId: relEventId } : undefined;
  return {
    kind: "event",
    event: buildEvent(summary, ctx, ctx.baseTimelineKey, undefined, replyTo),
  };
}

export function threadRootFromKey(timelineKey: string): string | undefined {
  const marker = ":thread:";
  const index = timelineKey.indexOf(marker);
  return index >= 0 ? timelineKey.slice(index + marker.length) : undefined;
}

/**
 * Strip a `:thread:<root>` suffix to recover the room/DM timeline key. A thread
 * key is `matrix:<account>:(room|dm):<roomId>:thread:<root>`; the room id may
 * itself contain colons, so split on the `:thread:` marker rather than on every
 * colon. A key with no thread suffix is returned unchanged.
 */
export function roomTimelineKeyFromKey(timelineKey: string): string {
  const marker = ":thread:";
  const index = timelineKey.indexOf(marker);
  return index >= 0 ? timelineKey.slice(0, index) : timelineKey;
}
