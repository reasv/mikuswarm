// =============================================================================
// Per-host HTTP egress limiter (spec CONCURRENCY-AND-RATE-LIMITING §8 / Design D).
//
// Unlike the LLM budget there is no scarce shared pool here: each host is
// independent and most fetches (link previews) hit arbitrary one-off user-posted
// hosts. So this is deliberately NOT a scheduler — no priority, no groups, no
// admission queue ordering. It provides exactly two protections, applied at the
// single `guardedFetch` chokepoint (`src/tools/ssrf.ts`):
//
//   1. Per-host admission concurrency (generous), plus an optional very-high
//      global ceiling as a pure degenerate backstop so a bot in hundreds of
//      channels can't open unbounded sockets at once.
//   2. UNCONDITIONAL 429/503 + Retry-After backoff, SHARED PER HOST: one caller's
//      throttle from a host pauses *all* callers to that host. This is the code
//      invariant of §5.3 — always on, independent of whether limits are
//      configured.
//
// State is process-global and keyed by host. The deliberately rate-limited API we
// know by name (Danbooru) is NOT configured here — it owns an internal limiter in
// its tool, tuned to its documented limits (spec §8.2); it still flows through
// this layer for the unconditional backoff (belt-and-suspenders).
// =============================================================================

export interface HttpLimiterConfig {
  /** Per-host concurrency cap when no host-specific override applies. */
  defaultMaxInFlightPerHost: number;
  /** Cross-host degenerate backstop; set far above normal load. */
  globalCeiling: number;
  /** Base for exponential backoff when a host throttles without a Retry-After. */
  backoffBaseMs: number;
  /** Ceiling for the computed (pre-jitter) backoff. */
  backoffMaxMs: number;
  /** Optional per-host concurrency overrides, keyed by lowercase hostname. */
  perHostMaxInFlight?: Record<string, number>;
}

const DEFAULTS: HttpLimiterConfig = {
  defaultMaxInFlightPerHost: 8,
  globalCeiling: 256,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
};

let config: HttpLimiterConfig = { ...DEFAULTS };

interface HostState {
  active: number;
  /** Epoch ms before which new acquisitions for this host must wait. 0 = none. */
  backoffUntil: number;
  consecutiveThrottles: number;
}

const hosts = new Map<string, HostState>();
let activeTotal = 0;

// Capacity-change wakeups. A blocked acquirer registers a resolver here; a release
// resolves all pending resolvers, which then re-check their conditions. A short
// safety re-poll guards against any missed notification.
let wakeupResolvers: Array<() => void> = [];
const WAKEUP_SAFETY_MS = 1000;

/** Apply deployment config (`[rate_limits.http]`); unset fields keep their defaults. */
export function configureHttpLimiter(partial: Partial<HttpLimiterConfig>): void {
  config = {
    defaultMaxInFlightPerHost: partial.defaultMaxInFlightPerHost ?? DEFAULTS.defaultMaxInFlightPerHost,
    globalCeiling: partial.globalCeiling ?? DEFAULTS.globalCeiling,
    backoffBaseMs: partial.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
    backoffMaxMs: partial.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
    perHostMaxInFlight: partial.perHostMaxInFlight ?? DEFAULTS.perHostMaxInFlight,
  };
}

/** Reset config and all per-host state. Test-only. */
export function resetHttpLimiter(): void {
  config = { ...DEFAULTS };
  hosts.clear();
  activeTotal = 0;
  wakeupResolvers = [];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

function getHostState(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { active: 0, backoffUntil: 0, consecutiveThrottles: 0 };
    hosts.set(host, state);
  }
  return state;
}

function perHostCap(host: string): number {
  return config.perHostMaxInFlight?.[host] ?? config.defaultMaxInFlightPerHost;
}

function notifyAll(): void {
  const pending = wakeupResolvers;
  wakeupResolvers = [];
  for (const resolve of pending) resolve();
}

function abortError(): Error {
  const error = new Error("HTTP limiter wait aborted");
  error.name = "AbortError";
  return error;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Await the next capacity-change wakeup (or a short safety re-poll, or abort). */
function waitForWakeup(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onWake = () => finish(resolve);
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(onWake, WAKEUP_SAFETY_MS);
    wakeupResolvers.push(onWake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Acquire a slot for the given URL's host, waiting out any active per-host backoff
 * and respecting the per-host + global concurrency caps. Resolves to an idempotent
 * release function the caller MUST invoke (in a `finally`) when the request settles.
 * Rejects with an `AbortError` if `signal` aborts while waiting.
 */
export async function acquireHttpSlot(url: string, signal?: AbortSignal): Promise<() => void> {
  const host = hostOf(url);
  for (;;) {
    if (signal?.aborted) throw abortError();
    const state = getHostState(host);
    const now = Date.now();
    if (state.backoffUntil > now) {
      await sleepAbortable(state.backoffUntil - now, signal);
      continue;
    }
    if (activeTotal < config.globalCeiling && state.active < perHostCap(host)) {
      state.active += 1;
      activeTotal += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        activeTotal = Math.max(0, activeTotal - 1);
        notifyAll();
      };
    }
    await waitForWakeup(signal);
  }
}

/**
 * Record a response status for a host so subsequent acquisitions back off on a
 * throttle. Always-on (the §5.3 invariant): a 429/503 extends the host's backoff
 * window (honouring `Retry-After` when present, else exponential + jitter); any
 * other status resets the host's throttle streak.
 */
export function noteHttpResponse(url: string, status: number, retryAfterHeader?: string | null): void {
  const host = hostOf(url);
  const state = getHostState(host);
  if (status === 429 || status === 503) {
    state.consecutiveThrottles += 1;
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    let backoffMs: number;
    if (retryAfterMs !== null) {
      backoffMs = retryAfterMs;
    } else {
      const ceiling = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (state.consecutiveThrottles - 1));
      // Partial jitter: keep a floor of half the ceiling so backoff never collapses to ~0.
      backoffMs = ceiling / 2 + Math.random() * (ceiling / 2);
    }
    state.backoffUntil = Math.max(state.backoffUntil, Date.now() + backoffMs);
  } else {
    state.consecutiveThrottles = 0;
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null. */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}
