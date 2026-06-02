import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDateStamp,
  compactAgentTimestamp,
  configureAgentTimezone,
  formatAgentTimestamp,
  getConfiguredTimezone,
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

test("configureAgentTimezone rejects an unknown zone (fail-fast)", () => {
  assert.throws(() => configureAgentTimezone("Mars/Phobos"), /Invalid agent\.timezone/);
});

test("resetAgentTimezone returns to UTC", () => {
  configureAgentTimezone("Asia/Tokyo");
  assert.equal(getConfiguredTimezone(), "Asia/Tokyo");
  resetAgentTimezone();
  assert.equal(getConfiguredTimezone(), "UTC");
  assert.equal(formatAgentTimestamp(SUMMER), "2026-06-02T14:00:00Z");
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
