// ---------------------------------------------------------------------------
// SauceNaoRateLimiter — in-memory short-window guard for the SauceNAO account
// quota (spec SAUCENAO-SOURCE-LOOKUP §4).
//
// SauceNAO's free tier limits searches in a short sliding window (~6 / 30s) and
// a long daily window (~200 / day). The short window is the one a busy bot will
// actually hit between turns, so it is the only one this guard *enforces*; the
// daily window is merely SURFACED from SauceNAO's authoritative counters
// (`long_remaining`) and left to its own 429 (see the tool). The SauceNAO quota
// is per-ACCOUNT (global), so this limiter is constructed ONCE at app startup
// and shared across every session — a per-session limiter would not bound the
// shared budget.
//
// It composes with, and is orthogonal to, the per-host HTTP limiter in
// `http-limiter.ts` (which bounds concurrency/back-off per host) and the SSRF
// egress guard — this limiter only adds the account-quota dimension neither of
// those models.
//
// `Date.now()` is used for the sliding window; the workflow-script `Date.now()`
// ban is a workflow-runtime constraint and does not apply to app code. The clock
// is injectable so the admission/reconciliation logic is unit-testable
// deterministically.
// ---------------------------------------------------------------------------

export interface SauceNaoRateLimiterOptions {
  /** Max admissions permitted within `shortWindowMs` (default-tuned ~6). */
  shortWindowMax: number;
  /** Sliding-window length in ms (default-tuned ~30000). */
  shortWindowMs: number;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
}

export type SauceNaoAcquireResult =
  | { admitted: true }
  /**
   * The short window is full and a slot would not free within `maxWaitMs`. The
   * caller surfaces this as a soft text result rather than blocking the turn.
   */
  | { admitted: false; waitMs: number };

export class SauceNaoRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  /** Start instants (epoch ms) of admissions still inside the window. */
  private starts: number[] = [];

  constructor(opts: SauceNaoRateLimiterOptions) {
    this.max = Math.max(1, Math.floor(opts.shortWindowMax));
    this.windowMs = Math.max(1, opts.shortWindowMs);
    this.now = opts.now ?? Date.now;
  }

  /** Drop admissions that have aged out of the window relative to `now`. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.starts.length === 0 || this.starts[0]! > cutoff) return;
    this.starts = this.starts.filter((t) => t > cutoff);
  }

  /**
   * ms until a slot frees (0 when one is free now). Pure read against `now`
   * (prunes expired entries as a side effect, which only ever frees capacity).
   */
  msUntilSlot(now: number = this.now()): number {
    this.prune(now);
    if (this.starts.length < this.max) return 0;
    // The oldest in-window admission falls out at `starts[0] + windowMs`.
    return Math.max(0, this.starts[0]! + this.windowMs - now);
  }

  /**
   * Synchronously claim a slot if one is free at `now`. Returns true on success.
   * The prune+check+push runs with no intervening await, so concurrent callers
   * (single-threaded JS) cannot both claim the last slot.
   */
  tryAcquire(now: number = this.now()): boolean {
    this.prune(now);
    if (this.starts.length >= this.max) return false;
    this.starts.push(now);
    return true;
  }

  /**
   * Admit one SauceNAO search, waiting up to `maxWaitMs` for the short window to
   * free a slot. Resolves `{ admitted: true }` once a slot is claimed, or
   * `{ admitted: false, waitMs }` when the wait would exceed `maxWaitMs` (the
   * caller turns that into a soft "try again shortly" result). Rejects if
   * `signal` aborts while waiting.
   */
  async acquire(opts: { signal?: AbortSignal; maxWaitMs: number }): Promise<SauceNaoAcquireResult> {
    const maxWaitMs = Math.max(0, opts.maxWaitMs);
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      if (this.tryAcquire()) return { admitted: true };
      const waitMs = this.msUntilSlot();
      if (waitMs > maxWaitMs) return { admitted: false, waitMs };
      // Wait the smaller of the time-to-slot and the remaining budget, then
      // re-check (another waiter may have taken the slot we were waiting for).
      await sleep(Math.max(1, Math.min(waitMs, maxWaitMs)), opts.signal);
    }
  }

  /**
   * Reconcile the in-memory window against SauceNAO's authoritative short-window
   * counter from a response header (`short_remaining`, optionally `short_limit`).
   * The server's view beats our local count: if it reports fewer remaining than
   * we think, pad the window so we stop sooner; if more, trim so we don't stall
   * unnecessarily. Best-effort — ignores non-finite/negative inputs.
   */
  reconcileShort(shortRemaining: number, shortLimit?: number, now: number = this.now()): void {
    if (!Number.isFinite(shortRemaining) || shortRemaining < 0) return;
    this.prune(now);
    const limit = Number.isFinite(shortLimit) && (shortLimit as number) > 0 ? Math.floor(shortLimit as number) : this.max;
    const used = Math.max(0, Math.min(limit, limit - Math.floor(shortRemaining)));
    if (used > this.starts.length) {
      // Server counts more used than we do: pad with `now` stamps (they age out
      // over the full window — conservative, the safe direction).
      while (this.starts.length < used) this.starts.push(now);
    } else if (used < this.starts.length) {
      // Server counts fewer: drop our oldest stamps so capacity reflects reality.
      this.starts = this.starts.slice(this.starts.length - used);
    }
  }

  /** Current window view at `now` (for the tool's header line / tests). */
  snapshot(now: number = this.now()): { used: number; remaining: number; max: number } {
    this.prune(now);
    return { used: this.starts.length, remaining: Math.max(0, this.max - this.starts.length), max: this.max };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("SauceNAO rate-limiter wait aborted");
  err.name = "AbortError";
  return err;
}
