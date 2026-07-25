/**
 * Discord inbound normalizer — pure functions taking plain data objects.
 *
 * All functions in this module are intentionally free of live discord.js Client
 * references so they can be exercised by unit tests without a gateway connection.
 * The provider extracts the relevant fields from discord.js objects and passes
 * them here as plain data.
 *
 * Spec: DISCORD-SUPPORT-DESIGN §8.1 (normalization), §8.2 (triggers),
 *       §8.3 (edits/deletes), §4.1 (key shapes).
 */

import { nanoid } from "nanoid";
import type {
  AttachmentMeta,
  CanonicalChatEvent,
  InboundChatEvent,
  LinkPreviewMeta,
  SenderInfo,
  TriggerInfo,
} from "../types.js";
import { buildTimelineKey } from "../storage/timeline-key.js";

// ── Raw data shapes ─────────────────────────────────────────────────────────

/** A resolvable user mention extracted from the discord.js message. */
export interface DiscordMentionedUser {
  id: string;
  username: string;
  /** Guild display name — may be undefined if not in guild context. */
  displayName?: string;
}

/** A resolvable role mention. */
export interface DiscordMentionedRole {
  id: string;
  name: string;
}

/** A resolvable channel mention. */
export interface DiscordMentionedChannel {
  id: string;
  name: string;
}

/** An attachment from a Discord message (file, image, etc.). */
export interface DiscordAttachmentData {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  size: number;
  width?: number;
  height?: number;
  /** Duration in seconds — present on voice messages. */
  durationSecs?: number;
  /** True when the Discord message flag IS_VOICE_MESSAGE (8192) is set. */
  isVoiceMessage?: boolean;
}

/** A sticker item on a Discord message. */
export interface DiscordStickerData {
  id: string;
  name: string;
  /** CDN URL for the sticker image. */
  url: string;
  contentType?: string;
}

/** A Discord embed (may carry og-style preview data). */
export interface DiscordEmbedData {
  url?: string;
  title?: string;
  description?: string;
  siteName?: string;
  type?: string;
}

/** A Discord poll (inbound). */
export interface DiscordPollData {
  question: string;
  answers: Array<{ text: string }>;
}

/** A referenced message (reply context) included in the gateway payload. */
export interface DiscordReferencedMessage {
  id: string;
  content: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName?: string;
  timestamp: number;
  attachments: DiscordAttachmentData[];
  stickers: DiscordStickerData[];
}

/**
 * Minimal plain-data representation of a Discord message, extracted by the
 * provider from the live discord.js Message object. All fields are primitive
 * values or plain objects so the normalizer stays free of discord.js imports.
 */
export interface DiscordMessageData {
  /** Message snowflake id. */
  id: string;
  /** Markdown text content. */
  content: string;
  /** Channel where the message was sent. */
  channelId: string;
  /**
   * Discord channel type integer.
   * 0 = GuildText, 1 = DM, 11 = PublicThread, 12 = PrivateThread,
   * 15 = ForumChannel (posts appear as threads), etc.
   */
  channelType: number;
  /** Guild id — absent for DMs. */
  guildId?: string;
  /**
   * For thread messages: the id of the parent (non-thread) channel.
   * Resolved by the provider via channel cache / REST before calling the normalizer.
   */
  parentChannelId?: string;
  /** Author snowflake id. */
  authorId: string;
  /** Author username (@handle). */
  authorUsername: string;
  /** Guild nick or global display name; falls back to username if absent. */
  authorDisplayName?: string;
  /** Message timestamp (ms epoch). */
  timestamp: number;
  /** Non-null when this is an edit. */
  editedTimestamp?: number | null;
  /** Explicit user mentions resolved by discord.js. */
  mentionedUsers: DiscordMentionedUser[];
  /** Role mentions resolved by discord.js. */
  mentionedRoles: DiscordMentionedRole[];
  /** Channel mentions resolved by discord.js. */
  mentionedChannels: DiscordMentionedChannel[];
  /** True when @everyone or @here was used. */
  mentionEveryone: boolean;
  /** File attachments. */
  attachments: DiscordAttachmentData[];
  /** Sticker items. */
  stickers: DiscordStickerData[];
  /** Embeds (link previews). */
  embeds: DiscordEmbedData[];
  /** For reply messages: the full referenced message payload (if available). */
  referencedMessage?: DiscordReferencedMessage;
  /** For poll messages. */
  poll?: DiscordPollData;
}

/** Context passed alongside each message for normalisation decisions. */
export interface DiscordNormalizerContext {
  accountId: string;
  selfUserId: string;
}

// ── Key construction ─────────────────────────────────────────────────────────

/** Discord channel type integers that represent threads or forum posts. */
const THREAD_CHANNEL_TYPES = new Set([11, 12, 10, 15]); // Public/Private/News threads, Forum (posts are threads)

/**
 * Build the canonical timeline key for a Discord message.
 *
 * For threads (channelType in THREAD_CHANNEL_TYPES), the key is:
 *   `discord:<accountId>:room:<parentChannelId>:thread:<channelId>`
 *
 * For DMs (channelType 1):
 *   `discord:<accountId>:dm:<channelId>`
 *
 * For guild text channels:
 *   `discord:<accountId>:room:<channelId>`
 */
export function buildDiscordTimelineKey(
  accountId: string,
  channelId: string,
  channelType: number,
  parentChannelId?: string,
): string {
  const isDm = channelType === 1;
  const isThread = THREAD_CHANNEL_TYPES.has(channelType) && Boolean(parentChannelId);

  if (isDm) {
    return buildTimelineKey({ provider: "discord", accountId, kind: "dm", channelId });
  }
  if (isThread && parentChannelId) {
    return buildTimelineKey({
      provider: "discord",
      accountId,
      kind: "room",
      channelId: parentChannelId,
      threadId: channelId,
    });
  }
  return buildTimelineKey({ provider: "discord", accountId, kind: "room", channelId });
}

/** Build the canonical event id for a Discord message. */
export function buildDiscordEventId(accountId: string, messageId: string): string {
  return `discord:${accountId}:${messageId}`;
}

// ── Body markup translation ───────────────────────────────────────────────────

/**
 * Translate Discord inline markup tokens to the readable vocabulary the rest
 * of the system uses. Operates on raw `content` text.
 *
 * Substitutions (spec §8.1):
 *   `<@id>` / `<@!id>`   → @username (nick form for `<@!id>`)
 *   `<#id>`              → #channel-name
 *   `<@&id>`             → @role-name
 *   `<:name:id>` / `<a:name:id>` → :name: (custom emoji; also records to emoji catalog)
 *
 * Unresolvable references (id not in the maps) pass through as-is so no
 * information is destroyed; the raw `<@id>` form is still meaningful.
 */
export function translateDiscordMarkup(
  content: string,
  context: {
    users: DiscordMentionedUser[];
    roles: DiscordMentionedRole[];
    channels: DiscordMentionedChannel[];
  },
): string {
  const userMap = new Map(context.users.map((u) => [u.id, u]));
  const roleMap = new Map(context.roles.map((r) => [r.id, r]));
  const channelMap = new Map(context.channels.map((c) => [c.id, c]));

  return content
    // Custom animated emoji <a:name:id> → :name:
    .replace(/<a:([^:>]+):\d+>/g, (_match, name) => `:${name}:`)
    // Custom static emoji <:name:id> → :name:
    .replace(/<:([^:>]+):\d+>/g, (_match, name) => `:${name}:`)
    // User mention nick form <@!id> → @displayName (nick preferred for this form)
    .replace(/<@!(\d+)>/g, (_match, id) => {
      const user = userMap.get(id);
      return user ? `@${user.displayName ?? user.username}` : `<@!${id}>`;
    })
    // User mention plain form <@id> → @username
    .replace(/<@(\d+)>/g, (_match, id) => {
      const user = userMap.get(id);
      return user ? `@${user.username}` : `<@${id}>`;
    })
    // Channel mention <#id> → #name
    .replace(/<#(\d+)>/g, (_match, id) => {
      const ch = channelMap.get(id);
      return ch ? `#${ch.name}` : `<#${id}>`;
    })
    // Role mention <@&id> → @role-name
    .replace(/<@&(\d+)>/g, (_match, id) => {
      const role = roleMap.get(id);
      return role ? `@${role.name}` : `<@&${id}>`;
    });
}

// ── Attachment normalisation ──────────────────────────────────────────────────

function attachmentToMeta(att: DiscordAttachmentData, eventId: string, index: number): AttachmentMeta {
  // Voice messages are audio attachments with duration and the IS_VOICE_MESSAGE flag.
  const isVoice = att.isVoiceMessage === true;
  const durationMs =
    isVoice && att.durationSecs != null ? Math.round(att.durationSecs * 1000) : undefined;
  const mediaType: AttachmentMeta["mediaType"] = inferMediaType(att.contentType, isVoice);

  return {
    id: `${eventId}:attach:${index}`,
    filename: att.filename,
    mimeType: att.contentType,
    mediaType,
    sizeBytes: att.size,
    width: att.width,
    height: att.height,
    remoteUrl: att.url,
    asVoice: isVoice || undefined,
    durationMs,
    processing: { downloaded: false, captioned: false },
  };
}

function stickerToAttachment(sticker: DiscordStickerData, eventId: string, index: number): AttachmentMeta {
  const mimeType = sticker.contentType ?? "image/png";
  // Lottie stickers are JSON animation descriptors — mediaType "file" so the
  // captioning worker (captionableTypes = [image, video, audio]) skips them.
  const mediaType: AttachmentMeta["mediaType"] = mimeType === "application/json" ? "file" : "image";
  const ext = mimeType === "image/gif" ? ".gif" : mimeType === "application/json" ? ".json" : ".png";
  return {
    id: `${eventId}:sticker:${index}`,
    filename: `${sticker.name}${ext}`,
    mimeType,
    mediaType,
    remoteUrl: sticker.url,
    processing: { downloaded: false, captioned: false },
  };
}

function inferMediaType(
  contentType: string | undefined,
  isVoice: boolean,
): AttachmentMeta["mediaType"] {
  if (isVoice) return "audio";
  if (!contentType) return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

// ── Embed → link preview ──────────────────────────────────────────────────────

/**
 * Convert Discord embeds to canonical link preview metas.
 * Only embeds with a URL are converted (spec §8.1).
 * `source_kind: "discord_embed"` is set so the enrichment worker can skip
 * re-scraping URLs already covered at ingest (spec §9.3 / §5.3).
 *
 * URL normalization note: the TODO(phase7) in src/storage/database.ts notes
 * that Discord embed URLs must be stored normalized the same way
 * DirectLinkPreviewClient's stripTrailingPunctuation does. We apply the same
 * trailing-punctuation strip here so exclusion matching works.
 */
export function embedsToLinkPreviews(embeds: DiscordEmbedData[]): LinkPreviewMeta[] {
  const previews: LinkPreviewMeta[] = [];
  for (const embed of embeds) {
    const rawUrl = embed.url;
    if (!rawUrl) continue;
    // Normalize: strip trailing punctuation matching what DirectLinkPreviewClient does.
    const url = rawUrl.replace(/[.,;:!?)"'\]}>]+$/, "");
    if (!url) continue;
    previews.push({
      url,
      title: embed.title ?? undefined,
      description: embed.description ?? undefined,
      sourceKind: "discord_embed",
      fetchedAt: Date.now(),
    });
  }
  return previews;
}

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect whether a Discord message should trigger the bot (spec §8.2).
 *
 * Triggers:
 *  - DM channel (channelType 1)
 *  - Direct user mention of the bot (not role, not @everyone)
 *  - Reply-to-bot is handled by the provider via host.resolveReplyTrigger
 *    (called separately after storing the event)
 *
 * Non-triggers:
 *  - Role mentions
 *  - @everyone / @here
 *  - Own messages (isSelf)
 */
export function detectDiscordTrigger(
  msg: DiscordMessageData,
  ctx: DiscordNormalizerContext,
  isSelf: boolean,
): TriggerInfo | undefined {
  if (isSelf) return undefined;
  const sender: SenderInfo = {
    id: msg.authorId,
    username: msg.authorUsername,
    displayName: msg.authorDisplayName,
  };
  // DM channel → dm trigger
  if (msg.channelType === 1) {
    return { type: "dm", reason: "direct message", triggeredBy: sender };
  }
  // Direct user mention of the bot (not @everyone/role)
  const mentionedSelf = msg.mentionedUsers.some((u) => u.id === ctx.selfUserId);
  if (mentionedSelf) {
    return { type: "mention", reason: "mentioned bot", triggeredBy: sender };
  }
  return undefined;
}

// ── Full event normalization ──────────────────────────────────────────────────

/** Result of normalizing a Discord gateway message. */
export interface DiscordNormalizeResult {
  inbound: InboundChatEvent;
  /** Custom emoji pairs observed in this message (name → id). */
  emojiObservations: Array<{ name: string; id: string; animated: boolean }>;
  /**
   * Embed previews for ingest-time storage (spec §8.1 / §9.3).
   * Written to link_previews with source_kind = 'discord_embed' at ingest time.
   */
  embedPreviews: LinkPreviewMeta[];
}

/**
 * Normalize a Discord MESSAGE_CREATE payload to a canonical InboundChatEvent.
 * Pure function — no live client; called by the provider after extracting data.
 */
export function normalizeDiscordMessage(
  msg: DiscordMessageData,
  ctx: DiscordNormalizerContext,
): DiscordNormalizeResult {
  const isSelf = msg.authorId === ctx.selfUserId;
  const timelineKey = buildDiscordTimelineKey(
    ctx.accountId,
    msg.channelId,
    msg.channelType,
    msg.parentChannelId,
  );
  const eventId = buildDiscordEventId(ctx.accountId, msg.id);

  // Translate body markup
  const body =
    translateDiscordMarkup(msg.content, {
      users: msg.mentionedUsers,
      roles: msg.mentionedRoles,
      channels: msg.mentionedChannels,
    }) || buildPollFallbackBody(msg.poll);

  // Attachments: regular files + stickers (→ image attachments)
  const attachments: AttachmentMeta[] = [
    ...msg.attachments.map((a, i) => attachmentToMeta(a, eventId, i)),
    ...msg.stickers.map((s, i) => stickerToAttachment(s, eventId, msg.attachments.length + i)),
  ];

  // Embeds → link previews (ingest-time; written to DB by the provider)
  const embedPreviews = embedsToLinkPreviews(msg.embeds);

  // Mentioned self?
  const mentionedSelf = msg.mentionedUsers.some((u) => u.id === ctx.selfUserId);

  // Channel type annotation for routing (spec §4.3)
  const channelType: InboundChatEvent["channelType"] =
    msg.channelType === 1
      ? "dm"
      : THREAD_CHANNEL_TYPES.has(msg.channelType)
        ? "thread"
        : "group";

  // Reply context — fully populated from referenced_message at ingest (spec §8.1)
  const replyTo = msg.referencedMessage
    ? buildReplyContext(msg.referencedMessage)
    : undefined;

  // Trigger detection (DM + direct mention; reply-to-bot resolved by provider)
  const trigger = detectDiscordTrigger(msg, ctx, isSelf);

  // Record custom emoji observed in the message content for the catalog
  const emojiObservations = extractEmojiObservations(msg.content);

  const canonical: CanonicalChatEvent = {
    id: eventId,
    externalId: msg.id,
    timelineKey,
    provider: "discord",
    role: isSelf ? "assistant" : "user",
    sender: {
      id: msg.authorId,
      username: msg.authorUsername,
      displayName: msg.authorDisplayName,
      isSelf,
    },
    body,
    timestamp: msg.timestamp,
    receivedAt: Date.now(),
    attachments: attachments.length > 0 ? attachments : undefined,
    replyTo,
    mentions: {
      mentionedUserIds: msg.mentionedUsers.map((u) => u.id),
      mentionedSelf,
    },
    threadId: THREAD_CHANNEL_TYPES.has(msg.channelType) ? msg.channelId : undefined,
    trigger,
    linkPreviews: embedPreviews.length > 0 ? embedPreviews : undefined,
  };

  const inbound: InboundChatEvent = {
    provider: "discord",
    timelineKey,
    channelType,
    event: canonical,
    trigger,
    outboundTarget: {
      provider: "discord",
      timelineKey,
      accountId: ctx.accountId,
      roomId: msg.channelId,
      threadId: THREAD_CHANNEL_TYPES.has(msg.channelType) ? msg.channelId : undefined,
      replyToId: msg.id,
    },
  };

  return { inbound, emojiObservations, embedPreviews };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPollFallbackBody(poll: DiscordPollData | undefined): string {
  if (!poll) return "";
  const answers = poll.answers.map((a) => a.text).join(", ");
  return `[poll] ${poll.question} — ${answers}`;
}

function buildReplyContext(ref: DiscordReferencedMessage): NonNullable<CanonicalChatEvent["replyTo"]> {
  const attachments = [
    ...ref.attachments.map((a, i) =>
      attachmentToMeta(a, `discord:reply:${ref.id}`, i),
    ),
    ...ref.stickers.map((s, i) =>
      stickerToAttachment(s, `discord:reply:${ref.id}`, ref.attachments.length + i),
    ),
  ];
  return {
    externalId: ref.id,
    sender: {
      id: ref.authorId,
      username: ref.authorUsername,
      displayName: ref.authorDisplayName,
    },
    body: ref.content,
    timestamp: ref.timestamp,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Extract custom emoji observations from a message's raw content string.
 * Captures `<:name:id>` and `<a:name:id>` forms and deduplicates by id.
 */
export function extractEmojiObservations(
  content: string,
): Array<{ name: string; id: string; animated: boolean }> {
  const seen = new Map<string, { name: string; id: string; animated: boolean }>();
  // Static custom emoji
  for (const match of content.matchAll(/<:([^:>]+):(\d+)>/g)) {
    const [, name, id] = match;
    if (!seen.has(id)) seen.set(id, { name, id, animated: false });
  }
  // Animated custom emoji
  for (const match of content.matchAll(/<a:([^:>]+):(\d+)>/g)) {
    const [, name, id] = match;
    if (!seen.has(id)) seen.set(id, { name, id, animated: true });
  }
  return [...seen.values()];
}

/**
 * Build a canonical id for a Discord message suitable for use as an
 * internally-generated placeholder (e.g. when nanoid is needed).
 */
export function buildDiscordPlaceholderId(accountId: string): string {
  return `discord:${accountId}:${nanoid()}`;
}
