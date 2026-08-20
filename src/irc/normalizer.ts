/**
 * IRC inbound normalizer — pure functions, no live client references.
 *
 * All functions here are intentionally free of irc-framework Client references
 * so they can be exercised by unit tests without a socket.
 *
 * Spec: IRC-SUPPORT-DESIGN §7.5 (inbound pipeline), §7.2 (id scheme),
 *       §4 (timeline keys), §5.1 (identity ladder — Phase 2),
 *       §7.1 (byte budget + chunking), §3 (casemapping for trigger detection).
 */

import { nanoid } from "nanoid";
import type {
  CanonicalChatEvent,
  InboundChatEvent,
  SenderInfo,
  TriggerInfo,
} from "../types.js";
import { buildTimelineKey } from "../storage/timeline-key.js";
import type { AccountTracker } from "./account-tracker.js";

// ── Control-code stripping ─────────────────────────────────────────────────

/**
 * mIRC color code — `\x03` optionally followed by fg[,bg] digit pairs.
 * Must be matched before the generic control-character strip.
 */
const MIRC_COLOR_RE = /\x03(?:\d{1,2}(?:,\d{1,2})?)?/g;

/**
 * Hex color code extension — `\x04` followed by exactly 6 hex digits.
 */
const MIRC_HEX_COLOR_RE = /\x04[0-9A-Fa-f]{6}/g;

/**
 * Other mIRC formatting control characters:
 *   \x02 bold, \x0F reset, \x11 monospace, \x16 reverse/swap,
 *   \x1D italic, \x1E strikethrough, \x1F underline.
 */
const MIRC_CTRL_RE = /[\x02\x0F\x11\x16\x1D\x1E\x1F]/g;

/**
 * Strip all mIRC/IRC control codes from a message body so the timeline stores
 * clean text. Per spec §7.1: "Inbound control codes are stripped at normalization".
 */
export function stripControlCodes(body: string): string {
  return body
    .replace(MIRC_COLOR_RE, "")
    .replace(MIRC_HEX_COLOR_RE, "")
    .replace(MIRC_CTRL_RE, "");
}

// ── Casemapping ────────────────────────────────────────────────────────────

/**
 * Apply IRC casemapping to a string. Per spec §3.2 / §7.5 (mention trigger):
 *   "ascii"         — only A–Z → a–z (plus normal Unicode lowercase).
 *   "rfc1459"       — ascii + {[]\~} ↔ {}|^.
 *   "strict-rfc1459"— ascii + {[]\} ↔ {}| (without ~ ↔ ^).
 *
 * Ergo networks may advertise "precis" (for non-ASCII nick support); we treat
 * that as "ascii" for fold purposes — disjointness from Matrix/Discord ids is
 * preserved regardless.
 */
export function casefold(s: string, casemapping: string): string {
  const lower = s.toLowerCase();
  if (casemapping === "rfc1459") {
    return lower
      .replace(/\[/g, "{")
      .replace(/\]/g, "}")
      .replace(/\\/g, "|")
      .replace(/~/g, "^");
  }
  if (casemapping === "strict-rfc1459") {
    return lower
      .replace(/\[/g, "{")
      .replace(/\]/g, "}")
      .replace(/\\/g, "|");
  }
  // "ascii", "precis", or unknown → plain toLowerCase
  return lower;
}

// ── Trigger detection ──────────────────────────────────────────────────────

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect an IRC mention trigger in `body`.
 *
 * Two forms are recognized (spec §7.5):
 *   1. Addressing prefix: `nick: …`, `nick, …`, or `nick …` at the start of
 *      the line (the space separator overlaps with form 2).
 *   2. Bare-nick word-boundary occurrence anywhere in the message.
 *
 * Matching is case-insensitive per the network's advertised casemapping.
 * The casemapping is applied to both `body` and `nick` before comparison.
 *
 * Surrounding "non-nick" chars for the word-boundary check are defined as
 * any char that is NOT in `[a-z0-9_\-\[\]\\^{}|~]` (standard IRC nick char
 * set post-casefold, rfc1459 convention). This is deliberately inclusive so
 * a nick at the start or end of the string also matches.
 */
export function detectMention(body: string, nick: string, casemapping: string): boolean {
  if (!nick) return false;
  const foldedBody = casefold(body, casemapping);
  const foldedNick = casefold(nick, casemapping);
  const escaped = escapeRegExp(foldedNick);

  // 1. Addressing prefix: "nick:" or "nick," at start of message
  if (/^[^\s:,]+[:, ]/.test(foldedBody)) {
    const prefix = foldedBody.split(/[:, ]/)[0]!;
    if (prefix === foldedNick) return true;
  }

  // 2. Bare-nick word-boundary occurrence
  // Nick chars (post-casefold): a-z 0-9 _ - [ ] \ ^ { } | ~
  const nickChar = "[a-z0-9_\\-\\[\\]\\\\\\^{}|~]";
  const re = new RegExp(`(?<!${nickChar})${escaped}(?!${nickChar})`);
  return re.test(foldedBody);
}

/**
 * Determine whether an inbound message triggers the bot, and of which type.
 *
 * Returns a `TriggerInfo` when a trigger is detected, or `undefined` otherwise.
 *
 * Per spec §7.5:
 *   - `dm` for any query message (target === selfNick, case-insensitive).
 *   - `mention` for a channel message containing an exact nick-token match.
 *   - NOTICEs: ingested but NEVER trigger (returns undefined for notice events).
 *
 * `resolvedSenderId` is the ladder result (account name or casemapped nick) used
 * for `TriggerInfo.triggeredBy.id` — ensures downstream trigger routing uses the
 * stable identity, not the mutable nick.
 */
export function detectIrcTrigger(
  body: string,
  senderNick: string,
  target: string,
  selfNick: string,
  channelType: "group" | "dm",
  casemapping: string,
  isNotice: boolean,
  resolvedSenderId?: string,
): TriggerInfo | undefined {
  // Notices never trigger (spec §7.5)
  if (isNotice) return undefined;

  const triggeredById = resolvedSenderId ?? casefold(senderNick, casemapping);
  const sender: SenderInfo = { id: triggeredById, username: senderNick };

  if (channelType === "dm") {
    return {
      type: "dm",
      reason: `direct message from ${senderNick}`,
      triggeredBy: sender,
    };
  }

  // Channel: mention only
  if (detectMention(body, selfNick, casemapping)) {
    return {
      type: "mention",
      reason: `mentioned in ${target}`,
      triggeredBy: sender,
    };
  }

  return undefined;
}

// ── Timeline key construction ──────────────────────────────────────────────

/**
 * Whether a target string is a channel (starts with a channel-prefix char).
 * Standard prefix chars: # & + !  (RFC 2812 §1.3).
 */
export function isChannelTarget(target: string): boolean {
  return target.length > 0 && "#&+!".includes(target[0]!);
}

/**
 * Build an IRC timeline key for a channel.
 *
 * Channel names are lowercased per casemapping for key stability.
 * A channel name containing `:` would collide with the key grammar — per the
 * IRC RFC, channel names cannot contain `:` on conforming servers, so we
 * simply lowercase and pass through. Validation at the call site is sufficient.
 *
 * Format: `irc:<accountId>:room:<channel_lowercased>`
 */
export function buildIrcChannelKey(
  accountId: string,
  channel: string,
  casemapping: string,
): string {
  return buildTimelineKey({
    provider: "irc",
    accountId,
    kind: "room",
    channelId: casefold(channel, casemapping),
  });
}

/**
 * Build an IRC timeline key for a DM (query).
 *
 * Per spec §4: identity key per the ladder (Phase 1: casemapped nick).
 * Format: `irc:<accountId>:dm:<identity>`
 */
export function buildIrcDmKey(accountId: string, identity: string): string {
  return buildTimelineKey({
    provider: "irc",
    accountId,
    kind: "dm",
    channelId: identity,
  });
}

// ── Byte budget + chunking ─────────────────────────────────────────────────

/**
 * Compute the PRIVMSG body byte budget for a given target, based on the bot's
 * known hostmask (nick!username@host).
 *
 * Wire format: `:<nick>!<user>@<host> PRIVMSG <target> :<body>\r\n`
 * Budget = 512 - 2 (CRLF) - 1 (`:`) - len(hostmask) - 9 (` PRIVMSG `)
 *        - len(target) - 2 (` :`)
 *        = 498 - len(hostmask) - len(target)
 *
 * The minimum returned is 50 bytes (guard against degenerate cases like an
 * extremely long nick or target).
 *
 * Per spec §7.1: "learns its own hostmask post-registration … recomputing it
 * if the server later changes the bot's hostmask".
 */
export function computeByteBudget(
  nick: string,
  username: string,
  host: string,
  target: string,
): number {
  // hostmask bytes: nick!user@host — all ASCII in practice (nick/user/host are
  // restricted to printable ASCII by IRC grammar).
  const hostmask = `${nick}!${username}@${host}`;
  const budget = 498 - Buffer.byteLength(hostmask, "utf8") - Buffer.byteLength(target, "utf8");
  return Math.max(50, budget);
}

/**
 * Conservative static budget used before the real hostmask is known.
 * Matches the spec's `maxMessageChars: 400` capability declaration.
 */
export const STATIC_MAX_CHARS = 400;

/**
 * Split a single newline-free `text` into chunks ≤ `maxBytes` UTF-8 bytes.
 *
 * Per spec §7.1: "UTF-8-boundary splitting preferring whitespace".
 * Algorithm:
 *   1. Iterate code points (handles surrogate pairs / emoji correctly).
 *   2. Accumulate until the byte budget would be exceeded.
 *   3. If a space was seen in the latter half of the window, split there
 *      and skip leading whitespace on the next chunk.
 *   4. Otherwise split exactly at the budget boundary.
 */
function chunkLine(text: string, maxBytes: number): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  let cpIdx = 0;

  while (cpIdx < codePoints.length) {
    let byteCount = 0;
    let end = cpIdx;
    let lastSpaceCpIdx = -1;
    let lastSpaceByteCount = 0;

    // Accumulate code points until maxBytes would be exceeded.
    while (end < codePoints.length) {
      const cp = codePoints[end]!;
      const cpBytes = Buffer.byteLength(cp, "utf8");
      if (byteCount + cpBytes > maxBytes) break;
      byteCount += cpBytes;
      if (cp === " ") {
        lastSpaceCpIdx = end;
        lastSpaceByteCount = byteCount;
      }
      end++;
    }

    // Entire remainder fits.
    if (end >= codePoints.length) {
      chunks.push(codePoints.slice(cpIdx).join(""));
      break;
    }

    // Must split. Prefer whitespace if found in the latter half of the window.
    const windowLen = end - cpIdx;
    if (lastSpaceCpIdx !== -1 && lastSpaceCpIdx - cpIdx > Math.floor(windowLen / 2)) {
      chunks.push(codePoints.slice(cpIdx, lastSpaceCpIdx).join(""));
      // Skip the space and any immediately following spaces.
      cpIdx = lastSpaceCpIdx + 1;
      while (cpIdx < codePoints.length && codePoints[cpIdx] === " ") cpIdx++;
    } else {
      chunks.push(codePoints.slice(cpIdx, end).join(""));
      cpIdx = end;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Split `text` into chunks where each chunk fits within `maxBytes` UTF-8 bytes.
 *
 * Pre-splits on embedded newlines (\\r\\n / \\n / \\r) before byte-budget
 * splitting. irc-framework's say() splits on the same pattern internally
 * (client.js:448-455), producing one PRIVMSG per line; without pre-splitting
 * a single PendingEcho for the whole body would never match the N separate
 * echoes and every multi-line send would stall 5 s then fabricate a receipt.
 * Blank/whitespace-only segments are skipped — IRC cannot send an empty PRIVMSG.
 */
export function chunkIrcMessage(text: string, maxBytes: number): string[] {
  if (!text) return [];
  if (maxBytes <= 0) return [text];

  // Pre-split on embedded newlines; filter out blank/whitespace-only segments.
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const all: string[] = [];
  for (const line of lines) {
    all.push(...chunkLine(line, maxBytes));
  }
  return all;
}

// ── Synthetic message id scheme ────────────────────────────────────────────

/**
 * Next monotonic counter value per-account (in-process, not persisted).
 * Used for synthetic id uniqueness within an account session.
 */
const counterMap = new Map<string, number>();

/** Reset counters — test seam only. */
export function _resetCounters(): void {
  counterMap.clear();
}

/**
 * Synthesize a message id unique within the given account.
 *
 * Format: `syn:<serverTimeMs>:<senderNick>:<counter>`
 *
 * Per spec §7.2: "synthetic ids unique within the account (server-time +
 * sender + monotonic counter)". These only serve dedup, echo-merge, and
 * trigger bookkeeping — no stable referenceability is required.
 */
export function syntheticMsgId(
  accountId: string,
  serverTimeMs: number,
  senderNick: string,
): string {
  const n = (counterMap.get(accountId) ?? 0) + 1;
  counterMap.set(accountId, n);
  return `syn:${serverTimeMs}:${senderNick}:${n}`;
}

// ── Inbound message normalization ─────────────────────────────────────────

// ── Network-scoped id helper ───────────────────────────────────────────────

/**
 * Scope a bare IRC identity to its network, producing a stable `SenderInfo.id`.
 *
 * Format: `<networkId>/<identity>`
 *
 * The separator `/` is safe because:
 *   - IRC hostnames and ISUPPORT NETWORK tokens never contain `/`
 *     (the ABNF in RFC 2812 §2.3.1 and the ISUPPORT spec both prohibit it).
 *   - IRC nick characters (RFC 2812 §2.3.1 nick grammar) and services account
 *     names (which must be valid nicks) likewise cannot contain `/`.
 *
 * Therefore the first `/` is always and unambiguously the scope separator,
 * and splitting on it unambiguously recovers networkId and identity.
 *
 * Use this helper everywhere an IRC user id is minted — never ad-hoc string
 * concatenation at call sites.
 */
export function scopeIrcId(networkId: string, identity: string): string {
  return `${networkId}/${identity}`;
}

/**
 * Inverse of {@link scopeIrcId}: strip the `<networkId>/` prefix, returning
 * the bare identity (nick or services account). The first `/` is the
 * separator; a string with no `/` is returned unchanged (defensive — scoped
 * ids always carry one).
 */
export function unscopeIrcId(scopedId: string): string {
  const slash = scopedId.indexOf("/");
  return slash === -1 ? scopedId : scopedId.slice(slash + 1);
}

export interface IrcNormalizerContext {
  accountId: string;
  /** The bot's current nick (for self-detection and trigger matching). */
  selfNick: string;
  /** Network casemapping (rfc1459 / strict-rfc1459 / ascii). */
  casemapping: string;
  /**
   * Network identity prefix for scoped user ids.
   * The NETWORK ISUPPORT token lowercased when advertised, else the configured
   * host lowercased. Frozen once per connection before any inbound event is
   * normalized (see provider.ts `networkIdFrozen`).
   */
  networkId: string;
  /**
   * In-memory account tracking state (Phase 2).
   * Used as the fallback rung of the identity ladder when no per-message account-tag
   * is present. The tracker is read-only from the normalizer's perspective — updates
   * happen in the provider before normalizeIrcMessage is called.
   */
  accountTracker?: AccountTracker;
  /**
   * The bot's own services account name (Phase 2).
   * Set to `sasl_user` when SASL is configured. Used for self-identity: the bot's
   * `SenderInfo.id` uses the account name (stable across nick changes) when known.
   */
  selfAccount?: string;
}

export interface IrcInboundMessage {
  nick: string;
  ident: string;
  hostname: string;
  target: string;
  message: string;
  tags: Record<string, string>;
  /** Server-time as ms-epoch. */
  time: number;
  /**
   * Services account from the account-tag on this specific message.
   * Present as a non-empty string when account-tag cap is enabled and the sender
   * is identified. Absent (undefined) when the cap is not enabled or user is not
   * identified (the account-tag is simply not sent in that case — unlike ACCOUNT
   * messages which use `"*"` for logged-out, account-tags are omitted when absent).
   */
  account?: string;
  /** True when this PRIVMSG was identified as a CTCP ACTION. */
  isAction?: boolean;
  /** True when this is a NOTICE. */
  isNotice?: boolean;
}

/**
 * Apply the identity ladder (spec §5.1) to a single message sender.
 *
 * Deterministic, per-message:
 *   1. Per-message account-tag (wins when present and non-empty)
 *   2. Tracked state from extended-join/account-notify/WHOX (fallback)
 *   3. Casemapped nick (final fallback)
 *
 * Per spec §5.1: "per-message tag ALWAYS wins".
 *
 * `msg.account` is the account-tag value from the message. The tag is absent
 * (undefined) when the user is not identified or the cap is not enabled; it is
 * never `"*"` on PRIVMSG (that's only for ACCOUNT messages). Defensive `"*"`
 * handling is included for safety.
 */
export function resolveIrcSenderId(
  nick: string,
  msgAccount: string | undefined,
  accountTracker: AccountTracker | undefined,
  casemapping: string,
): string {
  // Rung 1: per-message account-tag (defensive: treat "*" as absent)
  const tag = msgAccount && msgAccount !== "*" ? msgAccount : undefined;
  if (tag) return tag;

  // Rung 2: tracked state (extended-join, account-notify, WHOX)
  const tracked = accountTracker?.getAccount(nick, casemapping);
  if (tracked) return tracked;

  // Rung 3: casemapped nick
  return casefold(nick, casemapping);
}

/**
 * Normalize an incoming IRC PRIVMSG / ACTION / NOTICE into a CanonicalChatEvent
 * + InboundChatEvent.
 *
 * Spec §7.5 pipeline:
 *   - PRIVMSG → CanonicalChatEvent with stripped body
 *   - CTCP ACTION → body rendered as `* <nick> <action>`
 *   - NOTICE in channels → ingested, trigger=undefined
 *   - NOTICE in queries → NOT called from provider (provider skips them)
 *   - mIRC control codes stripped
 *
 * Identity (network-scoped, spec §5.1): SenderInfo.id = scopeIrcId(ctx.networkId, ladderResult)
 * where ladderResult = account-tag > tracked account > casemapped nick.
 * SenderInfo.username = current nick (display identity, always the nick).
 *
 * DM key: uses the scoped sender id as the channelId component so the key
 * encodes both the network and the identity.
 * Format: `irc:<accountId>:dm:<networkId>/<identity>`
 */
export function normalizeIrcMessage(
  msg: IrcInboundMessage,
  ctx: IrcNormalizerContext,
): InboundChatEvent {
  const now = Date.now();
  const serverTime = msg.time && msg.time > 0 ? msg.time : now;

  // Determine channel type
  const channelIsChannel = isChannelTarget(msg.target);
  const channelType: "group" | "dm" = channelIsChannel ? "group" : "dm";

  // ── Identity ladder (spec §5.1) ──────────────────────────────────────────────
  const isSelf =
    casefold(msg.nick, ctx.casemapping) === casefold(ctx.selfNick, ctx.casemapping);

  let bareId: string;
  if (isSelf) {
    // Self: use SASL account name when configured (stable across nick changes),
    // else casemapped nick.
    bareId = ctx.selfAccount ?? casefold(msg.nick, ctx.casemapping);
  } else {
    bareId = resolveIrcSenderId(msg.nick, msg.account, ctx.accountTracker, ctx.casemapping);
  }

  // Network-scope the bare ladder result.
  const senderId = scopeIrcId(ctx.networkId, bareId);

  // Build timeline key — DM key uses the scoped sender id (spec §4).
  const timelineKey = channelIsChannel
    ? buildIrcChannelKey(ctx.accountId, msg.target, ctx.casemapping)
    : buildIrcDmKey(ctx.accountId, senderId);

  const sender: SenderInfo = {
    id: senderId,
    // username = current nick (display identity; always mutable, always the nick)
    username: msg.nick,
    isSelf,
  };

  // External id from msgid tag or synthetic
  const msgidTag = msg.tags["msgid"];
  const externalId = msgidTag || syntheticMsgId(ctx.accountId, serverTime, msg.nick);

  // Build canonical event id (provider-internal unique id)
  const id = `irc:${ctx.accountId}:${externalId}:${nanoid(8)}`;

  // Body construction
  let body: string;
  if (msg.isAction) {
    // CTCP ACTION: "* nick action text" (spec §7.5)
    body = `* ${msg.nick} ${stripControlCodes(msg.message)}`;
  } else {
    body = stripControlCodes(msg.message);
  }

  // Trigger detection (spec §7.5) — pass the network-scoped senderId so triggeredBy.id is stable.
  const trigger = detectIrcTrigger(
    body,
    msg.nick,
    msg.target,
    ctx.selfNick,
    channelType,
    ctx.casemapping,
    msg.isNotice === true,
    senderId, // already scoped: <networkId>/<identity>
  );

  const event: CanonicalChatEvent = {
    id,
    externalId,
    timelineKey,
    provider: "irc",
    role: "user",
    sender,
    body,
    timestamp: serverTime,
    receivedAt: now,
    trigger,
  };

  const inbound: InboundChatEvent = {
    provider: "irc",
    timelineKey,
    event,
    trigger,
    channelType,
  };

  return inbound;
}
