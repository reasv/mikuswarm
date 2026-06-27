import assert from "node:assert/strict";
import test from "node:test";

import { formatRefusalDurationShort } from "../src/app.js";
import { roomIdFromTimelineKeyOpt } from "../src/storage/timeline-key.js";
import { roomIdFromTimelineKey } from "../src/timeline/index.js";

// ─── Issue #11: {resets_in} sub-minute → "now", not "0m" ─────────────────────

test("formatRefusalDurationShort: a positive sub-minute duration is \"now\", not \"0m\" (#11)", () => {
  // The regression: 20s is > 0 (passes the old guard) but rounds to 0 minutes, which
  // previously printed the misleading "0m". It must read "now".
  assert.equal(formatRefusalDurationShort(20_000), "now");
  assert.equal(formatRefusalDurationShort(1), "now"); // 1ms
  assert.equal(formatRefusalDurationShort(29_000), "now"); // rounds down to 0 min
  // The boundary: 30_000ms rounds UP to 1 minute → "1m" (no longer "now").
  assert.equal(formatRefusalDurationShort(30_000), "1m");
});

test("formatRefusalDurationShort: non-positive durations stay \"now\" (#11)", () => {
  assert.equal(formatRefusalDurationShort(0), "now");
  assert.equal(formatRefusalDurationShort(-5_000), "now");
});

test("formatRefusalDurationShort: larger durations are unaffected by the fix (#11)", () => {
  assert.equal(formatRefusalDurationShort(60_000), "1m");
  assert.equal(formatRefusalDurationShort(60_000 + 30_000), "2m"); // 90s → rounds to 2m
  assert.equal(formatRefusalDurationShort(3 * 3_600_000 + 12 * 60_000), "3h 12m");
  assert.equal(formatRefusalDurationShort(2 * 3_600_000), "2h");
  assert.equal(formatRefusalDurationShort(2 * 86_400_000), "2d");
  assert.equal(formatRefusalDurationShort(2 * 86_400_000 + 3 * 3_600_000), "2d 3h");
});

// ─── Issue #12: shared roomIdFromTimelineKey leaf cannot drift ────────────────

// A representative key set covering room, dm, thread, and malformed shapes. The
// storage-side `room_id` denormalization and the timeline-side `ctx.roomId` derive
// from ONE leaf regex now (src/storage/timeline-key.ts); these assert the derivation
// is correct AND that the two public wrappers agree on every key.
const CASES: Array<{ key: string; room: string | undefined; label: string }> = [
  { key: "matrix:bot:room:!abc:hs.org", room: "!abc:hs.org", label: "plain room" },
  { key: "matrix:bot:dm:!dmroom:hs.org", room: "!dmroom:hs.org", label: "dm room" },
  {
    key: "matrix:bot:room:!abc:hs.org:thread:$root123",
    room: "!abc:hs.org",
    label: "threaded room (thread suffix stripped)",
  },
  {
    key: "matrix:bot:dm:!dmroom:hs.org:thread:$root123",
    room: "!dmroom:hs.org",
    label: "threaded dm",
  },
  { key: "matrix:bot:channel:!x:hs", room: undefined, label: "unknown kind segment" },
  { key: "not-a-timeline-key", room: undefined, label: "garbage" },
  { key: "matrix:bot:room:", room: undefined, label: "empty room id" },
  { key: "", room: undefined, label: "empty string" },
];

test("roomIdFromTimelineKeyOpt: derives correctly across room/dm/thread/malformed keys (#12)", () => {
  for (const c of CASES) {
    assert.equal(roomIdFromTimelineKeyOpt(c.key), c.room, c.label);
  }
  assert.equal(roomIdFromTimelineKeyOpt(undefined), undefined, "undefined input");
});

test("storage and timeline wrappers agree across the representative key set (#12)", () => {
  // The timeline wrapper returns `string | undefined`; the leaf is its single source.
  // (The storage wrapper normalizes undefined → null for the SQLite column, exercised
  // in agent-sessions-storage.test.ts; here we pin that the timeline public surface and
  // the leaf never diverge.)
  for (const c of CASES) {
    assert.equal(roomIdFromTimelineKey(c.key), roomIdFromTimelineKeyOpt(c.key), c.label);
  }
});
