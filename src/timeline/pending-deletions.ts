import { parseTimelineKey, buildTimelineKey } from "../storage/timeline-key.js";
import type { DeletionMarker } from "../types.js";

/**
 * Deletions of messages the store does not have yet (ARCHITECTURE.md §6
 * "Message edits"): a message can be deleted before it is stored (its live
 * append is still on its way through the pipeline, behind the deletion). The
 * deletion is parked here and its marker is set when the target is appended
 * (`TimelineStore.appendIfMissing`, and for the agent's own messages
 * `ingestAssistantSend` / `ingestAssistantEcho`, in the insert's transaction). The parking
 * itself happens inside the write that found no target
 * (`Storage.markTimelineEventDeleted`'s `onMissing`), so no append can slip in
 * between. Messages buffered for longer (the gap-backfetch freeze) are marked in
 * their buffer instead (`GapBackfetchCoordinator.markBufferedDeleted`).
 *
 * In memory, bounded: an entry expires after `ttlMs`, and at most `maxEntries`
 * are kept (the oldest go first), so a deletion of something that is never
 * stored (a Matrix redaction of a reaction or a state event) does not
 * accumulate. A restart loses them with the in-flight events themselves;
 * history fetched again never returns a deleted message.
 *
 * Keyed by provider, external id and room: two accounts sharing a room store
 * the same message once each (different timeline keys), and each account's
 * deletion is parked and taken on its own.
 */
export interface PendingDeletionsOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export const PENDING_DELETION_TTL_MS = 10 * 60 * 1000;
export const PENDING_DELETION_MAX_ENTRIES = 1000;

interface Parked {
  /** Map keys of this parking: one per room it may land in (each also matches its threads). */
  keys: string[];
  marker: DeletionMarker;
  parkedAt: number;
}

/** The room (non-thread) key of a timeline key. */
export function roomKeyOf(timelineKey: string): string {
  const parsed = parseTimelineKey(timelineKey);
  if (!parsed?.threadId) return timelineKey;
  return buildTimelineKey({ ...parsed, threadId: undefined });
}

function keyOf(provider: string, externalId: string, roomKey: string): string {
  return `${provider}\u0000${externalId}\u0000${roomKey}`;
}

export class PendingDeletions {
  private readonly byKey = new Map<string, Parked>();
  /** Parkings in parking order (a Set keeps insertion order): expiry and eviction walk it. */
  private readonly order = new Set<Parked>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: PendingDeletionsOptions = {}) {
    this.ttlMs = options.ttlMs ?? PENDING_DELETION_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? PENDING_DELETION_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /** Parked deletions (each counts once, whatever the number of rooms it may land in). */
  get size(): number {
    return this.order.size;
  }

  /**
   * Park a deletion of `externalId`, to land in one of `timelineKeys` (or their
   * threads). A deletion already parked for one of those rooms keeps its marker
   * (the first wins, like the stored marker).
   */
  park(provider: string, externalId: string, timelineKeys: readonly string[], marker: DeletionMarker): void {
    this.prune();
    const keys = [...new Set(timelineKeys.map((k) => keyOf(provider, externalId, roomKeyOf(k))))];
    if (keys.length === 0 || keys.some((k) => this.byKey.has(k))) return;
    const parked: Parked = { keys, marker, parkedAt: this.now() };
    for (const k of keys) this.byKey.set(k, parked);
    this.order.add(parked);
    while (this.order.size > this.maxEntries) {
      const oldest = this.order.values().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /** The parked marker for a message just stored in `timelineKey`, removed; undefined when none (or expired). */
  take(provider: string, externalId: string, timelineKey: string): DeletionMarker | undefined {
    if (this.order.size === 0) return undefined;
    const parked = this.byKey.get(keyOf(provider, externalId, roomKeyOf(timelineKey)));
    if (!parked) return undefined;
    this.remove(parked);
    if (this.now() - parked.parkedAt > this.ttlMs) return undefined;
    return parked.marker;
  }

  private remove(parked: Parked): void {
    for (const k of parked.keys) if (this.byKey.get(k) === parked) this.byKey.delete(k);
    this.order.delete(parked);
  }

  private prune(): void {
    const now = this.now();
    for (const parked of this.order) {
      // Parking order: the first unexpired entry ends the sweep.
      if (now - parked.parkedAt <= this.ttlMs) break;
      this.remove(parked);
    }
  }
}
