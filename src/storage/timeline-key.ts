/**
 * Universal `timeline_key` grammar (spec DISCORD-SUPPORT-DESIGN §4.1–4.2).
 *
 * The key is a provider-generic string used as the universal FK across ~20 tables.
 * Its shape is a documented, parseable grammar — NOT opaque — so all subsystems
 * can extract provider/account/channel without per-site regexes:
 *
 *   <provider>:<accountId>:<kind>:<channelId>[:thread:<threadId>]
 *
 *   provider   [a-z0-9-]+      no colon (e.g. "matrix", "discord")
 *   accountId  operator-chosen config key, no colon
 *   kind       "room" | "dm"
 *   channelId  provider-native id; MAY contain colons (Matrix room ids do)
 *   threadId   provider-native id (no colons in practice)
 *
 * Matrix keys are exactly this shape — no stored row changes meaning:
 *   matrix:<account>:room:!local:server
 *   matrix:<account>:dm:!dm:server
 *   matrix:<account>:room:!local:server:thread:$root
 *
 * Discord keys (Phase 7, not yet implemented) follow the same grammar:
 *   discord:<account>:room:<channelSnowflake>
 *   discord:<account>:dm:<dmChannelSnowflake>
 *   discord:<account>:room:<parentSnowflake>:thread:<threadSnowflake>
 *
 * Because channelId may contain colons, `:thread:` is detected from the END
 * (last occurrence), not the start. Kind is always the 3rd colon-delimited
 * segment from the start.
 *
 * This module is intentionally dependency-free so BOTH the storage layer
 * (which denormalizes `room_id` onto `usage_events` at insert) and the
 * timeline layer (which derives `ctx.roomId`) can share one implementation.
 * Room-scoped meter seeding is correct only when those two derivations agree,
 * so they MUST NOT drift.
 */

export interface ParsedTimelineKey {
  provider: string;
  accountId: string;
  kind: "room" | "dm";
  channelId: string;
  threadId?: string;
}

/**
 * Parse a `timeline_key` into its components, or return `undefined` for a
 * missing or malformed key. This is the single source of truth for the grammar.
 *
 * Matrix room ids contain a colon (`!local:server`), so the channelId capture
 * takes everything after the `kind:` marker and strips a trailing `:thread:<id>`
 * suffix by searching for the LAST occurrence of `:thread:` — so a Matrix room id
 * that happens to contain `:thread:` does not confuse the parser.
 */
export function parseTimelineKey(key: string): ParsedTimelineKey | undefined {
  if (!key) return undefined;

  // Segment 1: provider (no colon allowed)
  const c1 = key.indexOf(":");
  if (c1 === -1) return undefined;
  const provider = key.slice(0, c1);
  if (!provider || !/^[a-z0-9-]+$/.test(provider)) return undefined;

  // Segment 2: accountId (no colon allowed)
  const c2 = key.indexOf(":", c1 + 1);
  if (c2 === -1) return undefined;
  const accountId = key.slice(c1 + 1, c2);
  if (!accountId) return undefined;

  // Segment 3: kind (must be "room" or "dm")
  const c3 = key.indexOf(":", c2 + 1);
  if (c3 === -1) return undefined;
  const kind = key.slice(c2 + 1, c3);
  if (kind !== "room" && kind !== "dm") return undefined;

  // Remainder: channelId[:thread:threadId]
  const rest = key.slice(c3 + 1);
  if (!rest) return undefined;

  // Detect `:thread:` from the END (channelId is greedy)
  const THREAD_MARKER = ":thread:";
  const threadIdx = rest.lastIndexOf(THREAD_MARKER);
  let channelId: string;
  let threadId: string | undefined;

  if (threadIdx !== -1) {
    channelId = rest.slice(0, threadIdx);
    threadId = rest.slice(threadIdx + THREAD_MARKER.length);
    // Both parts must be non-empty
    if (!channelId || !threadId) return undefined;
  } else {
    channelId = rest;
  }

  return { provider, accountId, kind, channelId, threadId };
}

/**
 * Construct a `timeline_key` from its parsed components.
 * Inverse of `parseTimelineKey`; round-trips are identity.
 */
export function buildTimelineKey(parts: {
  provider: string;
  accountId: string;
  kind: "room" | "dm";
  channelId: string;
  threadId?: string;
}): string {
  const base = `${parts.provider}:${parts.accountId}:${parts.kind}:${parts.channelId}`;
  return parts.threadId ? `${base}:thread:${parts.threadId}` : base;
}

/**
 * Extract the channel id from a `timeline_key`, or `undefined` for a missing /
 * malformed key. For Matrix this is the room id (`!local:server`); for Discord
 * it is the channel snowflake. The single source of truth used by both the
 * storage-layer `room_id` denormalization and the timeline-layer `ctx.roomId`,
 * ensuring they never drift.
 */
export function channelIdFromTimelineKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return parseTimelineKey(key)?.channelId;
}

/**
 * Return the kind segment (`"room"` or `"dm"`) of a `timeline_key`, or
 * `undefined` for a missing / malformed key.
 */
export function timelineKindOf(key: string | undefined): "room" | "dm" | undefined {
  if (!key) return undefined;
  return parseTimelineKey(key)?.kind;
}

/**
 * Extract the bare channel id from a `timeline_key`, or `undefined` for a
 * missing / malformed key.
 *
 * @deprecated Use {@link channelIdFromTimelineKey} instead. This alias exists
 *   to keep the diff reviewable during the Phase-1 migration; it will be removed
 *   in a follow-up phase once all callers are updated.
 */
export function roomIdFromTimelineKeyOpt(timelineKey: string | undefined): string | undefined {
  return channelIdFromTimelineKey(timelineKey);
}

/**
 * SQLite `LIKE … escape '\'` pattern matching every thread sub-timeline of a room
 * (`<roomKey>:thread:<root>`). The room key's LIKE metacharacters (`%`, `_`, `\`)
 * are escaped so a room id that contains them can't broaden the match. Pairs with
 * a `timeline_key = <roomKey>` arm to select a room together with its threads —
 * the console treats a room and its threads as one room (mirrors
 * `resolveEditTargetTimelineKey`).
 */
export function threadKeyLikePattern(roomKey: string): string {
  return `${roomKey.replace(/[\\%_]/g, "\\$&")}:thread:%`;
}
