import type { Logger } from "../observability/index.js";

/**
 * The slice of `Storage` that RoomLabelCache needs. Declared structurally so the
 * cache can be unit-tested against an in-memory fake without the full database.
 */
export interface RoomLabelStore {
  getRoomMetadata(timelineKey: string): { displayName: string; resolvedAt: number } | undefined;
  setRoomDisplayName(timelineKey: string, displayName: string): Promise<void>;
  listKnownTimelineKeys(): string[];
}

export interface RoomLabelCacheOptions {
  store: RoomLabelStore;
  /**
   * Resolve a human room label for a timeline key (network-backed: asks the
   * account's Matrix client for the room's name/alias/parent space). Mirrors the
   * diary pool's `resolveChannelLabel`. May reject; the cache logs and moves on.
   */
  resolve: (timelineKey: string) => Promise<string>;
  logger: Logger;
  /**
   * How long a cached label is trusted before a re-resolve is allowed. Rooms can
   * be renamed, so labels expire. Defaults to 6 hours.
   */
  ttlMs?: number;
  /**
   * Delay between successive resolves during the startup backfill, to avoid a
   * thundering herd of homeserver calls at boot. Defaults to 250ms.
   */
  backfillSpacingMs?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_SPACING_MS = 250;

/**
 * Caches resolved human room labels in `room_metadata` so the observability
 * console can show real room names instead of raw room ids.
 *
 * Resolution is network-backed and must never block the inbound hot path, so
 * `ensureLabel` is fire-and-forget: it does a cheap synchronous freshness check
 * and, only when a (re)resolve is due and not already in flight, kicks off the
 * async resolve + persist in the background. Concurrent calls for the same
 * timeline coalesce via the in-flight set.
 */
export class RoomLabelCache {
  readonly #store: RoomLabelStore;
  readonly #resolve: (timelineKey: string) => Promise<string>;
  readonly #logger: Logger;
  readonly #ttlMs: number;
  readonly #backfillSpacingMs: number;
  readonly #inFlight = new Set<string>();

  constructor(options: RoomLabelCacheOptions) {
    this.#store = options.store;
    this.#resolve = options.resolve;
    this.#logger = options.logger;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#backfillSpacingMs = options.backfillSpacingMs ?? DEFAULT_BACKFILL_SPACING_MS;
  }

  /**
   * Ensure a fresh label is cached for `timelineKey`. Returns immediately; the
   * resolve happens in the background. A no-op when a fresh label already exists
   * or a resolve for this key is already in flight.
   */
  ensureLabel(timelineKey: string): void {
    if (this.#inFlight.has(timelineKey)) return;
    const existing = this.#store.getRoomMetadata(timelineKey);
    if (existing && Date.now() - existing.resolvedAt < this.#ttlMs) return;
    void this.#refresh(timelineKey);
  }

  /**
   * Resolve labels for every known timeline (including idle rooms) at startup,
   * spaced out to avoid hammering the homeserver. Awaitable, but callers
   * typically run it fire-and-forget. Each key still goes through the freshness
   * check, so an already-warm cache resolves nothing.
   */
  async backfillAll(): Promise<void> {
    const keys = this.#store.listKnownTimelineKeys();
    let resolved = 0;
    for (const timelineKey of keys) {
      if (this.#inFlight.has(timelineKey)) continue;
      const existing = this.#store.getRoomMetadata(timelineKey);
      if (existing && Date.now() - existing.resolvedAt < this.#ttlMs) continue;
      await this.#refresh(timelineKey);
      resolved++;
      if (this.#backfillSpacingMs > 0) {
        await new Promise((r) => setTimeout(r, this.#backfillSpacingMs));
      }
    }
    this.#logger.info("room_label_backfill_complete", { known: keys.length, resolved });
  }

  async #refresh(timelineKey: string): Promise<void> {
    this.#inFlight.add(timelineKey);
    try {
      const label = await this.#resolve(timelineKey);
      await this.#store.setRoomDisplayName(timelineKey, label);
      this.#logger.debug("room_label_resolved", { timelineKey, label });
    } catch (error) {
      // Best-effort: a failed resolve leaves the prior label (or the room-id
      // fallback) in place and will be retried on the next inbound event.
      this.#logger.warn("room_label_resolve_failed", {
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#inFlight.delete(timelineKey);
    }
  }
}
