/**
 * Leaf helpers for parsing Matrix `timeline_key` strings (spec PER-USER-LIMITS §8.3).
 *
 * This module is intentionally dependency-free so BOTH the storage layer (which
 * denormalizes `room_id` onto `usage_events` at insert) and the timeline layer
 * (which derives `ctx.roomId`) can share one regex. Room-scoped meter seeding is
 * correct only when those two derivations agree, so they MUST NOT drift — keeping
 * the regex here, with no heavy imports, lets storage own it without depending on
 * the timeline subsystem (the reason the two copies were originally duplicated).
 *
 * Keys are shaped `matrix:<account>:room:<roomId>[:thread:<root>]` or
 * `matrix:<account>:dm:<roomId>`. A Matrix room id (`!local:server`) itself
 * contains a colon, so the capture takes everything between the `room:`/`dm:`
 * marker and an optional `:thread:` suffix rather than splitting on every colon.
 * The `room|dm` kind segment is validated, so a malformed key yields no room id.
 */

/**
 * Extract the bare Matrix room id from a `timeline_key`, or `undefined` for a
 * missing / malformed key. The single source of truth for the derivation; the
 * storage- and timeline-layer wrappers delegate here.
 */
export function roomIdFromTimelineKeyOpt(timelineKey: string | undefined): string | undefined {
  if (!timelineKey) return undefined;
  const match = timelineKey.match(/^matrix:[^:]+:(?:room|dm):(.+?)(?::thread:.+)?$/);
  const roomId = match?.[1];
  return roomId && roomId.length > 0 ? roomId : undefined;
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
