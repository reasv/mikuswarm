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
import { YOUTUBE_SOURCE_KIND, formatDuration, formatChapterTimestamp, formatUploadDate } from "../youtube/payload.js";
import type { YouTubePreviewPayload } from "../youtube/payload.js";
import { YOTSUBA_SOURCE_KIND } from "../yotsuba/types.js";
import type { YotsubaPreviewPayload, YotsubaPostNode, YotsubaPostFile } from "../yotsuba/types.js";
import { backlinksLine, fileElement, omittedElement, threadOpenTag, boardLabel } from "../yotsuba/format.js";
import type { FileRenderInfo } from "../yotsuba/format.js";
import { escapeAttr, escapeXml } from "./xml.js";
import { deletedPlaceholder } from "../timeline/deletions.js";
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
// Per-media caption/alt cap in the compact tweet line. A media-only tweet must
// still carry its content at this tier (it may be the entire message, and
// generation sessions render compact) — but bounded, since compact exists for
// token economy. Renderer constant, not config (sibling of the caps above).
const MAX_COMPACT_MEDIA_CAPTION = 200;

/** Hint appended after truncated tweet text/notes (payload.textTruncated). */
const X_FETCH_TRUNCATION_HINT = "[truncated — full text available via the x_fetch tool]";

/**
 * Every element name this renderer writes into the agent's context. The
 * send-contract `context_mimicry` detector (spec REFUSAL-HANDLING §7.2,
 * `agent/contract.ts`) matches against this list, so a tag added here is
 * detected without touching the detector; test/contract-events.test.ts fails
 * when a tag written below is missing from it.
 */
export const RENDERED_MESSAGE_TAGS: readonly string[] = [
  "message",
  "reply_to",
  "attachment",
  "handled_by_session",
  "cross_channel_note",
  "reactions",
  "link_preview",
  "linked_media",
  "preview_media",
  "tweet_media",
  "community_note",
  "poll",
  "youtube_video",
  "transcript",
  "board",
  "thread",
  "post",
  "omitted",
];

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
  /**
   * Claim-marker predicate (spec DUPLICATE-REPLY-MITIGATION §4): given a message's
   * Matrix external id, return a marker for *another* session that has claimed it
   * (its trigger), or undefined. When it returns a marker, a `<handled_by_session>`
   * child is emitted as the first part of the message so the model knows another
   * session is already answering it — `id="…"` when the owning session is known, or
   * `pending="true"` for an un-attributed (queued / pre-launch) claim whose session
   * id does not exist yet (review #4). The builder binds this to the current session
   * (self-claims excluded) and a build-time snapshot of the claim registry. RICH
   * TIER ONLY — the compact renderer never receives it, keeping the cache-stable
   * compact prefix byte-identical (§4.3). Undefined for every non-live-build caller.
   */
  claimedBy?: (externalId: string) => { sessionId?: string } | undefined;
  /**
   * Render a deleted message (`event.deleted`) as the deletion placeholder: the
   * envelope (sender, time, ids) and `[message deleted]`, never its content.
   * Set by the recent tiers and level-1 summary inputs (ARCHITECTURE.md §6
   * "Message edits"); search and the history tools leave it unset and render the
   * stored content.
   */
  deletedPlaceholder?: boolean;
}

/** Options of {@link renderCompactMessage}. */
export interface RenderCompactOptions {
  /** As {@link RenderRichOptions.deletedPlaceholder}. */
  deletedPlaceholder?: boolean;
}

/** The recent tiers' rich renderer: a deleted message shows the deletion placeholder. */
export function renderRecentRichMessage(event: CanonicalChatEvent, opts?: RenderRichOptions): string {
  return renderRichMessage(event, { ...opts, deletedPlaceholder: true });
}

/** The recent tiers' compact renderer: a deleted message shows the deletion placeholder. */
export function renderRecentCompactMessage(event: CanonicalChatEvent): string {
  return renderCompactMessage(event, { deletedPlaceholder: true });
}

export function renderRichMessage(event: CanonicalChatEvent, opts?: RenderRichOptions): string {
  // Deleted (recent tiers only): the envelope without content-derived attributes,
  // and the placeholder in place of everything the message carried.
  if (opts?.deletedPlaceholder && event.deleted) {
    return `<message ${buildMessageAttrs(event, { content: false })}>\n${escapeXml(deletedPlaceholder(event.deleted, event.sender.id))}\n</message>`;
  }
  const attrs = buildMessageAttrs(event);

  // UTD: keep the <message> envelope (sender/time attrs) but emit only the lock
  // placeholder — never the body or attachments, which are absent/meaningless.
  if (event.undecryptable) {
    return `<message ${attrs}>\n${escapeXml(UTD_PLACEHOLDER)}\n</message>`;
  }

  const parts: string[] = [];
  const body = opts?.bodyMax !== undefined ? truncate(event.body, opts.bodyMax) : event.body;

  // Claim marker (§4): a message another session has claimed is flagged "hands off"
  // before its body, so the model uses it as context but does not re-answer it.
  // Self-claims are already excluded by the predicate. An un-attributed (queued /
  // pre-launch) claim has no session id yet → render `pending="true"` (review #4).
  const claim =
    event.externalId && opts?.claimedBy ? opts.claimedBy(event.externalId) : undefined;
  if (claim) {
    parts.push(
      claim.sessionId
        ? `<handled_by_session id="${escapeAttr(claim.sessionId)}"/>`
        : `<handled_by_session pending="true"/>`,
    );
  }

  if (event.replyTo) parts.push(renderReply(event.replyTo));
  parts.push(escapeXml(body));
  for (const a of event.attachments ?? []) parts.push(renderAttachment(a));
  for (const m of event.linkedMedia ?? []) parts.push(renderLinkedMedia(m));
  for (const lp of filterYotsubaSupersededPreviews(event.linkPreviews ?? [])) parts.push(renderLinkPreview(lp));
  // View A (ARCHITECTURE.md §9f): deduped reaction counts, spatially attached to
  // the message. Rich tier only — renderCompactMessage deliberately omits these,
  // which is what confines reaction-driven byte changes to the cache-volatile
  // rich suffix.
  if (event.reactions && event.reactions.length > 0) parts.push(renderReactions(event.reactions));

  // Cross-channel context note (spec CROSS-CHANNEL-MESSAGING §6): render as a
  // child element so the fresh DM session sees intent + relay instructions.
  // Stored locally only — never transmitted on the wire.
  if (event.crossChannel) {
    const cc = event.crossChannel;
    parts.push(
      `<cross_channel_note origin="${escapeAttr(cc.originTimelineKey)}" ` +
        `sender="${escapeAttr(cc.originSenderId)}" ` +
        `session="${escapeAttr(cc.originSessionId)}">${escapeXml(cc.note)}</cross_channel_note>`,
    );
  }

  return `<message ${attrs}>\n${parts.join("\n\n")}\n</message>`;
}

function renderReactions(reactions: ReactionAggregate[]): string {
  // e.g. <reactions>👍×3 :blobwave:×1 😮×1</reactions>. `display` is already the
  // glyph / :shortcode: / literal form; we can't show the custom image, identical
  // to how the react/list_reactions tools render.
  const items = reactions.map((r) => `${escapeXml(r.display)}×${r.count}`).join(" ");
  return `<reactions>${items}</reactions>`;
}

export function renderCompactMessage(event: CanonicalChatEvent, opts?: RenderCompactOptions): string {
  const time = compactTime(event.timestamp);
  const sender = compactSenderLabel(event);

  // Deleted (recent tiers only): the `[time] sender:` prefix and the placeholder.
  if (opts?.deletedPlaceholder && event.deleted) {
    return `[${time}] ${sender}: ${deletedPlaceholder(event.deleted, event.sender.id)}`;
  }

  // UTD: keep the `[time] sender:` prefix but emit only the lock placeholder,
  // never the body/attachments (absent and never to be leaked).
  if (event.undecryptable) {
    return `[${time}] ${sender}: ${UTD_PLACEHOLDER}`;
  }

  const reply = event.replyTo ? compactReply(event.replyTo) : "";
  const attachments = (event.attachments ?? []).map(compactAttachmentPart).join("");
  const linked = (event.linkedMedia ?? []).map(compactLinkedMediaPart).join("");
  const links = (event.linkPreviews ?? []).map(compactLinkPreview).join("");
  // Cross-channel note suffix (spec CROSS-CHANNEL-MESSAGING §6): compact form is
  // a bracketed annotation appended after the body.
  const crossNote = event.crossChannel
    ? ` [→ from ${event.crossChannel.originTimelineKey}: ${event.crossChannel.note}]`
    : "";
  return `[${time}] ${sender}${reply}: ${truncate(normalizeWhitespace(event.body), 6000)}${attachments}${linked}${links}${crossNote}`;
}

function buildMessageAttrs(event: CanonicalChatEvent, opts?: { content?: boolean }): string {
  // §6.2 rendering rule: human-facing label is `username ?? id`; raw `id` is
  // reserved for `external_id` only (the declared exception for tool addressing).
  const handle = event.sender.username ?? event.sender.id;
  const pairs: [string, string][] = [
    ["sender", handle],
  ];
  if (event.sender.displayName && event.sender.displayName !== handle) {
    pairs.push(["display_name", truncate(event.sender.displayName, MAX_DISPLAY_NAME)]);
  }
  pairs.push(["time", formatAgentTimestamp(event.timestamp)]);
  if (opts?.content !== false && event.mentions?.mentionedSelf) pairs.push(["mentions_you", "true"]);
  if (event.externalId) pairs.push(["external_id", event.externalId]);
  if (event.agentSessionId) pairs.push(["agent_session_id", event.agentSessionId]);
  return pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
}

function renderReply(reply: ReplyContext): string {
  const pairs: [string, string][] = [];
  if (reply.sender) {
    // §6.2 rendering rule: same `username ?? id` handle used here for consistency.
    const handle = reply.sender.username ?? reply.sender.id;
    pairs.push(["sender", handle]);
    if (reply.sender.displayName && reply.sender.displayName !== handle) {
      pairs.push(["display_name", truncate(reply.sender.displayName, MAX_DISPLAY_NAME)]);
    }
  }
  if (reply.timestamp) pairs.push(["time", formatAgentTimestamp(reply.timestamp)]);
  if (reply.externalId) pairs.push(["external_id", reply.externalId]);
  if (reply.agentSessionId) pairs.push(["agent_session_id", reply.agentSessionId]);

  const attrStrDeleted = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  // A quote of a deleted message shows the placeholder, never the stored quote.
  if (reply.deleted) {
    return `<reply_to ${attrStrDeleted}>\n${escapeXml(deletedPlaceholder(reply.deleted, reply.sender?.id))}\n</reply_to>`;
  }

  const innerParts: string[] = [];
  if (reply.body && reply.body.trim().length > 0) innerParts.push(escapeXml(reply.body));
  for (const a of reply.attachments ?? []) innerParts.push(renderAttachment(a));
  for (const m of reply.linkedMedia ?? []) innerParts.push(renderLinkedMedia(m));
  for (const lp of filterYotsubaSupersededPreviews(reply.linkPreviews ?? [])) innerParts.push(renderLinkPreview(lp));
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

  // YouTube previews with a parseable payload get the structured rendering
  // (ARCHITECTURE.md §7e); without a payload they fall through to the flat form.
  if (preview.sourceKind === YOUTUBE_SOURCE_KIND && preview.ytPayload) {
    return renderYouTubePreview(preview, preview.ytPayload);
  }

  // 4chan (Yotsuba) previews with a parseable payload get the structured
  // rendering (ARCHITECTURE.md §7f). Without a payload (failed fetch, legacy
  // row) they fall through to the flat form below.
  if (preview.sourceKind === YOTSUBA_SOURCE_KIND) {
    return renderYotsubaPreview(preview);
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

/**
 * Full-tier renderer for YouTube enriched previews (ARCHITECTURE.md §7e).
 *
 * Structure inside <link_preview kind="youtube">:
 *   - <youtube_video> element with title/channel/duration/uploaded/views attrs
 *   - Chapter list: one "[M:SS] Title" line per chapter
 *   - <transcript> element (untrusted, escaped) with partial marker pointing at
 *     the youtube_fetch tool
 *   - Preview-media thumbnail (if available, same as the generic path)
 */
function renderYouTubePreview(preview: LinkPreviewMeta, payload: YouTubePreviewPayload): string {
  const urlAttr = `url="${escapeAttr(truncate(preview.url, MAX_URL))}"`;
  const innerParts: string[] = [renderYouTubeVideoNode(payload)];
  for (const m of preview.media ?? []) innerParts.push(renderPreviewMedia(m));
  return `<link_preview ${urlAttr} kind="youtube">\n${innerParts.join("\n\n")}\n</link_preview>`;
}

function renderYouTubeVideoNode(payload: YouTubePreviewPayload): string {
  const pairs: [string, string][] = [];
  if (payload.title) pairs.push(["title", truncate(payload.title, MAX_DISPLAY_NAME)]);
  if (payload.channel) pairs.push(["channel", truncate(payload.channel, MAX_DISPLAY_NAME)]);
  if (payload.durationSeconds !== undefined) {
    pairs.push(["duration", formatDuration(payload.durationSeconds)]);
  }
  const uploadedStr = formatUploadDate(payload.uploadDate);
  if (uploadedStr) pairs.push(["uploaded", uploadedStr]);
  if (payload.viewCount !== undefined) {
    pairs.push(["views", payload.viewCount.toLocaleString("en-US")]);
  }

  const bodyParts: string[] = [];

  // Chapter list (one per line: "[M:SS] Chapter title"). Capped at 20 to
  // avoid unbounded context growth on heavily-chaptered videos.
  const MAX_CHAPTERS = 20;
  if (payload.chapters.length > 0) {
    const visible = payload.chapters.slice(0, MAX_CHAPTERS);
    const lines = visible
      .map((ch) => `${formatChapterTimestamp(ch.startTime)} ${escapeXml(ch.title)}`)
      .join("\n");
    const remaining = payload.chapters.length - visible.length;
    const elision = remaining > 0 ? `\n[… and ${remaining} more chapters]` : "";
    bodyParts.push(`${lines}${elision}`);
  }

  // Transcript head (externally-sourced text — escaped, untrusted envelope).
  if (payload.transcriptKind !== "none" && payload.transcriptHead) {
    const kindAttr = `kind="${escapeAttr(payload.transcriptKind)}"`;
    const langAttr = payload.transcriptLang ? ` lang="${escapeAttr(payload.transcriptLang)}"` : "";
    const partialLine =
      "\n[partial — full transcript available via the youtube_fetch tool]";
    bodyParts.push(
      `<transcript ${kindAttr}${langAttr} partial="true">\n${escapeXml(payload.transcriptHead)}${partialLine}\n</transcript>`,
    );
  }

  const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  const open = attrStr ? `<youtube_video ${attrStr}>` : `<youtube_video>`;
  if (bodyParts.length === 0) return `${open}\n</youtube_video>`;
  return `${open}\n${bodyParts.join("\n\n")}\n</youtube_video>`;
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
  // X.com previews truncate MUCH earlier than the generic 1000-char form: tweet
  // text at 280 chars, quote at 140. Media renders with its caption/alt text
  // (bounded) — a media-only tweet must still carry content at this tier, which
  // generation sessions (summarize/diary) routinely see (ARCHITECTURE.md §7a).
  // Stats, polls, notes and media paths remain dropped.
  if (lp.sourceKind === FX_TWITTER_SOURCE_KIND && lp.payload) {
    const assetById = new Map<string, AttachmentMeta>();
    for (const m of lp.media ?? []) assetById.set(m.id, m);
    const main = compactTweetPart(lp.payload.tweet, MAX_COMPACT_TWEET_TEXT, assetById);
    const quote = lp.payload.tweet.quote
      ? ` | quoting ${compactTweetPart(lp.payload.tweet.quote, MAX_COMPACT_QUOTE_TEXT, assetById)}`
      : "";
    return ` [tweet: ${main}${quote}]`;
  }

  // YouTube previews: [youtube: "Title" · Channel · M:SS · transcript head…]
  // Bounded by MAX_COMPACT_MEDIA_CAPTION (200 chars), same cap as media captions
  // (ARCHITECTURE.md §7e).
  if (lp.sourceKind === YOUTUBE_SOURCE_KIND && lp.ytPayload) {
    return compactYouTubePreview(lp.ytPayload);
  }

  // 4chan compact previews (ARCHITECTURE.md §7f): one compact inline line.
  if (lp.sourceKind === YOTSUBA_SOURCE_KIND) {
    return compactYotsubaPreview(lp);
  }

  return ` [link: ${truncate(lp.title ?? lp.url, MAX_FILENAME)} — ${truncate(lp.description ?? "", 1000)}]`;
}

/** Compact inline YouTube preview: [youtube: "Title" · Channel · M:SS · head…] */
function compactYouTubePreview(payload: YouTubePreviewPayload): string {
  const parts: string[] = [];
  if (payload.title) parts.push(`"${payload.title}"`);
  if (payload.channel) parts.push(payload.channel);
  if (payload.durationSeconds !== undefined) parts.push(formatDuration(payload.durationSeconds));
  if (payload.transcriptHead) {
    // Append normalized transcript head text.
    parts.push(normalizeWhitespace(payload.transcriptHead));
  }
  const joined = parts.join(" · ");
  return ` [youtube: ${truncate(joined, MAX_COMPACT_MEDIA_CAPTION)}]`;
}

function compactTweetPart(
  node: XTweetNode,
  maxText: number,
  assetById: Map<string, AttachmentMeta>,
): string {
  const handle = node.authorHandle ? ` (@${node.authorHandle})` : "";
  const who = `${node.authorName ?? "unknown"}${handle}`;
  const text = node.text ? `: "${truncate(normalizeWhitespace(node.text), maxText)}"` : "";
  const media = compactMediaParts(node.media ?? [], assetById);
  return `${who}${text}${media.length > 0 ? ` · ${media.join(" · ")}` : ""}`;
}

/**
 * Compact media rendering for a tweet node: each slot with a caption (preferred)
 * or alt text renders as `kind: text` (bounded); caption-less slots fold into an
 * aggregate count form appended after, so a tweet with one captioned video and
 * three plain photos reads `video: … · 3 photos`, not four fragments. Failed
 * downloads are shown, never silently dropped (parity with the rich `status`).
 */
function compactMediaParts(
  slots: XMediaSlot[],
  assetById: Map<string, AttachmentMeta>,
): string[] {
  const captioned: string[] = [];
  let photos = 0;
  let videos = 0;
  let gifs = 0;
  for (const slot of slots) {
    const label = compactMediaKind(slot);
    const asset = assetById.get(slot.assetId);
    if (asset && asset.processing?.downloaded === false) {
      captioned.push(`${label}: [media unavailable]`);
      continue;
    }
    const text = asset?.caption ?? slot.altText;
    if (text && text.trim().length > 0) {
      captioned.push(`${label}: ${truncate(normalizeWhitespace(text), MAX_COMPACT_MEDIA_CAPTION)}`);
      continue;
    }
    if (slot.kind === "photo") photos += 1;
    else if (slot.kind === "mosaic") photos += slot.photoCount ?? 1;
    // A thumbnail-fallback slot still represents a video to the reader.
    else if (slot.kind === "video" || slot.kind === "video_thumbnail") videos += 1;
    else if (slot.kind === "gif") gifs += 1;
  }
  const counts: string[] = [];
  if (photos > 0) counts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos > 0) counts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  if (gifs > 0) counts.push(`${gifs} gif${gifs === 1 ? "" : "s"}`);
  return [...captioned, ...counts];
}

/** Reader-facing kind label for a compact media slot. */
function compactMediaKind(slot: XMediaSlot): string {
  switch (slot.kind) {
    case "mosaic":
      return slot.photoCount !== undefined ? `mosaic(${slot.photoCount})` : "mosaic";
    case "video":
    case "video_thumbnail":
      return "video";
    case "gif":
      return "gif";
    default:
      return "photo";
  }
}

function compactSenderLabel(event: CanonicalChatEvent): string {
  // §6.2: human-facing label is `username ?? id`; displayName shown only when it
  // differs from the handle (same suppression guard as the rich XML sender attr).
  const handle = event.sender.username ?? event.sender.id;
  if (event.sender.displayName && event.sender.displayName !== handle) {
    return `${escapeCompactParens(event.sender.displayName)} (${handle})`;
  }
  return handle;
}

function compactReply(reply: ReplyContext): string {
  // §6.2: reply sender label uses `username ?? id` as the handle.
  const replyHandle = reply.sender ? (reply.sender.username ?? reply.sender.id) : undefined;
  const senderDisplay = reply.sender?.displayName
    ? (reply.sender.displayName !== replyHandle
        ? `${escapeCompactParens(reply.sender.displayName)} (${replyHandle})`
        : replyHandle)
    // When there is no displayName: providers with a username (Discord) use the handle;
    // providers without one (Matrix) fall back to "unknown", preserving pre-3a byte-identity.
    : (reply.sender?.username != null ? replyHandle : "unknown");
  const time = reply.timestamp ? ` At: ${compactTime(reply.timestamp)}` : "";
  // A quote of a deleted message shows the placeholder, never the stored quote.
  if (reply.deleted) {
    return `\n\n(Replying to: > [From: ${senderDisplay}${time}]: ${deletedPlaceholder(reply.deleted, reply.sender?.id)})\n\n`;
  }
  const body = reply.body ? `: ${truncate(normalizeWhitespace(reply.body), 4096)}` : "";
  // Reply-context media is carried at compact tier too (it was previously
  // dropped): a reply to a media-only message must not render as empty.
  const media =
    (reply.attachments ?? []).map(compactAttachmentPart).join("") +
    (reply.linkedMedia ?? []).map(compactLinkedMediaPart).join("") +
    (reply.linkPreviews ?? []).map(compactLinkPreview).join("");
  return `\n\n(Replying to: > [From: ${senderDisplay}${time}]${body}${media})\n\n`;
}

/** Compact inline form for a message/reply attachment (filename, path, caption). */
function compactAttachmentPart(a: AttachmentMeta): string {
  return ` [attachment: ${truncate(a.filename ?? a.id, MAX_FILENAME)}${a.localPath ? ` ${a.localPath}` : ""}${a.caption ? ` caption=${truncate(a.caption, 300)}` : ""}]`;
}

/** Compact inline form for linked media (image URLs referenced in the body). */
function compactLinkedMediaPart(m: AttachmentMeta): string {
  return ` [linked_media: ${truncate(m.filename ?? m.id, MAX_FILENAME)}${m.localPath ? ` ${m.localPath}` : ""}${m.caption ? ` caption=${truncate(m.caption, 300)}` : ""}]`;
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

// ---------------------------------------------------------------------------
// Yotsuba discord_embed suppression (spec §6.8)
// ---------------------------------------------------------------------------

/**
 * Suppress `discord_embed` rows that are already covered by a yotsuba row
 * for the same 4chan URL within the same preview list.
 * The spec says: when an event has a yotsuba row for `(board, threadNo)`,
 * suppress any `discord_embed` row whose URL maps to the same canonical URL.
 */
function filterYotsubaSupersededPreviews(previews: LinkPreviewMeta[]): LinkPreviewMeta[] {
  if (!previews.some((p) => p.sourceKind === YOTSUBA_SOURCE_KIND)) return previews;
  // Build a set of URLs covered by yotsuba rows.
  const yotsubaUrls = new Set<string>();
  for (const p of previews) {
    if (p.sourceKind === YOTSUBA_SOURCE_KIND) yotsubaUrls.add(normalizeYotsubaUrl(p.url));
  }
  return previews.filter((p) => {
    if (p.sourceKind !== "discord_embed") return true;
    return !yotsubaUrls.has(normalizeYotsubaUrl(p.url));
  });
}

/** Normalize a 4chan URL by stripping post anchors and trailing slashes. */
function normalizeYotsubaUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Yotsuba (4chan) renderers (ARCHITECTURE.md §7f, spec §6.6)
// ---------------------------------------------------------------------------

/**
 * Rich-zone renderer for a 4chan link preview. Handles thread, board, and
 * gone/failed cases. The `currentSessionTriggerGroupId` (from the trigger
 * event) is set on `preview` by the caller when available; image blocks are
 * only added in the session that did the upgrade.
 */
function renderYotsubaPreview(preview: LinkPreviewMeta): string {
  const urlAttr = `url="${escapeAttr(truncate(preview.url, MAX_URL))}" kind="4chan"`;
  const payload = preview.yotsubaPayload;

  // Gone (404 at enrichment).
  if (!payload || (payload.kind === "thread" && !payload.threadNo && !payload.posts)) {
    // Check if it's a "gone" row.
    const isGone = !payload;
    if (isGone) {
      return `<link_preview ${urlAttr} status="gone" checked="${escapeAttr(
        preview.fetchedAt ? compactAgentTimestamp(new Date(preview.fetchedAt)) : ""
      )}"/>`;
    }
  }

  if (!payload) {
    // Fall through to flat form.
    const pairs: [string, string][] = [["url", truncate(preview.url, MAX_URL)]];
    if (preview.title) pairs.push(["title", truncate(preview.title, MAX_DISPLAY_NAME)]);
    const attrStr = pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
    return `<link_preview ${attrStr}>\n${escapeXml(preview.description ?? "")}\n</link_preview>`;
  }

  if (payload.kind === "board") {
    return renderYotsuba4chanBoard(urlAttr, payload, preview);
  }

  return renderYotsuba4chanThread(urlAttr, payload, preview);
}

function renderYotsuba4chanBoard(
  urlAttr: string,
  payload: YotsubaPreviewPayload,
  preview: LinkPreviewMeta,
): string {
  const code = payload.board;
  const title = payload.boardTitle;
  const attrs: string[] = [];
  attrs.push(`code="/${escapeAttr(code)}/"`);
  if (title) attrs.push(`title="${escapeAttr(title)}"`);
  if (payload.worksafe) attrs.push(`worksafe="true"`);
  attrs.push(`as_of="${escapeAttr(
    payload.asOf ? compactAgentTimestamp(new Date(payload.asOf)) : ""
  )}"`);

  const threads = payload.threads ?? [];
  const threadLines: string[] = [];
  for (const t of threads) {
    const tAttrs: string[] = [`no="${t.no}"`];
    tAttrs.push(`replies="${t.replies}"`);
    if (t.files) tAttrs.push(`files="${t.files}"`);
    tAttrs.push(`started="${escapeAttr(compactAgentTimestamp(new Date(t.time)))}"`);
    const hasSubject = !!(t.subject?.trim());
    if (!hasSubject && t.opExcerpt) tAttrs.push(`op_excerpt="true"`);
    const content = hasSubject ? t.subject! : (t.opExcerpt ?? "");
    threadLines.push(`<thread ${tAttrs.join(" ")}>${escapeXml(content)}</thread>`);
  }

  const footer = `[4chan board: the top ${threads.length} threads on page 1. The yotsuba tool can search the catalog.]`;
  const inner = [...threadLines, footer].join("\n");
  return `<link_preview ${urlAttr}>\n<board ${attrs.join(" ")}>\n${inner}\n</board>\n</link_preview>`;
}

function renderYotsuba4chanThread(
  urlAttr: string,
  payload: YotsubaPreviewPayload,
  preview: LinkPreviewMeta,
): string {
  if (!payload.threadNo) {
    // Malformed/gone row — treat as gone.
    return `<link_preview ${urlAttr} status="gone" checked="${escapeAttr(
      preview.fetchedAt ? compactAgentTimestamp(new Date(preview.fetchedAt)) : ""
    )}"/>`;
  }

  const board = payload.board;
  const boardTitle = payload.boardTitle;
  const label = boardLabel(board, boardTitle);
  const threadOpenStr = threadOpenTag({
    board: label,
    threadNo: payload.threadNo,
    subject: payload.subject,
    // Spec §6.2: post links always carry the OP excerpt; thread links only
    // when untitled (the OP itself is the headline there).
    opExcerpt: !payload.subject || payload.linkedNo != null ? payload.opExcerpt : undefined,
    postCount: payload.postCount,
    fileCount: payload.fileCount,
    posters: payload.posters,
    statusFlags: payload.status,
    asOf: payload.asOf,
    linkedNo: payload.linkedNo,
  });

  const upgrade = payload.upgrade;
  const assetById = new Map<string, import("../types.js").AttachmentMeta>();
  for (const m of preview.media ?? []) assetById.set(m.id, m);

  // Determine which posts to render. If upgraded, use includedNos; else headline only.
  const allPosts = payload.posts ?? [];
  const includedNos: ReadonlySet<number> = upgrade
    ? new Set(upgrade.includedNos)
    : new Set([payload.headlineNo ?? payload.threadNo ?? 0]);
  const includedPosts = allPosts.filter((p) => includedNos.has(p.no));
  const processedIds = new Set(upgrade?.processedAssetIds ?? []);

  // Build shownNos for quote annotation.
  const shownNos = new Set(includedPosts.map((p) => p.no));
  const opNo = payload.threadNo;

  // Render posts in order with gap markers.
  const sortedPosts = [...includedPosts].sort((a, b) => a.index - b.index);
  const parts: string[] = [];

  let lastIndex = -1;
  let lastPost: import("../yotsuba/types.js").YotsubaPostNode | undefined;
  // filesUpToLastPost = files in posts 0..lastIndex (used for trailing gap file counts).
  let filesUpToLastPost = 0;
  const totalPosts = payload.postCount ?? allPosts.length;
  const headlineNo = payload.headlineNo ?? payload.threadNo;
  // Upgraded: the trigger headline cap recorded by the upgrade. Ambient: the
  // ambient cap recorded at capture (spec §6.3), default 300.
  const headlineCharCap = upgrade ? upgrade.headlineChars : (payload.ambientChars ?? 300);

  for (const post of sortedPosts) {
    const gap = post.index - lastIndex - 1;
    if (gap > 0 && upgrade) {
      // Count files in the gap using filesBefore when available, else approximate.
      let gapFiles: number;
      if (post.filesBefore !== undefined && lastPost !== undefined) {
        gapFiles = post.filesBefore - filesUpToLastPost;
      } else if (post.filesBefore !== undefined && lastPost === undefined) {
        // Leading gap: filesBefore is exactly how many files are before this post.
        gapFiles = post.filesBefore;
      } else {
        gapFiles = allPosts.filter((p) => p.index > lastIndex && p.index < post.index && p.file).length;
      }
      parts.push(`<omitted posts="${gap}"${gapFiles > 0 ? ` files="${gapFiles}"` : ""}/>` );
    }
    const isHeadline = headlineCharCap !== undefined && post.no === headlineNo;
    parts.push(renderYotsubaPostNode(
      post, shownNos, opNo, assetById, processedIds, preview,
      isHeadline ? headlineCharCap : undefined,
      upgrade !== undefined,
      // §5.4: the replies line belongs to the post the view is about, i.e. the
      // linked post of an upgraded post-link rendering.
      upgrade !== undefined && post.role === "linked",
    ));
    lastIndex = post.index;
    lastPost = post;
    filesUpToLastPost = (post.filesBefore ?? filesUpToLastPost) + (post.file ? 1 : 0);
  }

  // Trailing gap (posts after the last shown post, to the end of the thread).
  const threadEndIndex = totalPosts - 1;
  if (upgrade && lastIndex < threadEndIndex) {
    const trailingGap = threadEndIndex - lastIndex;
    let trailingFiles: number;
    if (lastPost !== undefined && payload.fileCount !== undefined && lastPost.filesBefore !== undefined) {
      trailingFiles = Math.max(0, payload.fileCount - filesUpToLastPost);
    } else {
      trailingFiles = allPosts.filter((p) => p.index > lastIndex && p.file).length;
    }
    parts.push(`<omitted posts="${trailingGap}"${trailingFiles > 0 ? ` files="${trailingFiles}"` : ""}/>` );
  }

  // Footer line.
  parts.push(buildYotsubaThreadFooter(payload, upgrade));

  const inner = parts.join("\n");
  return `<link_preview ${urlAttr}>\n${threadOpenStr}\n${inner}\n</thread>\n</link_preview>`;
}

function renderYotsubaPostNode(
  post: YotsubaPostNode,
  shownNos: ReadonlySet<number>,
  opNo: number,
  assetById: Map<string, import("../types.js").AttachmentMeta>,
  processedIds: ReadonlySet<string>,
  preview: LinkPreviewMeta,
  /** When set, cap the post text at this many characters and append an ellipsis note. */
  charCap?: number,
  /** Trigger (upgraded) rendering: unprocessed downloaded files render `auto="off"`. */
  upgraded = false,
  /** Append the "[N replies: … shown; M more not shown]" line from `replyNos`. */
  showBacklinks = false,
): string {
  const attrs: string[] = [];
  attrs.push(`no="${post.no}"`);
  attrs.push(`role="${post.role}"`);
  if (post.posterId) attrs.push(`id="${escapeAttr(post.posterId)}"`);
  if (post.flag) attrs.push(`flag="${escapeAttr(post.flag)}"`);
  if (post.trip) attrs.push(`trip="${escapeAttr(post.trip)}"`);
  if (post.capcode) attrs.push(`capcode="${escapeAttr(post.capcode)}"`);
  attrs.push(`time="${escapeAttr(compactAgentTimestamp(new Date(post.time)))}"`);
  if (post.replies > 0) attrs.push(`replies="${post.replies}"`);

  const parts: string[] = [`<post ${attrs.join(" ")}>`];

  // Text with quote annotation; apply char cap first if set.
  const rawText = (charCap !== undefined && post.text.length > charCap)
    ? post.text.slice(0, charCap)
    : post.text;
  const overflow = (charCap !== undefined && post.text.length > charCap)
    ? post.text.length - charCap
    : 0;
  const deadNos = new Set(post.deadQuotes ?? []);
  const annotated = annotateYotsubaQuotes(rawText, post.quotes, shownNos, opNo, deadNos);
  // Cross-thread quotes are already inline in the converted text (markup.ts
  // writes `>>>/b/N` in place); annotate them there instead of repeating them.
  let textWithCross = post.crossQuotes?.length
    ? annotated.replace(/>>>\/[a-z0-9]{1,10}\/\d*/g, (m) => `${m} (other thread)`)
    : annotated;
  if (overflow > 0) {
    textWithCross = textWithCross + `\n[… ${overflow} more characters]`;
  }
  parts.push(escapeXml(textWithCross));

  // File element.
  if (post.file) {
    parts.push(renderYotsubaFileNode(post.file, assetById, processedIds, upgraded));
  }

  if (showBacklinks && post.replyNos?.length) {
    parts.push(backlinksLine(post.replyNos, shownNos));
  }

  parts.push("</post>");
  return parts.join("\n");
}

function renderYotsubaFileNode(
  file: YotsubaPostFile,
  assetById: Map<string, import("../types.js").AttachmentMeta>,
  processedIds: ReadonlySet<string>,
  upgraded = false,
): string {
  if (file.deleted) {
    const info: FileRenderInfo = {
      name: file.name,
      ext: file.ext,
      status: "deleted",
    };
    return fileElement(info);
  }
  const assetId = file.assetId;
  const sbAssetId = file.storyboardAssetId;
  const asset = assetId ? assetById.get(assetId) : undefined;
  const sbAsset = sbAssetId ? assetById.get(sbAssetId) : undefined;

  let status: FileRenderInfo["status"];
  if (!assetId) {
    status = "not shown";
  } else if (!upgraded || processedIds.has(assetId) || (sbAssetId && processedIds.has(sbAssetId))) {
    // Ambient: the headline file follows the normal caption rules (spec §6.2),
    // so it is a plain stored file. Upgraded: processed files are "shown".
    status = "shown";
  } else {
    status = "stored";
  }

  // Image block flag: only when the context builder actually sent this file (or
  // its storyboard) as a block in THIS build (it marks AttachmentMeta.isImageBlock).
  // processedIds persist across sessions; blocks do not (spec §6.5).
  const isImageBlock = !!(asset?.isImageBlock || sbAsset?.isImageBlock);

  // Caption: the original file's (a video's caption comes from the video lane);
  // the storyboard's only as a fallback.
  const caption = asset?.caption ?? sbAsset?.caption ?? undefined;

  const info: FileRenderInfo = {
    name: file.name,
    ext: file.ext,
    mimeType: asset?.mimeType ?? undefined,
    w: file.w,
    h: file.h,
    bytes: file.bytes,
    durationSec: file.durationSec,
    spoiler: file.spoiler,
    path: asset?.localPath ?? undefined,
    storyboardPath: sbAsset?.localPath ?? undefined,
    caption,
    status,
    imageBlock: isImageBlock,
  };
  return fileElement(info);
}

/** Annotate >>N quotelinks in post text. */
function annotateYotsubaQuotes(
  text: string,
  quotes: number[],
  shownNos: ReadonlySet<number>,
  opNo: number,
  deadNos: ReadonlySet<number>,
): string {
  // Replace >>N references with annotations for context.
  return text.replace(/>>([\d]+)/g, (match, numStr) => {
    const n = parseInt(numStr, 10);
    if (deadNos.has(n)) return `>>${n} (deleted)`;
    if (shownNos.has(n)) return `>>${n}`;
    if (n === opNo) return `>>${n} (OP)`;
    return `>>${n} (not shown)`;
  });
}

function buildYotsubaThreadFooter(
  payload: YotsubaPreviewPayload,
  upgrade?: YotsubaPreviewPayload["upgrade"],
): string {
  const totalPosts = payload.postCount ?? 0;
  const threadNo = payload.threadNo!;
  const isPostLink = !!payload.linkedNo;
  const allPosts = payload.posts ?? [];
  const includedNos = upgrade?.includedNos ?? allPosts.map((p) => p.no);
  const includedCount = includedNos.length;

  let desc: string;
  if (upgrade) {
    if (isPostLink) {
      const headlineNo = payload.headlineNo ?? payload.linkedNo;
      const repliedTo = allPosts.filter((p) => includedNos.includes(p.no) && p.role === "replied_to").length;
      const replies = allPosts.filter((p) => includedNos.includes(p.no) && p.role === "reply").length;
      const answers = repliedTo === 1 ? "the post it answers" : `the ${repliedTo} posts it answers`;
      const firstReplies = replies === 1 ? "its first reply" : `its first ${replies} replies`;
      desc = `the linked post${repliedTo > 0 ? `, ${answers}` : ""}${replies > 0 ? ` and ${firstReplies}` : ""} (${includedCount} of ${totalPosts})`;
    } else {
      const latestCount = allPosts.filter((p) => includedNos.includes(p.no) && p.role === "latest").length;
      const repliedTo = allPosts.filter((p) => includedNos.includes(p.no) && p.role === "replied_to").length;
      const lastReplies = latestCount === 1 ? "the last reply" : `the last ${latestCount} replies`;
      const answered = repliedTo === 1
        ? (latestCount === 1 ? "the post it answers" : "the post they answer")
        : `the ${repliedTo} posts ${latestCount === 1 ? "it answers" : "they answer"}`;
      desc = `the opening post${latestCount > 0 ? `, ${lastReplies}` : ""}${repliedTo > 0 ? ` and ${answered}` : ""} (${includedCount} of ${totalPosts})`;
    }
    const left = upgrade.left;
    let leftNote = "";
    if (left) {
      const dropped: string[] = [];
      if (left.latest) dropped.push(`${left.latest} more latest ${left.latest === 1 ? "reply" : "replies"}`);
      if (left.repliedTo) dropped.push(`${left.repliedTo} replied-to post${left.repliedTo === 1 ? "" : "s"}`);
      if (left.replies) dropped.push(`${left.replies} more ${left.replies === 1 ? "reply" : "replies"}`);
      if (dropped.length) leftNote = `; ${dropped.join(" and ")} left out for length`;
    }
    const storedNote = allPosts.some((p) => {
      if (!p.file || !includedNos.includes(p.no)) return false;
      const assetId = p.file.assetId;
      const sbId = p.file.storyboardAssetId;
      return assetId && !upgrade.processedAssetIds.includes(assetId)
        && (!sbId || !upgrade.processedAssetIds.includes(sbId));
    }) ? ` Files marked auto="off" were saved but not captioned or shown (image budget); open them by path with read_image or media.` : "";
    desc = `4chan thread snapshot as of ${payload.asOf ? compactAgentTimestamp(new Date(payload.asOf)) : "?"}: ${desc}${leftNote}.${storedNote} Read more with the yotsuba tool.`;
  } else {
    // Ambient footer.
    if (isPostLink) {
      desc = `4chan: the linked post only. The yotsuba tool reads the thread and the conversation around this post.`;
    } else if (includedCount > 1) {
      desc = `4chan: opening post only. The yotsuba tool reads the thread.`;
    } else {
      desc = `4chan: opening post only. The yotsuba tool reads the thread.`;
    }
  }
  return `[${desc}]`;
}

/**
 * Compact-zone renderer for a 4chan link preview.
 *
 * Examples (spec §6.6 F):
 *   [4chan /g/ "/lmg/ - Local Models General" (435 posts): /lmg/ - a general…]
 *   [4chan /g/ "why does every linux distro..." (54 posts), post >>109934102: because…]
 *   [4chan /g/ board: 3 threads]
 *   [4chan /g/ thread 109800000: already gone when linked]
 */
function compactYotsubaPreview(lp: LinkPreviewMeta): string {
  const payload = lp.yotsubaPayload;
  const board = payload?.board ?? extractBoardFromUrl(lp.url);

  if (!payload) {
    // Gone / no payload.
    return ` [4chan ${board ?? "?"} thread: already gone when linked]`;
  }

  if (payload.kind === "board") {
    const count = payload.threads?.length ?? 0;
    return ` [4chan /${board}/ board: ${count} threads]`;
  }

  // Thread.
  const threadNo = payload.threadNo;
  if (!threadNo) return ` [4chan /${board ?? "?"}/: gone]`;

  const headlinePost = payload.posts?.find(
    (p) => p.no === (payload.headlineNo ?? threadNo)
  );
  const headlineText = headlinePost?.text ?? "";
  const excerptMax = 150;
  const excerpt = truncate(normalizeWhitespace(headlineText), excerptMax);

  const parts: string[] = [`4chan /${board}/`];
  const label = payload.subject
    ? `"${truncate(payload.subject, 80)}"`
    : (payload.opExcerpt ? `"${truncate(payload.opExcerpt, 80)}"` : `thread ${threadNo}`);
  parts.push(label);
  if (payload.postCount) parts.push(`(${payload.postCount} posts)`);
  if (payload.linkedNo && headlinePost) parts.push(`post >>${payload.headlineNo ?? payload.linkedNo}`);
  const joined = parts.join(" ");
  const body = excerpt ? `${joined}: ${excerpt}` : joined;
  return ` [${body}]`;
}

function extractBoardFromUrl(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/^\/([^/]+)\//);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
