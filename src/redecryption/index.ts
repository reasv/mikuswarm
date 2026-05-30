import type { Logger } from "../observability/index.js";
import type { TimelineStore } from "../timeline/index.js";
import type { CanonicalChatEvent } from "../types.js";
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
   * Retry a single event: re-fetch its summary by room + event id. Returns the
   * native summary (possibly still UTD) or null when the event can't be fetched.
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
   */
  async tick(): Promise<void> {
    if (this.#stopped || this.#options.isDraining()) return;
    const now = Date.now();
    const candidates = this.#options.store
      .getUndecrypted(this.#options.batchSize * 4)
      .filter((event) => {
        const entry = this.#backoff.get(event.id);
        return !entry || entry.nextAttemptAt <= now;
      })
      .slice(0, this.#options.batchSize);

    for (const event of candidates) {
      if (this.#stopped || this.#options.isDraining()) return;
      await this.#probe(event);
    }
  }

  async #probe(event: CanonicalChatEvent): Promise<void> {
    const roomId = roomIdFromTimelineKey(event.timelineKey);
    const eventId = event.externalId;
    if (!roomId || !eventId) {
      // Can't re-fetch without a room + Matrix event id; drop from rotation.
      this.#backoff.set(event.id, { nextAttemptAt: Infinity, attempts: 0 });
      return;
    }

    let summary: MatrixMessageSummary | null;
    try {
      summary = await this.#options.retry({ roomId, eventId });
    } catch (error) {
      this.#recordFailure(event.id);
      this.#options.logger?.warn("redecryption_retry_failed", {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!summary || summary.undecryptable === true) {
      // Still undecryptable (or unfetchable) — back off and try later.
      this.#recordFailure(event.id);
      return;
    }

    // Keys arrived: replace the placeholder with the decrypted content.
    const result = await this.#options.store.replaceUndecrypted(event.id, (existing) =>
      decryptedCanonical(existing, summary!),
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

    this.#options.notifyEnrichment(replaced.id);
    if (replaced.attachments && replaced.attachments.length > 0) {
      this.#options.notifyCaptions();
    }
    this.#options.logger?.info("redecryption_replaced", {
      eventId: replaced.id,
      externalId: replaced.externalId,
      hasMedia: (replaced.attachments?.length ?? 0) > 0,
    });
  }

  #recordFailure(eventId: string): void {
    const prev = this.#backoff.get(eventId);
    const attempts = (prev?.attempts ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    this.#backoff.set(eventId, { attempts, nextAttemptAt: Date.now() + delay });
  }
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
