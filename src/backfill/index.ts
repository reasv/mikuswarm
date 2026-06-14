import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import { applyEditToCanonical, editStatus } from "../timeline/index.js";
import type { MatrixMessageSummary } from "../matrix/native-types.js";
import { classifyForTimeline } from "./classify.js";
import { paginateBackward, type BackfillReadClient, type MessageDisposition } from "./paginate.js";

export type { BackfillReadClient } from "./paginate.js";
export { BackfillTimeoutError } from "./paginate.js";

export interface InitialBackfillOptions {
  client: BackfillReadClient;
  store: TimelineStore;
  storage: Storage;
  /** Timeline being activated (room, DM, or thread). */
  timelineKey: string;
  roomId: string;
  accountId: string;
  /** The bot's own Matrix user ID, for role assignment. */
  selfUserId: string;
  /** Stop after this many newly-stored messages. 0 → no backfill. */
  maxMessages: number;
  /**
   * Stop at the first kept message older than this far before the activation
   * anchor (ms); that message is NOT stored. Enforced per message, not per
   * page, so a single sparse page spanning months cannot smuggle old history
   * past the window.
   */
  windowMs: number;
  /**
   * The activation moment — the trigger event's timestamp. The window floor is
   * anchored here (`anchorTimestamp - windowMs`), so `windowMs` means "fetch this
   * much history before activation" regardless of any older pre-activation
   * (inactive) events already stored. Falls back to `Date.now()` if unset.
   */
  anchorTimestamp?: number;
  /** Overall fetch budget (ms); the first trigger is held at most this long. */
  timeoutMs: number;
  /** Messages per page request (clamped 1–1000). Defaults to 100. */
  pageSize?: number;
  /**
   * Stop paging after this many *consecutive* stored undecryptable (UTD) events
   * — a long UTD run means we've paged into history we lack keys for, with no
   * useful forward progress. Counter resets on any non-UTD stored event.
   * Defaults to 50; 0 disables the guard.
   */
  utdHaltThreshold?: number;
  logger?: Logger;
}

export interface InitialBackfillResult {
  /** Summaries seen across all pages. */
  fetched: number;
  /** Newly-stored messages belonging to this timeline (excludes duplicates). */
  stored: number;
  reachedCount: boolean;
  reachedWindow: boolean;
  exhausted: boolean;
  timedOut: boolean;
  /** A non-timeout read failure interrupted pagination; the result is partial. */
  errored: boolean;
  /** Message of the read failure when `errored` is true. */
  error?: string;
  /** Paging stopped after a long run of consecutive undecryptable (UTD) events. */
  haltedOnUtd: boolean;
}

/**
 * Fetch recent room history backward from the room head on first-trigger
 * activation (§4 step 3). Pages backward via `readMessages` (no `before` token
 * starts at the head; each subsequent page uses the previous result's
 * `nextBatch` — the backward continuation token), storing each non-UTD message
 * with `enrichment_status='inactive'` (UTD messages with `'skipped'`). Dedup is
 * handled by `appendIfMissing` against the canonical Matrix event ID, so the
 * trigger event and any already-stored inactive events are not re-inserted.
 * Storing 'inactive' (not 'pending') keeps the catch-path invariant — a failed
 * activation must not leave enrichable rows under an inactive timeline; the
 * post-readiness `activateTimelineEvents` bulk-flip activates them on success.
 *
 * Stops at the first of: `maxMessages` newly stored, a kept message older than
 * the window floor (`anchorTimestamp - windowMs`, anchored to the activation
 * moment — checked per message BEFORE storing, so nothing older than the window
 * is ever persisted), history exhausted (or its pagination token failing to
 * advance), a read failure, or the timeout — the trigger is held until then.
 * Backward `/messages` pages are reverse-chronological, so breaking at the
 * first too-old kept message is a clean stop; anything after it in the page is
 * older still (modulo origin_server_ts jitter, which can at worst drop a
 * borderline in-window message — acceptable for a window heuristic).
 *
 * `readMessages` returns the whole room timeline (thread child events and edits
 * included), so messages are filtered to the activated timeline: a thread
 * timeline keeps only that thread's messages; a room/DM timeline excludes
 * thread messages.
 *
 * Edits (`m.replace`) are NOT dropped (#1). matrix-sdk's `room.messages()` does
 * not fold edits into their originals — the original keeps its pre-edit body and
 * the edit is a separate event — so dropping edits would leave the backfilled
 * original rendering its stale body. Instead each `m.replace` is routed through
 * the same `store.applyEdit` primitive the live and re-decryption paths use:
 * applied in place if the target is already stored, otherwise parked in
 * `pending_edits` and replayed by `appendIfMissing` once the target lands later
 * in a backward page. `editStatus` preserves `'inactive'` on the edited target,
 * so the activation bulk-flip still governs enrichment.
 *
 * UTD events (`undecryptable`) carry no readable relation — their thread/edit
 * metadata is megolm-encrypted — so during a thread-timeline activation they are
 * stored on the *room* timeline rather than dropped (#5), mirroring the live UTD
 * path; the re-decryption sweeper re-homes them to the thread once keys arrive.
 */
export async function performInitialBackfill(
  options: InitialBackfillOptions,
): Promise<InitialBackfillResult> {
  const { client, store, timelineKey, roomId, accountId, selfUserId, maxMessages, windowMs, logger } =
    options;

  if (maxMessages <= 0) {
    return {
      fetched: 0,
      stored: 0,
      reachedCount: false,
      reachedWindow: false,
      exhausted: false,
      timedOut: false,
      errored: false,
      haltedOnUtd: false,
    };
  }

  // Anchor the window to the activation moment (the trigger timestamp), NOT the
  // oldest already-stored event. On a channel with months of pre-activation
  // inactive history, anchoring to the oldest stored event would push the floor
  // far into the past and the cap would never bite. `windowMs` means "fetch this
  // much history before activation."
  const anchor = options.anchorTimestamp ?? Date.now();
  const windowFloor = anchor - windowMs;

  const onMessage = async (
    summary: MatrixMessageSummary,
    timestamp: number,
  ): Promise<MessageDisposition> => {
    const classified = classifyForTimeline(summary, {
      accountId,
      selfUserId,
      timelineKey,
      timestamp,
    });
    if (!classified) return "skip"; // not part of the activated timeline

    // Window floor, enforced per kept message BEFORE storing (edits included —
    // an edit older than the floor targets an even older message). Checking per
    // message (not per page) keeps a single sparse page spanning months from
    // being stored wholesale.
    if (timestamp < windowFloor) return "window";

    if (classified.kind === "edit") {
      const { replacement, targetExternalId } = classified;
      const editResult = await store.applyEdit(
        "matrix",
        targetExternalId,
        timelineKey,
        replacement,
        timestamp,
        (target) => applyEditToCanonical(target, replacement),
        editStatus,
      );
      logger?.debug("initial_backfill_edit", {
        timelineKey,
        editEventId: summary.eventId,
        targetExternalId,
        applied: editResult.applied,
      });
      return "edit";
    }

    const event = classified.event;
    const isUtd = event.undecryptable != null;
    // A normal event is stored 'inactive' — NOT 'pending' — so a failed
    // activation leaves it 'inactive' rather than stranding it 'pending' under an
    // inactive timeline; the post-readiness `activateTimelineEvents` bulk-flip
    // activates the backlog on success. A UTD event is stored 'skipped'.
    const { duplicate } = await store.appendIfMissing(event, isUtd ? "skipped" : "inactive");
    if (duplicate) return "duplicate";
    return isUtd ? "stored-utd" : "stored";
  };

  const result = await paginateBackward({
    client,
    roomId,
    pageSize: options.pageSize,
    maxMessages,
    timeoutMs: options.timeoutMs,
    utdHaltThreshold: options.utdHaltThreshold,
    logger,
    readFailedEvent: "initial_backfill_read_failed",
    logFields: { timelineKey },
    onMessage,
  });

  return {
    fetched: result.fetched,
    stored: result.stored,
    reachedCount: result.reachedCount,
    reachedWindow: result.reachedWindow,
    exhausted: result.exhausted,
    timedOut: result.timedOut,
    errored: result.errored,
    ...(result.error !== undefined ? { error: result.error } : {}),
    haltedOnUtd: result.haltedOnUtd,
  };
}
