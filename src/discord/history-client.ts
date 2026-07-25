/**
 * Discord history paging client — before-snowflake backward pagination via the
 * Discord REST API (spec DISCORD-SUPPORT-DESIGN §11.3).
 *
 * Implements both {@link HistoryClient} (the provider-facing interface used by
 * `IChatProvider.history()`) and {@link BackfillReadClient} (the engine-facing
 * interface consumed by `paginateBackward` in the backfill / read_messages path).
 *
 * Cursor scheme: a snowflake string (Discord message ID) used as the `before`
 * parameter in GET /channels/{id}/messages. The "before" cursor is exclusive —
 * messages older than the cursor snowflake are returned, newest-first.
 *
 * Thread channels: the `channelId` passed at construction is the actual channel
 * id (thread id for thread messages, parent id for room messages). The provider
 * passes the correct id based on the resolved timeline key.
 */

import type { Client } from "discord.js";
import { Routes } from "discord.js";
import type { AttachmentMeta, HistoryClient, HistoryPageRequest, HistoryPageResult, HistorySummary } from "../types.js";
import type { BackfillReadClient } from "../backfill/paginate.js";

// ── Raw Discord REST response types ──────────────────────────────────────────

interface RawDiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string };
  timestamp: string;
  edited_timestamp: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    size: number;
    width?: number;
    height?: number;
    duration_secs?: number;
    flags?: number;
  }>;
  message_reference?: { message_id?: string };
  flags?: number;
}

// Attachment flag: IS_VOICE_MESSAGE (bit 13 = 8192 on the message, but attachment
// flag for voice is bit 6 = 64 per Discord docs).
const ATTACHMENT_FLAG_VOICE = 64;
const MESSAGE_FLAG_VOICE = 8192;

// ── DiscordHistoryClient ──────────────────────────────────────────────────────

/**
 * Paging client wrapping Discord's GET /channels/{id}/messages endpoint.
 *
 * `accountId` is embedded in the canonical event ids it returns so they
 * match the keys produced by the live ingest path (`discord:<acct>:<msgId>`).
 */
export class DiscordHistoryClient implements HistoryClient, BackfillReadClient {
  constructor(
    private readonly client: Client,
    private readonly channelId: string,
    private readonly accountId: string,
  ) {}

  async readMessages(req: HistoryPageRequest): Promise<HistoryPageResult> {
    const limit = Math.min(Math.max(req.limit ?? 100, 1), 100);
    // Resolve the effective "before" snowflake: explicit `before` wins, else `cursor`.
    const before = req.before ?? req.cursor;

    // Use discord.js REST client to stay within the same rate-limit bucket.
    // query must be URLSearchParams (required by @discordjs/rest v2).
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set("before", before);

    const rawMessages = await this.client.rest.get(Routes.channelMessages(this.channelId), {
      query,
    }) as RawDiscordMessage[];

    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return { messages: [], nextCursor: undefined };
    }

    const messages: HistorySummary[] = rawMessages.map((msg) => this.toSummary(msg));

    // Messages come newest-first; the oldest one's id is the next `before` cursor.
    const oldest = rawMessages[rawMessages.length - 1];
    const nextCursor = rawMessages.length === limit && oldest ? oldest.id : undefined;

    return { messages, nextCursor };
  }

  private toSummary(msg: RawDiscordMessage): HistorySummary {
    const attachments: AttachmentMeta[] = msg.attachments.map((att, i) => {
      const isVoice =
        Boolean(att.flags && (att.flags & ATTACHMENT_FLAG_VOICE) !== 0) ||
        Boolean(msg.flags && (msg.flags & MESSAGE_FLAG_VOICE) !== 0);
      const mediaType = inferMediaType(att.content_type, isVoice);
      return {
        id: `discord:${this.accountId}:${msg.id}:attach:${i}`,
        filename: att.filename,
        mimeType: att.content_type,
        mediaType,
        sizeBytes: att.size,
        width: att.width,
        height: att.height,
        remoteUrl: att.url,
        asVoice: isVoice || undefined,
        durationMs: att.duration_secs != null ? Math.round(att.duration_secs * 1000) : undefined,
        processing: { downloaded: false, captioned: false },
      };
    });

    return {
      externalId: msg.id,
      sender: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.global_name ?? msg.author.username,
      },
      timestamp: new Date(msg.timestamp).getTime(),
      body: msg.content,
      attachments: attachments.length > 0 ? attachments : undefined,
      replyToExternalId: msg.message_reference?.message_id,
      edited: msg.edited_timestamp != null,
    };
  }
}

function inferMediaType(contentType: string | undefined, isVoice: boolean): AttachmentMeta["mediaType"] {
  if (isVoice) return "audio";
  if (!contentType) return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}
