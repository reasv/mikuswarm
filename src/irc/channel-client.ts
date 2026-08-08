/**
 * IrcChannelClient — per-target action surface for IRC (spec §7.1).
 *
 * IRC does not support reactions, polls, edits, deletes, pinning, or emoji
 * listing as server-side durable operations. All such methods throw immediately.
 *
 * `memberInfo()`, `members()`, `channelInfo()`, and `readMessages()` provide
 * basic stubs sufficient for the Phase 1 capability set; deep history and
 * roster tooling are deferred to later phases.
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

export interface IrcChannelClientOptions {
  /** IRC provider account id (the key from the config accounts record). */
  accountId: string;
  /** Channel name (with prefix) or DM nick. */
  target: string;
  /** Whether this is a DM (query) rather than a channel. */
  isDirect: boolean;
  /** Network name (for channel label construction). */
  networkName: string;
  /**
   * Resolve the current nick list for the target channel.
   * Called by `members()`; may be absent for DMs.
   */
  membersFn?(): Promise<MemberInfo[]>;
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

  // ── History (stub — deferred to later phase) ──────────────────────────

  readMessages(_req: HistoryPageRequest): Promise<HistoryPageResult> {
    return Promise.resolve({ messages: [] });
  }

  readMessage(_externalId: string) {
    return Promise.resolve(undefined);
  }

  // ── Member info ───────────────────────────────────────────────────────

  async memberInfo(userId: string): Promise<MemberInfo | undefined> {
    if (!this.opts.membersFn) return undefined;
    const list = await this.opts.membersFn();
    return list.find((m) => m.userId === userId);
  }

  async members(): Promise<SenderInfo[]> {
    if (this.opts.isDirect) return [];
    if (!this.opts.membersFn) return [];
    const list = await this.opts.membersFn();
    return list.map((m) => ({ id: m.userId, username: m.displayName, isSelf: m.isSelf }));
  }

  // ── Channel info ──────────────────────────────────────────────────────

  channelInfo(): Promise<ChannelInfo> {
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
