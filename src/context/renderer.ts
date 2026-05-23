import type { AttachmentMeta, CanonicalChatEvent, LinkPreviewMeta, ReplyContext } from "../types.js";
import { escapeXml } from "./xml.js";

export type RenderTier = "rich" | "compact";

export function renderMessage(event: CanonicalChatEvent, tier: RenderTier): string {
  return tier === "rich" ? renderRichMessage(event) : renderCompactMessage(event);
}

export function renderRichMessage(event: CanonicalChatEvent): string {
  const attrs = [
    ["sender", senderLabel(event)],
    ["time", new Date(event.timestamp).toISOString()],
    event.mentions?.mentionedSelf ? ["mentions_you", "true"] : undefined,
    event.externalId ? ["external_id", event.externalId] : undefined,
    event.agentSessionId ? ["agent_session_id", event.agentSessionId] : undefined,
  ].filter(Boolean) as string[][];
  const body = [
    escapeXml(event.body),
    event.replyTo ? renderReply(event.replyTo) : undefined,
    ...(event.attachments ?? []).map(renderAttachment),
    ...(event.linkPreviews ?? []).map(renderLinkPreview),
  ].filter(Boolean);
  return `<message ${attrs.map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ")}>\n${body.join("\n\n")}\n</message>`;
}

export function renderCompactMessage(event: CanonicalChatEvent): string {
  const time = compactTime(event.timestamp);
  const reply = event.replyTo ? compactReply(event.replyTo) : "";
  const attachments = (event.attachments ?? [])
    .map((attachment) => ` [attachment: ${attachment.filename ?? attachment.id}${attachment.localPath ? ` ${attachment.localPath}` : ""}${attachment.caption ? ` caption=${truncate(attachment.caption, 300)}` : ""}]`)
    .join("");
  const links = (event.linkPreviews ?? [])
    .map((preview) => ` [link: ${preview.title ?? preview.url} — ${truncate(preview.description ?? "", 1000)}]`)
    .join("");
  return `[${time}] ${senderLabel(event)}${reply}: ${truncate(normalizeWhitespace(event.body), 6000)}${attachments}${links}`;
}

function compactReply(reply: ReplyContext): string {
  const sender = reply.sender ? replySenderLabel(reply.sender) : "unknown";
  const time = reply.timestamp ? ` ${compactTime(reply.timestamp)}` : "";
  const body = reply.body ? `: ${truncate(normalizeWhitespace(reply.body), 4096)}` : "";
  return ` (> ${sender}${time}${body})`;
}

function renderReply(reply: ReplyContext): string {
  const senderText = reply.sender
    ? (reply.sender.displayName && reply.sender.username && reply.sender.displayName !== reply.sender.username
        ? `${reply.sender.displayName} (${reply.sender.username})`
        : reply.sender.displayName ?? reply.sender.id)
    : undefined;
  const attrs = [
    senderText ? ["sender", senderText] : undefined,
    reply.timestamp ? ["time", new Date(reply.timestamp).toISOString()] : undefined,
    reply.externalId ? ["external_id", reply.externalId] : undefined,
  ].filter(Boolean) as string[][];
  const attachments = (reply.attachments ?? []).map(renderAttachment).join("\n\n");
  const previews = (reply.linkPreviews ?? []).map(renderLinkPreview).join("\n\n");
  return `<reply_to ${attrs.map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ")}>\n${escapeXml(reply.body ?? "")}${attachments ? `\n\n${attachments}` : ""}${previews ? `\n\n${previews}` : ""}\n</reply_to>`;
}

function renderAttachment(attachment: AttachmentMeta): string {
  const attrs = [
    ["filename", attachment.filename ?? attachment.id],
    ["type", attachment.mimeType ?? attachment.mediaType],
    attachment.sizeBytes !== undefined ? ["size", String(attachment.sizeBytes)] : undefined,
    attachment.localPath ? ["path", attachment.localPath] : undefined,
  ].filter(Boolean) as string[][];
  const attrText = attrs.map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ");
  const caption = attachment.caption;
  return caption ? `<attachment ${attrText}>\n[caption: ${escapeXml(caption)}]\n</attachment>` : `<attachment ${attrText}/>`;
}

function renderLinkPreview(preview: LinkPreviewMeta): string {
  const attrs = [
    ["url", preview.url],
    preview.title ? ["title", preview.title] : undefined,
  ].filter(Boolean) as string[][];
  const mediaBlocks = (preview.media ?? []).map(renderAttachment).join("\n\n");
  return `<link_preview ${attrs.map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ")}>\n${escapeXml(preview.description ?? "")}${mediaBlocks ? `\n\n${mediaBlocks}` : ""}\n</link_preview>`;
}

function senderLabel(event: CanonicalChatEvent): string {
  return event.sender.displayName && event.sender.displayName !== event.sender.id
    ? `${event.sender.displayName} (${event.sender.id})`
    : event.sender.id;
}

function replySenderLabel(sender: NonNullable<ReplyContext["sender"]>): string {
  if (sender.displayName && sender.username && sender.displayName !== sender.username) {
    return `${sender.displayName} (${sender.username})`;
  }
  return sender.displayName ?? sender.id;
}

function compactTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return ".".repeat(max);
  return `${value.slice(0, max - 3)}...`;
}
