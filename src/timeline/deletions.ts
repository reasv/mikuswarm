import type { CanonicalChatEvent, DeletionMarker } from "../types.js";

/**
 * Deleted messages (ARCHITECTURE.md §6 "Message edits"). A deletion only marks
 * the stored message (`CanonicalChatEvent.deleted`); its content is kept. The
 * recent-history tiers a session sees, a level-1 summary's input and the
 * decision points' recent-chat windows show it as a placeholder (its position,
 * its sender and that it was deleted, never its content), the way clients do;
 * search, the history tools and existing summaries are unaffected.
 */

/**
 * True when `event` is deleted. With `asOf`, only a deletion at or before that
 * time counts (a window rebuilt for a past moment shows what users saw then).
 */
export function isDeleted(event: Pick<CanonicalChatEvent, "deleted">, asOf?: number): boolean {
  if (!event.deleted) return false;
  return asOf === undefined || event.deleted.at <= asOf;
}

/**
 * The placeholder a deleted message shows in place of its content:
 * `[message deleted]`, or `[message deleted by <deleter>]` when the deleter is
 * known and is not the sender (a moderator).
 */
export function deletedPlaceholder(marker: DeletionMarker, senderId?: string): string {
  return marker.by !== undefined && marker.by !== senderId
    ? `[message deleted by ${marker.by}]`
    : "[message deleted]";
}

/** Batch lookup of deleted stored messages by external id (see `Storage.getDeletedMessages`). */
export type DeletedLookup = (timelineKey: string, externalIds: readonly string[]) => Map<string, DeletionMarker>;

/**
 * Render-time projection for the recent tiers: every event whose reply target
 * is a deleted message gets `replyTo.deleted`, so its quote shows the deletion
 * placeholder instead of the stored content. Events are copied, never mutated;
 * ones without a deleted target are returned as they are.
 */
export function markDeletedReplyTargets(
  events: CanonicalChatEvent[],
  lookup: DeletedLookup,
): CanonicalChatEvent[] {
  const byTimeline = new Map<string, string[]>();
  for (const event of events) {
    const target = event.replyTo?.externalId;
    if (!target) continue;
    const list = byTimeline.get(event.timelineKey) ?? [];
    list.push(target);
    byTimeline.set(event.timelineKey, list);
  }
  if (byTimeline.size === 0) return events;
  const found = new Map<string, Map<string, DeletionMarker>>();
  for (const [timelineKey, ids] of byTimeline) found.set(timelineKey, lookup(timelineKey, ids));
  return events.map((event) => {
    const target = event.replyTo?.externalId;
    const marker = target ? found.get(event.timelineKey)?.get(target) : undefined;
    return marker ? { ...event, replyTo: { ...event.replyTo!, deleted: marker } } : event;
  });
}
