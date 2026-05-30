import type { Logger } from "../observability/index.js";
import type { TimelineStore } from "../timeline/index.js";
import { needsEnrichment } from "../timeline/index.js";
import type { CanonicalChatEvent, TimelineState } from "../types.js";
import type { MatrixMessageSummary } from "../matrix/native-types.js";
import { mediaToAttachment } from "../matrix/inbound.js";

/**
 * Re-decryption sweeper (issue #11, requirement #3).
 *
 * The native client consumes matrix-sdk via raw callbacks + `room.messages()`,
 * NOT the matrix-sdk-ui `Timeline`, so there is no automatic re-decryption
 * signal when room keys arrive late. This loop fills that gap: it periodically
 * re-fetches each stored undecryptable (UTD) event through the native
 * `messageSummary` primitive (which re-runs `load_or_fetch_event` + summarize),
 * and when the summary comes back non-UTD — meaning the megolm session is now
 * known — replaces the stored placeholder with the decrypted content and
 * re-arms enrichment/captioning.
 *
 * Per-event exponential backoff (capped) prevents hammering the homeserver for
 * events whose keys may never arrive (e.g. sent before the bot joined).
 */
export interface RedecryptionSweeperOptions {
  store: TimelineStore;
  /**
   * Retry a single event: re-fetch its summary by room + event id. Three outcomes,
   * each handled differently by the sweeper (issue #9):
   *   - returns a summary with `undecryptable === true` → still UTD (keys not yet
   *     known) → back off and retry later.
   *   - returns a decrypted summary (`undecryptable` falsy) → replace the row.
   *   - returns `null` (the native primitive returned `Ok(None)`) → the event
   *     fetched & decrypted but is NOT a renderable message (sticker / poll /
   *     reaction). The live path never stores these, so the placeholder is retired
   *     (deleted) to match live parity.
   *   - THROWS → the event could not be fetched at all (unknown room / network) →
   *     treated as a transient failure → back off and retry later.
   * The injected closure MUST throw on fetch failure (not swallow it into `null`),
   * so `null` is an unambiguous "decrypted non-message" signal.
   *
   * Injected so the sweeper is decoupled from the provider and unit-testable.
   */
  retry(params: { roomId: string; eventId: string }): Promise<MatrixMessageSummary | null>;
  /** Re-arm enrichment for a freshly-decrypted event. */
  notifyEnrichment(eventId: string): void;
  /** Nudge the caption pool when a decrypted event has media. */
  notifyCaptions(): void;
  /** Poll interval (ms); 0 disables the sweeper entirely. */
  intervalMs: number;
  /** Max UTD events probed per tick. */
  batchSize: number;
  /** True while the app is shutting down; the loop must stop promptly. */
  isDraining(): boolean;
  logger?: Logger;
}

interface BackoffEntry {
  /** Earliest time (ms epoch) the event may be retried again. */
  nextAttemptAt: number;
  /** Consecutive failed attempts, for exponential backoff. */
  attempts: number;
}

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000; // 1h cap

export class RedecryptionSweeper {
  readonly #options: RedecryptionSweeperOptions;
  readonly #backoff = new Map<string, BackoffEntry>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;
  #ticking: Promise<void> | undefined;

  constructor(options: RedecryptionSweeperOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#options.intervalMs <= 0) return;
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#ticking;
  }

  #schedule(): void {
    if (this.#stopped || this.#options.isDraining()) return;
    this.#timer = setTimeout(() => {
      this.#ticking = this.tick()
        .catch((error) => {
          this.#options.logger?.error("redecryption_sweep_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.#ticking = undefined;
          this.#schedule();
        });
    }, this.#options.intervalMs);
  }

  /**
   * One sweep pass: probe up to `batchSize` due UTD events, replacing any that
   * have become decryptable. Public for tests; the scheduled loop calls it.
   *
   * `getUndecrypted` already excludes rows past the give-up ceiling (issue #1), so
   * the oldest-first candidate window always reaches live decryptable rows even
   * when many old dead rows exist. The in-memory `#backoff` map is pruned to the
   * ids still in rotation each pass so it can't grow unbounded.
   */
  async tick(): Promise<void> {
    if (this.#stopped || this.#options.isDraining()) return;
    const now = Date.now();
    const rotation = this.#options.store.getUndecrypted(this.#options.batchSize * 4);

    // Prune backoff entries for ids no longer in the candidate set (decrypted,
    // deleted, or retired past the ceiling) so the map stays bounded (issue #1).
    const live = new Set(rotation.map((entry) => entry.event.id));
    for (const id of this.#backoff.keys()) {
      if (!live.has(id)) this.#backoff.delete(id);
    }

    const candidates = rotation
      .filter((entry) => {
        const backoff = this.#backoff.get(entry.event.id);
        if (backoff) return backoff.nextAttemptAt <= now;
        // No in-memory backoff yet (e.g. first sweep after restart): derive the
        // next-due time from the persisted attempt count so backoff survives
        // restarts and a long-dead row isn't probed immediately on boot.
        if (entry.attempts > 0) {
          this.#backoff.set(entry.event.id, {
            attempts: entry.attempts,
            nextAttemptAt: now + backoffDelay(entry.attempts),
          });
          return false;
        }
        return true;
      })
      .slice(0, this.#options.batchSize);

    for (const entry of candidates) {
      if (this.#stopped || this.#options.isDraining()) return;
      await this.#probe(entry.event);
    }
  }

  async #probe(event: CanonicalChatEvent): Promise<void> {
    const roomId = roomIdFromTimelineKey(event.timelineKey);
    const eventId = event.externalId;
    if (!roomId || !eventId) {
      // Can't re-fetch without a room + Matrix event id; retire permanently so the
      // row leaves the candidate set in the DB (not just front-of-queue in memory).
      await this.#options.store.retireUndecrypted(event.id);
      this.#backoff.delete(event.id);
      this.#options.logger?.warn("redecryption_retired_no_room_id", {
        eventId: event.id,
        externalId: event.externalId,
        timelineKey: event.timelineKey,
      });
      return;
    }

    let summary: MatrixMessageSummary | null;
    try {
      summary = await this.#options.retry({ roomId, eventId });
    } catch (error) {
      // Fetch failed (unknown room / network) — transient. Back off and persist
      // the attempt so the row eventually retires if the failure is permanent.
      await this.#recordFailure(event.id);
      this.#options.logger?.warn("redecryption_retry_failed", {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (summary === null) {
      // Fetched & decrypted, but not a renderable message (sticker/poll/reaction):
      // native returned Ok(None). The live append path never stores these, so
      // retire the placeholder by deleting it to match live parity (issue #9).
      const deleted = await this.#options.store.deleteUndecrypted(event.id);
      this.#backoff.delete(event.id);
      if (deleted) {
        this.#options.logger?.info("redecryption_retired_non_message", {
          eventId: event.id,
          externalId: event.externalId,
        });
      }
      return;
    }

    if (summary.undecryptable === true) {
      // Still undecryptable — keys not yet known. Back off and try later.
      await this.#recordFailure(event.id);
      return;
    }

    // Keys arrived: replace the placeholder with the decrypted content. The
    // post-decrypt enrichment_status is computed from the decrypted event and its
    // timeline's live state (issues #5/#6): inactive timelines store 'inactive'
    // (deferred to the activation bulk-flip; no enrichment/caption nudge), active
    // timelines store 'pending'/'skipped' per needsEnrichment.
    const result = await this.#options.store.replaceUndecrypted(
      event.id,
      (existing) => decryptedCanonical(existing, summary!),
      postDecryptStatus,
    );
    this.#backoff.delete(event.id);

    // Only re-arm enrichment/captions and log a replacement when a real write
    // happened. A no-op (`replaced === false`) means the row was already
    // decrypted (the sweeper raced backfill / a message_summary touch) — nudging
    // again would re-enrich already-handled content and the log would be
    // misleading.
    if (!result || !result.replaced) return;
    const replaced = result.event;
    if (replaced.undecryptable) return;

    // A thread message stored UTD on the room timeline is re-homed to its thread
    // timeline once the decrypted relation is known; surface that move.
    if (replaced.timelineKey !== event.timelineKey) {
      this.#options.logger?.info("redecryption_rehomed_to_thread", {
        eventId: replaced.id,
        externalId: replaced.externalId,
        fromTimelineKey: event.timelineKey,
        toTimelineKey: replaced.timelineKey,
        threadId: replaced.threadId,
      });
    }

    // Notify enrichment/captions consistently with the STORED status (issues
    // #5/#6). For inactive timelines the status is 'inactive' and we notify
    // neither pool — activation's bulk-flip will pick the row up later. For active
    // timelines, nudge enrichment only when 'pending' and captions only when the
    // decrypted event actually has attachments.
    const hasMedia = (replaced.attachments?.length ?? 0) > 0;
    if (result.status === "pending") {
      this.#options.notifyEnrichment(replaced.id);
    }
    if (result.status !== "inactive" && hasMedia) {
      this.#options.notifyCaptions();
    }
    this.#options.logger?.info("redecryption_replaced", {
      eventId: replaced.id,
      externalId: replaced.externalId,
      hasMedia,
      enrichmentStatus: result.status,
    });
  }

  async #recordFailure(eventId: string): Promise<void> {
    // Persist the attempt so the row eventually crosses the give-up ceiling and
    // drops out of getUndecrypted (issue #1). Keep the in-memory backoff in sync
    // with the persisted count so backoff timing matches across restarts.
    const persisted = await this.#options.store.recordRedecryptFailure(eventId);
    const attempts = persisted ?? (this.#backoff.get(eventId)?.attempts ?? 0) + 1;
    this.#backoff.set(eventId, { attempts, nextAttemptAt: Date.now() + backoffDelay(attempts) });
  }
}

/** Exponential backoff delay (ms) for a given attempt count, capped. */
function backoffDelay(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

/**
 * Post-decrypt enrichment status for a re-decrypted event (issues #5/#6),
 * mirroring the live append path. An inactive timeline defers all work to the
 * activation bulk-flip (`'inactive'`); otherwise the status matches what the live
 * path would store for the same content (`needsEnrichment` → `'pending'` /
 * `'skipped'`).
 */
export function postDecryptStatus(
  updated: CanonicalChatEvent,
  timelineState: TimelineState,
): string {
  if (timelineState === "inactive") return "inactive";
  return needsEnrichment(updated) ? "pending" : "skipped";
}

/**
 * Resolve a single re-decryption probe across multiple bot accounts that may
 * share the room (issue #3). Tries each account's `fetch` (which throws when the
 * room is unknown to that account or the fetch fails) and combines the per-account
 * outcomes by precedence, returning the value the sweeper's `retry` contract
 * expects (issue #9):
 *
 *   1. decrypted message summary (non-null, not UTD) → returned (best outcome;
 *      short-circuits — no need to ask the remaining accounts).
 *   2. `null` (an account fetched & decrypted a non-renderable message) → `null`,
 *      so the sweeper retires the placeholder.
 *   3. a still-UTD summary (no account holds the megolm key) → that summary, so
 *      the sweeper keeps backing off.
 *   4. every account threw (none has the room / all fetch-failed) → rethrow the
 *      last error so the sweeper treats it as a transient failure. It must NOT
 *      collapse to `null` — that would falsely retire the row as a non-message.
 *
 * Behaviorally identical to a single-account probe: with one account the loop runs
 * once and returns exactly that account's outcome (or rethrows its error).
 */
export async function resolveMultiAccountRetry(
  accountIds: Iterable<string>,
  fetch: (accountId: string) => Promise<MatrixMessageSummary | null>,
): Promise<MatrixMessageSummary | null> {
  let utdSummary: MatrixMessageSummary | undefined;
  let sawNonMessage = false;
  let anyFetched = false;
  let lastError: unknown;
  for (const accountId of accountIds) {
    let summary: MatrixMessageSummary | null;
    try {
      summary = await fetch(accountId);
    } catch (error) {
      // Account not running or room unknown to it — try the next account.
      lastError = error;
      continue;
    }
    anyFetched = true;
    if (summary === null) {
      sawNonMessage = true;
      continue;
    }
    if (summary.undecryptable === true) {
      utdSummary = summary;
      continue;
    }
    return summary; // decrypted message — best possible result.
  }
  if (sawNonMessage) return null;
  if (utdSummary) return utdSummary;
  if (anyFetched) {
    // An account fetched but produced neither a summary nor a null (unreachable
    // given the branches above, but keep the row in rotation if it ever happens).
    return null;
  }
  if (lastError !== undefined) throw lastError;
  // No accounts were tried at all.
  throw new Error("redecryption: no account available to probe the event");
}

/**
 * Merge a now-decrypted native summary into the stored canonical event, clearing
 * the `undecryptable` flag and populating the real body/attachments. Identity
 * fields (id, timelineKey, role, timestamps, sender) are preserved from the
 * stored row; the summary supplies the decrypted content.
 */
export function decryptedCanonical(
  existing: CanonicalChatEvent,
  summary: MatrixMessageSummary,
): CanonicalChatEvent {
  const next: CanonicalChatEvent = {
    ...existing,
    body: summary.body,
    attachments: (summary.media ?? []).map((media) =>
      mediaToAttachment(summary.eventId, media),
    ),
  };
  if (summary.senderName && !next.sender.displayName) {
    next.sender = { ...next.sender, displayName: summary.senderName };
  }

  // The relation was encrypted at store time, so a stored UTD always landed on
  // the room timeline with `replyTo`/`threadId` unset. Now that the event is
  // decrypted, `summary.relatesTo` reveals its true placement. Mirror
  // `summaryToCanonical` in the backfill path so live and backfilled rows agree.
  const relType = summary.relatesTo?.relType ?? undefined;
  const relEventId = summary.relatesTo?.eventId ?? undefined;
  if (relType === "m.thread" && relEventId) {
    // A thread message belongs on the thread timeline, not the room timeline.
    // Re-home it: set the thread root and recompute the timeline key. The
    // canonical id (dedup key) is unchanged — only the placement moves.
    next.threadId = relEventId;
    const threadKey = threadTimelineKeyFrom(existing.timelineKey, relEventId);
    if (threadKey) next.timelineKey = threadKey;
  } else if (relType == null && relEventId) {
    // A bare in-reply-to (no rel_type) is a reply; record it so enrichment can
    // resolve the quoted context. `m.replace` (edits) and any other relation are
    // intentionally left unset — the original event carries the content, and a
    // UTD that turns out to be an edit should not masquerade as a normal message.
    next.replyTo = { externalId: relEventId };
  }

  delete next.undecryptable;
  return next;
}

/**
 * Build the thread timeline key for a re-homed re-decrypted event from the
 * room/DM timeline key it was stored under. Reuses the existing key scheme
 * (`matrix:<account>:(room|dm):<roomId>[:thread:<root>]`); the account segment is
 * `[^:]+` and the room id may contain colons. Returns undefined if the source
 * key isn't a recognizable room/DM key or already carries a thread suffix.
 */
function threadTimelineKeyFrom(timelineKey: string, threadRoot: string): string | undefined {
  const match = timelineKey.match(/^(matrix:[^:]+:(?:room|dm):.+?)(?::thread:.+)?$/);
  const base = match?.[1];
  if (!base) return undefined;
  return `${base}:thread:${threadRoot}`;
}

/**
 * Extract the Matrix room id from a timeline key. Keys are shaped
 * `matrix:<account>:room:<roomId>[:thread:<root>]` or
 * `matrix:<account>:dm:<roomId>`. A Matrix room id (`!local:server`) itself
 * contains a colon, so this captures everything between the `room:`/`dm:` marker
 * and an optional `:thread:` suffix rather than splitting on every colon.
 */
export function roomIdFromTimelineKey(timelineKey: string): string | undefined {
  const match = timelineKey.match(/^matrix:[^:]+:(?:room|dm):(.+?)(?::thread:.+)?$/);
  const roomId = match?.[1];
  return roomId && roomId.length > 0 ? roomId : undefined;
}
