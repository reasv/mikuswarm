/**
 * DiscordChannelClient — implements the cross-provider ChannelClient interface
 * for Discord (spec DISCORD-SUPPORT-DESIGN §7.1).
 *
 * Constructed by DiscordProvider.channelClient() and passed into tools instead
 * of the raw discord.js Client. Encapsulates the target channel id, its guild
 * id (when applicable), the bot's self-identity, and the emoji catalog.
 *
 * All operations use the discord.js REST client via `client.rest.*` so they
 * share the same rate-limit bucket management as the gateway connection.
 *
 * Spec decisions:
 *   - deleteMessage: delete-others surfaces permission errors as tool errors
 *     (error messages propagate; the tool wraps them for the model).
 *   - pins: 50-cap is noted in the returned PinnedMessage array metadata.
 *   - members(): present iff `memberIntent` was true at account construction.
 *   - createPoll: Discord poll object on send (per reshaped schema); end-poll
 *     is exposed as a separate method on the result external id.
 *   - votePoll: absent (Discord has no bot vote endpoint — pollVote: false).
 *   - emojiList: returns only the sendable set (guild + app emoji), no snowflakes.
 */

import {
  Routes,
  type Client,
  type GuildBasedChannel,
  type TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type {
  ChannelClient,
  ChannelInfo,
  CreatePollRequest,
  CreatePollResult,
  EmojiEntry,
  HistoryPageRequest,
  HistoryPageResult,
  HistorySummary,
  MemberInfo,
  PinnedMessage,
  ReactionEntry,
  ReactionListing,
  SenderInfo,
} from "../types.js";
import type { EmojiCatalog } from "./emoji-catalog.js";
import { DiscordHistoryClient } from "./history-client.js";

// ── Raw Discord REST types ─────────────────────────────────────────────────────

interface RawReactionUser {
  id: string;
  username: string;
  global_name?: string;
}

interface RawPinnedMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string };
  timestamp: string;
}

interface RawGuildMember {
  user?: { id: string; username: string; global_name?: string };
  nick?: string;
  avatar?: string;
}

// ── DiscordChannelClient ──────────────────────────────────────────────────────

export class DiscordChannelClient implements ChannelClient {
  private readonly historyClient: DiscordHistoryClient;

  /**
   * Present only when `member_intent = true` for this account (spec §7.2).
   * Absent (undefined) when member intent is off — the roster tool then reports
   * "roster unavailable on this channel" via the optional-method check in app.ts
   * (`client.members?.()` short-circuits to undefined).
   */
  readonly members?: () => Promise<SenderInfo[]>;

  constructor(
    private readonly client: Client,
    /** The channel id to operate on (thread id for threads). */
    private readonly channelId: string,
    /** The guild (server) id; undefined for DM channels. */
    private readonly guildId: string | undefined,
    /** The bot's own user id in this account. */
    private readonly selfUserId: string,
    /** Whether the GUILD_MEMBERS intent is enabled for this account. */
    memberIntentEnabled: boolean,
    /** Per-account emoji catalog. */
    private readonly emojiCatalog: EmojiCatalog,
    /** Account id (for building canonical event ids in history). */
    private readonly accountId: string,
  ) {
    this.historyClient = new DiscordHistoryClient(client, channelId, accountId);
    if (memberIntentEnabled) {
      this.members = () => this.listMembers();
    }
  }

  // ── Reactions ────────────────────────────────────────────────────────────────

  async react(externalId: string, emoji: string): Promise<{ display?: string } | void> {
    const { apiEmoji, display } = this.resolveEmojiOrThrow(emoji);
    await this.client.rest.put(
      Routes.channelMessageOwnReaction(this.channelId, externalId, encodeURIComponent(apiEmoji)),
    );
    return display ? { display } : undefined;
  }

  async unreact(externalId: string, emoji: string): Promise<{ removed?: number } | void> {
    const { apiEmoji } = this.resolveEmojiOrThrow(emoji);
    await this.client.rest.delete(
      Routes.channelMessageOwnReaction(this.channelId, externalId, encodeURIComponent(apiEmoji)),
    );
  }

  async listReactions(externalId: string, limit?: number): Promise<ReactionListing> {
    // First: get all distinct emoji that have reactions on this message.
    // Discord's GET /channels/{id}/messages/{msgId}/reactions/{emoji} returns users
    // per emoji. We need the message to know which emoji exist.
    // Approach: fetch the message to get its reactions array.
    const raw = await this.client.rest.get(
      Routes.channelMessage(this.channelId, externalId),
    ) as { reactions?: Array<{ emoji: { id?: string; name?: string }; count: number; me: boolean }> };

    const reactions = raw.reactions ?? [];
    const cap = Math.min(limit ?? 50, reactions.length);
    const entries: ReactionEntry[] = [];

    for (const rxn of reactions.slice(0, cap)) {
      const emojiId = rxn.emoji.id;
      const emojiName = rxn.emoji.name ?? "";
      const isCustom = Boolean(emojiId);

      const normalizedKey = isCustom ? `discord:${emojiId}` : emojiName;
      const display = isCustom ? `:${emojiName}:` : emojiName;
      const kind: ReactionEntry["kind"] = isCustom ? "custom" : "unicode";
      const apiEmojiStr = isCustom ? `${emojiName}:${emojiId}` : encodeURIComponent(emojiName);

      // Fetch users for this emoji (max 100 per Discord's API)
      let users: RawReactionUser[] = [];
      try {
        const q = new URLSearchParams({ limit: "100" });
        users = await this.client.rest.get(
          Routes.channelMessageReaction(this.channelId, externalId, encodeURIComponent(apiEmojiStr)),
          { query: q },
        ) as RawReactionUser[];
      } catch {
        // Fallback: can't list users — use count from the message reaction
      }

      entries.push({
        normalizedKey,
        display,
        kind,
        shortcode: isCustom ? emojiName : undefined,
        count: rxn.count,
        users: users.map((u) => u.id),
      });
    }
    return entries;
  }

  // ── Message operations ────────────────────────────────────────────────────────

  async editMessage(externalId: string, body: string): Promise<{ externalId?: string } | void> {
    await this.client.rest.patch(Routes.channelMessage(this.channelId, externalId), {
      body: { content: body },
    });
  }

  async deleteMessage(externalId: string, _reason?: string): Promise<void> {
    // Discord REST DELETE /channels/{id}/messages/{msgId}
    // Deleting others' messages requires MANAGE_MESSAGES permission.
    // Permission errors surface as HTTP 403 → discord.js throws → tool catches and shows.
    await this.client.rest.delete(Routes.channelMessage(this.channelId, externalId));
  }

  async readMessages(req: HistoryPageRequest): Promise<HistoryPageResult> {
    return this.historyClient.readMessages(req);
  }

  async readMessage(externalId: string): Promise<HistorySummary | undefined> {
    try {
      const raw = await this.client.rest.get(
        Routes.channelMessage(this.channelId, externalId),
      ) as { id: string; content: string; author: { id: string; username: string; global_name?: string }; timestamp: string; edited_timestamp: string | null };
      return {
        externalId: raw.id,
        sender: {
          id: raw.author.id,
          username: raw.author.username,
          displayName: raw.author.global_name ?? raw.author.username,
        },
        timestamp: new Date(raw.timestamp).getTime(),
        body: raw.content,
        edited: raw.edited_timestamp != null,
      };
    } catch {
      return undefined;
    }
  }

  // ── Members / user info ───────────────────────────────────────────────────────

  async memberInfo(userId: string): Promise<MemberInfo | undefined> {
    if (!this.guildId) {
      // DM channel: no guild membership. Return minimal info.
      return {
        userId,
        isSelf: userId === this.selfUserId,
        isDirect: true,
      };
    }
    try {
      const member = await this.client.rest.get(
        Routes.guildMember(this.guildId, userId),
      ) as RawGuildMember;
      return {
        userId,
        displayName: member.nick ?? member.user?.global_name ?? member.user?.username,
        isSelf: userId === this.selfUserId,
        isDirect: false,
      };
    } catch {
      return undefined;
    }
  }

  // Page through guild members (max 1000 per request).
  // Called only when member_intent=true; assigned to this.members in constructor.
  private async listMembers(): Promise<SenderInfo[]> {
    if (!this.guildId) return [];
    const members: SenderInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ limit: "1000" });
      if (after) q.set("after", after);
      const batch = await this.client.rest.get(Routes.guildMembers(this.guildId), {
        query: q,
      }) as RawGuildMember[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        if (!m.user) continue;
        members.push({
          id: m.user.id,
          username: m.user.username,
          displayName: m.nick ?? m.user.global_name ?? m.user.username,
        });
      }
      if (batch.length < 1000) break;
      const last = batch[batch.length - 1];
      after = last?.user?.id;
      if (!after) break;
    }
    return members;
  }

  // ── Channel info ──────────────────────────────────────────────────────────────

  async channelInfo(): Promise<ChannelInfo> {
    // Try to get from cache first.
    const cached = this.client.channels.cache.get(this.channelId) as GuildBasedChannel | undefined;
    if (cached) {
      return this.channelInfoFromCached(cached);
    }

    // Cache miss: REST fetch.
    try {
      const raw = await this.client.rest.get(Routes.channel(this.channelId)) as {
        type: number;
        name?: string;
        topic?: string;
        guild_id?: string;
        member_count?: number;
      };
      const isDirect = raw.type === ChannelType.DM || raw.type === ChannelType.GroupDM;
      const channelName = raw.name ?? this.channelId;

      // Try to get guild name
      let guildName: string | undefined;
      const guildId = raw.guild_id ?? this.guildId;
      if (guildId && !isDirect) {
        try {
          const guildRaw = await this.client.rest.get(Routes.guild(guildId)) as { name?: string };
          guildName = guildRaw.name;
        } catch {
          // Non-fatal
        }
      }

      const label = guildName
        ? `#${channelName} (${guildName})`
        : `#${channelName}`;

      return {
        label,
        displayName: channelName,
        channelId: this.channelId,
        serverName: guildName,
        isDirect,
        topic: raw.topic ?? undefined,
        memberCount: raw.member_count,
        joined: true,
      };
    } catch {
      // Absolute fallback: use channel id.
      return {
        label: `#${this.channelId}`,
        channelId: this.channelId,
        isDirect: !this.guildId,
      };
    }
  }

  private channelInfoFromCached(ch: GuildBasedChannel): ChannelInfo {
    // GuildBasedChannel is never a DM channel — isDirect is always false here.
    const isDirect = false;
    const channelName = "name" in ch ? (ch as TextChannel).name : this.channelId;
    const guildName = ch.guild?.name;
    const label = guildName ? `#${channelName} (${guildName})` : `#${channelName}`;
    const topic = "topic" in ch ? (ch as TextChannel).topic ?? undefined : undefined;
    const memberCount =
      "memberCount" in ch ? (ch as unknown as { memberCount?: number }).memberCount : undefined;
    return {
      label,
      displayName: channelName,
      channelId: this.channelId,
      serverName: guildName,
      isDirect: Boolean(isDirect),
      topic,
      memberCount,
      joined: true,
    };
  }

  // ── Pins ─────────────────────────────────────────────────────────────────────

  async pins(): Promise<PinnedMessage[]> {
    // Discord: GET /channels/{id}/pins returns up to 50 pinned messages.
    // The tool output notes the 50-cap per spec §14.
    const raw = await this.client.rest.get(Routes.channelPins(this.channelId)) as RawPinnedMessage[];
    return raw.map((msg) => ({
      externalId: msg.id,
      sender: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.global_name ?? msg.author.username,
      },
      body: msg.content,
      timestamp: new Date(msg.timestamp).getTime(),
    }));
  }

  async pinMessage(externalId: string): Promise<{ pinCount?: number } | void> {
    await this.client.rest.put(Routes.channelPin(this.channelId, externalId));
  }

  async unpinMessage(externalId: string): Promise<{ pinCount?: number } | void> {
    await this.client.rest.delete(Routes.channelPin(this.channelId, externalId));
  }

  // ── Emoji list ────────────────────────────────────────────────────────────────

  async emojiList(limit?: number): Promise<EmojiEntry[]> {
    const all = this.emojiCatalog.getSendableEmoji(this.guildId);
    return limit != null && limit > 0 ? all.slice(0, limit) : all;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────────

  /**
   * Create a Discord poll by sending a message with a poll object.
   *
   * Schema (spec §7.1 / §14): reshaped from the Matrix create_poll schema.
   * Discord poll fields:
   *   - question.text: string (max 300 chars)
   *   - answers: array of {poll_media: {text}} (max 10)
   *   - duration: hours (integer 1–168; we default to 24)
   *   - allow_multiselect: boolean (from maxSelections > 1)
   *
   * CreatePollRequest.options is the array from the tool. Discord ignores the
   * client-assigned `id` field — the platform assigns answer IDs.
   */
  async createPoll(req: CreatePollRequest): Promise<CreatePollResult> {
    const answers = req.options.slice(0, 10).map((opt) => ({
      poll_media: { text: opt.text },
    }));
    const payload = {
      content: "",
      poll: {
        question: { text: req.question },
        answers,
        duration: 24, // hours; could be made configurable later
        allow_multiselect: Boolean(req.maxSelections && req.maxSelections > 1),
        layout_type: 1, // DEFAULT
      },
    };
    const result = await this.client.rest.post(Routes.channelMessages(this.channelId), {
      body: payload,
    }) as { id: string };
    return { externalId: result.id };
  }

  // ── Emoji resolution helper ────────────────────────────────────────────────────

  /**
   * Resolve an emoji token for a Discord reaction API call.
   * Throws a clear error (with near-matches) when `:name:` is not sendable.
   */
  private resolveEmojiOrThrow(emoji: string): { apiEmoji: string; display: string } {
    const resolved = this.emojiCatalog.resolve(emoji, this.guildId);
    if (!resolved) {
      const near = this.emojiCatalog.nearMatches(
        emoji.replace(/^:|:$/g, ""),
        this.guildId,
      );
      const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
      throw new Error(`Emoji ${emoji} is not in the sendable set for this channel.${hint}`);
    }
    if (resolved.kind === "unicode") {
      return { apiEmoji: resolved.emoji, display: resolved.emoji };
    }
    // Custom: format as `name:id` for the Discord REST API
    return {
      apiEmoji: `${resolved.name}:${resolved.id}`,
      display: `:${resolved.name}:`,
    };
  }
}
