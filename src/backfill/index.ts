import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
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
  /** Stop once a fetched page reaches this far before the activation anchor (ms). */
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
}

class BackfillTimeoutError extends Error {}

/**
 * Fetch recent room history backward from the room head on first-trigger
 * activation (§4 step 3). Pages backward via `readMessages` (no `before` token
 * starts at the head; each subsequent page uses the previous result's
 * `nextBatch` — the backward continuation token), storing each message with
 * `enrichment_status='pending'`. Dedup is handled by `appendIfMissing` against
 * the canonical Matrix event ID, so the trigger event and any already-stored
 * inactive events are not re-inserted.
 *
 * Stops at the first of: `maxMessages` newly stored, a page crossing the window
 * floor (`anchorTimestamp - windowMs`, anchored to the activation moment),
 * history exhausted (or its pagination token failing to advance), a read
 * failure, or the timeout — the trigger is held until then.
 *
 * `readMessages` returns the whole room timeline (thread child events and edits
 * included), so messages are filtered to the activated timeline: a thread
 * timeline keeps only that thread's messages; a room/DM timeline excludes
 * thread messages. Edits (`m.replace`) are skipped — the original message
 * carries the content.
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

  const result: InitialBackfillResult = {
    fetched: 0,
    stored: 0,
    reachedCount: false,
    reachedWindow: false,
    exhausted: false,
    timedOut: false,
    errored: false,
  };
  if (maxMessages <= 0) return result;

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

    let pageMinTimestamp = Infinity;
    for (const summary of page.messages) {
      result.fetched++;
      const parsed = Date.parse(summary.timestamp);
      const timestamp = Number.isFinite(parsed) ? parsed : Date.now();
      pageMinTimestamp = Math.min(pageMinTimestamp, timestamp);

      const event = summaryToCanonical(summary, {
        accountId,
        selfUserId,
        timelineKey,
        threadRootId,
        timestamp,
      });
      if (!event) continue; // not part of the activated timeline (thread/edit filtering)

      const { duplicate } = await store.appendIfMissing(event, "pending");
      if (!duplicate) {
        result.stored++;
        if (result.stored >= maxMessages) {
          result.reachedCount = true;
          break;
        }
      }
    }
    if (result.reachedCount) break;

    if (pageMinTimestamp < windowFloor) {
      result.reachedWindow = true;
      break;
    }

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

/**
 * Convert a `readMessages` summary to a canonical event, or undefined when the
 * message does not belong to the activated timeline. The canonical ID matches
 * `normalizeMatrixInboundEvent`'s scheme so live and backfilled rows dedup.
 */
function summaryToCanonical(
  summary: MatrixMessageSummary,
  ctx: SummaryContext,
): CanonicalChatEvent | undefined {
  const relType = summary.relatesTo?.relType ?? undefined;
  const relEventId = summary.relatesTo?.eventId ?? undefined;

  if (relType === "m.replace") return undefined;
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
  };
}

function threadRootFromKey(timelineKey: string): string | undefined {
  const marker = ":thread:";
  const index = timelineKey.indexOf(marker);
  return index >= 0 ? timelineKey.slice(index + marker.length) : undefined;
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
