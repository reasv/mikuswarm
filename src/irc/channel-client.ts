/**
 * IrcChannelClient — per-target action surface for IRC (spec §7.6).
 *
 * IRC does not support reactions, polls, edits, deletes, pinning, or emoji
 * listing as server-side durable operations. All such methods throw immediately
 * or return empty results.
 *
 * `memberInfo()`, `members()`, and `channelInfo()` are the three live operations:
 *
 *   - `memberInfo(id)` — WHOIS-backed: issues WHOIS by nick (resolved from id via
 *     the account→nick reverse lookup when id is a services account name, otherwise
 *     treated as a nick directly). Maps the WHOIS response to MemberInfo.
 *   - `members()` — roster-backed: returns the current channel roster from
 *     RosterTracker, enriched with account ids from AccountTracker.
 *   - `channelInfo()` — topic + member count from tracked state.
 *
 * Spec: IRC-SUPPORT-DESIGN §7.6
 */

import type {
  ChannelClient,
  ChannelInfo,
  EmojiEntry,
  HistoryPageRequest,
  HistoryPageResult,
  MemberInfo,
  PinnedMessage,
  ReactionListing,
  SenderInfo,
} from "../types.js";

function notSupported(op: string): never {
  throw new Error(`IRC does not support ${op}`);
}

/**
 * Whois result shape as emitted by irc-framework (assembled from RPL_WHOISUSER,
 * RPL_WHOISACCOUNT, RPL_AWAY, RPL_WHOISCHANNELS). All fields are optional because
 * the object is assembled piecemeal across multiple numeric replies; any field
 * absent means the corresponding numeric was not sent by the server.
 */
export interface IrcWhoisResult {
  nick?: string;
  ident?: string;
  hostname?: string;
  real_name?: string;
  /** Away message string when the user is currently away. Absent when not away. */
  away?: string;
  /**
   * Raw RPL_WHOISCHANNELS string, e.g. `"@#general +#other"`.
   * Each token is `<prefixes><channel>`.
   */
  channels?: string;
  /** Services account name from RPL_WHOISACCOUNT (330). */
  account?: string;
  /** "not_found" when the nick doesn't exist (set by the library at RPL_ENDOFWHOIS). */
  error?: string;
}

export interface IrcChannelClientOptions {
  /** IRC provider account id (the key from the config accounts record). */
  accountId: string;
  /** Channel name (with prefix, e.g. "#general") or DM nick. */
  target: string;
  /** Whether this is a DM (query) rather than a channel. */
  isDirect: boolean;
  /** Network name (for channel label construction). */
  networkName: string;
  /**
   * Return the current roster members for the target channel.
   * Members carry: id (account or casemapped nick), username (current nick),
   * isSelf flag. Called by `members()`.
   * Absent for DMs or when the provider cannot provide roster data.
   */
  membersFn?(): Promise<SenderInfo[]>;
  /**
   * Resolve a member info entry for a given id (account name or nick).
   * Called by `memberInfo(id)`.
   */
  memberInfoFn?(id: string): Promise<MemberInfo | undefined>;
  /**
   * Return the current channel info (topic, member count, etc.).
   * Called by `channelInfo()`.
   */
  channelInfoFn?(): Promise<ChannelInfo>;
}

export class IrcChannelClient implements ChannelClient {
  private readonly opts: IrcChannelClientOptions;

  constructor(opts: IrcChannelClientOptions) {
    this.opts = opts;
  }

  // ── Unsupported ──────────────────────────────────────────────────────────

  react(): Promise<never> {
    return Promise.resolve(notSupported("reactions"));
  }
  unreact(): Promise<never> {
    return Promise.resolve(notSupported("reactions"));
  }
  listReactions(): Promise<ReactionListing> {
    return Promise.resolve(notSupported("reactions"));
  }
  editMessage(): Promise<never> {
    return Promise.resolve(notSupported("message editing"));
  }
  deleteMessage(): Promise<never> {
    return Promise.resolve(notSupported("message deletion"));
  }
  pins(): Promise<PinnedMessage[]> {
    return Promise.resolve(notSupported("pins"));
  }
  pinMessage(): Promise<never> {
    return Promise.resolve(notSupported("pinning"));
  }
  unpinMessage(): Promise<never> {
    return Promise.resolve(notSupported("unpinning"));
  }
  emojiList(): Promise<EmojiEntry[]> {
    return Promise.resolve([]);
  }

  // ── History (stub — deferred to later phase) ─────────────────────────────

  readMessages(_req: HistoryPageRequest): Promise<HistoryPageResult> {
    return Promise.resolve({ messages: [] });
  }

  readMessage(_externalId: string) {
    return Promise.resolve(undefined);
  }

  // ── Member info ──────────────────────────────────────────────────────────

  /**
   * Look up a member by id (services account name or nick).
   *
   * Resolution ladder (spec §7.6):
   *   1. If `memberInfoFn` is available, delegate (it handles account→nick resolution
   *      via tracked state, then issues WHOIS by nick).
   *   2. Fall back to a basic roster lookup (no WHOIS).
   */
  async memberInfo(id: string): Promise<MemberInfo | undefined> {
    if (this.opts.memberInfoFn) {
      return this.opts.memberInfoFn(id);
    }
    // Fallback: check members() for a matching entry.
    if (!this.opts.isDirect && this.opts.membersFn) {
      const list = await this.opts.membersFn();
      const match = list.find((m) => m.id === id || m.username === id);
      if (match) {
        return {
          userId: match.id,
          displayName: match.username,
          isSelf: Boolean(match.isSelf),
          isDirect: false,
        };
      }
    }
    return undefined;
  }

  /**
   * Return the current members of the channel.
   *
   * Each entry follows the identity ladder (spec §5.1):
   *   - `id`       = services account when known; casemapped nick otherwise.
   *   - `username` = current nick (display identity; always the nick).
   */
  async members(): Promise<SenderInfo[]> {
    if (this.opts.isDirect) return [];
    if (!this.opts.membersFn) return [];
    return this.opts.membersFn();
  }

  // ── Channel info ─────────────────────────────────────────────────────────

  /**
   * Return current channel info.
   * Delegates to `channelInfoFn` when available (uses tracked topic/mode/count).
   * Falls back to a minimal static description when the channel info function
   * is not wired (e.g. DMs or stubs without a registered runtime).
   */
  channelInfo(): Promise<ChannelInfo> {
    if (this.opts.channelInfoFn) {
      return this.opts.channelInfoFn();
    }
    // Static fallback.
    const label = this.opts.isDirect
      ? `${this.opts.target} (${this.opts.networkName} DM)`
      : `${this.opts.target} (${this.opts.networkName})`;
    return Promise.resolve({
      label,
      displayName: this.opts.target,
      channelId: this.opts.target,
      serverName: this.opts.networkName,
      isDirect: this.opts.isDirect,
    });
  }
}
