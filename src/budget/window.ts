// =============================================================================
// Budget-window math (spec USAGE-COST-LIMITS §5/§6.1).
//
// Two window kinds:
//   - rolling  { duration }      — a trailing window of fixed length ending now.
//   - calendar { period, tz }    — day/week/month aligned to local wall-clock in
//                                  an IANA time zone (DST-correct).
//
// Pure functions over an injected `now` (ms epoch) so the engine and its tests
// never touch the wall clock directly. `windowStart` is the inclusive lower
// bound of the live window; `resetsAt` is when the current window rolls (the
// user-facing "back at X"). For rolling windows there is no fixed boundary, so
// `resetsAt` is an UPPER bound: the instant the window would be fully clear if no
// further spend occurred (oldest-possible contribution + duration). Exactness at
// the boundary is not required for a budget gate (§6.1).
// =============================================================================

/** A normalized window spec (parsed from config). */
export type WindowSpec =
  | { type: "rolling"; durationMs: number; duration: string }
  | { type: "calendar"; period: "day" | "week" | "month"; tz: string };

/** Parse a duration string ("24h", "7d", "30d", "90m", "45s") to milliseconds. */
export function parseDuration(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(input);
  if (!match) throw new Error(`invalid duration "${input}" (expected e.g. "24h", "7d", "30m")`);
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * scale[unit];
}

/** True if `tz` is a real named IANA zone (rejects bare numeric offsets like "+09:00"). */
export function isValidTimeZone(tz: string): boolean {
  // Modern Node/ICU accepts offset strings ("+09:00") as valid time zones, but the
  // project convention (cf. configureAgentTimezone) requires a NAMED zone — reject
  // bare numeric offsets explicitly so calendar windows can't silently use one.
  if (/^[+-]\d/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1 (Mon) .. 7 (Sun), ISO
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function localPartsInTz(epoch: number, tz: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(epoch))) map[part.type] = part.value;
  // Intl can emit "24" for midnight under hour12:false on some engines; normalize.
  const hour = Number(map.hour) % 24;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 1,
  };
}

/** Offset (ms) of `tz` from UTC at `epoch` (positive east of UTC). */
function tzOffsetMs(epoch: number, tz: string): number {
  const p = localPartsInTz(epoch, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epoch;
}

/** Epoch (ms) at which the given wall-clock instant occurs in `tz` (DST-safe). */
function wallClockToEpoch(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(guess, tz);
  let epoch = guess - off1;
  const off2 = tzOffsetMs(epoch, tz);
  if (off2 !== off1) epoch = guess - off2;
  return epoch;
}

/**
 * The inclusive start and the next reset of the current calendar window for
 * `period` in `tz`, evaluated at `now`. Week starts Monday (ISO).
 */
function calendarBounds(
  now: number,
  period: "day" | "week" | "month",
  tz: string,
): { start: number; resetsAt: number } {
  const p = localPartsInTz(now, tz);
  if (period === "day") {
    const start = wallClockToEpoch(p.year, p.month, p.day, 0, 0, 0, tz);
    // Next local midnight: advance the calendar date via a UTC date arithmetic
    // helper, then convert that wall-clock midnight back to an epoch.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    const resetsAt = wallClockToEpoch(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      0,
      tz,
    );
    return { start, resetsAt };
  }
  if (period === "week") {
    const daysSinceMonday = p.weekday - 1; // weekday 1=Mon
    const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday));
    const start = wallClockToEpoch(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
      0,
      0,
      0,
      tz,
    );
    const nextMonday = new Date(Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday + 7));
    const resetsAt = wallClockToEpoch(
      nextMonday.getUTCFullYear(),
      nextMonday.getUTCMonth() + 1,
      nextMonday.getUTCDate(),
      0,
      0,
      0,
      tz,
    );
    return { start, resetsAt };
  }
  // month
  const start = wallClockToEpoch(p.year, p.month, 1, 0, 0, 0, tz);
  const nextMonth = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
  const resetsAt = wallClockToEpoch(nextMonth.y, nextMonth.m, 1, 0, 0, 0, tz);
  return { start, resetsAt };
}

/**
 * Resolve the live window's inclusive start and next-reset instant for any
 * window spec at `now` (ms epoch).
 */
export function resolveWindow(spec: WindowSpec, now: number): { start: number; resetsAt: number } {
  if (spec.type === "rolling") {
    return { start: now - spec.durationMs, resetsAt: now + spec.durationMs };
  }
  return calendarBounds(now, spec.period, spec.tz);
}
