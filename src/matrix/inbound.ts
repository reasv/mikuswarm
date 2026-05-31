import { nanoid } from "nanoid";
import type { MatrixInboundEvent, MatrixInboundMedia } from "./native-types.js";
import type {
  AttachmentMeta,
  CanonicalChatEvent,
  InboundChatEvent,
  TriggerInfo,
} from "../types.js";

/**
 * Map a native media descriptor to a canonical {@link AttachmentMeta}. Shared by
 * the live-receive path ({@link normalizeMatrixInboundEvent}) and the backfill
 * converter (`classifySummary`) so live and historical attachments are
 * byte-for-byte identical. Download + caption happen later, keyed by event ID;
 * the descriptor carries no encryption keys (encrypted media is resolved at
 * download time by re-fetching the event).
 */
export function mediaToAttachment(eventId: string, media: MatrixInboundMedia): AttachmentMeta {
  return {
    id: `${eventId}:media:${media.index}`,
    filename: media.filename ?? media.body,
    mimeType: media.contentType,
    mediaType: media.kind,
    sizeBytes: media.sizeBytes,
    processing: {
      downloaded: false,
      captioned: false,
    },
  };
}

export interface MatrixInboundContext {
  accountId: string;
  selfUserId: string;
}

export function timelineKeyForMatrixEvent(accountId: string, event: MatrixInboundEvent): string {
  if (event.chatType === "direct") {
    return `matrix:${accountId}:dm:${event.roomId}`;
  }
  if (event.threadRootId) {
    return `matrix:${accountId}:room:${event.roomId}:thread:${event.threadRootId}`;
  }
  return `matrix:${accountId}:room:${event.roomId}`;
}

export function normalizeMatrixInboundEvent(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
): InboundChatEvent {
  const timelineKey = timelineKeyForMatrixEvent(context.accountId, event);
  const mentionedSelf = isMentioningSelf(event, context);
  // An `m.replace` edit is applied to its target message in place rather than
  // appended as a new event (issue #17). `event.body`/`event.media` already hold
  // the replacement (`m.new_content`); `relatesTo.eventId` is the target.
  const editTargetExternalId =
    event.relatesTo?.relType === "m.replace" ? event.relatesTo.eventId : undefined;
  const edit = editTargetExternalId ? { targetExternalId: editTargetExternalId } : undefined;
  // A UTD event carries no body/mention info and must never trigger the bot —
  // a human client wouldn't act on a message it can't read either. An edit also
  // never triggers: the agent already reacted (or not) to the original; an edit
  // updates content in place and shouldn't re-fire a session. Surface both
  // (stored / applied) but with no trigger.
  const trigger =
    event.undecryptable || edit ? undefined : detectTrigger(event, context, mentionedSelf);
  const timestamp = Date.parse(event.timestamp);

  const canonical: CanonicalChatEvent = {
    id: `matrix:${context.accountId}:${event.eventId || nanoid()}`,
    externalId: event.eventId,
    timelineKey,
    provider: "matrix",
    role: event.senderId === context.selfUserId ? "assistant" : "user",
    sender: {
      id: event.senderId,
      displayName: event.senderName,
      isSelf: event.senderId === context.selfUserId,
    },
    body: event.body,
    htmlBody: event.formattedBody,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    receivedAt: Date.now(),
    attachments: event.media.map((media) => mediaToAttachment(event.eventId, media)),
    replyTo: event.replyToId ? { externalId: event.replyToId } : undefined,
    mentions: {
      mentionedUserIds: event.mentions?.userIds ?? [],
      mentionedSelf,
    },
    threadId: event.threadRootId,
    trigger,
    undecryptable: event.undecryptable
      ? { sessionId: event.sessionId, reason: event.utdReason }
      : undefined,
  };

  return {
    provider: "matrix",
    timelineKey,
    event: canonical,
    trigger,
    edit,
    outboundTarget: {
      provider: "matrix",
      timelineKey,
      accountId: context.accountId,
      roomId: event.roomId,
      threadId: event.threadRootId,
      replyToId: event.eventId,
    },
  };
}

function detectTrigger(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
  mentionedSelf: boolean,
): TriggerInfo | undefined {
  if (event.senderId === context.selfUserId) return undefined;
  if (event.chatType === "direct") {
    return {
      type: "dm",
      reason: "direct message",
      triggeredBy: { id: event.senderId, displayName: event.senderName },
    };
  }
  if (mentionedSelf) {
    return {
      type: "mention",
      reason: "mentioned bot",
      triggeredBy: { id: event.senderId, displayName: event.senderName },
    };
  }
  return undefined;
}

function isMentioningSelf(event: MatrixInboundEvent, context: MatrixInboundContext): boolean {
  return event.mentions?.userIds?.includes(context.selfUserId) ?? false;
}
