import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import { applyEditToCanonical, editStatus } from "../timeline/index.js";
import type { CanonicalChatEvent } from "../types.js";
import { mediaToAttachment } from "../matrix/inbound.js";
import type {
  MatrixMessageSummary,
  MatrixReadMessagesRequest,
  MatrixReadMessagesResult,
} from "../matrix/native-types.js";

/** Minimal slice of the native client needed for backward history paging. */
export interface BackfillReadClient {
  readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult>;
}

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

class BackfillTimeoutError extends Error {}

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
  const {
    client,
    store,
    storage,
    timelineKey,
    roomId,
    accountId,
    selfUserId,
    maxMessages,
    windowMs,
    anchorTimestamp,
    timeoutMs,
    logger,
  } = options;
  const utdHaltThreshold = options.utdHaltThreshold ?? 50;

  const result: InitialBackfillResult = {
    fetched: 0,
    stored: 0,
    reachedCount: false,
    reachedWindow: false,
    exhausted: false,
    timedOut: false,
    errored: false,
    haltedOnUtd: false,
  };
  if (maxMessages <= 0) return result;

  // Consecutive-UTD counter (§5): increments per stored UTD event, resets to 0
  // on any non-UTD stored event. A long run means no useful forward progress.
  let consecutiveUtd = 0;

  const threadRootId = threadRootFromKey(timelineKey);
  // Anchor the window to the activation moment (the trigger timestamp), NOT the
  // oldest already-stored event. On a channel with months of pre-activation
  // inactive history, anchoring to the oldest stored event would push the floor
  // far into the past and the cap would never bite. `windowMs` means "fetch this
  // much history before activation."
  const anchor = anchorTimestamp ?? Date.now();
  const windowFloor = anchor - windowMs;
  const deadline = Date.now() + timeoutMs;
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 1000);

  let before: string | undefined;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.timedOut = true;
      break;
    }

    let page: MatrixReadMessagesResult;
    try {
      page = await withDeadline(client.readMessages({ roomId, limit: pageSize, before }), remaining);
    } catch (error) {
      if (error instanceof BackfillTimeoutError) {
        result.timedOut = true;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        result.errored = true;
        result.error = message;
        logger?.warn("initial_backfill_read_failed", {
          timelineKey,
          error: message,
        });
      }
      break;
    }

    if (page.messages.length === 0) {
      result.exhausted = true;
      break;
    }

    for (const summary of page.messages) {
      result.fetched++;
      const parsed = Date.parse(summary.timestamp);
      const timestamp = Number.isFinite(parsed) ? parsed : Date.now();

      const classified = classifySummary(summary, {
        accountId,
        selfUserId,
        timelineKey,
        threadRootId,
        timestamp,
      });
      if (!classified) continue; // not part of the activated timeline (thread filtering)

      // Window floor, enforced per kept message BEFORE storing (edits included
      // — an edit older than the floor targets an even older message). Only
      // messages kept for this timeline are checked (#1): `readMessages`
      // returns the whole room timeline, so a page dominated by non-thread
      // traffic must not stop thread backfill short; a fully-filtered page
      // keeps paging on the token. Checking per message (not per page) is what
      // keeps a single sparse page spanning months from being stored wholesale.
      if (timestamp < windowFloor) {
        result.reachedWindow = true;
        break;
      }

      if (classified.kind === "edit") {
        // An `m.replace` is not a standalone message and never counts toward the
        // stored cap or the UTD run; route it through the same store primitive
        // the live and re-decryption paths use (#1). Applied in place if the
        // target is already stored, otherwise parked in `pending_edits` and
        // replayed by `appendIfMissing` once the target lands in a later backward
        // page. `editStatus` keeps an inactive target's status `'inactive'`, so
        // the activation bulk-flip still governs enrichment.
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
        continue;
      }

      const event = classified.event;
      const isUtd = event.undecryptable != null;

      // A UTD event is stored with `enrichment_status='skipped'` (no body/media
      // to enrich; the redecryption sweeper handles it once keys arrive, and it
      // respects inactive timelines). A normal event is stored 'inactive' — NOT
      // 'pending' — so a failed activation (readiness throws or the process
      // crashes before reaching 'active') leaves it 'inactive' rather than
      // stranding it 'pending' and enriching it under an inactive timeline. The
      // post-readiness `activateTimelineEvents` bulk-flip ('inactive'→'pending')
      // activates these together with the rest of the backlog on success.
      const { duplicate } = await store.appendIfMissing(event, isUtd ? "skipped" : "inactive");

      // Advance the consecutive-UTD run ONLY on a real (newly-stored) event (#5):
      // re-paged duplicates are history we already hold, not new dead history, so
      // counting them would let an already-stored UTD region halt the fetch early.
      // A newly-stored non-UTD event is forward progress and resets the run.
      if (!duplicate) {
        if (isUtd) {
          consecutiveUtd++;
        } else {
          consecutiveUtd = 0;
        }
        result.stored++;
        if (result.stored >= maxMessages) {
          result.reachedCount = true;
          break;
        }
      }

      if (utdHaltThreshold > 0 && consecutiveUtd >= utdHaltThreshold) {
        result.haltedOnUtd = true;
        break;
      }
    }
    if (result.reachedCount || result.haltedOnUtd || result.reachedWindow) break;

    const nextBefore = page.nextBatch ?? undefined;
    if (!nextBefore) {
      result.exhausted = true;
      break;
    }
    // Spin guard: if the homeserver returns the same continuation token it was
    // just given, pagination is not advancing and would burn the full timeout on
    // a stable non-null token. Treat history as exhausted. This is keyed on the
    // token, not on `stored`, so the legitimate "page fully deduped/filtered but
    // token advances" case keeps paging.
    if (nextBefore === before) {
      result.exhausted = true;
      break;
    }
    before = nextBefore;
  }

  return result;
}

interface SummaryContext {
  accountId: string;
  selfUserId: string;
  timelineKey: string;
  threadRootId: string | undefined;
  timestamp: number;
}

/** A summary classified for backfill: a kept event, an edit to apply, or dropped. */
type ClassifiedSummary =
  | { kind: "event"; event: CanonicalChatEvent }
  | {
      kind: "edit";
      targetExternalId: string;
      replacement: { body: string; attachments: ReturnType<typeof mediaToAttachment>[] };
    };

/**
 * Classify a `readMessages` summary for backfill, or undefined when it does not
 * belong to the activated timeline (thread filtering). Returns:
 *  - `kind: "edit"` for an `m.replace`, with the resolved replacement to route
 *    through `store.applyEdit` (#1) — never a standalone row.
 *  - `kind: "event"` for a kept message; the canonical ID matches
 *    `normalizeMatrixInboundEvent`'s scheme so live and backfilled rows dedup.
 *
 * A UTD summary carries no readable relation (its thread/edit metadata is
 * megolm-encrypted), so it is kept on the *room* timeline even when a thread is
 * being activated (#5), mirroring the live UTD path; the re-decryption sweeper
 * re-homes it to the thread once keys arrive.
 */
function classifySummary(
  summary: MatrixMessageSummary,
  ctx: SummaryContext,
): ClassifiedSummary | undefined {
  const relType = summary.relatesTo?.relType ?? undefined;
  const relEventId = summary.relatesTo?.eventId ?? undefined;

  // A UTD event has no decryptable relation, so it can't be filtered by thread
  // membership and is never an applyable edit. Land it on the room timeline (not
  // the thread key) so the sweeper can re-home it on decrypt — never dropped.
  if (summary.undecryptable) {
    const roomKey = ctx.threadRootId ? roomTimelineKeyFromKey(ctx.timelineKey) : ctx.timelineKey;
    const isSelf = summary.sender === ctx.selfUserId;
    return {
      kind: "event",
      event: {
        id: `matrix:${ctx.accountId}:${summary.eventId}`,
        externalId: summary.eventId,
        timelineKey: roomKey,
        provider: "matrix",
        role: isSelf ? "assistant" : "user",
        sender: { id: summary.sender, displayName: summary.senderName, isSelf },
        body: summary.body,
        timestamp: ctx.timestamp,
        receivedAt: Date.now(),
        attachments: [],
        threadId: undefined,
        replyTo: undefined,
        undecryptable: { sessionId: summary.sessionId, reason: summary.utdReason },
      },
    };
  }

  if (relType === "m.replace") {
    if (!relEventId) return undefined; // malformed edit with no target — drop.
    return {
      kind: "edit",
      targetExternalId: relEventId,
      replacement: {
        body: summary.body,
        attachments: (summary.media ?? []).map((media) =>
          mediaToAttachment(summary.eventId, media),
        ),
      },
    };
  }

  const isThreadMessage = relType === "m.thread";
  if (ctx.threadRootId) {
    if (!isThreadMessage || relEventId !== ctx.threadRootId) return undefined;
  } else if (isThreadMessage) {
    return undefined;
  }

  const isSelf = summary.sender === ctx.selfUserId;
  // A non-thread message whose relation is a bare in-reply-to (no rel_type) is a
  // reply; record it so enrichment can resolve the quoted context.
  const replyTo = !isThreadMessage && relType == null && relEventId ? { externalId: relEventId } : undefined;

  return {
    kind: "event",
    event: {
      id: `matrix:${ctx.accountId}:${summary.eventId}`,
      externalId: summary.eventId,
      timelineKey: ctx.timelineKey,
      provider: "matrix",
      role: isSelf ? "assistant" : "user",
      sender: { id: summary.sender, displayName: summary.senderName, isSelf },
      body: summary.body,
      timestamp: ctx.timestamp,
      receivedAt: Date.now(),
      // Emit the same attachment shape as the live path so backfilled media flows
      // through the identical download + caption pipeline (keyed by event ID).
      attachments: (summary.media ?? []).map((media) =>
        mediaToAttachment(summary.eventId, media),
      ),
      threadId: ctx.threadRootId,
      replyTo,
      undecryptable: undefined,
    },
  };
}

function threadRootFromKey(timelineKey: string): string | undefined {
  const marker = ":thread:";
  const index = timelineKey.indexOf(marker);
  return index >= 0 ? timelineKey.slice(index + marker.length) : undefined;
}

/**
 * Strip a `:thread:<root>` suffix to recover the room/DM timeline key (#5). A
 * thread key is `matrix:<account>:(room|dm):<roomId>:thread:<root>`; the room id
 * may itself contain colons, so split on the `:thread:` marker rather than on
 * every colon. A key with no thread suffix is returned unchanged.
 */
function roomTimelineKeyFromKey(timelineKey: string): string {
  const marker = ":thread:";
  const index = timelineKey.indexOf(marker);
  return index >= 0 ? timelineKey.slice(0, index) : timelineKey;
}

/**
 * Reject with BackfillTimeoutError after `ms`. The underlying promise is left to
 * settle on its own (the native call can't be cancelled); handlers are attached
 * so it never surfaces as an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackfillTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
