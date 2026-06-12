import type {
  AttachmentMeta,
  CanonicalChatEvent,
  LinkPreviewMeta,
  ReactionAggregate,
  ReplyContext,
} from "../types.js";
import type { XMediaSlot, XTweetNode } from "../fxtwitter/types.js";
import { FX_TWITTER_SOURCE_KIND } from "../fxtwitter/types.js";
import { formatStatsLine } from "../fxtwitter/format.js";
import { escapeAttr, escapeXml } from "./xml.js";
import { compactAgentTimestamp, formatAgentTimestamp } from "../time/index.js";

export type RenderTier = "rich" | "compact";

const MAX_DISPLAY_NAME = 256;
const MAX_FILENAME = 256;
const MAX_URL = 2048;

// Compact-tier tweet text caps (ARCHITECTURE.md §7a). Renderer constants like
// the caps above, NOT config: tweets must not ride the generic 1000-char
// compact description truncation, which is far too generous for aged-out
// messages.
const MAX_COMPACT_TWEET_TEXT = 280;
const MAX_COMPACT_QUOTE_TEXT = 140;

/** Hint appended after truncated tweet text/notes (payload.textTruncated). */
const X_FETCH_TRUNCATION_HINT = "[truncated — full text available via the x_fetch tool]";

export function renderMessage(event: CanonicalChatEvent, tier: RenderTier): string {
  return tier === "rich" ? renderRichMessage(event) : renderCompactMessage(event);
}

/**
 * Placeholder shown for an undecryptable (UTD) event, mirroring what a human
 * Matrix client renders. Carries no body/attachments — only the sender and
 * timestamp (from the message envelope) are visible.
 */
const UTD_PLACEHOLDER = "🔒 unable to decrypt this message";

export interface RenderRichOptions {
  /**
   * Cap the rendered message body to this many characters (truncated with an
   * ellipsis). Undefined (the default) emits the body verbatim — the live
   * context builder relies on the full body, so only bounded callers (e.g. the
   * search tool over arbitrary-size historical events) should pass this.
   */
  bodyMax?: number;
}

export function renderRichMessage(event: CanonicalChatEvent, opts?: RenderRichOptions): string {
  const attrs = buildMessageAttrs(event);

  // UTD: keep the <message> envelope (sender/time attrs) but emit only the lock
  // placeholder — never the body or attachments, which are absent/meaningless.
  if (event.undecryptable) {
    return `<message ${attrs}>\n${escapeXml(UTD_PLACEHOLDER)}\n</message>`;
  }

  const parts: string[] = [];
  const body = opts?.bodyMax !== undefined ? truncate(event.body, opts.bodyMax) : event.body;

  if (event.replyTo) parts.push(renderReply(event.replyTo));
  parts.push(escapeXml(body));
  for (const a of event.attachments ?? []) parts.push(renderAttachment(a));
  for (const m of event.linkedMedia ?? []) parts.push(renderLinkedMedia(m));
  for (const lp of event.linkPreviews ?? []) parts.push(renderLinkPreview(lp));
  // View A (ARCHITECTURE.md §9f): deduped reaction counts, spatially attached to
  // the message. Rich tier only — renderCompactMessage deliberately omits these,
  // which is what confines reaction-driven byte changes to the cache-volatile
  // rich suffix.
  if (event.reactions && event.reactions.length > 0) parts.push(renderReactions(event.reactions));

  return `<message ${attrs}>\n${parts.join("\n\n")}\n</message>`;
}

function renderReactions(reactions: ReactionAggregate[]): string {
  // e.g. <reactions>👍×3 :blobwave:×1 😮×1</reactions>. `display` is already the
  // glyph / :shortcode: / literal form; we can't show the custom image, identical
  // to how the react/list_reactions tools render.
  const items = reactions.map((r) => `${escapeXml(r.display)}×${r.count}`).join(" ");
  return `<reactions>${items}</reactions>`;
}

export function renderCompactMessage(event: CanonicalChatEvent): string {
  const time = compactTime(event.timestamp);
  const sender = compactSenderLabel(event);

  // UTD: keep the `[time] sender:` prefix but emit only the lock placeholder,
  // never the body/attachments (absent and never to be leaked).
  if (event.undecryptable) {
    return `[${time}] ${sender}: ${UTD_PLACEHOLDER}`;
  }

  const reply = event.replyTo ? compactReply(event.replyTo) : "";
  const attachments = (event.attachments ?? [])
    .map((a) => ` [attachment: ${truncate(a.filename ?? a.id, MAX_FILENAME)}${a.localPath ? ` ${a.localPath}` : ""}${a.caption ? ` caption=${truncate(a.caption, 300)}` : ""}]`)
    .join("");
  const linked = (event.linkedMedia ?? [])
    .map((m) => ` [linked_media: ${truncate(m.filename ?? m.id, MAX_FILENAME)}${m.localPath ? ` ${m.localPath}` : ""}${m.caption ? ` caption=${truncate(m.caption, 300)}` : ""}]`)
    .join("");
  const links = (event.linkPreviews ?? [])
    .map((lp) => compactLinkPreview(lp))
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
  pairs.push(["time", formatAgentTimestamp(event.timestamp)]);
  if (event.mentions?.mentionedSelf) pairs.push(["mentions_you", "true"]);
  if (event.externalId) pairs.push(["external_id", event.externalId]);
  if (event.agentSessionId) pairs.push(["agent_session_id", event.agentSessionId]);
  return pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
}

function renderReply(reply: ReplyContext): string {
  const pairs: [string, string][] = [];
  if (reply.sender) {
    pairs.push(["sender", reply.sender.id]);
    if (reply.sender.displayName && reply.sender.displayName !== reply.sender.id) {
      pairs.push(["display_name", truncate(reply.sender.displayName, MAX_DISPLAY_NAME)]);
    }
  }
  if (reply.timestamp) pairs.push(["time", formatAgentTimestamp(reply.timestamp)]);
  if (reply.externalId) pairs.push(["external_id", reply.externalId]);

  const innerParts: string[] = [];
  if (reply.body && reply.body.trim().length > 0) innerParts.push(escapeXml(reply.body));
  for (const a of reply.attachments ?? []) innerParts.push(renderAttachment(a));
  for (const m of reply.linkedMedia ?? []) innerParts.push(renderLinkedMedia(m));
  for (const lp of reply.linkPreviews ?? []) innerParts.push(renderLinkPreview(lp));
  // Unresolved reply context (enrichment pending or the target couldn't be
  // fetched): say so instead of showing the model an empty quote block.
  if (innerParts.length === 0) innerParts.push("[original message unavailable]");

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
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

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
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

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  if (media.caption) {
    return `<linked_media ${attrStr}>\n[caption: ${escapeXml(media.caption)}]\n</linked_media>`;
  }
  return `<linked_media ${attrStr}/>`;
}

function renderLinkPreview(preview: LinkPreviewMeta): string {
  // X.com previews with a parseable payload get the structured rendering
  // (ARCHITECTURE.md §7a); without a payload (failed fetch, legacy row) they
  // fall through to the flat description form below like any other preview.
  if (preview.sourceKind === FX_TWITTER_SOURCE_KIND && preview.payload) {
    return renderXPreview(preview);
  }

  const pairs: [string, string][] = [
    ["url", truncate(preview.url, MAX_URL)],
  ];
  if (preview.title) pairs.push(["title", truncate(preview.title, MAX_DISPLAY_NAME)]);

  const innerParts: string[] = [escapeXml(preview.description ?? "")];
  for (const m of preview.media ?? []) innerParts.push(renderPreviewMedia(m));

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  return `<link_preview ${attrStr}>\n${innerParts.join("\n\n")}\n</link_preview>`;
}

function renderXPreview(preview: LinkPreviewMeta): string {
  const assetById = new Map<string, AttachmentMeta>();
  for (const m of preview.media ?? []) assetById.set(m.id, m);
  const tweet = renderXTweetNode(preview.payload!.tweet, assetById, "tweet");
  const urlAttr = `url="${escapeAttr(truncate(preview.url, MAX_URL))}"`;
  return `<link_preview ${urlAttr} kind="x.com">\n${tweet}\n</link_preview>`;
}

function renderXTweetNode(
  node: XTweetNode,
  assetById: Map<string, AttachmentMeta>,
  tag: "tweet" | "quoted_tweet",
): string {
  const pairs: [string, string][] = [];
  if (node.authorName) pairs.push(["author", truncate(node.authorName, MAX_DISPLAY_NAME)]);
  if (node.authorHandle) pairs.push(["handle", `@${node.authorHandle}`]);
  if (node.createdAtMs !== undefined) pairs.push(["time", compactAgentTimestamp(node.createdAtMs)]);
  const stats = formatStatsLine(node.stats);
  if (stats) pairs.push(["stats", stats]);

  const innerParts: string[] = [];
  if (node.text) {
    const hint = node.textTruncated ? `\n${X_FETCH_TRUNCATION_HINT}` : "";
    innerParts.push(`${escapeXml(node.text)}${hint}`);
  }
  if (node.poll) {
    const pollAttrs = node.poll.totalVotes !== undefined ? ` total_votes="${node.poll.totalVotes}"` : "";
    const choices = node.poll.choices
      .map((c) => {
        const pct = c.percentage !== undefined ? ` — ${c.percentage}%` : "";
        const count = c.count !== undefined ? ` (${c.count.toLocaleString("en-US")})` : "";
        return escapeXml(`${c.label}${pct}${count}`);
      })
      .join("\n");
    innerParts.push(`<poll${pollAttrs}>\n${choices}\n</poll>`);
  }
  if (node.communityNote) {
    const hint = node.communityNoteTruncated ? `\n${X_FETCH_TRUNCATION_HINT}` : "";
    innerParts.push(`<community_note>\n${escapeXml(node.communityNote)}${hint}\n</community_note>`);
  }
  const photoTotal = (node.media ?? []).filter((s) => s.kind === "photo").length;
  for (const slot of node.media ?? []) {
    innerParts.push(renderXTweetMedia(slot, assetById.get(slot.assetId), photoTotal));
  }
  if (node.quote) {
    innerParts.push(renderXTweetNode(node.quote, assetById, "quoted_tweet"));
  }

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  const open = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;
  return `${open}\n${innerParts.join("\n\n")}\n</${tag}>`;
}

function renderXTweetMedia(
  slot: XMediaSlot,
  asset: AttachmentMeta | undefined,
  photoTotal: number,
): string {
  const pairs: [string, string][] = [["kind", slot.kind]];
  if (slot.kind === "mosaic" && slot.photoCount !== undefined) {
    pairs.push(["photos", String(slot.photoCount)]);
  }
  // Positional caption correlation in individual-photos mode: each photo slot
  // carries its 1-based index out of the node's photo count.
  if (slot.kind === "photo" && slot.index !== undefined && photoTotal > 1) {
    pairs.push(["index", `${slot.index}/${photoTotal}`]);
  }
  if (asset?.mimeType) pairs.push(["type", asset.mimeType]);
  if (slot.durationSeconds !== undefined) pairs.push(["duration", `${slot.durationSeconds}s`]);
  // A failed download renders visibly, never silently (spec §6.2).
  const failed = !asset || asset.processing?.downloaded === false;
  if (failed) {
    pairs.push(["status", "failed"]);
    const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
    return `<tweet_media ${attrStr}/>`;
  }
  if (asset.localPath) pairs.push(["path", asset.localPath]);
  if (asset.isImageBlock) pairs.push(["image_block", "true"]);

  const innerParts: string[] = [];
  if (slot.altText) innerParts.push(`[alt: ${escapeXml(slot.altText)}]`);
  if (asset.caption) innerParts.push(`[caption: ${escapeXml(asset.caption)}]`);

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  if (innerParts.length === 0) return `<tweet_media ${attrStr}/>`;
  return `<tweet_media ${attrStr}>\n${innerParts.join("\n")}\n</tweet_media>`;
}

function renderPreviewMedia(media: AttachmentMeta): string {
  const pairs: [string, string][] = [
    ["filename", truncate(media.filename ?? media.id, MAX_FILENAME)],
    ["type", media.mimeType ?? media.mediaType],
  ];
  if (media.localPath) pairs.push(["path", media.localPath]);
  if (media.isImageBlock) pairs.push(["image_block", "true"]);

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  if (media.caption) {
    return `<preview_media ${attrStr}>\n[caption: ${escapeXml(media.caption)}]\n</preview_media>`;
  }
  return `<preview_media ${attrStr}/>`;
}

function compactLinkPreview(lp: LinkPreviewMeta): string {
  // X.com previews truncate MUCH earlier than the generic 1000-char form:
  // tweet text at 280 chars, quote at 140; media as counts only. Stats, polls,
  // notes, captions and paths are all dropped at this tier (ARCHITECTURE.md §7a).
  if (lp.sourceKind === FX_TWITTER_SOURCE_KIND && lp.payload) {
    const main = compactTweetPart(lp.payload.tweet, MAX_COMPACT_TWEET_TEXT);
    const quote = lp.payload.tweet.quote
      ? ` | quoting ${compactTweetPart(lp.payload.tweet.quote, MAX_COMPACT_QUOTE_TEXT)}`
      : "";
    return ` [tweet: ${main}${quote}]`;
  }
  return ` [link: ${truncate(lp.title ?? lp.url, MAX_FILENAME)} — ${truncate(lp.description ?? "", 1000)}]`;
}

function compactTweetPart(node: XTweetNode, maxText: number): string {
  const handle = node.authorHandle ? ` (@${node.authorHandle})` : "";
  const who = `${node.authorName ?? "unknown"}${handle}`;
  const text = node.text ? `: "${truncate(normalizeWhitespace(node.text), maxText)}"` : "";
  const counts = compactMediaCounts(node.media ?? []);
  return `${who}${text}${counts.length > 0 ? ` · ${counts.join(" · ")}` : ""}`;
}

function compactMediaCounts(slots: XMediaSlot[]): string[] {
  let photos = 0;
  let videos = 0;
  let gifs = 0;
  for (const slot of slots) {
    if (slot.kind === "photo") photos += 1;
    else if (slot.kind === "mosaic") photos += slot.photoCount ?? 1;
    // A thumbnail-fallback slot still represents a video to the reader.
    else if (slot.kind === "video" || slot.kind === "video_thumbnail") videos += 1;
    else if (slot.kind === "gif") gifs += 1;
  }
  const parts: string[] = [];
  if (photos > 0) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  if (gifs > 0) parts.push(`${gifs} gif${gifs === 1 ? "" : "s"}`);
  return parts;
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
  return compactAgentTimestamp(timestamp);
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
