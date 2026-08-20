/**
 * IrcProvider — Phase 1 + Phase 2 + Phase 3 implementation.
 *
 * Implements {@link IChatProvider} for IRC using irc-framework v4.
 * One irc-framework Client per configured account; reconnect with exponential
 * backoff is handled by the library. On every (re-)registration:
 *   - Floor cap validation (§3.1) — hard error and quit on missing cap.
 *   - Channel rejoin and self-WHO for hostmask learning (§7.1).
 *
 * Phase 2 additions (spec IRC-SUPPORT-DESIGN §5):
 *   - Identity ladder: account-tag > tracked account > casemapped nick.
 *   - Account↔nick tracking via AccountTracker: extended-join, account-notify,
 *     opportunistic account-tag refresh, WHOX on channel join.
 *   - Ladder-keyed DM timelines (spec §4).
 *   - user_identities writes via IrcProviderCallbacks.upsertUserIdentity on NICK.
 *   - QUIT pruning of tracked state.
 *   - Self-identity: SASL account name when configured, else casemapped nick.
 *
 * Phase 3 additions (spec IRC-SUPPORT-DESIGN §7.6, §10):
 *   - Per-channel roster tracking via RosterTracker (join/part/quit/nick/away/back/kick).
 *   - Per-channel topic/mode tracking in `channelData` map.
 *   - Full ChannelClient: membersFn (roster), memberInfoFn (WHOIS), channelInfoFn (tracked state).
 *   - setChannelMetadata callback: upserts room_metadata on every inbound message.
 *
 * Spec: IRC-SUPPORT-DESIGN
 *   §3 (caps), §4 (timeline keys), §5 (identity), §6 (capabilities),
 *   §7 (send/echo/reconnect), §7.5 (inbound pipeline), §7.6 (ChannelClient), §8 (config), §10.
 */

import IrcFramework from "irc-framework";
import { nanoid } from "nanoid";
import { parseTimelineKey } from "../storage/timeline-key.js";
import type {
  ChannelClient,
  ChannelInfo,
  ChatProviderHost,
  DeliveryReceipt,
  EnrichmentCapabilities,
  IChatProvider,
  MemberInfo,
  OutboundMessage,
  OutboundTarget,
  ProviderCapabilities,
  SelfIdentity,
  SenderInfo,
} from "../types.js";
import type { IrcAccountConfig, IrcConfig } from "../config/schema.js";
import type { UserIdentityUpsertInput } from "../storage/database.js";
import {
  casefold,
  chunkIrcMessage,
  computeByteBudget,
  isChannelTarget,
  normalizeIrcMessage,
  scopeIrcId,
  unscopeIrcId,
  STATIC_MAX_CHARS,
  syntheticMsgId,
  type IrcNormalizerContext,
} from "./normalizer.js";
import { IrcChannelClient, type IrcWhoisResult } from "./channel-client.js";
import { AccountTracker } from "./account-tracker.js";
import { RosterTracker } from "./roster-tracker.js";

// ── IrcProviderCallbacks ──────────────────────────────────────────────────────

/**
 * Callbacks injected at construction time for operations that need storage access.
 *
 * Follows the same pattern as {@link DiscordProviderCallbacks}: the provider is
 * constructed before storage is available, and the callbacks bridge that gap.
 * All callbacks are fire-and-forget (void) from the provider's perspective.
 *
 * Phase 2: `upsertUserIdentity` — per-NICK-event identity writes.
 * Phase 3: `setChannelMetadata` — upsert room_metadata so serverIdsFor() (spec §7.4 / §10)
 *          can return the network id for per-user-limits partitioning.
 */
export interface IrcProviderCallbacks {
  /**
   * Upsert a user identity row (spec §5.3).
   * Called on NICK renames to record the old nick as an alias.
   * Per-message upserts are handled by the generic ingest path in app.ts.
   */
  upsertUserIdentity(input: UserIdentityUpsertInput): Promise<void>;
  /**
   * Upsert room_metadata for a timeline key (spec §7.4, §10 serverIdsFor touch point).
   * Called on every inbound message so the network id (serverId) is kept current.
   * Non-fatal: errors are swallowed by the caller.
   */
  setChannelMetadata(
    timelineKey: string,
    meta: { displayName: string; serverId?: string; serverName?: string },
  ): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How often to refresh the typing indicator (IRC clients clear after ~30s;
 *  we refresh much more often to be safe on both strict and lenient servers). */
const TYPING_REFRESH_MS = 8_000;

/** Maximum hold-extension multiplier for trigger_hold_ms. */
const TRIGGER_HOLD_MAX_MULTIPLIER = 4;

/** Timeout for awaiting an echo before falling back to the synthetic id. */
const ECHO_TIMEOUT_MS = 5_000;

/** Timeout for a WHOIS reply before memberInfo gives up (connection drop mid-query). */
const WHOIS_TIMEOUT_MS = 10_000;

/**
 * Set message_max_length to this value so irc-framework does NOT chunk.
 * We pre-chunk manually for UTF-8 accuracy (§7.1).
 */
const LIBRARY_MSG_MAX_LEN = 512;

/**
 * Floor caps required for every account. The library's default want list already
 * includes server-time and message-tags. echo-message requires enable_echomessage
 * in connect options (not in the library's default want list).
 */
const FLOOR_CAPS = ["server-time", "message-tags", "echo-message"] as const;

/**
 * Opportunistic caps: requested when advertised; absence changes internal
 * mechanics only; never hard-errors. Per spec §3.2.
 */
const OPPORTUNISTIC_CAPS = [
  "msgid",
  "labeled-response",
  "batch",
  "account-tag",
  "extended-join",
  "account-notify",
  "away-notify",
  "chghost",
  "setname",
];

// ── Per-account runtime state ─────────────────────────────────────────────────

interface PendingEcho {
  target: string;
  body: string;
  syntheticId: string;
  resolve(id: string): void;
  timer: NodeJS.Timeout;
}

interface PendingTrigger {
  event: import("../types.js").InboundChatEvent;
  timer: NodeJS.Timeout;
}

interface AccountRuntime {
  accountId: string;
  config: IrcAccountConfig;
  client: IrcFramework.Client;
  self?: SelfIdentity;
  /** True after a floor cap validation failure — suppress re-error on reconnect. */
  capFailed: boolean;
  /** Set once the `registered` event fires and caps are validated. */
  registered: boolean;
  /**
   * Set by the CAP DEL handler when a required cap is withdrawn mid-connection.
   * Causes the `close` handler (which fires after quit()) to re-enter the
   * connection loop instead of giving up, implementing spec §3.1's RECONNECT path.
   */
  capDelReconnect: boolean;
  /** Pending CAP DEL reconnect delay timer — cleared on stop(). */
  reconnectTimer?: NodeJS.Timeout;
  /** Casemapping from ISUPPORT token (default: rfc1459). */
  casemapping: string;
  /** NETWORK ISUPPORT token lowercased, or configured host when absent. */
  networkName: string;
  /**
   * Set to `true` after the first `server options` (RPL_ISUPPORT / 005) event fires.
   * The 005 burst always arrives after RPL_WELCOME (001) — the library emits
   * `registered` on 001 and `server options` on each 005, and within any single
   * TCP data event irc-framework processes lines synchronously in order, so
   * `registered` always fires before `server options`.  Between those two events,
   * inbound DMs could theoretically arrive (if they land in a separate TCP packet);
   * we gate all inbound processing on this flag so the network-scoped identity
   * prefix is frozen before any id is minted.  In practice the 001→005 burst is
   * sent atomically by every modern ircd and the window never opens.
   */
  networkIdFrozen: boolean;
  /** Hostmask components (learned from WHO after registration). */
  nick: string;
  username: string;
  host: string;
  /** True when the `labeled-response` cap is enabled. */
  hasLabeledResponse: boolean;
  /** True when the `msgid` cap is enabled (server assigns message IDs). */
  hasMsgid: boolean;
  /**
   * Echo-merge FIFO queues per target. Used when `labeled-response` is NOT
   * available. Each entry is the pending echo for a not-yet-echoed PRIVMSG,
   * in send order (IRC ordered-delivery guarantee).
   */
  echoQueues: Map<string, PendingEcho[]>;
  /**
   * Pending echo promises by label string. Used when `labeled-response` IS
   * available. Each key is the nanoid label sent with the PRIVMSG.
   */
  pendingByLabel: Map<string, PendingEcho>;
  /**
   * Account↔nick tracking state (Phase 2).
   * Populated by extended-join, account-notify, account-tag (opportunistic),
   * and WHOX bulk updates. Used by the identity ladder when no per-message tag.
   */
  accountTracker: AccountTracker;
  /**
   * Per-channel member roster (Phase 3).
   * Tracks join/part/quit/nick/away/back/kick transitions.
   * Cleared on socket close (stale membership must not bleed across reconnects).
   */
  rosterTracker: RosterTracker;
  /**
   * Per-channel topic and mode summary (Phase 3).
   * Key: casemapped channel name. Updated by TOPIC and RPL_TOPIC events.
   */
  channelData: Map<string, { topic?: string; modes?: string }>;
}

// ── IrcProvider ────────────────────────────────────────────────────────────────

export class IrcProvider implements IChatProvider {
  readonly id = "irc";

  readonly capabilities: ProviderCapabilities = {
    typing: true,
    reactions: false,
    mediaUpload: false,
    maxAttachmentsPerMessage: 0,
    maxMessageChars: STATIC_MAX_CHARS,
    formatting: "plain",
    edits: false,
    deletes: false,
    pollCreate: false,
    pollVote: false,
    pins: false,
    voiceMessages: false,
    threads: false,
    history: false,
    encrypted: false,
    linkPreviews: "none",
    singleAttachmentPerMessage: false,
    membershipRoster: true,
  };

  private readonly config: IrcConfig;
  private readonly callbacks?: IrcProviderCallbacks;
  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly typingChains = new Map<string, { token: object; timer?: NodeJS.Timeout }>();
  private readonly pendingTriggers = new Map<string, PendingTrigger>();

  private host?: ChatProviderHost;
  private stopped = false;

  constructor(config: IrcConfig, callbacks?: IrcProviderCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  // ── IChatProvider.start ───────────────────────────────────────────────────

  async start(host: ChatProviderHost): Promise<void> {
    this.host = host;
    this.stopped = false;

    const entries = Object.entries(this.config.accounts ?? {});
    for (const [accountKey, accountConfig] of entries) {
      this.initAccount(accountKey, accountConfig);
    }
  }

  // ── IChatProvider.stop ────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pendingTriggers.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingTriggers.clear();
    for (const [, chain] of this.typingChains) {
      clearTimeout(chain.timer);
    }
    this.typingChains.clear();
    for (const [, rt] of this.accounts) {
      if (rt.reconnectTimer) {
        clearTimeout(rt.reconnectTimer);
        rt.reconnectTimer = undefined;
      }
      // Drain pending echo promises with a generic error.
      for (const queue of rt.echoQueues.values()) {
        for (const pending of queue) {
          clearTimeout(pending.timer);
          pending.resolve(pending.syntheticId);
        }
      }
      rt.echoQueues.clear();
      for (const [, pending] of rt.pendingByLabel) {
        clearTimeout(pending.timer);
        pending.resolve(pending.syntheticId);
      }
      rt.pendingByLabel.clear();
      try {
        rt.client.quit("shutting down");
      } catch {
        // Best-effort
      }
    }
    this.accounts.clear();
  }

  // ── IChatProvider.send ────────────────────────────────────────────────────

  async send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const parsed = parseTimelineKey(target.timelineKey);
    if (!parsed || parsed.provider !== "irc") {
      throw new Error(`IrcProvider.send: foreign timeline key: ${target.timelineKey}`);
    }
    const rt = this.accounts.get(parsed.accountId);
    if (!rt || !rt.registered) {
      throw new Error(`IrcProvider.send: account "${parsed.accountId}" is not registered`);
    }
    if (rt.capFailed) {
      throw new Error(`IrcProvider.send: account "${parsed.accountId}" failed floor cap validation`);
    }

    // Determine IRC target string: channel name, or for DMs the bare nick /
    // account — the channelId of a DM key is the network-scoped identity
    // (`<network>/<identity>`, spec §4) and the wire target must be bare.
    const ircTarget = parsed.kind === "dm" ? unscopeIrcId(parsed.channelId) : parsed.channelId;

    // Compute byte budget: use real hostmask when known, conservative fallback otherwise.
    const byteBudget = rt.host
      ? computeByteBudget(rt.nick, rt.username, rt.host, ircTarget)
      : STATIC_MAX_CHARS;

    // Chunk the body.
    const chunks = chunkIrcMessage(message.body, byteBudget);
    if (chunks.length === 0) {
      // Empty body — return a receipt with a synthetic id.
      const id = syntheticMsgId(parsed.accountId, Date.now(), rt.nick);
      return {
        provider: "irc",
        target,
        externalId: id,
        deliveredAt: Date.now(),
      };
    }

    // Send all chunks and collect their echo ids.
    const externalIds: string[] = [];
    for (const chunk of chunks) {
      const id = await this.sendChunk(rt, ircTarget, chunk, parsed.accountId);
      externalIds.push(id);
    }

    return {
      provider: "irc",
      target,
      externalId: externalIds[0],
      externalIds,
      deliveredAt: Date.now(),
    };
  }

  // ── IChatProvider.setTyping ───────────────────────────────────────────────

  async setTyping(target: OutboundTarget, typing: boolean): Promise<void> {
    const parsed = parseTimelineKey(target.timelineKey);
    if (!parsed || parsed.provider !== "irc") return;
    const rt = this.accounts.get(parsed.accountId);
    if (!rt || !rt.registered || rt.capFailed) return;

    // DM keys carry the network-scoped identity; the wire target must be bare.
    const ircTarget = parsed.kind === "dm" ? unscopeIrcId(parsed.channelId) : parsed.channelId;
    const chainKey = `${parsed.accountId}:${ircTarget}`;

    if (!typing) {
      const existing = this.typingChains.get(chainKey);
      if (existing) {
        clearTimeout(existing.timer);
        // Invalidate by replacing token
        const newToken = {};
        existing.token = newToken;
        this.typingChains.set(chainKey, existing);
      }
      try {
        rt.client.tagmsg(ircTarget, { "+typing": "done" });
      } catch {
        // Best-effort
      }
      return;
    }

    // Start/refresh typing indicator.
    const token = {};
    const chain = { token, timer: undefined as NodeJS.Timeout | undefined };
    this.typingChains.set(chainKey, chain);

    const send = () => {
      if (this.typingChains.get(chainKey)?.token !== token) return;
      if (this.stopped) return;
      try {
        rt.client.tagmsg(ircTarget, { "+typing": "active" });
      } catch {
        // Best-effort
      }
      chain.timer = setTimeout(send, TYPING_REFRESH_MS);
      this.typingChains.set(chainKey, chain);
    };
    send();
  }

  // ── IChatProvider.accountIds ──────────────────────────────────────────────

  accountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  // ── IChatProvider.getSelf ─────────────────────────────────────────────────

  getSelf(accountId: string): SelfIdentity | undefined {
    return this.accounts.get(accountId)?.self;
  }

  // ── IChatProvider.ownsUserId ──────────────────────────────────────────────

  /**
   * Permissive shape test for network-scoped IRC user ids.
   * Format: `<networkId>/<identity>` — the `/` separator is mandatory and
   * disambiguates IRC ids from Matrix ids (`@`-prefixed) and Discord ids (all-digit).
   *
   * Rules: non-empty, no whitespace/NUL, not `@`-prefixed, not all-digit, and
   * must contain at least one `/` (the scope separator).
   */
  ownsUserId(id: string): boolean {
    if (!id) return false;
    if (/[\s\0]/.test(id)) return false;
    if (id.startsWith("@")) return false;
    if (/^\d+$/.test(id)) return false;
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) return false; // requires non-empty <network>/<identity>
    return true;
  }

  // ── IChatProvider.channelClient ───────────────────────────────────────────

  channelClient(target: OutboundTarget): ChannelClient | undefined {
    const parsed = parseTimelineKey(target.timelineKey);
    if (!parsed || parsed.provider !== "irc") return undefined;
    const rt = this.accounts.get(parsed.accountId);
    if (!rt) return undefined;

    const isDirect = parsed.kind === "dm";
    const channelTarget = parsed.channelId;

    // ── membersFn (roster-backed, Phase 3) ───────────────────────────────────
    // Returns the current channel roster enriched with account ids via AccountTracker.
    // Each entry's id is network-scoped: scopeIrcId(rt.networkName, ladderResult).
    // Only defined for channels (not DMs); absent for DMs (consistent with Discord).
    const membersFn = isDirect
      ? undefined
      : (): Promise<SenderInfo[]> => {
          const entries = rt.rosterTracker.getMembers(channelTarget, rt.casemapping);
          const selfId = rt.self?.id;
          const result: SenderInfo[] = entries.map((entry) => {
            // Identity ladder (spec §5.1): account if known, else casemapped nick;
            // then scoped to the network.
            const account = rt.accountTracker.getAccount(entry.nick, rt.casemapping);
            const bareId = account ?? casefold(entry.nick, rt.casemapping);
            const id = scopeIrcId(rt.networkName, bareId);
            return {
              id,
              username: entry.nick,
              isSelf: id === selfId || casefold(entry.nick, rt.casemapping) === casefold(rt.nick, rt.casemapping),
            };
          });
          return Promise.resolve(result);
        };

    // ── memberInfoFn (WHOIS-backed, Phase 3) ─────────────────────────────────
    // Resolves a network-scoped id (e.g. "libera.chat/alice_services") to a
    // MemberInfo.  The scoped id is stripped to its bare ladder result before
    // roster/WHOIS resolution.  A mismatched network prefix returns undefined.
    const memberInfoFn = async (id: string): Promise<MemberInfo | undefined> => {
      // Strip the network prefix — only our network's prefix is accepted.
      const prefix = rt.networkName + "/";
      if (!id.startsWith(prefix)) return undefined; // mismatched network
      const bareId = id.slice(prefix.length);

      let nick: string = bareId;

      if (!isDirect) {
        // Try to find a roster member whose account matches the bare ladder result.
        const byAccount = rt.rosterTracker.findNickByAccount(
          channelTarget,
          bareId,
          (n) => rt.accountTracker.getAccount(n, rt.casemapping),
          rt.casemapping,
        );
        if (byAccount) {
          nick = byAccount;
        }
        // If not found by account, treat bareId as a nick directly.
      }

      // Issue WHOIS when registered; fall back to a minimal static entry when not.
      if (!rt.registered || !rt.client) {
        return { userId: id, isSelf: id === rt.self?.id, isDirect };
      }

      const whoisResult = await this.doWhois(rt, nick);
      if (!whoisResult || whoisResult.error === "not_found") {
        return undefined;
      }

      const selfId = rt.self?.id;
      const account = whoisResult.account;
      const resolvedBareId = account ?? casefold(nick, rt.casemapping);
      const resolvedId = scopeIrcId(rt.networkName, resolvedBareId);
      const isSelf = resolvedId === selfId ||
        casefold(whoisResult.nick ?? nick, rt.casemapping) === casefold(rt.nick, rt.casemapping);

      return {
        userId: resolvedId,
        displayName: whoisResult.nick ?? nick,
        isSelf,
        isDirect,
      };
    };

    // ── channelInfoFn (tracked state, Phase 3) ────────────────────────────────
    const channelInfoFn = (): Promise<ChannelInfo> => {
      const key = casefold(channelTarget, rt.casemapping);
      const data = rt.channelData.get(key);
      const topic = data?.topic;

      // DM channelIds are network-scoped (`<network>/<identity>`); display the
      // bare identity — the scoped form is redundant next to the network label.
      const displayTarget = isDirect ? unscopeIrcId(channelTarget) : channelTarget;
      const label = isDirect
        ? `${displayTarget} (${rt.networkName} DM)`
        : `${displayTarget} (${rt.networkName})`;

      return Promise.resolve({
        label,
        displayName: displayTarget,
        channelId: channelTarget,
        serverName: rt.networkName,
        isDirect,
        topic,
        memberCount: isDirect ? undefined : rt.rosterTracker.getMemberCount(channelTarget, rt.casemapping),
        joined: !isDirect,
      });
    };

    return new IrcChannelClient({
      accountId: parsed.accountId,
      target: channelTarget,
      isDirect,
      networkName: rt.networkName,
      membersFn,
      memberInfoFn,
      channelInfoFn,
    });
  }

  // ── IChatProvider.enrichment ──────────────────────────────────────────────

  enrichment(accountId: string): EnrichmentCapabilities | undefined {
    if (!this.accounts.has(accountId)) return undefined;
    // Capture by reference so callbacks always see the live runtime.
    const accounts = this.accounts;
    return {
      async downloadMedia(_params) {
        // IRC messages carry no attachments (spec §1 non-goals); the enrichment
        // worker never has an attachment to download for an IRC event.
        throw new Error("IrcProvider.enrichment.downloadMedia: IRC messages carry no attachments");
      },
      async messageSummary(_params) {
        // No reply concept in IRC v1 (spec §7.5) — reply-context enrichment
        // never applies.
        return null;
      },
      // resolveLinkPreviews omitted: linkPreviews "none" → the enrichment
      // worker falls back to DirectLinkPreviewClient (spec §7.7), exactly as
      // Discord does for non-embedded links. This registration is what routes
      // IRC events through the link-preview and YouTube enrichment stages.
      async memberInfo(params) {
        const rt = accounts.get(accountId);
        if (!rt) return { displayName: undefined };
        const id = params.userId ?? "";
        if (!id) return { displayName: undefined };
        // The id is network-scoped (e.g. "libera.chat/alice_services").
        // Strip the network prefix — only our network's prefix is accepted.
        const prefix = rt.networkName + "/";
        if (!id.startsWith(prefix)) return { displayName: undefined };
        const bareId = id.slice(prefix.length);
        // Prefer the roster: account → current nick; else treat bareId as a nick.
        const byAccount = rt.rosterTracker.findNickByAccount(
          params.roomId,
          bareId,
          (n) => rt.accountTracker.getAccount(n, rt.casemapping),
          rt.casemapping,
        );
        if (byAccount) return { displayName: byAccount };
        const entry = rt.rosterTracker.getMember(params.roomId, bareId, rt.casemapping);
        return { displayName: entry?.nick };
      },
    };
  }

  // ── Account lifecycle ─────────────────────────────────────────────────────

  private initAccount(accountKey: string, config: IrcAccountConfig): void {
    const port = config.port ?? (config.tls !== false ? 6697 : 6667);
    const tls = config.tls ?? (port === 6697);

    const connectOptions: IrcFramework.IrcConnectOptions = {
      host: config.host,
      port,
      tls,
      nick: config.nick,
      username: config.username ?? config.nick,
      gecos: config.realname ?? config.nick,
      enable_echomessage: true,
      enable_chghost: true,
      message_max_length: LIBRARY_MSG_MAX_LEN,
      auto_reconnect: true,
      // Unlimited retries — the library's default is 3 which is too low for
      // a production bot. On cap failure we handle "give up" by not processing
      // further (capFailed flag). For transient network issues we want indefinite
      // retry.
      auto_reconnect_max_retries: 0,
    };

    if (config.server_password) {
      connectOptions.password = config.server_password;
    }
    if (config.sasl_user && config.sasl_password) {
      connectOptions.account = {
        account: config.sasl_user,
        password: config.sasl_password,
      };
    }

    const client = new IrcFramework.Client(connectOptions);

    // Request opportunistic caps (library will only request the ones the server
    // advertises, per CAP LS).
    client.requestCap(OPPORTUNISTIC_CAPS);

    const rt: AccountRuntime = {
      accountId: accountKey,
      config,
      client,
      capFailed: false,
      registered: false,
      capDelReconnect: false,
      casemapping: "rfc1459",
      networkName: config.host,
      networkIdFrozen: false,
      nick: config.nick,
      username: config.username ?? config.nick,
      host: "",
      hasLabeledResponse: false,
      hasMsgid: false,
      echoQueues: new Map(),
      pendingByLabel: new Map(),
      accountTracker: new AccountTracker(),
      rosterTracker: new RosterTracker(),
      channelData: new Map(),
    };

    this.accounts.set(accountKey, rt);
    this.attachListeners(rt);
    client.connect();
  }

  private attachListeners(rt: AccountRuntime): void {
    const { client } = rt;

    // ── registered ──────────────────────────────────────────────────────────
    client.on("registered", (event) => {
      if (this.stopped) return;

      // Update nick from the WELCOME message.
      rt.nick = event.nick;

      // Validate floor caps.
      if (!this.validateFloorCaps(rt)) return;

      // Floor caps OK — mark registered.
      rt.registered = true;
      rt.capFailed = false;

      // Detect opportunistic caps.
      const enabled = rt.client.network.cap.enabled;
      rt.hasLabeledResponse =
        enabled.includes("labeled-response") && enabled.includes("batch");
      rt.hasMsgid = enabled.includes("msgid");

      // Note: CASEMAPPING and NETWORK ISUPPORT tokens arrive in 005 (RPL_ISUPPORT),
      // which is sent AFTER 001 (RPL_WELCOME). Since this handler fires on 001,
      // those values are not yet available here. The `server options` listener below
      // reads them once 005 has been processed, updates networkName/casemapping, and
      // sets networkIdFrozen = true.  Until that happens, networkName stays as
      // config.host (the default) and rt.self is set provisionally below.

      // Self identity (provisional — scoped with current networkName = config.host;
      // the `server options` listener overwrites rt.self once the NETWORK token arrives).
      const selfAccount = rt.config.sasl_user;
      const selfBareId = selfAccount ? selfAccount : casefold(rt.nick, rt.casemapping);
      rt.self = { id: scopeIrcId(rt.networkName, selfBareId), username: rt.nick };

      // Learn hostmask via WHO.
      this.learnHostmask(rt);

      // Join configured channels.
      for (const channel of rt.config.channels ?? []) {
        try {
          rt.client.join(channel);
        } catch (err) {
          this.host?.onError(err, { accountId: rt.accountId, phase: "join" });
        }
      }
    });

    // ── server options (RPL_ISUPPORT / 005) ──────────────────────────────────────
    // The library fires `registered` on 001 (RPL_WELCOME) and `server options` on
    // each 005 (RPL_ISUPPORT). Because 005 always follows 001 in the IRC protocol
    // handshake, the `registered` listener above cannot read ISUPPORT tokens — they
    // are not yet stored in handler.network when 001 is dispatched. This listener
    // reads them on the FIRST 005, freezes the network id, and overwrites rt.self
    // with the correctly scoped value. Subsequent 005 lines (servers may send
    // multiple) are ignored once frozen.
    //
    // Inbound event handlers gate on `rt.networkIdFrozen` so no user id is minted
    // until the prefix is final. In practice the 001→005 burst is always atomic
    // (same TCP packet / same onSocketData call) and the gate closes instantly.
    client.on("server options", () => {
      if (rt.networkIdFrozen) return; // already frozen on a prior 005 line

      // Read CASEMAPPING and NETWORK from ISUPPORT (now available).
      const casemapping = rt.client.network.supports("CASEMAPPING");
      if (typeof casemapping === "string" && casemapping) {
        rt.casemapping = casemapping.toLowerCase();
      }
      const networkToken = rt.client.network.supports("NETWORK");
      if (typeof networkToken === "string" && networkToken) {
        rt.networkName = networkToken.toLowerCase();
      }
      // else: networkName stays as config.host (already set in initAccount).

      // Recompute self identity with the now-final networkName and casemapping.
      const selfAccount = rt.config.sasl_user;
      const selfBareId = selfAccount ? selfAccount : casefold(rt.nick, rt.casemapping);
      rt.self = { id: scopeIrcId(rt.networkName, selfBareId), username: rt.nick };

      rt.networkIdFrozen = true;
    });

    // ── socket close (every disconnect, including auto-reconnect windows) ────────
    // The library emits 'socket close' on EVERY disconnect; 'close' is emitted only
    // when it gives up reconnecting (connection.js:111/141). Without this handler,
    // rt.registered stays true during auto-reconnect windows → send() writes to a
    // dead socket, connection.write returns false silently, and after the 5s echo
    // timeout a synthetic receipt is fabricated for a never-delivered message.
    client.on("socket close", () => {
      rt.registered = false;
      rt.networkIdFrozen = false; // re-freeze on next reconnect's 005
      // Clear stale nick→account mappings: a user may have logged out of services
      // while we were disconnected, and no WHOX fires for absent nicks on reconnect.
      // WHOX-on-self-join repopulates channel members; per-message account-tag
      // repopulates on first message — correct per spec §5.1 ladder.
      rt.accountTracker.clear();
      // Clear stale roster: membership seen before the disconnect is invalid after
      // reconnect (users may have parted while we were gone; NAMES re-populates on join).
      rt.rosterTracker.clear();
      this.drainPendingEchoes(rt);
    });

    // ── close (library gave up — no more auto-reconnect) ─────────────────────────
    // registered and pending echoes are already cleared by 'socket close' above;
    // this handler handles the CAP DEL reconnect path (spec §3.1): quit() sets
    // requested_disconnect=true so the library emits 'close' (not just 'socket
    // close') immediately after — we re-enter the connection loop manually here.
    client.on("close", () => {
      rt.registered = false;
      this.drainPendingEchoes(rt);
      if (rt.capDelReconnect && !rt.capFailed) {
        rt.capDelReconnect = false;
        // Small delay before reconnect to avoid a tight reconnect loop.
        rt.reconnectTimer = setTimeout(() => {
          rt.reconnectTimer = undefined;
          if (!this.stopped) rt.client.connect();
        }, 1_000);
      }
    });

    // ── privmsg ──────────────────────────────────────────────────────────────
    client.on("privmsg", (event) => {
      if (this.stopped || !rt.registered || !rt.networkIdFrozen) return;
      if (event.from_server) return;

      const isSelfEcho =
        casefold(event.nick, rt.casemapping) ===
        casefold(rt.nick, rt.casemapping);

      if (isSelfEcho) {
        this.handleSelfEcho(rt, event, false);
        return;
      }

      // Inbound message from another user.
      const isDm = !isChannelTarget(event.target);
      if (isDm && rt.config.dm_enabled === false) return;

      // Opportunistic account-tag refresh (Phase 2 §5.1): if account-tag is present
      // on this message, update the tracker so future messages (which may lack the tag)
      // still benefit from the known account. The tracker is updated BEFORE normalization
      // so the normalizer reads the freshest state.
      if (event.account) {
        if (event.account !== "*") {
          rt.accountTracker.setAccount(event.nick, event.account, rt.casemapping);
        } else {
          rt.accountTracker.clearAccount(event.nick, rt.casemapping);
        }
      }

      const ctx: IrcNormalizerContext = {
        accountId: rt.accountId,
        networkId: rt.networkName,
        selfNick: rt.nick,
        casemapping: rt.casemapping,
        accountTracker: rt.accountTracker,
        selfAccount: rt.config.sasl_user,
      };
      const inbound = normalizeIrcMessage(
        {
          nick: event.nick,
          ident: event.ident,
          hostname: event.hostname,
          target: event.target,
          message: event.message,
          tags: event.tags,
          time: event.time,
          account: event.account,
          isAction: false,
          isNotice: false,
        },
        ctx,
      );
      this.applyTriggerHoldOrEmit(inbound);
      // Phase 3: upsert room_metadata so serverIdsFor returns the network id.
      if (!isDm) {
        this.emitChannelMetadata(rt, inbound.timelineKey, event.target);
      }
    });

    // ── action ────────────────────────────────────────────────────────────────
    client.on("action", (event) => {
      if (this.stopped || !rt.registered || !rt.networkIdFrozen) return;
      if (event.from_server) return;

      const isSelfEcho =
        casefold(event.nick, rt.casemapping) ===
        casefold(rt.nick, rt.casemapping);
      if (isSelfEcho) return; // Actions are not echoed in the echo-merge path

      const isDm = !isChannelTarget(event.target);
      if (isDm && rt.config.dm_enabled === false) return;

      // Opportunistic account-tag refresh (same as privmsg path above).
      if (event.account) {
        if (event.account !== "*") {
          rt.accountTracker.setAccount(event.nick, event.account, rt.casemapping);
        } else {
          rt.accountTracker.clearAccount(event.nick, rt.casemapping);
        }
      }

      const ctx: IrcNormalizerContext = {
        accountId: rt.accountId,
        networkId: rt.networkName,
        selfNick: rt.nick,
        casemapping: rt.casemapping,
        accountTracker: rt.accountTracker,
        selfAccount: rt.config.sasl_user,
      };
      const inbound = normalizeIrcMessage(
        {
          nick: event.nick,
          ident: event.ident,
          hostname: event.hostname,
          target: event.target,
          message: event.message,
          tags: event.tags,
          time: event.time,
          account: event.account,
          isAction: true,
          isNotice: false,
        },
        ctx,
      );
      this.applyTriggerHoldOrEmit(inbound);
      // Phase 3: upsert room_metadata so serverIdsFor returns the network id.
      if (!isDm) {
        this.emitChannelMetadata(rt, inbound.timelineKey, event.target);
      }
    });

    // ── notice ────────────────────────────────────────────────────────────────
    client.on("notice", (event) => {
      if (this.stopped || !rt.registered || !rt.networkIdFrozen) return;
      if (event.from_server) return;

      // Per spec §7.5:
      //   Channel notices → ingest (no trigger).
      //   Query notices (DM) → do NOT ingest.
      if (!isChannelTarget(event.target)) return;

      // Opportunistic account-tag refresh (same as privmsg/action paths): update
      // tracker before ctx construction so future messages without account-tag
      // resolve to the same identity (spec §5.1 "per-message tag ALWAYS wins").
      if (event.account) {
        if (event.account !== "*") {
          rt.accountTracker.setAccount(event.nick, event.account, rt.casemapping);
        } else {
          rt.accountTracker.clearAccount(event.nick, rt.casemapping);
        }
      }

      const ctx: IrcNormalizerContext = {
        accountId: rt.accountId,
        networkId: rt.networkName,
        selfNick: rt.nick,
        casemapping: rt.casemapping,
        accountTracker: rt.accountTracker,
        selfAccount: rt.config.sasl_user,
      };
      const inbound = normalizeIrcMessage(
        {
          nick: event.nick,
          ident: event.ident,
          hostname: event.hostname,
          target: event.target,
          message: event.message,
          tags: event.tags,
          time: event.time,
          account: event.account,
          isAction: false,
          isNotice: true,
        },
        ctx,
      );
      this.host?.onEvent(inbound);
      // Phase 3: channel notices are always channel-targeted (DMs filtered above).
      this.emitChannelMetadata(rt, inbound.timelineKey, event.target);
    });

    // ── cap del (cap withdrawn mid-connection) ────────────────────────────────
    client.on("cap del", (event) => {
      if (this.stopped || !rt.registered) return;
      for (const cap of Object.keys(event.capabilities)) {
        if ((FLOOR_CAPS as readonly string[]).includes(cap)) {
          // Fatal — cap withdrawn mid-connection; enter NORMAL RECONNECT path
          // (spec §3.1). quit() sets requested_disconnect=true internally, so
          // the library will NOT auto-reconnect; instead the 'close' handler
          // (below) detects capDelReconnect and calls connect() explicitly.
          this.host?.onError(
            new Error(
              `irc account "${rt.accountId}": required capability "${cap}" was withdrawn ` +
                "mid-connection — reconnecting",
            ),
            { accountId: rt.accountId, phase: "cap_del" },
          );
          rt.registered = false;
          rt.capFailed = false; // Allow re-validation on next connect.
          rt.capDelReconnect = true; // Signal 'close' handler to reconnect.
          this.drainPendingEchoes(rt);
          try {
            rt.client.quit("required cap withdrawn");
          } catch {
            // Best-effort — socket may already be gone.
          }
          break;
        }
      }
    });

    // ── nick (NICK rename — any user, including our own) ─────────────────────
    client.on("nick", (event) => {
      // networkIdFrozen gate: a rename in the 001→005 window would otherwise
      // mint a user_identities row scoped to the pre-freeze host value.
      if (!rt.registered || !rt.networkIdFrozen) return;
      const isOwnNick =
        casefold(event.nick, rt.casemapping) === casefold(rt.nick, rt.casemapping);

      // 1. Move tracked account association from old nick to new nick (Phase 2).
      rt.accountTracker.renameNick(event.nick, event.new_nick, rt.casemapping);
      // 2. Move roster entries across all channels (Phase 3).
      rt.rosterTracker.renameNick(event.nick, event.new_nick, rt.casemapping);

      if (isOwnNick) {
        // Own nick change (server rename, e.g. Guest12345): update rt.nick and
        // self-identity. Self-id remains the SASL account name when configured
        // (stable across renames), or switches to the new casemapped nick.
        rt.nick = event.new_nick;
        const selfAccount = rt.config.sasl_user;
        const selfBareId = selfAccount ? selfAccount : casefold(rt.nick, rt.casemapping);
        rt.self = { id: scopeIrcId(rt.networkName, selfBareId), username: rt.nick };
        // Re-learn hostmask (budget recomputed for new nick length).
        this.learnHostmask(rt);
      } else {
        // Other user's rename: upsert their identity row so the new nick is
        // recorded as username (spec §5.4 / §5.3 alias history). The identity key
        // is their scoped account name when known, else the scoped old casemapped nick.
        const bareKey =
          rt.accountTracker.getAccount(event.new_nick, rt.casemapping) ??
          casefold(event.nick, rt.casemapping);
        const identityKey = scopeIrcId(rt.networkName, bareKey);
        void this.callbacks
          ?.upsertUserIdentity({
            provider: "irc",
            userId: identityKey,
            username: event.new_nick,
            observedAt: event.time ?? Date.now(),
          })
          .catch(() => {});
      }
    });

    // ── user updated (CHGHOST / SETNAME) ─────────────────────────────────────
    // irc-framework emits 'user updated' for CHGHOST when enable_chghost is true
    // (commands/handlers/user.js:48). When the bot's own hostmask changes (vhost or
    // cloak applied by the server), recompute the byte budget via learnHostmask(rt).
    // Per spec §7.1: "recomputing it if the server later changes the bot's hostmask".
    client.on("user updated", (event) => {
      if (!rt.registered) return;
      // Only react to our own hostmask changes; ignore changes for other users.
      if (casefold(event.nick, rt.casemapping) === casefold(rt.nick, rt.casemapping)) {
        this.learnHostmask(rt);
      }
    });

    // ── join (extended-join account tracking + roster update + WHOX on self-join) ──
    // extended-join: when the cap is enabled, JOIN carries an account field.
    // The library maps the protocol's "*" (not identified) → JavaScript false.
    // When the cap is absent, the field is undefined — no information; skip.
    //
    // On our OWN join: issue WHO for the channel to bulk-populate accounts via
    // WHOX (the library uses WHOX automatically when the server advertises the
    // WHOX ISUPPORT token). Non-WHOX WHO responses will have account=undefined
    // in the user objects and AccountTracker.bulkUpdateFromWhox will skip them.
    client.on("join", (event) => {
      if (!rt.registered) return;

      const isSelfJoin =
        casefold(event.nick, rt.casemapping) === casefold(rt.nick, rt.casemapping);

      // Update account tracker from extended-join (any user, including self).
      if (event.account !== undefined) {
        if (event.account && event.account !== "*") {
          rt.accountTracker.setAccount(event.nick, event.account, rt.casemapping);
        } else {
          // false (or defensive "*") → not identified; clear any stale entry.
          rt.accountTracker.clearAccount(event.nick, rt.casemapping);
        }
      }

      // Update roster: add the joining member (Phase 3).
      rt.rosterTracker.addMember(event.channel, event.nick, rt.casemapping);

      if (isSelfJoin) {
        // Issue WHO for the channel: bulk-populate account tracker from WHOX
        // (or plain WHO — the library handles both; WHOX is used when supported).
        // who() is a synchronous enqueue and never throws; server rejections arrive
        // as numerics and simply produce no callback.
        rt.client.who(event.channel, (whoEvent) => {
          rt.accountTracker.bulkUpdateFromWhox(whoEvent.users, rt.casemapping);
        });
      }
    });

    // ── userlist (NAMES reply, Phase 3) ──────────────────────────────────────
    // Fires when RPL_ENDOFNAMES arrives. Reinitialises the roster for the channel
    // from the full member list (including mode prefixes stripped by the library).
    client.on("userlist", (event) => {
      if (!rt.registered) return;
      rt.rosterTracker.initChannel(event.channel, event.users, rt.casemapping);
    });

    // ── part (Phase 3 roster update) ─────────────────────────────────────────
    // Remove the parting user from this channel's roster.
    // Per AccountTracker pruning docs: PART does NOT prune nick→account (user may
    // still be in other served channels). Roster tracker removes from this channel only.
    client.on("part", (event) => {
      if (!rt.registered) return;
      rt.rosterTracker.removeMember(event.channel, event.nick, rt.casemapping);
    });

    // ── kick (Phase 3 roster update) ─────────────────────────────────────────
    // Remove the kicked user from the channel roster. Also check if we were kicked
    // (self-kick): irc-framework auto-rejoins by default on KICK? No — it does NOT
    // auto-rejoin on KICK; that's the operator's job. Simply remove from roster.
    client.on("kick", (event) => {
      if (!rt.registered) return;
      rt.rosterTracker.removeMember(event.channel, event.kicked, rt.casemapping);
    });

    // ── topic (Phase 3 channel info tracking) ────────────────────────────────
    // Fired for: RPL_TOPIC (332, on channel join), RPL_NOTOPIC (331), TOPIC command.
    // Update the per-channel topic cache.
    client.on("topic", (event) => {
      const key = casefold(event.channel, rt.casemapping);
      const existing = rt.channelData.get(key) ?? {};
      rt.channelData.set(key, { ...existing, topic: event.topic || undefined });
    });

    // ── away / back (away-notify, Phase 3 roster freshness) ──────────────────
    // When away-notify is active, the server sends AWAY messages when visible
    // users change their away state. Update roster tracker accordingly.
    client.on("away", (event) => {
      if (!rt.registered) return;
      rt.rosterTracker.setAway(event.nick, rt.casemapping);
    });

    client.on("back", (event) => {
      if (!rt.registered) return;
      rt.rosterTracker.setBack(event.nick, rt.casemapping);
    });

    // ── account (account-notify: user logged in or out of services) ───────────
    // The library maps "*" → false; a string is the account name on login.
    client.on("account", (event) => {
      if (!rt.registered) return;
      if (event.account && event.account !== "*") {
        // User identified to services.
        rt.accountTracker.setAccount(event.nick, event.account, rt.casemapping);
      } else {
        // User logged out (account === false from library, or defensive "*").
        rt.accountTracker.clearAccount(event.nick, rt.casemapping);
      }
    });

    // ── quit (prune tracked state) ────────────────────────────────────────────
    // QUIT means the user has disconnected from the network entirely — definitely
    // no longer visible in any served channel. Per AccountTracker pruning docs:
    // PART does NOT prune (user may still be in other served channels).
    client.on("quit", (event) => {
      if (!rt.registered) return;
      rt.accountTracker.removeNick(event.nick, rt.casemapping);
      // Phase 3: remove from all channel rosters.
      rt.rosterTracker.removeNick(event.nick, rt.casemapping);
    });

    // ── socket error ──────────────────────────────────────────────────────────
    client.on("socket error", (err) => {
      this.host?.onError(err, { accountId: rt.accountId, phase: "socket" });
    });
  }

  // ── Floor cap validation ─────────────────────────────────────────────────────

  /** Returns true when all floor caps are present; false (+ logs error) when not. */
  private validateFloorCaps(rt: AccountRuntime): boolean {
    if (rt.capFailed) {
      // Already failed before — silently quit again without re-logging.
      try {
        rt.client.quit("required cap not supported");
      } catch {
        /* best-effort */
      }
      return false;
    }

    const enabled = rt.client.network.cap.enabled;
    const hasSasl =
      !rt.config.sasl_user || !rt.config.sasl_password || enabled.includes("sasl");

    // Check the three always-required caps.
    for (const cap of FLOOR_CAPS) {
      if (!enabled.includes(cap)) {
        const errMsg =
          `irc account "${rt.accountId}": server ${rt.config.host} does not advertise ` +
          `required capability "${cap}" — mikuswarm requires a modern IRCv3 server ` +
          "(Solanum, InspIRCd, UnrealIRCd, Ergo or equivalent)";
        rt.capFailed = true;
        this.host?.onError(new Error(errMsg), {
          accountId: rt.accountId,
          phase: "floor_cap_validation",
        });
        try {
          rt.client.quit("required cap not supported");
        } catch {
          /* best-effort */
        }
        return false;
      }
    }

    // Check SASL when credentials are configured.
    if (!hasSasl) {
      const errMsg =
        `irc account "${rt.accountId}": server ${rt.config.host} does not advertise ` +
        `required capability "sasl" — mikuswarm requires a modern IRCv3 server ` +
        "(Solanum, InspIRCd, UnrealIRCd, Ergo or equivalent)";
      rt.capFailed = true;
      this.host?.onError(new Error(errMsg), {
        accountId: rt.accountId,
        phase: "floor_cap_validation",
      });
      try {
        rt.client.quit("required cap not supported");
      } catch {
        /* best-effort */
      }
      return false;
    }

    return true;
  }

  // ── WHOIS helper (Phase 3) ────────────────────────────────────────────────────

  /**
   * Issue a WHOIS for `nick` and return the result when RPL_ENDOFWHOIS arrives.
   * Returns `undefined` on error (socket not connected, library throws, etc.).
   * Resolves with the event object from irc-framework; `event.error === "not_found"`
   * when the nick does not exist on the network.
   */
  private doWhois(rt: AccountRuntime, nick: string): Promise<IrcWhoisResult | undefined> {
    // The library's whois() listener only fires on RPL_ENDOFWHOIS; if the
    // connection drops mid-query the reply never arrives and the promise would
    // never settle, hanging the awaiting tool call. Bound it with a timeout.
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), WHOIS_TIMEOUT_MS);
      try {
        rt.client.whois(nick, (event) => {
          clearTimeout(timer);
          resolve(event as IrcWhoisResult);
        });
      } catch {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  // ── Channel metadata upsert helper (Phase 3) ───────────────────────────────────

  /**
   * Fire-and-forget upsert of room_metadata for an IRC channel.
   * Called from the inbound privmsg/action/notice paths so the network id
   * (rt.networkName → serverId) lands in room_metadata, making serverIdsFor()
   * return the correct value for per-user-limits partitioning (spec §7.4 / §10).
   */
  private emitChannelMetadata(rt: AccountRuntime, timelineKey: string, channelName: string): void {
    if (!this.callbacks?.setChannelMetadata) return;
    void this.callbacks.setChannelMetadata(timelineKey, {
      displayName: channelName,
      serverId: rt.networkName,
      serverName: rt.networkName,
    }).catch(() => {});
  }

  // ── Hostmask learning ─────────────────────────────────────────────────────────

  private learnHostmask(rt: AccountRuntime): void {
    try {
      rt.client.who(rt.nick, (event) => {
        const user = event.users.find(
          (u) =>
            casefold(u.nick, rt.casemapping) ===
            casefold(rt.nick, rt.casemapping),
        );
        if (user) {
          rt.username = user.ident;
          rt.host = user.hostname;
        }
      });
    } catch {
      // WHO may not be available on all servers; byte budget falls back to static.
    }
  }

  // ── Echo-merge ──────────────────────────────────────────────────────────────

  /**
   * Handle an inbound self-echo (privmsg where sender === selfNick).
   * Resolves the matching pending echo promise and also delivers the event to
   * the host with `isSelf: true` for timeline storage.
   */
  private handleSelfEcho(
    rt: AccountRuntime,
    event: IrcFramework.PrivmsgEvent,
    _isAction: boolean,
  ): void {
    let resolvedId: string | undefined;

    if (rt.hasLabeledResponse) {
      const label = event.tags["label"];
      if (label) {
        const pending = rt.pendingByLabel.get(label);
        if (pending) {
          clearTimeout(pending.timer);
          rt.pendingByLabel.delete(label);
          const msgid = event.tags["msgid"];
          resolvedId = msgid || pending.syntheticId;
          pending.resolve(resolvedId);
        }
      }
    } else {
      // FIFO: find the first pending for this target+body pair.
      const key = casefold(event.target, rt.casemapping);
      const queue = rt.echoQueues.get(key);
      if (queue && queue.length > 0) {
        const pending = queue[0]!;
        if (pending.body === event.message) {
          queue.shift();
          if (queue.length === 0) rt.echoQueues.delete(key);
          clearTimeout(pending.timer);
          const msgid = event.tags["msgid"];
          resolvedId = msgid || pending.syntheticId;
          pending.resolve(resolvedId);
        }
      }
    }

    // Deliver the echo event to the host for timeline storage (isSelf: true).
    const ctx: IrcNormalizerContext = {
      accountId: rt.accountId,
      networkId: rt.networkName,
      selfNick: rt.nick,
      casemapping: rt.casemapping,
      accountTracker: rt.accountTracker,
      selfAccount: rt.config.sasl_user,
    };
    const msgid = event.tags["msgid"];
    const externalId = resolvedId ?? msgid ?? syntheticMsgId(rt.accountId, event.time, rt.nick);

    const inbound = normalizeIrcMessage(
      {
        nick: event.nick,
        ident: event.ident,
        hostname: event.hostname,
        target: event.target,
        message: event.message,
        tags: { ...event.tags, msgid: externalId },
        time: event.time,
        account: event.account,
        isAction: false,
        isNotice: false,
      },
      ctx,
    );
    this.host?.onEvent(inbound);
  }

  // ── Chunk sending + echo awaiting ────────────────────────────────────────────

  private sendChunk(
    rt: AccountRuntime,
    ircTarget: string,
    chunk: string,
    accountId: string,
  ): Promise<string> {
    const synId = syntheticMsgId(accountId, Date.now(), rt.nick);

    return new Promise<string>((resolve) => {
      let resolved = false;
      const done = (id: string) => {
        if (resolved) return;
        resolved = true;
        resolve(id);
      };

      const timer = setTimeout(() => {
        // Echo timeout — resolve with synthetic id and clean up.
        if (rt.hasLabeledResponse) {
          for (const [label, pending] of rt.pendingByLabel) {
            if (pending.syntheticId === synId) {
              rt.pendingByLabel.delete(label);
              break;
            }
          }
        } else {
          const key = casefold(ircTarget, rt.casemapping);
          const queue = rt.echoQueues.get(key);
          if (queue) {
            const idx = queue.findIndex((p) => p.syntheticId === synId);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) rt.echoQueues.delete(key);
          }
        }
        done(synId);
      }, ECHO_TIMEOUT_MS);

      const pending: PendingEcho = {
        target: ircTarget,
        body: chunk,
        syntheticId: synId,
        resolve: done,
        timer,
      };

      if (rt.hasLabeledResponse) {
        const label = nanoid(12);
        rt.pendingByLabel.set(label, pending);
        try {
          rt.client.say(ircTarget, chunk, { label });
        } catch (err) {
          clearTimeout(timer);
          rt.pendingByLabel.delete(label);
          done(synId);
        }
      } else {
        const key = casefold(ircTarget, rt.casemapping);
        let queue = rt.echoQueues.get(key);
        if (!queue) {
          queue = [];
          rt.echoQueues.set(key, queue);
        }
        queue.push(pending);
        try {
          rt.client.say(ircTarget, chunk);
        } catch (err) {
          clearTimeout(timer);
          const idx = queue.indexOf(pending);
          if (idx !== -1) queue.splice(idx, 1);
          done(synId);
        }
      }
    });
  }

  // ── Trigger hold (spec §7.5, mirrors Matrix/Discord providers) ───────────────

  /**
   * Dispatch an inbound event, applying the trigger-hold debounce when
   * `trigger_hold_ms` is non-zero and the event carries a trigger (spec §7.5).
   *
   * With default (trigger_hold_ms absent or 0) the call is byte-identical to
   * `this.host?.onEvent(inbound)`.
   */
  private applyTriggerHoldOrEmit(inbound: import("../types.js").InboundChatEvent): void {
    const holdMs = this.config.trigger_hold_ms ?? 0;

    if (!inbound.trigger || !holdMs) {
      this.host?.onEvent(inbound);
      return;
    }

    const key = inbound.timelineKey;
    const existing = this.pendingTriggers.get(key);

    if (existing) {
      // Extend hold — reset timer, but cap total hold at MULTIPLIER × holdMs
      // from the first trigger so a steady drip cannot extend indefinitely.
      clearTimeout(existing.timer);
      const now = Date.now();
      const startedAt = existing.event.trigger?.holdStartedAt ?? now;
      const maxEnd = startedAt + holdMs * TRIGGER_HOLD_MAX_MULTIPLIER;
      const remaining = Math.max(0, Math.min(holdMs, maxEnd - now));
      existing.event = inbound;
      existing.timer = setTimeout(() => {
        this.pendingTriggers.delete(key);
        if (!this.stopped) this.host?.onEvent(existing.event);
      }, remaining);
      return;
    }

    // New hold.
    if (inbound.trigger) {
      inbound.trigger.holdStartedAt = Date.now();
    }
    const pending: PendingTrigger = { event: inbound, timer: undefined! };
    pending.timer = setTimeout(() => {
      this.pendingTriggers.delete(key);
      if (!this.stopped) this.host?.onEvent(pending.event);
    }, holdMs);
    this.pendingTriggers.set(key, pending);
  }

  /** Drain all pending echo promises with their synthetic ids (on disconnect). */
  private drainPendingEchoes(rt: AccountRuntime): void {
    for (const queue of rt.echoQueues.values()) {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.resolve(pending.syntheticId);
      }
    }
    rt.echoQueues.clear();
    for (const [, pending] of rt.pendingByLabel) {
      clearTimeout(pending.timer);
      pending.resolve(pending.syntheticId);
    }
    rt.pendingByLabel.clear();
  }
}
