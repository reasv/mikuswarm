import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDateStamp,
  compactAgentTimestamp,
  configureAgentTimezone,
  formatAgentTimestamp,
  getConfiguredTimezone,
  parseZonedWallClock,
  resetAgentTimezone,
} from "../src/time/index.js";
import { renderMessage } from "../src/context/renderer.js";
import type { CanonicalChatEvent } from "../src/types.js";

// A fixed summer instant: 2026-06-02 14:00:00 UTC.
const SUMMER = Date.UTC(2026, 5, 2, 14, 0, 0);
// A winter instant (for DST-aware zones): 2026-01-15 14:00:00 UTC.
const WINTER = Date.UTC(2026, 0, 15, 14, 0, 0);

test.afterEach(() => resetAgentTimezone());

test("formatAgentTimestamp renders UTC with a Z suffix", () => {
  configureAgentTimezone("UTC");
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T14:00:00Z");
});

test("formatAgentTimestamp renders a fixed-offset zone", () => {
  configureAgentTimezone("Asia/Tokyo"); // +09:00 year-round
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T23:00:00+09:00");
});

test("formatAgentTimestamp honors DST transitions", () => {
  configureAgentTimezone("America/New_York");
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T10:00:00-04:00"); // EDT
  assert.equal(formatAgentTimestamp(WINTER), "2026-01-15T09:00:00-05:00"); // EST
});

test("formatAgentTimestamp accepts a Date as well as epoch ms", () => {
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(formatAgentTimestamp(new Date(SUMMER)), "2026-06-02T23:00:00+09:00");
});

test("agentDateStamp uses the configured zone's calendar day (boundary)", () => {
  // 16:00 UTC is already the next calendar day in Tokyo (+09:00 → 01:00).
  const lateUtc = Date.UTC(2026, 5, 2, 16, 0, 0);
  configureAgentTimezone("UTC");
  assert.equal(agentDateStamp(lateUtc), "2026-06-02");
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(agentDateStamp(lateUtc), "2026-06-03");
});

test("compactAgentTimestamp renders YYYY-MM-DD HH:MM in zone", () => {
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(compactAgentTimestamp(SUMMER), "2026-06-02 23:00");
});

test("formatAgentTimestamp renders a half-hour offset zone (+05:30)", () => {
  configureAgentTimezone("Asia/Kolkata"); // +05:30 year-round
  // SUMMER is 14:00 UTC → 19:30 in Kolkata. Exercises offsetSuffix's minutes branch.
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T19:30:00+05:30");
});

test("formatAgentTimestamp renders a 45-minute offset zone (+05:45)", () => {
  configureAgentTimezone("Asia/Kathmandu"); // +05:45 year-round
  const formatted = formatAgentTimestamp(SUMMER);
  assert.equal(formatted, "2026-06-02T19:45:00+05:45");
  assert.match(formatted, /\+05:45$/);
});

test("formatAgentTimestamp throws RangeError on an invalid date (fallback contract)", () => {
  configureAgentTimezone("UTC");
  // pins.ts and read-messages.ts rely on this throw to fall back to the raw string.
  assert.throws(() => formatAgentTimestamp(new Date("nope")), RangeError);
  assert.throws(() => formatAgentTimestamp(new Date(NaN)), RangeError);
  // agentDateStamp / compactAgentTimestamp share the formatToParts path.
  assert.throws(() => agentDateStamp(new Date("nope")), RangeError);
  assert.throws(() => compactAgentTimestamp(new Date("nope")), RangeError);
});

test("configureAgentTimezone sets and resets process.env.TZ", () => {
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(process.env.TZ, "Asia/Tokyo");
  resetAgentTimezone();
  assert.equal(process.env.TZ, "UTC");
});

test("configureAgentTimezone rejects an unknown zone (fail-fast)", () => {
  assert.throws(() => configureAgentTimezone("Mars/Phobos"), /Invalid agent\.timezone/);
});

test("configureAgentTimezone rejects offset-style strings, accepts named zones", () => {
  // Bare numeric offsets are unsafe for the TZ backstops — must fail fast.
  for (const offset of ["+09:00", "+0900", "-05:30", "09:00"]) {
    assert.throws(() => configureAgentTimezone(offset), /named IANA/, `expected "${offset}" to throw`);
  }
  // Named zones (including UTC, GMT, and Etc/GMT+9) must still pass.
  for (const zone of ["UTC", "GMT", "Etc/GMT+9", "Asia/Tokyo"]) {
    assert.doesNotThrow(() => configureAgentTimezone(zone), `expected "${zone}" to be accepted`);
    resetAgentTimezone();
  }
});

test("resetAgentTimezone returns to UTC", () => {
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(getConfiguredTimezone(), "Asia/Tokyo");
  resetAgentTimezone();
  assert.equal(getConfiguredTimezone(), "UTC");
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T14:00:00Z");
});

test("parseZonedWallClock rejects out-of-range calendar fields (review issue #4a)", () => {
  // Pre-fix `Date.UTC` silently normalized these (e.g. 2026-13-40 → 2027-02-09),
  // so a bad recall_memory date filter resolved to a wrong day instead of being
  // surfaced. They must now be null, consistent with the nonsense→null contract.
  assert.equal(parseZonedWallClock("2026-13-40 00:00", "UTC"), null, "month 13 / day 40");
  assert.equal(parseZonedWallClock("2026-00-10 00:00", "UTC"), null, "month 0");
  assert.equal(parseZonedWallClock("2026-01-32 00:00", "UTC"), null, "day 32");
  assert.equal(parseZonedWallClock("2026-02-30 00:00", "UTC"), null, "Feb 30 (no round-trip)");
  assert.equal(parseZonedWallClock("2026-04-31 00:00", "UTC"), null, "Apr 31 (no round-trip)");
  assert.equal(parseZonedWallClock("2026-06-01 24:00", "UTC"), null, "hour 24");
  assert.equal(parseZonedWallClock("2026-06-01 12:60", "UTC"), null, "minute 60");
  // Valid edges still parse (including a real leap day).
  assert.ok(parseZonedWallClock("2024-02-29 00:00", "UTC") != null, "2024-02-29 is valid");
  assert.ok(parseZonedWallClock("2026-12-31 23:59", "UTC") != null, "Dec 31 23:59 is valid");
});

test("rendered messages carry the configured zone, never the host/UTC zone", () => {
  configureAgentTimezone("Asia/Tokyo");
  const event: CanonicalChatEvent = {
    id: "evt1",
    provider: "matrix",
    timelineKey: "matrix:miku:room:!r:example.org",
    role: "user",
    sender: { id: "@alice:example.org" },
    body: "hello",
    timestamp: SUMMER,
    receivedAt: SUMMER,
  } as CanonicalChatEvent;

  const rich = renderMessage(event, "rich");
  assert.match(rich, /time="2026-06-02T23:00:00\+09:00"/);
  assert.doesNotMatch(rich, /T\d\d:\d\d:\d\dZ"/); // no UTC leakage in the time attr

  const compact = renderMessage(event, "compact");
  assert.match(compact, /\[2026-06-02 23:00\]/);
});
