/**
 * Discord provider — full Phase 7 implementation (gateway, inbound, send, tools).
 *
 * Implements {@link IChatProvider} for Discord using discord.js v14.
 * One discord.js Client per configured account; reconnect/resume is
 * discord.js's responsibility.
 *
 * Implemented capabilities (v1 scope, spec §14):
 *   - Gateway inbound: messageCreate / messageUpdate / messageDelete with
 *     trigger-hold, reply-trigger detection, and late-embed discrimination.
 *   - Reaction events: messageReactionAdd / Remove / RemoveAll / RemoveEmoji.
 *   - ChannelClient: full tool surface (reactions, history, members when
 *     member_intent=true, pins, emoji, polls, channelInfo, memberInfo).
 *   - HistoryClient: before-snowflake backward paging (read_messages + backfill).
 *   - Voice messages: ogg/opus transcode + waveform computation via ffmpeg.
 *   - setProfile: avatar (data URI PATCH) + per-guild nick.
 *   - Emoji catalog: guild + app emoji at READY, updated on guild events.
 *   - User identity upserts (handleMessageCreate + guildMemberUpdate).
 *   - Channel metadata upserts (room_metadata: display_name, server_id, server_name).
 *
 * Spec: DISCORD-SUPPORT-DESIGN §12 (provider), §8 (inbound pipeline),
 *       §4.1 (key shapes), §5 (config), §14 (v1 scope).
 */

import {
  Client,
  GatewayIntentBits,
  Options,
  ChannelType,
  StickerFormatType,
  Routes,
  type Message,
  type PartialMessage,
  type TextChannel,
  type DMChannel,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type GuildEmoji,
  type GuildMember,
  type PartialGuildMember,
  MessageFlags,
} from "discord.js";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config/index.js";
import type {
  CanonicalChatEvent,
  ChannelClient,
  ChatProviderHost,
  DeliveryReceipt,
  HistoryClient,
  IChatProvider,
  LinkPreviewMeta,
  OutboundMessage,
  OutboundTarget,
  ProviderCapabilities,
  ReactionStreamEvent,
  SelfIdentity,
} from "../types.js";
import type { EnrichmentCapabilities } from "../enrichment/types.js";
import type { UserIdentityUpsertInput } from "../storage/database.js";
import {
  buildDiscordTimelineKey,
  buildDiscordEventId,
  detectDiscordTrigger,
  normalizeDiscordMessage,
  embedsToLinkPreviews,
  extractEmojiObservations,
  type DiscordMessageData,
  type DiscordMentionedUser,
  type DiscordMentionedRole,
  type DiscordMentionedChannel,
  type DiscordAttachmentData,
  type DiscordStickerData,
  type DiscordEmbedData,
  type DiscordReferencedMessage,
} from "./normalizer.js";
import { EmojiCatalog } from "./emoji-catalog.js";
import { DiscordHistoryClient } from "./history-client.js";
import { DiscordChannelClient } from "./channel-client.js";
import { encodeVoiceMessage, cleanupVoiceFile } from "./voice-message.js";
import { chunkMarkdownText } from "../tools/chunk.js";
import { parseTimelineKey } from "../storage/timeline-key.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum Discord message content length (spec §12.4 / §3.3). */
const DISCORD_MAX_CHARS = 2000;

/** Maximum attachments in one Discord message send (spec §3.3). */
const DISCORD_MAX_ATTACHMENTS = 10;

/** How often to refresh the typing indicator (Discord clears it after ~10s). */
const TYPING_REFRESH_MS = 8_000;

/** Maximum hold-extension multiplier for trigger_hold_ms. */
const TRIGGER_HOLD_MAX_MULTIPLIER = 4;

/** Discord channel types that represent threads. */
const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

// ── Per-account runtime state ─────────────────────────────────────────────────

interface AccountRuntime {
  accountId: string;
  token: string;
  client: Client;
  self?: SelfIdentity;
  /** Guild snowflake allowlist — undefined means all guilds. */
  allowedGuilds?: Set<string>;
  dmEnabled: boolean;
  memberIntentEnabled: boolean;
  /** Optional application id (for app-emoji catalog fetch). */
  applicationId?: string;
  /** Per-account emoji catalog (guild + app + observed emoji). */
  emojiCatalog: EmojiCatalog;
}

interface PendingTrigger {
  event: import("../types.js").InboundChatEvent;
  embedPreviews: LinkPreviewMeta[];
  timer: NodeJS.Timeout;
}

// ── DiscordProvider ───────────────────────────────────────────────────────────

/**
 * Callbacks injected at construction time for operations that need access to
 * storage (which is initialized after the provider is constructed).
 */
export interface DiscordProviderCallbacks {
  /**
   * Called when a MESSAGE_UPDATE has null editedTimestamp (late-embed resolution).
   * The provider has already identified this as NOT a user edit. The host merges
   * the embeds into the stored event's link_previews rows.
   * Returns silently when the event is not yet stored (race — provider must not
   * throw in that case).
   */
  mergeLateEmbeds(
    provider: string,
    externalId: string,
    timelineKey: string,
    previews: LinkPreviewMeta[],
  ): Promise<void>;

  /**
   * Called at ingest time after the provider stores discord_embed link previews
   * for a new message. Allows the storage layer to write them before enrichment.
   * Each preview corresponds to one embed with a URL.
   * Silently ignored if there are no previews.
   */
  storeIngestEmbeds(
    eventId: string,
    previews: LinkPreviewMeta[],
  ): Promise<void>;

  /**
   * Upsert a user identity row at ingest time (spec §6.5).
   * Called for every Discord message sender whose username is known. The storage
   * layer handles the "only update when changed" logic.
   */
  upsertUserIdentity(input: UserIdentityUpsertInput): Promise<void>;

  /**
   * Upsert channel metadata (display label + guild/server scope) into
   * room_metadata at ingest time (spec §6.6). Called on every message create.
   */
  setChannelMetadata(
    timelineKey: string,
    meta: { displayName: string; serverId?: string; serverName?: string },
  ): Promise<void>;

  /**
   * Called when a Discord account's READY event fires and `self` is resolved.
   * Allows app.ts to add the Discord self-id to the selfUserIds budget set and
   * the gapBackfetchSelfIds map — both of which are built before provider.start()
   * and cannot include Discord ids until after READY (spec §6.3 / TODO(phase7)).
   */
  onSelfResolved?(accountId: string, selfId: string): void;
}

export class DiscordProvider implements IChatProvider {
  readonly id = "discord";

  /**
   * Capabilities for the Discord provider (spec §3.3 Discord column).
   *
   * Notes:
   *   - `voiceMessages: true` — Phase 7b ships ogg/opus send + waveform computation.
   *     The send() method handles `attachment.asVoice === true` by transcoding via
   *     ffmpeg and sending the resulting ogg/opus with IS_VOICE_MESSAGE flag.
   *   - `history: true` — HistoryClient (before-snowflake paging) is implemented in 7b.
   *   - `pollCreate: true` reflects v1 scope (spec §14) — createPoll on ChannelClient
   *     sends a Discord poll message.
   *   - `membershipRoster` is per-account and set at construction from config.
   *     It is advertised as `false` here (the static default); the constructor
   *     below overrides it when any account has member_intent=true.
   */
  readonly capabilities: ProviderCapabilities = {
    typing: true,
    reactions: true,
    reactionKinds: ["unicode", "custom"],
    customEmojiScoped: true,
    mediaUpload: false,
    maxAttachmentsPerMessage: DISCORD_MAX_ATTACHMENTS,
    maxMessageChars: DISCORD_MAX_CHARS,
    formatting: "markdown",
    edits: true,
    deletes: true,
    pollCreate: true,
    pollVote: false,
    pins: true,
    voiceMessages: true,
    threads: true,
    history: true,
    encrypted: false,
    linkPreviews: "none",
    singleAttachmentPerMessage: false,
    // membershipRoster: depends on per-account member_intent — default false.
    // The wiring in app.ts uses the provider-level capability for gate decisions.
    // For Discord, member_intent is per-account; we use the most-permissive value
    // across accounts (any account with member_intent=true enables the capability).
    membershipRoster: false,
  };

  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly pendingTriggers = new Map<string, PendingTrigger>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private host?: ChatProviderHost;
  private stopped = false;

  constructor(
    private readonly config: NonNullable<AppConfig["discord"]>,
    private readonly callbacks: DiscordProviderCallbacks,
  ) {
    // Compute membershipRoster from config: true iff any account has member_intent=true
    const anyMemberIntent = Object.values(config.accounts ?? {}).some(
      (a) => a.member_intent === true,
    );
    (this.capabilities as { membershipRoster: boolean }).membershipRoster = anyMemberIntent;
  }

  // ── IChatProvider: lifecycle ───────────────────────────────────────────────

  async start(host: ChatProviderHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    if (!this.config.enabled || !this.config.accounts) return;

    for (const [accountId, accountConfig] of Object.entries(this.config.accounts)) {
      const intents = buildIntents(accountConfig.member_intent === true);
      const client = new Client({
        intents,
        // Tune cache limits down: the timeline store is the source of truth for
        // history; we only need what thread-parent resolution, member lookup,
        // and emoji resolution require (spec §12.1).
        makeCache: Options.cacheWithLimits({
          MessageManager: { maxSize: 50 },
          GuildMessageManager: { maxSize: 50 },
          DMMessageManager: { maxSize: 50 },
          GuildMemberManager: { maxSize: accountConfig.member_intent ? 200 : 0 },
          GuildEmojiManager: { maxSize: 500 },
          ThreadManager: { maxSize: 200 },
        }),
      });

      const runtime: AccountRuntime = {
        accountId,
        token: accountConfig.token,
        client,
        allowedGuilds: accountConfig.guilds?.length
          ? new Set(accountConfig.guilds)
          : undefined,
        dmEnabled: accountConfig.dm_enabled !== false,
        memberIntentEnabled: accountConfig.member_intent === true,
        applicationId: accountConfig.application_id,
        emojiCatalog: new EmojiCatalog(),
      };

      this.accounts.set(accountId, runtime);
      this.attachListeners(runtime);

      // discord.js login is async; errors surface through the host
      client.login(accountConfig.token).catch((error) => {
        host.onError(error, { accountId, phase: "login" });
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Cancel pending trigger hold timers
    for (const pending of this.pendingTriggers.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingTriggers.clear();
    // Cancel typing refresh timers
    for (const timer of this.typingTimers.values()) {
      clearTimeout(timer);
    }
    this.typingTimers.clear();
    // Destroy discord.js clients
    for (const runtime of this.accounts.values()) {
      runtime.client.destroy();
    }
    this.accounts.clear();
  }

  // ── IChatProvider: identity ────────────────────────────────────────────────

  /**
   * Returns the ids of all configured accounts, whether or not start() has been
   * called. This allows enrichment registration and other pre-start queries to work.
   */
  accountIds(): string[] {
    return Object.keys(this.config.accounts ?? {});
  }

  getSelf(accountId: string): SelfIdentity | undefined {
    return this.accounts.get(accountId)?.self;
  }

  /**
   * Discord user IDs are numeric snowflakes.
   * A pure shape test: any string of all digits is assumed to be a Discord
   * snowflake. Used as a budget-enforceability predicate (spec §6.4).
   */
  ownsUserId(id: string): boolean {
    return /^\d+$/.test(id);
  }

  // ── IChatProvider: channel / enrichment / history ─────────────────────────

  /**
   * Returns a DiscordChannelClient for the resolved target channel.
   * Returns undefined for foreign targets (unknown accountId, not in allowedGuilds).
   *
   * The channel client resolves the guild id from the timeline key metadata
   * (stored at ingest), falling back to a channel-cache lookup. For DM channels
   * `guildId` is undefined, which the client handles gracefully.
   */
  channelClient(target: OutboundTarget): ChannelClient | undefined {
    const accountId =
      target.accountId ?? parseTimelineKey(target.timelineKey)?.accountId;
    if (!accountId) return undefined;

    const runtime = this.accounts.get(accountId);
    if (!runtime) return undefined;

    // Resolve channel id from target: prefer explicit roomId, fall back to key.
    const parsed = parseTimelineKey(target.timelineKey);
    const channelId = target.roomId
      ?? (parsed?.threadId ?? parsed?.channelId);
    if (!channelId) return undefined;

    // Resolve guild id from the discord.js cache (set on READY and message create).
    // For thread channels, the parent channel's guild is what we need.
    const guildId = this.resolveGuildId(runtime, channelId, parsed?.threadId);

    const selfId = runtime.self?.id ?? "";
    return new DiscordChannelClient(
      runtime.client,
      channelId,
      guildId,
      selfId,
      runtime.memberIntentEnabled,
      runtime.emojiCatalog,
      accountId,
    );
  }

  /** Attempt to derive the guild id for a channel from the discord.js cache. */
  private resolveGuildId(
    runtime: AccountRuntime,
    channelId: string,
    threadId?: string,
  ): string | undefined {
    // If it's a thread, look up the thread channel (which should have guildId).
    const ch = runtime.client.channels.cache.get(threadId ?? channelId);
    if (ch && "guildId" in ch) return (ch as { guildId?: string }).guildId ?? undefined;
    // Not in cache — try to derive from guild cache (for text channels).
    for (const guild of runtime.client.guilds.cache.values()) {
      if (
        (runtime.allowedGuilds && !runtime.allowedGuilds.has(guild.id)) ||
        !guild.channels.cache.has(channelId)
      ) {
        continue;
      }
      return guild.id;
    }
    return undefined;
  }

  /**
   * Returns a minimal EnrichmentCapabilities object for Discord.
   *
   * Discord attachments carry a remoteUrl (CDN URL), so the enrichment worker
   * downloads them via FetchClient.downloadUrl directly — it never calls
   * downloadMedia. For reply-context enrichment, messageSummary is a stub
   * returning null: the Discord normalizer already populates replyTo fully
   * at ingest from referenced_message, so no REST lookup is needed.
   * resolveLinkPreviews is absent (linkPreviews: "none" → DirectLinkPreviewClient
   * fallback in the enrichment worker).
   */
  enrichment(accountId: string): EnrichmentCapabilities | undefined {
    if (!this.accounts.has(accountId)) return undefined;
    // Capture the accounts map by reference so memberInfo always uses the live runtime.
    const accounts = this.accounts;
    return {
      async downloadMedia(_params) {
        // Discord attachments always use the remoteUrl path in the enrichment
        // worker; this method is never called for Discord events.
        throw new Error(
          "DiscordProvider.enrichment.downloadMedia: Discord attachments use remoteUrl, not this path",
        );
      },
      async messageSummary(_params) {
        // Reply context is fully populated at ingest from referenced_message;
        // the enrichment worker's resolveReplyContext call is a no-op for Discord.
        return null;
      },
      async memberInfo(params) {
        // Look up displayName from the guild member cache for the given userId.
        const rt = accounts.get(accountId);
        if (!rt) return { displayName: undefined };
        for (const guild of rt.client.guilds.cache.values()) {
          const member = guild.members.cache.get(params.userId ?? "");
          if (member) {
            return {
              displayName:
                member.nickname ??
                member.user.globalName ??
                member.user.username,
            };
          }
        }
        return { displayName: undefined };
      },
    };
  }

  /**
   * Returns a DiscordHistoryClient for before-snowflake backward paging.
   * Used by read_messages and the initial-activation backfill.
   */
  history?(target: OutboundTarget): HistoryClient | undefined {
    const accountId =
      target.accountId ?? parseTimelineKey(target.timelineKey)?.accountId;
    if (!accountId) return undefined;
    const runtime = this.accounts.get(accountId);
    if (!runtime) return undefined;

    const parsed = parseTimelineKey(target.timelineKey);
    const channelId = target.roomId ?? (parsed?.threadId ?? parsed?.channelId);
    if (!channelId) return undefined;

    return new DiscordHistoryClient(runtime.client, channelId, accountId);
  }

  // ── IChatProvider: send / typing ──────────────────────────────────────────

  async send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const { accountId, client } = this.resolveAccount(target);
    const channelId = target.roomId ?? parseTimelineKey(target.timelineKey)?.channelId;
    if (!channelId) throw new Error("Discord send: cannot resolve channel id from target");

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord send: channel ${channelId} is not a text channel`);
    }

    // ── Voice message path (spec §12.4, §14) ────────────────────────────────
    // When the first attachment has asVoice=true, send as a Discord voice message.
    // Voice messages require: ogg/opus audio, IS_VOICE_MESSAGE flag, empty content,
    // duration_secs and waveform fields on the attachment.
    const voiceAttachment = message.attachments?.find((a) => a.asVoice && a.localPath);
    if (voiceAttachment?.localPath) {
      const encoded = await encodeVoiceMessage(voiceAttachment.localPath);
      let voiceMessageId: string | undefined;
      try {
        // Use REST API directly for precise control over the multipart payload.
        // discord.js attachment builder does not expose durationSecs/waveform directly;
        // we post via the raw REST client with the correct field names.
        const formData = new FormData();
        const audioBlob = new Blob(
          [await import("node:fs/promises").then((fs) => fs.readFile(encoded.outputPath))],
          { type: "audio/ogg" },
        );
        formData.append("files[0]", audioBlob, "voice-message.ogg");
        formData.append(
          "payload_json",
          JSON.stringify({
            content: "",
            flags: MessageFlags.IsVoiceMessage,
            attachments: [
              {
                id: 0,
                filename: "voice-message.ogg",
                duration_secs: encoded.durationSecs,
                waveform: encoded.waveformBase64,
              },
            ],
          }),
        );
        const result = await client.rest.post(
          Routes.channelMessages(channelId),
          { body: formData, passThroughBody: true },
        ) as { id: string };
        voiceMessageId = result.id;
      } finally {
        await cleanupVoiceFile(encoded.outputPath);
      }
      return {
        provider: "discord",
        target,
        externalId: voiceMessageId,
        externalIds: voiceMessageId ? [voiceMessageId] : [],
        deliveredAt: Date.now(),
      };
    }

    // ── Regular send path ────────────────────────────────────────────────────

    // Resolve @username mention tokens → <@id> substitutions and collect user ids
    // for allowed_mentions. parse stays [] to block @everyone/role pings.
    // repliedUser flag (not users list) controls the reply ping — see below.
    // Spec §7.3, §14.
    const { body: resolvedBody, userIds: allowedUserIds } = await resolveMentionTokens(
      message.body ?? "",
      channel as TextChannel | DMChannel,
    );

    // Build message_reference for reply threading (discord.js ReplyOptions shape)
    const replyRef = target.replyToId
      ? { messageReference: target.replyToId, failIfNotExists: false }
      : undefined;

    // Chunked send: split resolved body at 2000 chars (fence-aware)
    const chunks = resolvedBody
      ? chunkMarkdownText(resolvedBody, DISCORD_MAX_CHARS)
      : [""];

    // Attachments: up to 10 files
    const files = buildAttachmentFiles(message.attachments);

    // Send first chunk (with attachments + reply reference)
    let firstMessageId: string | undefined;
    const externalIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;

      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i] || undefined,
        // Attach files only on the last chunk (or first if single chunk)
        files: isLast ? files : undefined,
        reply: isFirst && replyRef ? replyRef : undefined,
        allowedMentions: {
          parse: [], // no automatic @everyone/roles/users
          users: [...allowedUserIds].slice(0, 100), // Discord API limit: max 100 users
          repliedUser: Boolean(replyRef),
        },
      });

      externalIds.push(sent.id);
      if (!firstMessageId) firstMessageId = sent.id;
    }

    return {
      provider: "discord",
      target,
      externalId: firstMessageId,
      externalIds,
      deliveredAt: Date.now(),
    };
  }

  async setTyping(target: OutboundTarget, typing: boolean): Promise<void> {
    const timerKey = target.timelineKey;
    const existing = this.typingTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(timerKey);
    }
    if (!typing) return;

    const channelId = target.roomId ?? parseTimelineKey(target.timelineKey)?.channelId;
    if (!channelId) return;

    let { client } = this.resolveAccount(target);

    const sendTyping = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const ch = await client.channels.fetch(channelId);
        if (ch && ch.isTextBased()) {
          await (ch as TextChannel | DMChannel).sendTyping();
        }
        // Schedule next refresh
        const timer = setTimeout(() => {
          void sendTyping();
        }, TYPING_REFRESH_MS);
        timer.unref?.();
        this.typingTimers.set(timerKey, timer);
      } catch {
        // Non-fatal — typing failure must not disrupt the session
        this.typingTimers.delete(timerKey);
      }
    };

    await sendTyping();
  }

  // ── IChatProvider: setProfile ─────────────────────────────────────────────

  /**
   * Update the bot's avatar and/or per-guild nick (spec §7.1, §14).
   *
   * Global username rename is intentionally excluded (spec §14 deliberate exclusion):
   * Discord usernames are globally unique and rename-rate-limited (~2/hr); a
   * model-invocable rename risks permanently losing the handle to a snipe or
   * failing on collision. Per-guild nick covers the visible effect.
   *
   * Avatar: PATCH /users/@me with `avatar` as a data: URI (base64 image).
   * Per-guild nick: PATCH /guilds/{guildId}/members/@me (requires accountId's bot
   * to be in the guild). We update the nick in ALL guilds the account is in.
   * displayName here maps to the per-guild nick.
   */
  async setProfile(
    accountId: string,
    opts: {
      displayName?: string;
      avatarUrl?: string;
      avatarDataBase64?: string;
      avatarContentType?: string;
    },
  ): Promise<{ displayName?: string; avatarUrl?: string }> {
    const runtime = this.accounts.get(accountId);
    if (!runtime) throw new Error(`Discord setProfile: account "${accountId}" is not running`);
    const { client } = runtime;

    let resultAvatarUrl: string | undefined;
    let resultDisplayName: string | undefined;

    // ── Avatar update ────────────────────────────────────────────────────────
    if (opts.avatarDataBase64) {
      const contentType = opts.avatarContentType ?? "image/png";
      const dataUri = `data:${contentType};base64,${opts.avatarDataBase64}`;
      const result = await client.rest.patch(Routes.user("@me"), {
        body: { avatar: dataUri },
      }) as { avatar?: string | null; id?: string };
      // Build CDN URL for the updated avatar
      if (result.avatar) {
        resultAvatarUrl = `https://cdn.discordapp.com/avatars/${result.id}/${result.avatar}.png`;
      }
    }

    // ── Per-guild nick update ─────────────────────────────────────────────────
    if (opts.displayName !== undefined) {
      const nick = opts.displayName.trim() || null; // empty string → clear nick
      const guilds = client.guilds.cache;
      for (const guild of guilds.values()) {
        if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guild.id)) continue;
        try {
          await client.rest.patch(Routes.guildMember(guild.id, "@me"), {
            body: { nick },
          });
          resultDisplayName = nick ?? "";
        } catch {
          // Non-fatal: nick update may fail in a guild where bot lacks CHANGE_NICKNAME
        }
      }
    }

    return {
      displayName: resultDisplayName,
      avatarUrl: resultAvatarUrl,
    };
  }

  // ── Event listener setup ──────────────────────────────────────────────────

  private attachListeners(runtime: AccountRuntime): void {
    const { client, accountId } = runtime;

    // Gateway ready: capture self identity, load guild emoji, and notify app.ts.
    client.on("ready", (readyClient) => {
      runtime.self = {
        id: readyClient.user.id,
        username: readyClient.user.username,
        displayName: readyClient.user.displayName ?? readyClient.user.username,
      };
      this.host?.onNativeEvent?.(
        { type: "ready", selfId: readyClient.user.id, username: readyClient.user.username },
        { accountId },
      );
      // Notify app.ts so it can add this self-id to selfUserIds + gapBackfetchSelfIds
      // (boot-ordering constraint: getSelf() returns undefined until READY).
      this.callbacks.onSelfResolved?.(accountId, readyClient.user.id);

      // Load emoji for all guilds the bot is already in at READY time.
      for (const guild of readyClient.guilds.cache.values()) {
        if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guild.id)) continue;
        runtime.emojiCatalog.setGuildEmoji(guild.id, guild.emojis.cache.map((e) => ({
          id: e.id,
          name: e.name ?? e.id,
          animated: e.animated ?? false,
        })));
      }

      // Fetch application emoji if application_id is configured.
      if (runtime.applicationId) {
        void client.rest.get(Routes.applicationEmojis(runtime.applicationId))
          .then((result) => {
            const data = (result as { items?: Array<{ id?: string; name?: string; animated?: boolean }> }).items ?? [];
            runtime.emojiCatalog.setAppEmoji(
              data.filter((e) => e.id && e.name).map((e) => ({
                id: e.id!,
                name: e.name!,
                animated: e.animated ?? false,
              })),
            );
          })
          .catch(() => {
            // Non-fatal — app emoji are a nice-to-have
          });
      }
    });

    // USER_UPDATE: refresh self identity when the bot's own profile changes
    client.on("userUpdate", (_oldUser: User | PartialUser, newUser: User) => {
      const self = runtime.self;
      if (self && newUser.id === self.id) {
        runtime.self = {
          id: newUser.id,
          username: newUser.username,
          displayName: newUser.displayName ?? newUser.username,
        };
      }
    });

    // GUILD_CREATE: load emoji for newly joined guilds.
    client.on("guildCreate", (guild) => {
      if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guild.id)) return;
      runtime.emojiCatalog.setGuildEmoji(guild.id, guild.emojis.cache.map((e) => ({
        id: e.id,
        name: e.name ?? e.id,
        animated: e.animated ?? false,
      })));
    });

    // GUILD_DELETE: remove emoji for guilds the bot has left.
    client.on("guildDelete", (guild) => {
      runtime.emojiCatalog.clearGuildEmoji(guild.id);
    });

    // GUILD_EMOJIS_UPDATE: refresh emoji whenever the guild's emoji set changes.
    // discord.js v14 signature: (guild, oldEmojis, newEmojis)
    client.on("guildEmojisUpdate", (guild, _oldEmojis, newEmojis) => {
      if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guild.id)) return;
      runtime.emojiCatalog.setGuildEmoji(guild.id, newEmojis.map((e: GuildEmoji) => ({
        id: e.id,
        name: e.name ?? e.id,
        animated: e.animated ?? false,
      })));
    });

    // GUILD_MEMBER_UPDATE: upsert user identity when member_intent is on (spec §6.5).
    if (runtime.memberIntentEnabled) {
      client.on("guildMemberUpdate", (_oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
        if (!newMember.user) return;
        if (runtime.allowedGuilds && !runtime.allowedGuilds.has(newMember.guild.id)) return;
        void this.callbacks.upsertUserIdentity({
          provider: "discord",
          userId: newMember.user.id,
          username: newMember.user.username,
          displayName: newMember.nickname ?? newMember.user.globalName ?? newMember.user.username,
          observedAt: Date.now(),
        }).catch(() => {});
      });
    }

    // Resume / disconnect lifecycle events for the console
    client.on("shardResume", () => {
      this.host?.onNativeEvent?.({ type: "resumed" }, { accountId });
    });

    client.on("shardDisconnect", (closeEvent) => {
      this.host?.onNativeEvent?.({ type: "disconnected", code: closeEvent.code }, { accountId });
    });

    // Rate-limit diagnostics
    client.rest.on("rateLimited", (info) => {
      this.host?.onDiagnostics?.({ type: "rate_limited", ...info }, { accountId });
    });

    // ── Reaction events (spec §12.6, §10) ────────────────────────────────────

    client.on("messageReactionAdd", (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowedByGuild(runtime, reaction.message.guildId)) return;
      this.handleReactionAdd(runtime, reaction, user);
    });

    client.on("messageReactionRemove", (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowedByGuild(runtime, reaction.message.guildId)) return;
      this.handleReactionRemove(runtime, reaction, user);
    });

    client.on("messageReactionRemoveAll", (message) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowedByGuild(runtime, message.guildId)) return;
      // Bulk clear: tombstone ALL reactions on this message (spec §10.1).
      const targetEventId = buildDiscordEventId(accountId, message.id);
      this.host.onBulkReactionClear?.({ targetEventId }, { accountId });
    });

    client.on("messageReactionRemoveEmoji", (reaction: MessageReaction | PartialMessageReaction) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowedByGuild(runtime, reaction.message.guildId)) return;
      // Bulk clear: tombstone all reactions with this emoji on this message (spec §10.1).
      const targetEventId = buildDiscordEventId(accountId, reaction.message.id);
      const normalizedKey = buildReactionNormalizedKey(reaction.emoji);
      this.host.onBulkReactionClear?.({ targetEventId, normalizedKey }, { accountId });
    });

    // Error surface
    client.on("error", (error) => {
      this.host?.onError(error, { accountId, phase: "gateway" });
    });

    // ── Inbound message create ────────────────────────────────────────────────

    client.on("messageCreate", (message) => {
      if (this.stopped) return;
      if (!this.host) return;

      // Filter by guild allowlist
      if (!this.isAllowed(runtime, message)) return;

      void this.handleMessageCreate(runtime, message).catch((error) => {
        this.host?.onError(error, { accountId, phase: "messageCreate" });
      });
    });

    // ── Message update (edits + late embeds) ─────────────────────────────────

    client.on("messageUpdate", (_oldMsg, newMsg) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowed(runtime, newMsg)) return;

      void this.handleMessageUpdate(runtime, newMsg).catch((error) => {
        this.host?.onError(error, { accountId, phase: "messageUpdate" });
      });
    });

    // ── Message delete ────────────────────────────────────────────────────────

    client.on("messageDelete", (message) => {
      if (this.stopped) return;
      if (!this.host) return;
      if (!this.isAllowed(runtime, message)) return;

      void this.handleMessageDelete(runtime, message).catch((error) => {
        this.host?.onError(error, { accountId, phase: "messageDelete" });
      });
    });
  }

  // ── Inbound handlers ─────────────────────────────────────────────────────

  private async handleMessageCreate(runtime: AccountRuntime, message: Message): Promise<void> {
    const selfId = runtime.self?.id;
    const isSelf = Boolean(selfId && message.author.id === selfId);

    const parentChannelId = await this.resolveParentChannelId(runtime, message);
    const msgData = extractMessageData(message, parentChannelId);
    const ctx = { accountId: runtime.accountId, selfUserId: selfId ?? "" };

    const { inbound, embedPreviews } = normalizeDiscordMessage(msgData, ctx);

    // Record custom emoji observed inline so the catalog can display them later.
    // These are NOT added to the sendable set (spec §10.2/§10.3).
    for (const obs of extractEmojiObservations(message.content)) {
      runtime.emojiCatalog.observeEmoji(obs.id, obs.name, obs.animated);
    }

    // Upsert the sender's user identity (spec §6.5). Non-fatal.
    void this.callbacks.upsertUserIdentity({
      provider: "discord",
      userId: message.author.id,
      username: message.author.username,
      displayName: msgData.authorDisplayName,
      observedAt: message.createdTimestamp,
    }).catch(() => {});

    // Upsert channel metadata (spec §6.6). Non-fatal.
    void this.callbacks.setChannelMetadata(inbound.timelineKey, {
      displayName: buildChannelDisplayName(message),
      serverId: message.guildId ?? undefined,
      serverName: message.guild?.name ?? undefined,
    }).catch(() => {});

    // Self-sent message: mark isSelf and flow through for echo-merge.
    // host.onEvent first (synchronously enqueues the FIFO single-writer event insert),
    // then storeIngestEmbeds (so the link_previews FK on timeline_events(id) is
    // satisfied — the event row is always committed before the preview rows).
    if (isSelf) {
      inbound.event.sender.isSelf = true;
      this.host!.onEvent(inbound);
      if (embedPreviews.length > 0) {
        await this.callbacks.storeIngestEmbeds(inbound.event.id, embedPreviews);
      }
      return;
    }

    // Trigger-hold mechanism (mirrors Matrix provider, spec §8.4).
    // embedPreviews are passed into the hold structure and stored at flush time,
    // after host.onEvent fires, so the link_previews FK on timeline_events(id) is
    // satisfied on the held path too.
    if (inbound.trigger && this.config.trigger_hold_ms) {
      this.applyTriggerHold(runtime, inbound, embedPreviews);
      return;
    }

    // Check for reply-to-bot trigger (spec §8.2)
    if (!inbound.trigger && inbound.event.replyTo?.externalId) {
      const replyTrigger = this.host!.resolveReplyTrigger?.({
        provider: "discord",
        externalId: inbound.event.replyTo.externalId,
        timelineKey: inbound.timelineKey,
        sender: inbound.event.sender,
      });
      if (replyTrigger) {
        inbound.trigger = replyTrigger;
        inbound.event.trigger = replyTrigger;
      }
    }

    // host.onEvent first, then embeds (same FK ordering reason as above).
    this.host!.onEvent(inbound);
    if (embedPreviews.length > 0) {
      await this.callbacks.storeIngestEmbeds(inbound.event.id, embedPreviews);
    }
  }

  private async handleMessageUpdate(
    runtime: AccountRuntime,
    rawMsg: Message | PartialMessage,
  ): Promise<void> {
    // Fetch the full message if we only have a partial
    let message: Message;
    try {
      message = rawMsg.partial ? await rawMsg.fetch() : (rawMsg as Message);
    } catch {
      // Fetch failed (deleted, forbidden) — ignore
      return;
    }

    const selfId = runtime.self?.id;
    const parentChannelId = await this.resolveParentChannelId(runtime, message);
    const msgData = extractMessageData(message, parentChannelId);
    const timelineKey = buildDiscordTimelineKey(
      runtime.accountId,
      msgData.channelId,
      msgData.channelType,
      msgData.parentChannelId,
    );

    // Discriminate: user edit vs late-embed resolution (spec §8.3)
    const hasEditedTimestamp = message.editedTimestamp !== null;

    if (!hasEditedTimestamp) {
      // Late-embed resolution: Discord updated the embeds without user editing the text.
      // DO NOT route as edit (double-processing hazard).
      const previews = embedsToLinkPreviews(msgData.embeds);
      if (previews.length > 0) {
        await this.callbacks.mergeLateEmbeds(
          "discord",
          message.id,
          timelineKey,
          previews,
        );
      }
      return; // Not an edit — stop here
    }

    // User edit: route as InboundChatEvent with edit marker
    const ctx = { accountId: runtime.accountId, selfUserId: selfId ?? "" };
    const { inbound } = normalizeDiscordMessage(msgData, ctx);

    // Mark as edit
    const editInbound: typeof inbound = {
      ...inbound,
      edit: { targetExternalId: message.id },
      trigger: undefined, // edits never re-trigger
    };
    editInbound.event.trigger = undefined;

    this.host!.onEvent(editInbound);
  }

  private async handleMessageDelete(
    runtime: AccountRuntime,
    message: Message | PartialMessage,
  ): Promise<void> {
    // For deletes we only need the id and channel info (may be partial)
    const channelId = message.channelId;
    const channelType = await this.resolveChannelType(runtime, channelId);
    const parentChannelId = THREAD_CHANNEL_TYPES.has(channelType as ChannelType)
      ? await this.resolveParentId(runtime, channelId)
      : undefined;

    const timelineKey = buildDiscordTimelineKey(
      runtime.accountId,
      channelId,
      channelType,
      parentChannelId,
    );
    const externalId = message.id;
    const canonicalId = buildDiscordEventId(runtime.accountId, externalId);

    // Route as a delete — use the same path Matrix redactions use: an inbound event
    // with a delete marker so the timeline store removes the target.
    const deleteEvent: CanonicalChatEvent = {
      id: `${canonicalId}:delete:${nanoid()}`,
      timelineKey,
      provider: "discord",
      role: "user",
      sender: { id: "system" },
      body: "",
      timestamp: Date.now(),
      receivedAt: Date.now(),
    };

    this.host!.onEvent({
      provider: "discord",
      timelineKey,
      event: deleteEvent,
      edit: { targetExternalId: externalId }, // reuse edit marker for delete routing
    });
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  private isAllowed(runtime: AccountRuntime, message: Message | PartialMessage): boolean {
    const guildId = message.guildId;

    // DM: guildId is null
    if (!guildId) {
      return runtime.dmEnabled;
    }

    // Guild allowlist filtering (spec §12.3)
    if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guildId)) {
      return false;
    }

    return true;
  }

  /** Returns true if a guildId is allowed by this account's guild allowlist. */
  private isAllowedByGuild(runtime: AccountRuntime, guildId: string | null | undefined): boolean {
    if (!guildId) return runtime.dmEnabled; // DM reaction
    if (runtime.allowedGuilds && !runtime.allowedGuilds.has(guildId)) return false;
    return true;
  }

  /** Handle MESSAGE_REACTION_ADD — route to host.onReaction (spec §12.6, §10). */
  private handleReactionAdd(
    runtime: AccountRuntime,
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): void {
    const { accountId } = runtime;
    const messageId = reaction.message.id;
    const userId = user.id;
    const emoji = reaction.emoji;

    const normalizedKey = buildReactionNormalizedKey(emoji);
    // Synthetic PK: `discord:<messageId>:<normalizedKey>:<userId>` (spec §10, §57-61)
    const reactionEventId = `discord:${messageId}:${normalizedKey}:${userId}`;

    const channelId = reaction.message.channelId;
    const channelType = reaction.message.channel?.type ?? ChannelType.GuildText;
    let parentChannelId: string | undefined;
    if (THREAD_CHANNEL_TYPES.has(channelType as ChannelType)) {
      const ch = reaction.message.channel as { parentId?: string | null } | null;
      parentChannelId = ch?.parentId ?? undefined;
    }
    const timelineKey = buildDiscordTimelineKey(accountId, channelId, channelType, parentChannelId);

    let kind: "unicode" | "custom";
    let display: string;
    let shortcode: string | undefined;
    if (emoji.id) {
      kind = "custom";
      display = `:${emoji.name ?? emoji.id}:`;
      shortcode = emoji.name ?? undefined;
    } else {
      kind = "unicode";
      display = emoji.name ?? "";
    }

    this.host!.onReaction({
      action: "add",
      reactionEventId,
      timelineKey,
      senderId: userId,
      senderDisplay: (user as User).username,
      reactedAtMs: Date.now(),
      targetEventId: buildDiscordEventId(accountId, messageId),
      kind,
      display,
      shortcode,
      normalizedKey,
    }, { accountId });
  }

  /** Handle MESSAGE_REACTION_REMOVE — route to host.onReaction as tombstone (spec §12.6, §10). */
  private handleReactionRemove(
    runtime: AccountRuntime,
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): void {
    const { accountId } = runtime;
    const messageId = reaction.message.id;
    const userId = user.id;

    const normalizedKey = buildReactionNormalizedKey(reaction.emoji);
    // Reconstruct the same PK used on "add" so the storage layer can tombstone it.
    const reactionEventId = `discord:${messageId}:${normalizedKey}:${userId}`;

    const channelId = reaction.message.channelId;
    const channelType = reaction.message.channel?.type ?? ChannelType.GuildText;
    let parentChannelId: string | undefined;
    if (THREAD_CHANNEL_TYPES.has(channelType as ChannelType)) {
      const ch = reaction.message.channel as { parentId?: string | null } | null;
      parentChannelId = ch?.parentId ?? undefined;
    }
    const timelineKey = buildDiscordTimelineKey(accountId, channelId, channelType, parentChannelId);

    this.host!.onReaction({
      action: "remove",
      reactionEventId,
      timelineKey,
      senderId: userId,
      reactedAtMs: Date.now(),
    }, { accountId });
  }

  // ── Trigger hold (mirrors Matrix provider) ────────────────────────────────

  private applyTriggerHold(
    runtime: AccountRuntime,
    inbound: import("../types.js").InboundChatEvent,
    embedPreviews: LinkPreviewMeta[],
  ): void {
    const holdMs = this.config.trigger_hold_ms ?? 0;
    if (!holdMs) {
      this.host!.onEvent(inbound);
      if (embedPreviews.length > 0) {
        void this.callbacks.storeIngestEmbeds(inbound.event.id, embedPreviews);
      }
      return;
    }

    const key = inbound.timelineKey;
    const existing = this.pendingTriggers.get(key);

    if (existing) {
      // Extend hold — reset timer, but cap total hold at MULTIPLIER × holdMs.
      // Read holdStartedAt from the EXISTING held trigger (not the incoming event)
      // so a steady drip of triggers cannot extend the hold beyond 4× from the
      // FIRST trigger (mirrors Matrix provider logic, src/matrix/provider.ts:~347).
      // The incoming event's embedPreviews replace the held ones; each event's
      // previews stay paired with that event's id (only the final merged event is
      // flushed to host.onEvent, so only its previews are stored).
      const now = Date.now();
      const startedAt = existing.event.trigger?.holdStartedAt ?? now;
      const maxEnd = startedAt + holdMs * TRIGGER_HOLD_MAX_MULTIPLIER;
      const remaining = Math.max(0, Math.min(holdMs, maxEnd - now));
      clearTimeout(existing.timer);
      existing.event = inbound;
      existing.embedPreviews = embedPreviews;
      existing.timer = setTimeout(() => {
        this.pendingTriggers.delete(key);
        if (!this.stopped) {
          this.host!.onEvent(existing.event);
          // Store embeds after host.onEvent so link_previews FK on timeline_events(id)
          // is satisfied on the held path: event row is enqueued first, previews after.
          if (existing.embedPreviews.length > 0) {
            void this.callbacks.storeIngestEmbeds(existing.event.event.id, existing.embedPreviews);
          }
        }
      }, remaining);
      return;
    }

    // New hold
    if (inbound.trigger) {
      inbound.trigger.holdStartedAt = Date.now();
    }
    // Build pending structure first so the flush closure references it by identity;
    // subsequent merges that update pending.event / pending.embedPreviews are visible
    // when the timer fires.
    const pending: PendingTrigger = { event: inbound, embedPreviews, timer: undefined! };
    pending.timer = setTimeout(() => {
      this.pendingTriggers.delete(key);
      if (!this.stopped) {
        this.host!.onEvent(pending.event);
        // Store embeds after host.onEvent so link_previews FK on timeline_events(id)
        // is satisfied on the held path: event row is enqueued first, previews after.
        if (pending.embedPreviews.length > 0) {
          void this.callbacks.storeIngestEmbeds(pending.event.event.id, pending.embedPreviews);
        }
      }
    }, holdMs);
    this.pendingTriggers.set(key, pending);
  }

  // ── Channel resolution helpers ────────────────────────────────────────────

  /**
   * Resolve the parent channel id for a thread message.
   * Uses the discord.js channel cache, falling back to a REST fetch on miss.
   */
  private async resolveParentChannelId(
    runtime: AccountRuntime,
    message: Message,
  ): Promise<string | undefined> {
    if (!THREAD_CHANNEL_TYPES.has(message.channel.type as ChannelType)) {
      return undefined;
    }
    const ch = message.channel;
    if ("parentId" in ch && ch.parentId) return ch.parentId;
    // Cache miss: fetch the channel to get its parent
    try {
      const fetched = await runtime.client.channels.fetch(message.channelId);
      if (fetched && "parentId" in fetched && fetched.parentId) return fetched.parentId;
    } catch {
      // Ignore fetch errors — the key degrades to room:<threadId> without parent
    }
    return undefined;
  }

  private async resolveParentId(
    runtime: AccountRuntime,
    channelId: string,
  ): Promise<string | undefined> {
    try {
      const ch = await runtime.client.channels.fetch(channelId);
      if (ch && "parentId" in ch && ch.parentId) return ch.parentId;
    } catch {
      // Ignore
    }
    return undefined;
  }

  private async resolveChannelType(
    runtime: AccountRuntime,
    channelId: string,
  ): Promise<number> {
    // Try cache first
    const cached = runtime.client.channels.cache.get(channelId);
    if (cached) return cached.type;
    try {
      const ch = await runtime.client.channels.fetch(channelId);
      if (ch) return ch.type;
    } catch {
      // Ignore
    }
    return ChannelType.GuildText; // default fallback
  }

  // ── Account resolution ────────────────────────────────────────────────────

  private resolveAccount(target: OutboundTarget): { accountId: string; client: Client } {
    const accountId =
      target.accountId ?? parseTimelineKey(target.timelineKey)?.accountId;
    if (!accountId) {
      throw new Error("Discord send: cannot determine accountId from target");
    }
    const runtime = this.accounts.get(accountId);
    if (!runtime) {
      throw new Error(`Discord send: account "${accountId}" is not running`);
    }
    return { accountId, client: runtime.client };
  }
}

// ── Intent builder ────────────────────────────────────────────────────────────

function buildIntents(memberIntent: boolean): number[] {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildExpressions,
  ];
  if (memberIntent) {
    intents.push(GatewayIntentBits.GuildMembers);
  }
  return intents;
}

// ── Message data extraction ───────────────────────────────────────────────────

/** Extract a plain DiscordMessageData from a discord.js Message object. */
function extractMessageData(message: Message, parentChannelId: string | undefined): DiscordMessageData {
  const mentionedUsers: DiscordMentionedUser[] = message.mentions.users.map((user, id) => ({
    id,
    username: user.username,
    displayName: getMemberDisplayName(message, id) ?? user.displayName ?? user.username,
  }));

  const mentionedRoles: DiscordMentionedRole[] = message.mentions.roles.map((role, id) => ({
    id,
    name: role.name,
  }));

  const mentionedChannels: DiscordMentionedChannel[] = message.mentions.channels.map(
    (ch, id) => ({
      id,
      name: "name" in ch ? (ch as TextChannel).name : id,
    }),
  );

  const attachments: DiscordAttachmentData[] = [...message.attachments.values()].map((att) => ({
    id: att.id,
    filename: att.name,
    url: att.url,
    contentType: att.contentType ?? undefined,
    size: att.size,
    width: att.width ?? undefined,
    height: att.height ?? undefined,
    durationSecs: att.duration ?? undefined,
    isVoiceMessage: message.flags.has(MessageFlags.IsVoiceMessage),
  }));

  const stickers: DiscordStickerData[] = [...message.stickers.values()].map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    contentType: stickerFormatToContentType(s.format),
  }));

  const embeds: DiscordEmbedData[] = message.embeds.map((e) => ({
    url: e.url ?? undefined,
    title: e.title ?? undefined,
    description: e.description ?? undefined,
    siteName: e.provider?.name ?? undefined,
    type: e.data.type,
  }));

  let referencedMessage: DiscordMessageData["referencedMessage"] | undefined;
  // Gate on message.reference?.messageId alone — repliedUser can be null on
  // partial payloads and must not suppress the context (MINOR 2).
  if (message.reference?.messageId) {
    // BLOCKER 1 fix: discord.js v14 has no .referencedMessage property.
    // Use the channel message cache instead; fall through to the author stub on miss.
    const refMsg = message.channel.messages.cache.get(message.reference.messageId);
    if (refMsg) {
      referencedMessage = {
        id: refMsg.id,
        content: refMsg.content,
        authorId: refMsg.author.id,
        authorUsername: refMsg.author.username,
        authorDisplayName: getMemberDisplayName(refMsg, refMsg.author.id) ?? refMsg.author.displayName ?? refMsg.author.username,
        timestamp: refMsg.createdTimestamp,
        attachments: [...refMsg.attachments.values()].map((a) => ({
          id: a.id,
          filename: a.name,
          url: a.url,
          contentType: a.contentType ?? undefined,
          size: a.size,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
        })),
        stickers: [...refMsg.stickers.values()].map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          contentType: stickerFormatToContentType(s.format),
        })),
      };
    } else {
      // Cache miss: use repliedUser (author stub) as fallback, if available.
      const ref = message.mentions.repliedUser;
      referencedMessage = {
        id: message.reference.messageId,
        content: "",
        authorId: ref?.id ?? "",
        authorUsername: ref?.username ?? "",
        authorDisplayName: ref?.displayName ?? ref?.username ?? "",
        timestamp: 0,
        attachments: [],
        stickers: [],
      };
    }
  }

  const poll: DiscordMessageData["poll"] | undefined = message.poll
    ? {
        question: message.poll.question.text ?? "",
        answers: [...message.poll.answers.values()].map((a) => ({
          text: a.text ?? "",
        })),
      }
    : undefined;

  return {
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    channelType: message.channel.type,
    guildId: message.guildId ?? undefined,
    parentChannelId,
    authorId: message.author.id,
    authorUsername: message.author.username,
    authorDisplayName:
      getMemberDisplayName(message, message.author.id) ??
      message.author.displayName ??
      message.author.username,
    timestamp: message.createdTimestamp,
    editedTimestamp: message.editedTimestamp,
    mentionedUsers,
    mentionedRoles,
    mentionedChannels,
    mentionEveryone: message.mentions.everyone,
    attachments,
    stickers,
    embeds,
    referencedMessage,
    poll,
  };
}

function getMemberDisplayName(message: Message, userId: string): string | undefined {
  // Try to get guild nick from member cache
  const member = message.guild?.members.cache.get(userId);
  return member?.nickname ?? undefined;
}

// ── @username mention resolution (spec §7.3, §14) ────────────────────────────

/**
 * Resolve `@username` tokens in an outbound message body.
 *
 * Scans `body` for tokens of the form `@word` (not preceded by a word char,
 * so email-address local-parts are skipped). Each unique token is resolved
 * in order:
 *   1. Guild member cache (`guild.members.cache.find`)
 *   2. REST member search (`guild.members.search({ query, limit: 10 })`) on miss
 *
 * DMs: only the DM recipient is eligible (no guild lookup).
 * Never resolves `@everyone` or `@here` — those tokens are skipped.
 * Unresolved tokens pass through unchanged (plain text).
 *
 * Resolved tokens are replaced in the body with `<@id>` Discord mention syntax
 * and the user id is added to `userIds` for `allowed_mentions.users`.
 * `allowed_mentions.parse` stays `[]` so no automatic @everyone/role pings fire.
 *
 * Exported for unit testing with stubbed channel objects.
 */
export async function resolveMentionTokens(
  body: string,
  channel: TextChannel | DMChannel,
): Promise<{ body: string; userIds: Set<string> }> {
  const userIds = new Set<string>();
  if (!body) return { body, userIds };

  // Extract unique @username tokens; skip @everyone and @here.
  // Negative lookbehind `(?<!\w)` avoids matching inside email addresses.
  const TOKEN_RE = /(?<!\w)@([a-zA-Z0-9_.]+)/g;
  const rawTokens = [...body.matchAll(TOKEN_RE)].map((m) => m[1]!);
  const uniqueTokens = [...new Set(rawTokens)].filter(
    (t) => t !== "everyone" && t !== "here" && t.length >= 1,
  );

  if (uniqueTokens.length === 0) return { body, userIds };

  // Per-send resolution cache: username → id
  const resolvedMap = new Map<string, string>();

  if (channel.type === ChannelType.DM) {
    // DM: resolve only the DM recipient.
    const dmCh = channel as DMChannel;
    const recipient = dmCh.recipient;
    if (recipient) {
      for (const username of uniqueTokens) {
        if (recipient.username.toLowerCase() === username.toLowerCase()) {
          resolvedMap.set(username, recipient.id);
        }
      }
    }
  } else {
    // Guild channel: cache-first, then REST.
    const guildCh = channel as TextChannel;
    const guild = guildCh.guild;
    if (guild) {
      for (const username of uniqueTokens) {
        const cached = guild.members.cache.find(
          (m) => m.user.username.toLowerCase() === username.toLowerCase(),
        );
        if (cached) {
          resolvedMap.set(username, cached.user.id);
        } else {
          try {
            const results = await guild.members.search({ query: username, limit: 10 });
            const matched = results.find(
              (m) => m.user.username.toLowerCase() === username.toLowerCase(),
            );
            if (matched) {
              resolvedMap.set(username, matched.user.id);
            }
          } catch {
            // REST failed — token passes through unchanged
          }
        }
      }
    }
  }

  // Replace resolved tokens and collect user ids.
  let resolvedBody = body;
  for (const [username, id] of resolvedMap) {
    userIds.add(id);
    // Escape special regex chars in username (dots, etc.).
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Negative lookahead `(?![a-zA-Z0-9_.])` ensures we don't match a prefix
    // of a longer username (e.g. @alice must not match inside @alice.smith).
    const re = new RegExp(`(?<!\\w)@${escaped}(?![a-zA-Z0-9_.])`, "g");
    resolvedBody = resolvedBody.replace(re, `<@${id}>`);
  }

  return { body: resolvedBody, userIds };
}

// ── Sticker format helper ─────────────────────────────────────────────────────

/**
 * Map the discord.js StickerFormatType enum to a MIME type string.
 *
 * PNG (1) and APNG (2) → image/png  (.png)
 * GIF (4)              → image/gif  (.gif)
 * Lottie (3)           → application/json (.json, skips captioning — mediaType "file")
 *
 * Lottie files are JSON animation descriptors; the captioning worker skips
 * any attachment with mediaType "file" (captionableTypes = [image, video, audio]).
 */
function stickerFormatToContentType(format: StickerFormatType | undefined): string | undefined {
  switch (format) {
    case StickerFormatType.PNG:
    case StickerFormatType.APNG:
      return "image/png";
    case StickerFormatType.GIF:
      return "image/gif";
    case StickerFormatType.Lottie:
      return "application/json";
    default:
      return undefined;
  }
}

// ── Reaction helpers ──────────────────────────────────────────────────────────

/**
 * Build the normalized reaction key for a Discord emoji.
 *   Unicode → the glyph string (e.g. "👍").
 *   Custom  → `discord:<emojiSnowflake>` (via EmojiCatalog.normalizedKey).
 */
function buildReactionNormalizedKey(
  emoji: MessageReaction["emoji"] | PartialMessageReaction["emoji"],
): string {
  if (emoji.id) {
    return EmojiCatalog.normalizedKey(emoji.id);
  }
  return emoji.name ?? "";
}

// ── Channel display name helper ───────────────────────────────────────────────

/**
 * Build a human-readable display name for a channel, used in room_metadata.
 * Format: `#channel-name (Guild Name)` for guild channels; `#channel-name` for DMs.
 */
function buildChannelDisplayName(message: Message): string {
  const ch = message.channel;
  const chName = "name" in ch && typeof (ch as { name?: unknown }).name === "string"
    ? (ch as { name: string }).name
    : message.channelId;
  const guildName = message.guild?.name;
  return guildName ? `#${chName} (${guildName})` : `#${chName}`;
}

// ── Attachment file builder ───────────────────────────────────────────────────

function buildAttachmentFiles(
  attachments: OutboundMessage["attachments"],
): Array<{ attachment: string; name: string }> {
  if (!attachments || attachments.length === 0) return [];
  return attachments
    .slice(0, DISCORD_MAX_ATTACHMENTS)
    .filter((a) => Boolean(a.localPath))
    .map((a) => ({
      attachment: a.localPath!,
      name: a.filename ?? "file",
    }));
}
