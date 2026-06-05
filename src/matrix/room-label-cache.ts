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
  /**
   * After a resolve fails (rejects or yields an empty label), how long to wait
   * before another inbound event is allowed to trigger a re-resolve for that
   * timeline. Bounds the rate of network-backed retries so a persistently
   * failing room does not fire one homeserver call per inbound message. Defaults
   * to 5 minutes.
   */
  failureCooldownMs?: number;
  /**
   * Injectable clock, primarily for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_SPACING_MS = 250;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Caches resolved human room labels in `room_metadata` so the observability
 * console can show real room names instead of raw room ids.
 *
 * Resolution is network-backed and must never block the inbound hot path, so
 * `ensureLabel` is fire-and-forget: it does a cheap synchronous freshness check
 * and, only when a (re)resolve is due and not already in flight, kicks off the
 * async resolve + persist in the background. Concurrent calls for the same
 * timeline coalesce via the in-flight set.
 *
 * A failed resolve does not persist anything, so the freshness gate ("no row, or
 * row older than TTL") would otherwise re-fire a homeserver call on every
 * inbound event for a room that keeps failing. To bound that, failures are
 * recorded in an in-memory negative cache and the freshness gate skips a
 * re-resolve until `failureCooldownMs` has elapsed. A later success clears the
 * failure entry.
 */
export class RoomLabelCache {
  readonly #store: RoomLabelStore;
  readonly #resolve: (timelineKey: string) => Promise<string>;
  readonly #logger: Logger;
  readonly #ttlMs: number;
  readonly #backfillSpacingMs: number;
  readonly #failureCooldownMs: number;
  readonly #now: () => number;
  readonly #inFlight = new Set<string>();
  /** Negative cache: timelineKey -> timestamp of the last failed resolve. */
  readonly #failures = new Map<string, number>();

  constructor(options: RoomLabelCacheOptions) {
    this.#store = options.store;
    this.#resolve = options.resolve;
    this.#logger = options.logger;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#backfillSpacingMs = options.backfillSpacingMs ?? DEFAULT_BACKFILL_SPACING_MS;
    this.#failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether a re-resolve is currently suppressed by the negative cache, i.e. the
   * last resolve failed and the cooldown has not yet elapsed.
   */
  #inFailureCooldown(timelineKey: string): boolean {
    const failedAt = this.#failures.get(timelineKey);
    if (failedAt === undefined) return false;
    if (this.#now() - failedAt < this.#failureCooldownMs) return true;
    // Cooldown elapsed: drop the stale entry so a retry can proceed.
    this.#failures.delete(timelineKey);
    return false;
  }

  /**
   * Ensure a fresh label is cached for `timelineKey`. Returns immediately; the
   * resolve happens in the background. A no-op when a fresh label already exists,
   * a resolve for this key is already in flight, or a recent failure is still
   * within its cooldown.
   */
  ensureLabel(timelineKey: string): void {
    if (this.#inFlight.has(timelineKey)) return;
    const existing = this.#store.getRoomMetadata(timelineKey);
    if (existing && this.#now() - existing.resolvedAt < this.#ttlMs) return;
    if (this.#inFailureCooldown(timelineKey)) return;
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
      if (existing && this.#now() - existing.resolvedAt < this.#ttlMs) continue;
      if (this.#inFailureCooldown(timelineKey)) continue;
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
      // The store assumes non-empty labels: `room_metadata.display_name` is NOT
      // NULL but that constraint does not reject `''`, and `listConsoleRooms`
      // only falls back to the room id via `coalesce(..., NULL)`. Persisting an
      // empty/whitespace label would show a blank console name, so treat it as a
      // non-fatal failure: skip the write and engage the backoff so an
      // empty-returning resolver doesn't re-fire on every inbound message.
      if (label.trim() === "") {
        this.#failures.set(timelineKey, this.#now());
        this.#logger.warn("room_label_resolve_empty", { timelineKey });
        return;
      }
      await this.#store.setRoomDisplayName(timelineKey, label);
      this.#failures.delete(timelineKey);
      this.#logger.debug("room_label_resolved", { timelineKey, label });
    } catch (error) {
      // Best-effort: a failed resolve leaves the prior label (or the room-id
      // fallback) in place. Record the failure so the freshness gate backs off
      // for `failureCooldownMs` instead of re-resolving on every inbound event;
      // a later success clears the entry.
      this.#failures.set(timelineKey, this.#now());
      this.#logger.warn("room_label_resolve_failed", {
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#inFlight.delete(timelineKey);
    }
  }
}
