/**
 * PacedLimiter: a generic paced request limiter with priority classes.
 *
 * Extracted from the Danbooru tool's `DanbooruRateLimiter` (same core algorithm:
 * synchronous start-instant reservation, FIFO admission with direct handoff).
 * Extended with two priority classes — `interactive` and `background` — backed
 * by two separate FIFO queues. A slot released is handed to the interactive
 * head first, then the background head, so a backfill burst of background work
 * never delays an interactive (user-facing) call.
 *
 * Callers that pass no class get single-queue behavior identical to the original
 * limiter (Danbooru uses this unchanged path).
 */

export type PacedLimiterClass = "interactive" | "background";

export interface PacedLimiterOptions {
  /** Minimum wall-clock interval between request *starts*, in milliseconds. */
  minIntervalMs: number;
  /** Maximum number of in-flight requests at any instant. */
  maxInFlight: number;
}

/**
 * A process-scoped paced limiter. Thread-safe within a single Node.js event
 * loop (single-threaded). The `run` method is the primary public interface:
 *
 * ```ts
 * const limiter = new PacedLimiter({ minIntervalMs: 1000, maxInFlight: 1 });
 * const result = await limiter.run(() => fetch(url));
 * // — or, with priority:
 * const result = await limiter.run(() => fetch(url), "interactive");
 * ```
 */
export class PacedLimiter {
  private active = 0;
  /** Next free start instant in the pacing schedule (epoch ms). */
  private nextStartMs = 0;
  /**
   * Two separate FIFO queues for the two priority classes plus the unclassified
   * callers. Interactive waiters are drained before background waiters.
   * `unclassed` behaves like a third queue drained last (Danbooru compat).
   */
  private readonly interactiveWaiters: Array<() => void> = [];
  private readonly backgroundWaiters: Array<() => void> = [];
  private readonly unclassedWaiters: Array<() => void> = [];

  constructor(private readonly opts: PacedLimiterOptions) {}

  /**
   * Run `fn` under the limiter. `fn` is called only when a slot is granted
   * and the pacing interval has elapsed. The slot is released when `fn`
   * settles (success or throw).
   *
   * @param fn   The work to pace.
   * @param cls  Optional priority class. Interactive callers are served before
   *             background ones when slots are contended. Unclassed callers
   *             (the Danbooru compat path) share one queue drained last.
   */
  async run<T>(fn: () => Promise<T>, cls?: PacedLimiterClass): Promise<T> {
    await this.acquire(cls);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private pickNextWaiter(): (() => void) | undefined {
    // Drain interactive first, then background, then unclassed.
    return (
      this.interactiveWaiters.shift() ??
      this.backgroundWaiters.shift() ??
      this.unclassedWaiters.shift()
    );
  }

  private queueFor(cls: PacedLimiterClass | undefined): Array<() => void> {
    if (cls === "interactive") return this.interactiveWaiters;
    if (cls === "background") return this.backgroundWaiters;
    return this.unclassedWaiters;
  }

  private hasPendingWaiters(): boolean {
    return (
      this.interactiveWaiters.length > 0 ||
      this.backgroundWaiters.length > 0 ||
      this.unclassedWaiters.length > 0
    );
  }

  private async acquire(cls: PacedLimiterClass | undefined): Promise<void> {
    // Slot admission: FIFO within each priority tier, with DIRECT HANDOFF on
    // release. A caller queues when the limiter is saturated OR anyone else is
    // already queued (no overtaking within a tier). `release` transfers slot
    // ownership to the highest-priority waiter WITHOUT decrementing `active`,
    // so a fresh caller arriving between the release and the waiter's resumption
    // can never double-grant the freed slot past `maxInFlight`.
    if (this.active >= this.opts.maxInFlight || this.hasPendingWaiters()) {
      await new Promise<void>((resolve) => this.queueFor(cls).push(resolve));
      // Slot ownership was handed over in release(); `active` already counts us.
    } else {
      this.active += 1;
    }
    // Pacing: reserve this request's start instant SYNCHRONOUSLY (before any
    // await), so concurrent acquirers each claim a distinct slot in the schedule
    // instead of reading the same stale "last start" and waking together.
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartMs);
    this.nextStartMs = startAt + this.opts.minIntervalMs;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }

  private release(): void {
    const next = this.pickNextWaiter();
    if (next) {
      // Direct handoff: the slot stays counted in `active` and now belongs to
      // the head waiter (highest-priority first).
      next();
      return;
    }
    this.active -= 1;
  }
}
