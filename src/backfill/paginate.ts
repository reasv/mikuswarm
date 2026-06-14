import type { Logger } from "../observability/index.js";
import type {
  MatrixMessageSummary,
  MatrixReadMessagesRequest,
  MatrixReadMessagesResult,
} from "../matrix/native-types.js";

/** Minimal slice of the native client needed for backward history paging. */
export interface BackfillReadClient {
  readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult>;
}

/**
 * How a per-message handler classified one summary, telling the pagination
 * engine how to account for it and whether to keep going. The engine owns the
 * universal bookkeeping (fetched/stored counts, the cap, the consecutive-UTD
 * halt) so the two callers — first-trigger initial backfill (insert-as-you-page)
 * and startup gap backfetch (buffer-then-commit) — share the fiddly paging core
 * (§6.5) and differ only in classification, routing, and the store-vs-buffer
 * side effect.
 *
 * - `"skip"`      — not part of the scope being fetched (thread filtering); keep
 *                   paging, no accounting, no UTD-run change.
 * - `"edit"`      — handled as an `m.replace` (applied/buffered); never a
 *                   standalone row, so it does not count toward the cap and does
 *                   not touch the UTD run.
 * - `"window"`    — older than the window floor; STOP (sets `reachedWindow`).
 * - `"floor"`     — reached the room's committed high-water (gap backfetch only);
 *                   STOP (sets `reachedFloor`). The floor message itself is not
 *                   recorded.
 * - `"stored"`    — a newly-recorded non-UTD message; counts toward the cap and
 *                   resets the consecutive-UTD run.
 * - `"stored-utd"`— a newly-recorded UTD message; counts toward the cap and
 *                   advances the consecutive-UTD run.
 * - `"duplicate"` — already held (initial backfill's dedup); no count, no UTD-run
 *                   change. Re-paged duplicates must not advance the UTD run, else
 *                   an already-stored dead-history region could halt early.
 */
export type MessageDisposition =
  | "skip"
  | "edit"
  | "window"
  | "floor"
  | "stored"
  | "stored-utd"
  | "duplicate";

export interface BackwardPaginateOptions {
  client: BackfillReadClient;
  roomId: string;
  /** Messages per page request (clamped 1–1000). Defaults to 100. */
  pageSize?: number;
  /**
   * Stop after this many newly-recorded messages. `<= 0` ⇒ no cap (unbounded) —
   * the gap-backfetch default. (Initial backfill early-returns on `<= 0` before
   * ever calling here, so for it this is always positive.)
   */
  maxMessages: number;
  /** Overall fetch budget (ms). `<= 0` ⇒ no timeout. */
  timeoutMs: number;
  /**
   * Stop paging after this many *consecutive* recorded undecryptable (UTD)
   * events. 0 disables the guard. Defaults to 50.
   */
  utdHaltThreshold?: number;
  logger?: Logger;
  /** Log event name + fields for a read failure (caller-specific). */
  readFailedEvent: string;
  logFields?: Record<string, unknown>;
  /**
   * Per-summary handler: classify the summary (routing, window/floor decision)
   * and perform its store/buffer side effect, returning the disposition. The
   * engine drives paging and owns all counting from the returned dispositions.
   */
  onMessage: (
    summary: MatrixMessageSummary,
    timestamp: number,
  ) => Promise<MessageDisposition> | MessageDisposition;
}

export interface BackwardPaginateResult {
  /** Summaries seen across all pages. */
  fetched: number;
  /** Newly-recorded messages (excludes duplicates/edits/skips). */
  stored: number;
  reachedCount: boolean;
  reachedWindow: boolean;
  /** Reached the room's committed high-water — gap fully closed (gap backfetch). */
  reachedFloor: boolean;
  exhausted: boolean;
  timedOut: boolean;
  /** A non-timeout read failure interrupted pagination; the result is partial. */
  errored: boolean;
  /** Message of the read failure when `errored` is true. */
  error?: string;
  /** Paging stopped after a long run of consecutive undecryptable (UTD) events. */
  haltedOnUtd: boolean;
}

export class BackfillTimeoutError extends Error {}

/**
 * Drive backward `/messages` pagination from the room head (no `before` token)
 * and feed every summary to `onMessage`. Each page's `nextBatch` becomes the next
 * `before` (the backward continuation token). Between pages the standard
 * exhaust / spin-guard / deadline checks apply. The engine accounts for each
 * message from `onMessage`'s returned {@link MessageDisposition} and stops at the
 * first of: cap reached, window floor crossed, room floor reached, history
 * exhausted (or a non-advancing token), the timeout, a read failure, or a long
 * run of consecutive UTD events.
 */
export async function paginateBackward(
  options: BackwardPaginateOptions,
): Promise<BackwardPaginateResult> {
  const { client, roomId, maxMessages, timeoutMs, logger, readFailedEvent, onMessage } = options;
  const utdHaltThreshold = options.utdHaltThreshold ?? 50;
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 1000);
  // `timeoutMs <= 0` means "no timeout": use an effectively-infinite deadline so
  // the remaining-budget check never trips and `withDeadline` never fires.
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  const result: BackwardPaginateResult = {
    fetched: 0,
    stored: 0,
    reachedCount: false,
    reachedWindow: false,
    reachedFloor: false,
    exhausted: false,
    timedOut: false,
    errored: false,
    haltedOnUtd: false,
  };

  // Consecutive-UTD counter: advanced per recorded UTD message, reset on any
  // recorded non-UTD message. A long run means no useful forward progress.
  let consecutiveUtd = 0;
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
        logger?.warn(readFailedEvent, { ...options.logFields, error: message });
      }
      break;
    }

    if (page.messages.length === 0) {
      result.exhausted = true;
      break;
    }

    let stop = false;
    for (const summary of page.messages) {
      result.fetched++;
      const parsed = Date.parse(summary.timestamp);
      const timestamp = Number.isFinite(parsed) ? parsed : Date.now();

      const disposition = await onMessage(summary, timestamp);
      if (disposition === "skip" || disposition === "edit") continue;
      if (disposition === "window") {
        result.reachedWindow = true;
        stop = true;
        break;
      }
      if (disposition === "floor") {
        result.reachedFloor = true;
        stop = true;
        break;
      }
      if (disposition === "stored" || disposition === "stored-utd") {
        if (disposition === "stored-utd") consecutiveUtd++;
        else consecutiveUtd = 0;
        result.stored++;
        if (maxMessages > 0 && result.stored >= maxMessages) {
          result.reachedCount = true;
          stop = true;
          break;
        }
      }
      // `duplicate` falls through with the UTD run unchanged.
      if (utdHaltThreshold > 0 && consecutiveUtd >= utdHaltThreshold) {
        result.haltedOnUtd = true;
        stop = true;
        break;
      }
    }
    if (stop) break;

    const nextBefore = page.nextBatch ?? undefined;
    if (!nextBefore) {
      result.exhausted = true;
      break;
    }
    // Spin guard: a homeserver that returns the same continuation token it was
    // just given is not advancing; treat history as exhausted rather than burning
    // the full budget on a stable non-null token. Keyed on the token (not on
    // `stored`) so the legitimate "page fully deduped/filtered but token advances"
    // case keeps paging.
    if (nextBefore === before) {
      result.exhausted = true;
      break;
    }
    before = nextBefore;
  }

  return result;
}

/**
 * Reject with {@link BackfillTimeoutError} after `ms`. The underlying promise is
 * left to settle on its own (the native call can't be cancelled); handlers are
 * attached so it never surfaces as an unhandled rejection. A non-finite `ms`
 * (no-timeout mode) installs no timer.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
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
