import { nanoid } from "nanoid";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MatrixInboundEvent, MatrixMessageSummary } from "./native-types.js";
import type { MatrixNativeClient } from "./native-client.js";
import type {
  AttachmentMeta,
  CanonicalChatEvent,
  InboundChatEvent,
  LinkPreviewMeta,
  ReplyContext,
  TriggerInfo,
} from "../types.js";

export interface MatrixInboundContext {
  accountId: string;
  selfUserId: string;
  mentionNames: string[];
  attachmentDir?: string;
  client?: MatrixNativeClient;
}

export function timelineKeyForMatrixEvent(accountId: string, event: MatrixInboundEvent): string {
  if (event.chatType === "direct") {
    return `matrix:${accountId}:dm:${event.senderId}`;
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
  const trigger = detectTrigger(event, context, mentionedSelf);
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
    attachments: event.media.map((media): AttachmentMeta => ({
      id: `${event.eventId}:media:${media.index}`,
      filename: media.filename ?? media.body,
      mimeType: media.contentType,
      mediaType: media.kind,
      sizeBytes: media.sizeBytes,
      processing: {
        downloaded: false,
        captioned: false,
      },
    })),
    mentions: {
      mentionedUserIds: event.mentions?.userIds ?? [],
      mentionedSelf,
      displayMentions: context.mentionNames.filter((name) =>
        event.body.toLowerCase().includes(`@${name.toLowerCase()}`),
      ),
    },
    threadId: event.threadRootId,
    trigger,
  };

  return {
    provider: "matrix",
    timelineKey,
    event: canonical,
    trigger,
    outboundTarget: {
      provider: "matrix",
      timelineKey,
      accountId: context.accountId,
      roomId: event.roomId,
      threadId: event.threadRootId,
    },
  };
}

export async function processMatrixInboundEvent(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
): Promise<InboundChatEvent> {
  const inbound = normalizeMatrixInboundEvent(event, context);
  const [attachments, replyTo, linkPreviews] = await Promise.all([
    resolveAttachments(event, context, inbound.event.attachments ?? []),
    resolveReplyContext(event, context),
    resolveLinkPreviews(event, context),
  ]);

  inbound.event.attachments = attachments;
  inbound.event.replyTo = replyTo;
  inbound.event.linkPreviews = linkPreviews;
  return inbound;
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
  if (event.mentions?.userIds?.includes(context.selfUserId)) return true;
  const body = event.body.toLowerCase();
  return context.mentionNames.some((name) => body.includes(`@${name.toLowerCase()}`));
}

async function resolveAttachments(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
  attachments: AttachmentMeta[],
): Promise<AttachmentMeta[]> {
  if (!context.client || !context.attachmentDir || attachments.length === 0) return attachments;
  await mkdir(context.attachmentDir, { recursive: true });
  return Promise.all(
    attachments.map(async (attachment) => {
      return downloadAttachment(event.roomId, event.eventId, attachment, context);
    }),
  );
}

async function resolveReplyContext(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
): Promise<ReplyContext | undefined> {
  if (!context.client || !event.replyToId) return undefined;
  try {
    const summary = context.client.messageSummary({ roomId: event.roomId, eventId: event.replyToId });
    if (!summary) return { externalId: event.replyToId };
    const timestamp = Date.parse(summary.timestamp);
    return {
      externalId: summary.eventId,
      sender: { id: summary.sender },
      body: summary.body,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      attachments: await resolveReplyAttachments(event.roomId, summary, context),
    };
  } catch {
    return { externalId: event.replyToId };
  }
}

async function resolveReplyAttachments(
  roomId: string,
  summary: MatrixMessageSummary,
  context: MatrixInboundContext,
): Promise<AttachmentMeta[] | undefined> {
  const mediaType = mediaTypeForMsgtype(summary.msgtype);
  if (!mediaType || !context.client || !context.attachmentDir) return undefined;
  const base: AttachmentMeta = {
    id: `${summary.eventId}:media:0`,
    filename: summary.body,
    mediaType,
    processing: {
      downloaded: false,
      captioned: false,
    },
  };
  await mkdir(context.attachmentDir, { recursive: true });
  const resolved = await downloadAttachment(roomId, summary.eventId, base, context);
  return [resolved];
}

async function downloadAttachment(
  roomId: string,
  eventId: string,
  attachment: AttachmentMeta,
  context: MatrixInboundContext,
): Promise<AttachmentMeta> {
  try {
    const downloaded = context.client!.downloadMedia({
      roomId,
      eventId,
    });
    const extension = extensionFor(downloaded.contentType, downloaded.filename ?? attachment.filename);
    const filename = `${safePart(eventId)}-${safePart(attachment.id)}${extension}`;
    const localPath = path.join(context.attachmentDir!, filename);
    await writeFile(localPath, Buffer.from(downloaded.dataBase64, "base64"));
    return {
      ...attachment,
      filename: downloaded.filename ?? attachment.filename,
      mimeType: downloaded.contentType ?? attachment.mimeType,
      mediaType: downloaded.kind,
      localPath,
      processing: {
        downloaded: true,
        captioned: false,
      },
    };
  } catch (error) {
    return {
      ...attachment,
      processing: {
        ...attachment.processing,
        downloaded: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function mediaTypeForMsgtype(msgtype?: string): AttachmentMeta["mediaType"] | undefined {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.video") return "video";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.file") return "file";
  return undefined;
}

async function resolveLinkPreviews(
  event: MatrixInboundEvent,
  context: MatrixInboundContext,
): Promise<LinkPreviewMeta[] | undefined> {
  if (!context.client || !event.body.includes("http")) return undefined;
  try {
    const result = context.client.resolveLinkPreviews({
      bodyText: event.body,
      includeImages: false,
      maxBytes: 256_000,
    });
    const fetchedAt = Date.now();
    return result.sources.map((source, index) => ({
      url: source.url,
      title: source.title ?? source.siteName,
      description: source.description ?? result.textBlocks[index],
      fetchedAt,
    }));
  } catch {
    return undefined;
  }
}

function extensionFor(contentType?: string, filename?: string): string {
  const parsed = filename ? path.extname(filename) : "";
  if (parsed) return parsed;
  if (contentType === "image/png") return ".png";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  return "";
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
