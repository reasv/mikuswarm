import type { AttachmentMeta, CanonicalChatEvent, HistorySummary } from "../types.js";

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
      replacement: { body: string; attachments: AttachmentMeta[] };
    };

interface CommonContext {
  /** Provider id (e.g. "matrix") — placed on every reconstructed event. */
  provider: string;
  accountId: string;
  selfUserId: string;
  timestamp: number;
  /**
   * Construct the canonical event id from a provider-scoped external id.
   * Injected by the caller so classify.ts stays provider-agnostic (§11.3).
   * For Matrix: `(externalId) => \`matrix:\${accountId}:\${externalId}\``.
   */
  buildId: (externalId: string) => string;
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

function editReplacement(summary: HistorySummary) {
  return {
    body: summary.body,
    attachments: summary.attachments ?? [],
  };
}

function buildEvent(
  summary: HistorySummary,
  ctx: CommonContext,
  timelineKey: string,
  threadId: string | undefined,
  replyTo: { externalId: string } | undefined,
): CanonicalChatEvent {
  const isSelf = summary.sender.id === ctx.selfUserId;
  return {
    id: ctx.buildId(summary.externalId),
    externalId: summary.externalId,
    timelineKey,
    provider: ctx.provider,
    role: isSelf ? "assistant" : "user",
    sender: { id: summary.sender.id, displayName: summary.sender.displayName, username: summary.sender.username, isSelf },
    body: summary.body,
    timestamp: ctx.timestamp,
    receivedAt: Date.now(),
    // Emit the same attachment shape as the live path so backfilled media flows
    // through the identical download + caption pipeline (keyed by event ID).
    attachments: summary.attachments ?? [],
    threadId,
    replyTo,
    undecryptable: undefined,
  };
}

function buildUtdEvent(
  summary: HistorySummary,
  ctx: CommonContext,
  roomTimelineKey: string,
): CanonicalChatEvent {
  const isSelf = summary.sender.id === ctx.selfUserId;
  return {
    id: ctx.buildId(summary.externalId),
    externalId: summary.externalId,
    timelineKey: roomTimelineKey,
    provider: ctx.provider,
    role: isSelf ? "assistant" : "user",
    sender: { id: summary.sender.id, displayName: summary.sender.displayName, username: summary.sender.username, isSelf },
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
  summary: HistorySummary,
  ctx: TimelineClassifyContext,
): ClassifiedSummary | undefined {
  const threadRootId = threadRootFromKey(ctx.timelineKey);

  if (summary.undecryptable) {
    const roomKey = threadRootId ? roomTimelineKeyFromKey(ctx.timelineKey) : ctx.timelineKey;
    return { kind: "event", event: buildUtdEvent(summary, ctx, roomKey) };
  }

  if (summary.edited) {
    const editTarget = summary.editTargetExternalId;
    if (!editTarget) return undefined; // malformed edit with no target — drop.
    return { kind: "edit", targetExternalId: editTarget, replacement: editReplacement(summary) };
  }

  const isThreadMessage = summary.threadRootExternalId != null;
  if (threadRootId) {
    if (!isThreadMessage || summary.threadRootExternalId !== threadRootId) return undefined;
  } else if (isThreadMessage) {
    return undefined;
  }

  const replyTo =
    !isThreadMessage && summary.replyToExternalId ? { externalId: summary.replyToExternalId } : undefined;
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
  summary: HistorySummary,
  ctx: RoomClassifyContext,
): ClassifiedSummary | undefined {
  // A UTD event has no decryptable relation; land it on the base room/DM key
  // (mirrors the live UTD path). The sweeper re-homes it to a thread on decrypt.
  if (summary.undecryptable) {
    return { kind: "event", event: buildUtdEvent(summary, ctx, ctx.baseTimelineKey) };
  }

  if (summary.edited) {
    const editTarget = summary.editTargetExternalId;
    if (!editTarget) return undefined; // malformed edit with no target — drop.
    return { kind: "edit", targetExternalId: editTarget, replacement: editReplacement(summary) };
  }

  const isThreadMessage = summary.threadRootExternalId != null;
  // DMs never get thread timeline keys (timelineKeyForMatrixEvent routes a direct
  // chat to its dm key regardless of any thread relation), so only non-DM rooms
  // split thread events into a thread key.
  if (isThreadMessage && !ctx.isDm) {
    const threadRoot = summary.threadRootExternalId!;
    const timelineKey = `${ctx.baseTimelineKey}:thread:${threadRoot}`;
    return { kind: "event", event: buildEvent(summary, ctx, timelineKey, threadRoot, undefined) };
  }

  const replyTo =
    !isThreadMessage && summary.replyToExternalId ? { externalId: summary.replyToExternalId } : undefined;
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
