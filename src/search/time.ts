/**
 * Time-window parsing shared by `search_messages` and `recap` (ARCHITECTURE.md §9e).
 * Chat timestamps are epoch-ms, so all of these resolve to ms. Parsing is tolerant:
 * an unparseable bound is reported back (so the tool can tell the agent it was
 * ignored) rather than throwing.
 */

const DURATION_RE = /^(\d+)\s*([smhdw])$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Parse a relative duration like "24h", "3d", "90m", "2w", "45s" → ms (undefined if bad). */
export function parseDuration(input: string): number | undefined {
  const m = DURATION_RE.exec(input.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * UNIT_MS[m[2].toLowerCase()];
}

/**
 * Parse an instant bound. Accepts a full ISO-8601 datetime or a bare `YYYY-MM-DD`
 * (interpreted as UTC midnight). Returns epoch-ms, or undefined if unparseable.
 */
export function parseInstant(input: string): number | undefined {
  const s = input.trim();
  if (s === "") return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

export function isDateOnly(input: string): boolean {
  return DATE_ONLY_RE.test(input.trim());
}

export interface TimeWindowArgs {
  after?: string;
  before?: string;
  last?: string;
}

export interface ResolvedTimeWindow {
  afterTs?: number;
  /** Exclusive upper bound (ms). */
  beforeTs?: number;
  /** Names of bounds that were supplied but unparseable (surfaced to the agent). */
  ignored: string[];
}

/**
 * Resolve after/before/last into [afterTs, beforeTs). `last` wins for the lower bound
 * when both `last` and `after` are given (a relative window is the more specific
 * intent). A bare-date `before` is made inclusive of that whole day by advancing the
 * exclusive bound to the next midnight; a datetime `before` is used as-is (exclusive).
 */
export function resolveTimeWindow(args: TimeWindowArgs, now: number): ResolvedTimeWindow {
  const ignored: string[] = [];
  let afterTs: number | undefined;
  let beforeTs: number | undefined;

  if (args.last !== undefined) {
    const dur = parseDuration(args.last);
    if (dur === undefined) ignored.push("last");
    else afterTs = now - dur;
  }
  if (afterTs === undefined && args.after !== undefined) {
    const ts = parseInstant(args.after);
    if (ts === undefined) ignored.push("after");
    else afterTs = ts;
  }
  if (args.before !== undefined) {
    const ts = parseInstant(args.before);
    if (ts === undefined) ignored.push("before");
    else beforeTs = isDateOnly(args.before) ? ts + DAY_MS : ts;
  }
  return { afterTs, beforeTs, ignored };
}
