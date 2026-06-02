/**
 * Agent timezone — the single source of truth for how the agent perceives and
 * renders wall-clock time.
 *
 * Everything the agent can see (system prompt runtime state, rendered messages,
 * summaries, and the timestamp-bearing tools) formats dates through this module
 * so they appear in one configured IANA zone — never the server/container's real
 * local zone. This serves two goals:
 *
 *   1. Presentation — the agent consistently sees `YYYY-MM-DDTHH:mm:ss±HH:MM`
 *      (or `…Z`) in the configured zone, regardless of where the process runs.
 *   2. Leak prevention — the configured zone's offset is the only timezone
 *      information that can reach a chat user or the agent. `configureAgentTimezone`
 *      also sets `process.env.TZ` so any unaudited code path that falls back to
 *      system-local formatting (`Date#toString`, `toLocaleString`, the sandbox's
 *      `date`/`ls -l`) still surfaces the configured zone, not the host's.
 *
 * Module-level state mirrors the secret-redaction registry (src/config/redaction.ts):
 * configured once at config-load time, read everywhere, reset for tests/reloads.
 *
 * Zone math uses the built-in `Intl.DateTimeFormat` (Node ships full ICU) — no
 * external dependency.
 */

const DEFAULT_TIMEZONE = "UTC";

let configuredTimezone = DEFAULT_TIMEZONE;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // h23 keeps midnight as "00" rather than ICU's "24:00" quirk.
      hourCycle: "h23",
      // ICU `longOffset` emits "GMT+09:00" / "GMT-05:00" / "GMT+00:00" (full
      // GMT±HH:MM, even for UTC) — parsed into the ISO offset suffix by offsetSuffix.
      timeZoneName: "longOffset",
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  timeZoneName: string;
}

function partsOf(date: Date): DateParts {
  const out: Record<string, string> = {};
  for (const part of getFormatter(configuredTimezone).formatToParts(date)) {
    out[part.type] = part.value;
  }
  return out as unknown as DateParts;
}

/**
 * Convert an ICU `longOffset` time-zone name into an ISO-8601 offset suffix.
 * Current ICU always emits the full `GMT±HH:MM` form, including for UTC:
 *   "GMT+09:00" → "+09:00"; "GMT+05:45" → "+05:45"; "GMT+00:00" → "Z".
 * The minutes-less branch ("GMT-5" → "-05:00") and the bare-"GMT" fallback ("Z")
 * are defensive against ICU/locale variants and are not hit by current ICU.
 */
function offsetSuffix(timeZoneName: string): string {
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(timeZoneName);
  if (!match) return "Z"; // bare "GMT"/"UTC" — zero offset
  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = (match[3] ?? "00").padStart(2, "0");
  if (hours === "00" && minutes === "00") return "Z";
  return `${sign}${hours}:${minutes}`;
}

function toDate(ts: number | Date): Date {
  return typeof ts === "number" ? new Date(ts) : ts;
}

/**
 * Set the agent's timezone. Requires a *named* IANA zone and fails fast on a
 * misconfigured value, then sets `process.env.TZ` as a defense-in-depth backstop.
 *
 * Two rejection paths:
 *   1. Unrecognized zones throw via `Intl.DateTimeFormat` (RangeError).
 *   2. Bare numeric offset strings (e.g. "+09:00", "+0900", "-05:30", "09:00")
 *      are rejected explicitly — `Intl` silently accepts them, but they break
 *      both backstops: V8 ignores an offset `process.env.TZ` and leaks the host's
 *      real local zone, while the sandbox's glibc treats `TZ=+09:00` as UTC. Only
 *      named zones keep the explicit formatters and the backstops in agreement.
 *
 * Named zones including "UTC", "GMT", and "Etc/GMT+9" pass — only bare offsets fail.
 */
export function configureAgentTimezone(tz: string): void {
  // Reject bare numeric offsets before the Intl check. A named IANA zone never
  // starts with a sign or digit, so anything matching here is an offset form
  // ("+09:00", "+0900", "-05:30") or a bare offset ("09:00"). Note "Etc/GMT+9",
  // "UTC", "GMT", "Asia/Tokyo" etc. all start with a letter and pass through.
  if (/^[+-]?\d/.test(tz)) {
    throw new Error(
      `Invalid agent.timezone "${tz}": a named IANA time zone is required, not a ` +
        `numeric offset (e.g. use "Asia/Tokyo" or "Etc/GMT-9", not "+09:00"). ` +
        `Offset strings are silently mishandled by the TZ backstops.`,
    );
  }
  try {
    // Throws RangeError for an unrecognized zone name.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch (error) {
    throw new Error(
      `Invalid agent.timezone "${tz}": not a recognized IANA time zone name ` +
        `(e.g. "UTC", "America/New_York", "Asia/Tokyo").`,
      { cause: error },
    );
  }
  configuredTimezone = tz;
  formatterCache.clear();
  process.env.TZ = tz;
}

/** Reset to UTC. For tests and config reloads (mirrors resetRedactionRegistry). */
export function resetAgentTimezone(): void {
  configuredTimezone = DEFAULT_TIMEZONE;
  formatterCache.clear();
  process.env.TZ = DEFAULT_TIMEZONE;
}

/** The currently configured IANA zone name (e.g. for the sandbox `TZ` env). */
export function getConfiguredTimezone(): string {
  return configuredTimezone;
}

/**
 * Format an instant as ISO-8601 with the configured zone's offset, e.g.
 * `2026-06-02T23:00:00+09:00` (or `…Z` for a zero-offset zone). Replaces
 * `new Date(ts).toISOString()` everywhere the agent can see the result.
 */
export function formatAgentTimestamp(ts: number | Date): string {
  const p = partsOf(toDate(ts));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetSuffix(p.timeZoneName)}`;
}

/** `YYYY-MM-DD` in the configured zone (e.g. the memory daily-file boundary). */
export function agentDateStamp(ts: number | Date): string {
  const p = partsOf(toDate(ts));
  return `${p.year}-${p.month}-${p.day}`;
}

/** `YYYY-MM-DD HH:MM` in the configured zone (compact-tier message rendering). */
export function compactAgentTimestamp(ts: number | Date): string {
  const p = partsOf(toDate(ts));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
