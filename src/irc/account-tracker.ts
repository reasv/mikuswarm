/**
 * Account↔nick tracking for the IRC identity ladder (spec §5.1, §5.3).
 *
 * Maintains a per-account-runtime map from casemapped nick to services account name.
 * Updated by:
 *   - extended-join (account field in JOIN payload when cap is active)
 *   - account-notify (ACCOUNT messages)
 *   - account-tag on any PRIVMSG (opportunistic, per-message)
 *   - WHOX WHO responses (bulk, on channel join)
 *
 * Pruning semantics (documented):
 *   - QUIT:  prune — user is definitively gone from all served channels on the network.
 *   - PART:  do NOT prune — the user may still be present in other served channels,
 *            and we do not track per-channel membership for pruning purposes.
 *            Stale PART entries are harmless: per-message account-tag always wins
 *            (spec §5.1 "per-message tag ALWAYS wins").
 *
 * Per spec §5.1: per-message account-tag ALWAYS overrides tracked state.
 * This class is the fallback only — used when no per-message tag is present.
 */

import { casefold } from "./normalizer.js";

export class AccountTracker {
  /** casemapped_nick → services_account_name */
  private readonly nickToAccount = new Map<string, string>();

  /**
   * Set or update the account for a nick.
   *
   * Call on:
   *   - extended-join (account is a non-empty string)
   *   - account-notify ACCOUNT message (user logged in; account is a string)
   *   - per-message account-tag (opportunistic refresh; account is a string)
   *
   * No-op when `account` is empty.
   */
  setAccount(nick: string, account: string, casemapping: string): void {
    if (!account) return;
    this.nickToAccount.set(casefold(nick, casemapping), account);
  }

  /**
   * Clear the account association for a nick.
   *
   * Call on:
   *   - account-notify ACCOUNT message with `false` (user logged out)
   *   - extended-join with `false` (user not identified at join time)
   *   - defensive: per-message account-tag with `"*"` (non-standard but handled)
   */
  clearAccount(nick: string, casemapping: string): void {
    this.nickToAccount.delete(casefold(nick, casemapping));
  }

  /**
   * Move the account association from `oldNick` to `newNick` (on NICK rename).
   * If no association exists for `oldNick`, nothing changes.
   */
  renameNick(oldNick: string, newNick: string, casemapping: string): void {
    const key = casefold(oldNick, casemapping);
    const account = this.nickToAccount.get(key);
    if (account !== undefined) {
      this.nickToAccount.delete(key);
      this.nickToAccount.set(casefold(newNick, casemapping), account);
    }
  }

  /**
   * Remove all tracking state for a nick.
   *
   * Call on QUIT only. PART does not prune (see module docstring).
   */
  removeNick(nick: string, casemapping: string): void {
    this.nickToAccount.delete(casefold(nick, casemapping));
  }

  /**
   * Look up the services account for a nick (case-insensitive per casemapping).
   * Returns `undefined` when the account is unknown (never seen, logged out, or pruned).
   */
  getAccount(nick: string, casemapping: string): string | undefined {
    return this.nickToAccount.get(casefold(nick, casemapping));
  }

  /**
   * Bulk-update tracked accounts from a WHOX wholist event.
   *
   * When WHOX is active (server advertises the WHOX ISUPPORT token and the
   * library sent `WHO <target> %tcuhsnfdaor,<token>`), each user object includes
   * an `account` field populated by irc-framework from RPL_WHOSPCRPL:
   *
   *   - non-empty string → user is identified with that account name
   *   - `""` (empty string) → server sent `0` (not identified); clear from map
   *   - `undefined` → non-WHOX WHO response (plain RPL_WHOREPLY); skip, no update
   *
   * Source: node_modules/irc-framework/src/commands/handlers/misc.js line 173:
   *   `account: params[9] === '0' ? '' : params[9]`
   */
  bulkUpdateFromWhox(
    users: ReadonlyArray<{ nick: string; account?: string }>,
    casemapping: string,
  ): void {
    for (const user of users) {
      if (user.account === undefined) {
        // Non-WHOX response — no account information available; skip.
        continue;
      }
      const foldedNick = casefold(user.nick, casemapping);
      if (user.account !== "") {
        this.nickToAccount.set(foldedNick, user.account);
      } else {
        // Empty string = '0' from server = not identified.
        this.nickToAccount.delete(foldedNick);
      }
    }
  }

  /**
   * Clear all tracked nick→account associations.
   *
   * Call on 'socket close': stale mappings from a previous connection window
   * are invalid after reconnect (a user may have logged out of services while
   * we were gone; no WHOX fires for those nicks until they speak or rejoin).
   * WHOX-on-self-join repopulates channel members after reconnect; per-message
   * account-tag repopulates on the first message from any user — correct per
   * spec §5.1 ladder.
   */
  clear(): void {
    this.nickToAccount.clear();
  }

  /** Snapshot of current entries — for testing only. */
  _dump(): Map<string, string> {
    return new Map(this.nickToAccount);
  }
}
