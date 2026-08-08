/**
 * IrcProvider — Phase 1 + Phase 2 implementation.
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
 * Spec: IRC-SUPPORT-DESIGN
 *   §3 (caps), §4 (timeline keys), §5 (identity), §6 (capabilities),
 *   §7 (send/echo/reconnect), §7.5 (inbound pipeline), §8 (config).
 */

import IrcFramework from "irc-framework";
import { nanoid } from "nanoid";
import { parseTimelineKey } from "../storage/timeline-key.js";
import type {
  ChannelClient,
  ChatProviderHost,
  DeliveryReceipt,
  EnrichmentCapabilities,
  IChatProvider,
  OutboundMessage,
  OutboundTarget,
  ProviderCapabilities,
  SelfIdentity,
} from "../types.js";
import type { IrcAccountConfig, IrcConfig } from "../config/schema.js";
import type { UserIdentityUpsertInput } from "../storage/database.js";
import {
  casefold,
  chunkIrcMessage,
  computeByteBudget,
  isChannelTarget,
  normalizeIrcMessage,
  STATIC_MAX_CHARS,
  syntheticMsgId,
  type IrcNormalizerContext,
} from "./normalizer.js";
import { IrcChannelClient } from "./channel-client.js";
import { AccountTracker } from "./account-tracker.js";

// ── IrcProviderCallbacks ──────────────────────────────────────────────────────

/**
 * Callbacks injected at construction time for operations that need storage access.
 *
 * Follows the same pattern as {@link DiscordProviderCallbacks}: the provider is
 * constructed before storage is available, and the callbacks bridge that gap.
 * All callbacks are fire-and-forget (void) from the provider's perspective.
 *
 * Phase 2: only `upsertUserIdentity` is needed. Per-message identity upserts
 * flow automatically via the generic `handleInbound` path in app.ts (which checks
 * `sender.username`); this callback is only invoked for out-of-band identity
 * events such as NICK renames (where no message event fires).
 */
export interface IrcProviderCallbacks {
  /**
   * Upsert a user identity row (spec §5.3).
   * Called on NICK renames to record the old nick as an alias.
   * Per-message upserts are handled by the generic ingest path in app.ts.
   */
  upsertUserIdentity(input: UserIdentityUpsertInput): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How often to refresh the typing indicator (IRC clients clear after ~30s;
 *  we refresh much more often to be safe on both strict and lenient servers). */
const TYPING_REFRESH_MS = 8_000;

/** Maximum hold-extension multiplier for trigger_hold_ms. */
const TRIGGER_HOLD_MAX_MULTIPLIER = 4;

/** Timeout for awaiting an echo before falling back to the synthetic id. */
const ECHO_TIMEOUT_MS = 5_000;

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

    // Determine IRC target string: channel name or DM nick from channelId.
    const ircTarget = parsed.channelId;

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

    const ircTarget = parsed.channelId;
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
   * Permissive shape test for IRC user ids.
   * Per spec §5.1 Phase 1: id = casemapped nick.
   * A valid IRC user id is: non-empty, no whitespace or NUL, not @-prefixed, not all-digit.
   */
  ownsUserId(id: string): boolean {
    if (!id) return false;
    if (/[\s\0]/.test(id)) return false;
    if (id.startsWith("@")) return false;
    if (/^\d+$/.test(id)) return false;
    return true;
  }

  // ── IChatProvider.channelClient ───────────────────────────────────────────

  channelClient(target: OutboundTarget): ChannelClient | undefined {
    const parsed = parseTimelineKey(target.timelineKey);
    if (!parsed || parsed.provider !== "irc") return undefined;
    const rt = this.accounts.get(parsed.accountId);
    if (!rt) return undefined;

    const isDirect = parsed.kind === "dm";

    return new IrcChannelClient({
      accountId: parsed.accountId,
      target: parsed.channelId,
      isDirect,
      networkName: rt.networkName,
    });
  }

  // ── IChatProvider.enrichment ──────────────────────────────────────────────

  enrichment(_accountId: string): EnrichmentCapabilities | undefined {
    // IRC has no media upload or attachment capability; no enrichment.
    return undefined;
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
      nick: config.nick,
      username: config.username ?? config.nick,
      host: "",
      hasLabeledResponse: false,
      hasMsgid: false,
      echoQueues: new Map(),
      pendingByLabel: new Map(),
      accountTracker: new AccountTracker(),
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

      // Casemapping from ISUPPORT.
      const casemapping = rt.client.network.supports("CASEMAPPING");
      if (typeof casemapping === "string" && casemapping) {
        rt.casemapping = casemapping.toLowerCase();
      }

      // Network name from ISUPPORT.
      const networkName = rt.client.network.supports("NETWORK");
      if (typeof networkName === "string" && networkName) {
        rt.networkName = networkName.toLowerCase();
      }

      // Self identity (Phase 2 ladder §5.1): SASL account name when configured
      // (stable across nick changes), else casemapped nick.
      const selfAccount = rt.config.sasl_user;
      const selfId = selfAccount ? selfAccount : casefold(rt.nick, rt.casemapping);
      rt.self = { id: selfId, username: rt.nick };

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

    // ── socket close (every disconnect, including auto-reconnect windows) ────────
    // The library emits 'socket close' on EVERY disconnect; 'close' is emitted only
    // when it gives up reconnecting (connection.js:111/141). Without this handler,
    // rt.registered stays true during auto-reconnect windows → send() writes to a
    // dead socket, connection.write returns false silently, and after the 5s echo
    // timeout a synthetic receipt is fabricated for a never-delivered message.
    client.on("socket close", () => {
      rt.registered = false;
      // Clear stale nick→account mappings: a user may have logged out of services
      // while we were disconnected, and no WHOX fires for absent nicks on reconnect.
      // WHOX-on-self-join repopulates channel members; per-message account-tag
      // repopulates on first message — correct per spec §5.1 ladder.
      rt.accountTracker.clear();
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
      if (this.stopped || !rt.registered) return;
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
    });

    // ── action ────────────────────────────────────────────────────────────────
    client.on("action", (event) => {
      if (this.stopped || !rt.registered) return;
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
    });

    // ── notice ────────────────────────────────────────────────────────────────
    client.on("notice", (event) => {
      if (this.stopped || !rt.registered) return;
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
      if (!rt.registered) return;
      const isOwnNick =
        casefold(event.nick, rt.casemapping) === casefold(rt.nick, rt.casemapping);

      // 1. Move tracked account association from old nick to new nick (Phase 2).
      rt.accountTracker.renameNick(event.nick, event.new_nick, rt.casemapping);

      if (isOwnNick) {
        // Own nick change (server rename, e.g. Guest12345): update rt.nick and
        // self-identity. Self-id remains the SASL account name when configured
        // (stable across renames), or switches to the new casemapped nick.
        rt.nick = event.new_nick;
        const selfAccount = rt.config.sasl_user;
        const selfId = selfAccount ? selfAccount : casefold(rt.nick, rt.casemapping);
        rt.self = { id: selfId, username: rt.nick };
        // Re-learn hostmask (budget recomputed for new nick length).
        this.learnHostmask(rt);
      } else {
        // Other user's rename: upsert their identity row so the new nick is
        // recorded as username (spec §5.4 / §5.3 alias history). The identity key
        // is their account name when known, else the old casemapped nick.
        const identityKey =
          rt.accountTracker.getAccount(event.new_nick, rt.casemapping) ??
          casefold(event.nick, rt.casemapping);
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

    // ── join (extended-join account tracking + WHOX on self-join) ────────────
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
