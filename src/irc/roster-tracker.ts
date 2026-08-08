/**
 * Per-channel member roster tracker for IRC (spec IRC-SUPPORT-DESIGN §7.6).
 *
 * Tracks the set of users currently present in each served channel. Updated by:
 *   - `userlist` (NAMES reply, emitted as RPL_ENDOFNAMES): reinitialises the
 *     roster for the channel from the full member list including modes.
 *   - `join`: adds a new member.
 *   - `part`: removes a member from a specific channel.
 *   - `quit`: removes a member from all channels.
 *   - `nick`: renames a member in all channels.
 *   - `away` (away-notify cap): marks a member away in all channels.
 *   - `back` (away-notify cap): marks a member not-away in all channels.
 *   - `kick`: removes the kicked member from a channel.
 *
 * The tracker works with casemapped keys internally (keys in the channel map and
 * in per-channel member maps are casemapped). Original-case nicks are preserved in
 * the `nick` field of each entry for display.
 *
 * Thread-safety: single-threaded JS event loop — no locking needed.
 */

import { casefold } from "./normalizer.js";

/** A tracked member in a channel. */
export interface RosterEntry {
  /** Current nick (original case, for display). */
  nick: string;
  /**
   * Mode letters active on this user in this channel.
   * E.g. `['o']` for op, `['v']` for voice, `['o', 'v']` for both.
   */
  modes: string[];
  /** True when away-notify indicates the user is away. */
  away: boolean;
}

export class RosterTracker {
  /**
   * channelKey (casemapped) → Map<casemappedNick, RosterEntry>
   */
  private readonly channels = new Map<string, Map<string, RosterEntry>>();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Reinitialise a channel's roster from a NAMES list.
   * Called when the `userlist` event fires (RPL_ENDOFNAMES).
   */
  initChannel(
    channel: string,
    users: ReadonlyArray<{ nick: string; modes: string[] }>,
    casemapping: string,
  ): void {
    const key = casefold(channel, casemapping);
    const members = new Map<string, RosterEntry>();
    for (const u of users) {
      members.set(casefold(u.nick, casemapping), {
        nick: u.nick,
        modes: u.modes.slice(),
        away: false,
      });
    }
    this.channels.set(key, members);
  }

  /**
   * Add a member to a channel on JOIN.
   * If the channel is not tracked (e.g. an unsolicited invite we accepted but
   * haven't received NAMES for yet), initialise it with just this member.
   */
  addMember(channel: string, nick: string, casemapping: string): void {
    const key = casefold(channel, casemapping);
    let members = this.channels.get(key);
    if (!members) {
      members = new Map();
      this.channels.set(key, members);
    }
    members.set(casefold(nick, casemapping), { nick, modes: [], away: false });
  }

  /**
   * Remove a member from a specific channel on PART or KICK.
   * No-op when the channel or member is not tracked.
   */
  removeMember(channel: string, nick: string, casemapping: string): void {
    const key = casefold(channel, casemapping);
    const members = this.channels.get(key);
    if (members) {
      members.delete(casefold(nick, casemapping));
    }
  }

  /**
   * Remove a member from all tracked channels on QUIT.
   */
  removeNick(nick: string, casemapping: string): void {
    const nickKey = casefold(nick, casemapping);
    for (const members of this.channels.values()) {
      members.delete(nickKey);
    }
  }

  /**
   * Rename a member in all tracked channels on NICK.
   * Preserves modes and away state.
   */
  renameNick(oldNick: string, newNick: string, casemapping: string): void {
    const oldKey = casefold(oldNick, casemapping);
    const newKey = casefold(newNick, casemapping);
    for (const members of this.channels.values()) {
      const entry = members.get(oldKey);
      if (entry !== undefined) {
        members.delete(oldKey);
        members.set(newKey, { ...entry, nick: newNick });
      }
    }
  }

  /**
   * Mark a member as away in all tracked channels (away-notify `away` event).
   */
  setAway(nick: string, casemapping: string): void {
    const nickKey = casefold(nick, casemapping);
    for (const members of this.channels.values()) {
      const entry = members.get(nickKey);
      if (entry !== undefined) {
        entry.away = true;
      }
    }
  }

  /**
   * Mark a member as back (not away) in all tracked channels (away-notify `back` event).
   */
  setBack(nick: string, casemapping: string): void {
    const nickKey = casefold(nick, casemapping);
    for (const members of this.channels.values()) {
      const entry = members.get(nickKey);
      if (entry !== undefined) {
        entry.away = false;
      }
    }
  }

  /**
   * Clear all tracking state.
   * Called on `socket close` so stale membership from a previous connection
   * window does not bleed into the post-reconnect session.
   */
  clear(): void {
    this.channels.clear();
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Return all tracked members for a channel.
   * Returns an empty array when the channel is unknown or has no tracked members.
   */
  getMembers(channel: string, casemapping: string): RosterEntry[] {
    const key = casefold(channel, casemapping);
    const members = this.channels.get(key);
    if (!members) return [];
    return Array.from(members.values());
  }

  /**
   * Look up a member in a channel by casemapped nick.
   * Returns `undefined` when not found.
   */
  getMember(channel: string, nick: string, casemapping: string): RosterEntry | undefined {
    const key = casefold(channel, casemapping);
    const members = this.channels.get(key);
    return members?.get(casefold(nick, casemapping));
  }

  /**
   * Return the member count for a channel, or 0 when not tracked.
   */
  getMemberCount(channel: string, casemapping: string): number {
    const key = casefold(channel, casemapping);
    return this.channels.get(key)?.size ?? 0;
  }

  /**
   * Find the nick(s) in a channel whose account (from AccountTracker) matches
   * the given account name. Used by memberInfo() to resolve an account-name id
   * to a nick for WHOIS. Returns the first match (there should be at most one).
   */
  findNickByAccount(
    channel: string,
    accountName: string,
    nickToAccount: (nick: string) => string | undefined,
    casemapping: string,
  ): string | undefined {
    const key = casefold(channel, casemapping);
    const members = this.channels.get(key);
    if (!members) return undefined;
    for (const entry of members.values()) {
      if (nickToAccount(entry.nick) === accountName) {
        return entry.nick;
      }
    }
    return undefined;
  }

  /** Snapshot of all channels and their member maps — for testing only. */
  _dump(): Map<string, Map<string, RosterEntry>> {
    return new Map(
      Array.from(this.channels.entries()).map(([ch, members]) => [
        ch,
        new Map(members),
      ]),
    );
  }
}
