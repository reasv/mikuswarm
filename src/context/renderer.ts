import type { AttachmentMeta, CanonicalChatEvent, LinkPreviewMeta, ReplyContext } from "../types.js";
import { escapeXml } from "./xml.js";

export type RenderTier = "rich" | "compact";

const MAX_DISPLAY_NAME = 256;
const MAX_FILENAME = 256;
const MAX_URL = 2048;

export function renderMessage(event: CanonicalChatEvent, tier: RenderTier): string {
  return tier === "rich" ? renderRichMessage(event) : renderCompactMessage(event);
}

export function renderRichMessage(event: CanonicalChatEvent): string {
  const attrs = buildMessageAttrs(event);
  const parts: string[] = [];

  if (event.replyTo) parts.push(renderReply(event.replyTo));
  parts.push(escapeXml(event.body));
  for (const a of event.attachments ?? []) parts.push(renderAttachment(a));
  for (const m of event.linkedMedia ?? []) parts.push(renderLinkedMedia(m));
  for (const lp of event.linkPreviews ?? []) parts.push(renderLinkPreview(lp));

  return `<message ${attrs}>\n${parts.join("\n\n")}\n</message>`;
}

export function renderCompactMessage(event: CanonicalChatEvent): string {
  const time = compactTime(event.timestamp);
  const sender = compactSenderLabel(event);
  const reply = event.replyTo ? compactReply(event.replyTo) : "";
  const attachments = (event.attachments ?? [])
    .map((a) => ` [attachment: ${truncate(a.filename ?? a.id, MAX_FILENAME)}${a.localPath ? ` ${a.localPath}` : ""}${a.caption ? ` caption=${truncate(a.caption, 300)}` : ""}]`)
    .join("");
  const linked = (event.linkedMedia ?? [])
    .map((m) => ` [linked_media: ${truncate(m.filename ?? m.id, MAX_FILENAME)}${m.localPath ? ` ${m.localPath}` : ""}${m.caption ? ` caption=${truncate(m.caption, 300)}` : ""}]`)
    .join("");
  const links = (event.linkPreviews ?? [])
    .map((lp) => ` [link: ${truncate(lp.title ?? lp.url, MAX_FILENAME)} — ${truncate(lp.description ?? "", 1000)}]`)
    .join("");
  return `[${time}] ${sender}${reply}: ${truncate(normalizeWhitespace(event.body), 6000)}${attachments}${linked}${links}`;
}

function buildMessageAttrs(event: CanonicalChatEvent): string {
  const pairs: [string, string][] = [
    ["sender", event.sender.id],
  ];
  if (event.sender.displayName && event.sender.displayName !== event.sender.id) {
    pairs.push(["display_name", truncate(event.sender.displayName, MAX_DISPLAY_NAME)]);
  }
  pairs.push(["time", new Date(event.timestamp).toISOString()]);
  if (event.mentions?.mentionedSelf) pairs.push(["mentions_you", "true"]);
  if (event.externalId) pairs.push(["external_id", event.externalId]);
  if (event.agentSessionId) pairs.push(["agent_session_id", event.agentSessionId]);
  return pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
}

function renderReply(reply: ReplyContext): string {
  const pairs: [string, string][] = [];
  if (reply.sender) {
    pairs.push(["sender", reply.sender.id]);
    if (reply.sender.displayName && reply.sender.displayName !== reply.sender.id) {
      pairs.push(["display_name", truncate(reply.sender.displayName, MAX_DISPLAY_NAME)]);
    }
  }
  if (reply.timestamp) pairs.push(["time", new Date(reply.timestamp).toISOString()]);
  if (reply.externalId) pairs.push(["external_id", reply.externalId]);

  const innerParts: string[] = [escapeXml(reply.body ?? "")];
  for (const a of reply.attachments ?? []) innerParts.push(renderAttachment(a));
  for (const m of reply.linkedMedia ?? []) innerParts.push(renderLinkedMedia(m));
  for (const lp of reply.linkPreviews ?? []) innerParts.push(renderLinkPreview(lp));

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  return `<reply_to ${attrStr}>\n${innerParts.join("\n\n")}\n</reply_to>`;
}

function renderAttachment(attachment: AttachmentMeta): string {
  const pairs: [string, string][] = [
    ["filename", truncate(attachment.filename ?? attachment.id, MAX_FILENAME)],
    ["type", attachment.mimeType ?? attachment.mediaType],
  ];
  if (attachment.sizeBytes !== undefined) pairs.push(["size", String(attachment.sizeBytes)]);
  if (attachment.localPath) pairs.push(["path", attachment.localPath]);
  if (attachment.isCharacterCard) pairs.push(["is_character_card", "true"]);
  if (attachment.cardName) pairs.push(["card_name", truncate(attachment.cardName, MAX_DISPLAY_NAME)]);
  if (attachment.isImageBlock) pairs.push(["image_block", "true"]);

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  if (attachment.caption) {
    return `<attachment ${attrStr}>\n[caption: ${escapeXml(attachment.caption)}]\n</attachment>`;
  }
  return `<attachment ${attrStr}/>`;
}

function renderLinkedMedia(media: AttachmentMeta): string {
  const pairs: [string, string][] = [
    ["filename", truncate(media.filename ?? media.id, MAX_FILENAME)],
    ["type", media.mimeType ?? media.mediaType],
  ];
  if (media.sizeBytes !== undefined) pairs.push(["size", String(media.sizeBytes)]);
  if (media.localPath) pairs.push(["path", media.localPath]);
  if (media.isImageBlock) pairs.push(["image_block", "true"]);

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  if (media.caption) {
    return `<linked_media ${attrStr}>\n[caption: ${escapeXml(media.caption)}]\n</linked_media>`;
  }
  return `<linked_media ${attrStr}/>`;
}

function renderLinkPreview(preview: LinkPreviewMeta): string {
  const pairs: [string, string][] = [
    ["url", truncate(preview.url, MAX_URL)],
  ];
  if (preview.title) pairs.push(["title", truncate(preview.title, MAX_DISPLAY_NAME)]);

  const innerParts: string[] = [escapeXml(preview.description ?? "")];
  for (const m of preview.media ?? []) innerParts.push(renderPreviewMedia(m));

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  return `<link_preview ${attrStr}>\n${innerParts.join("\n\n")}\n</link_preview>`;
}

function renderPreviewMedia(media: AttachmentMeta): string {
  const pairs: [string, string][] = [
    ["filename", truncate(media.filename ?? media.id, MAX_FILENAME)],
    ["type", media.mimeType ?? media.mediaType],
  ];
  if (media.localPath) pairs.push(["path", media.localPath]);
  if (media.isImageBlock) pairs.push(["image_block", "true"]);

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  if (media.caption) {
    return `<preview_media ${attrStr}>\n[caption: ${escapeXml(media.caption)}]\n</preview_media>`;
  }
  return `<preview_media ${attrStr}/>`;
}

function compactSenderLabel(event: CanonicalChatEvent): string {
  if (event.sender.displayName && event.sender.displayName !== event.sender.id) {
    return `${escapeCompactParens(event.sender.displayName)} (${event.sender.id})`;
  }
  return event.sender.id;
}

function compactReply(reply: ReplyContext): string {
  const senderDisplay = reply.sender?.displayName
    ? (reply.sender.displayName !== reply.sender.id
        ? `${escapeCompactParens(reply.sender.displayName)} (${reply.sender.id})`
        : reply.sender.id)
    : "unknown";
  const time = reply.timestamp ? ` At: ${compactTime(reply.timestamp)}` : "";
  const body = reply.body ? `: ${truncate(normalizeWhitespace(reply.body), 4096)}` : "";
  return `\n\n(Replying to: > [From: ${senderDisplay}${time}]${body})\n\n`;
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

function escapeCompactParens(value: string): string {
  return value.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
