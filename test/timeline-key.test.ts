/**
 * Unit tests for the universal timeline-key grammar (spec DISCORD-SUPPORT-DESIGN §4.1–4.2).
 *
 * Covers:
 *  - Matrix round-trips (plain room, DM, thread, room ids with colons)
 *  - Discord-shaped keys (guild text channel, DM, thread)
 *  - Malformed keys → undefined
 *  - buildTimelineKey / parseTimelineKey round-trip property
 *  - channelIdFromTimelineKey backward compat with the old roomIdFromTimelineKeyOpt
 *  - timelineKindOf / isDmTimeline DM detection for both Matrix and Discord shapes
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTimelineKey,
  buildTimelineKey,
  channelIdFromTimelineKey,
  timelineKindOf,
  roomIdFromTimelineKeyOpt,
} from "../src/storage/timeline-key.js";
import { isDmTimeline } from "../src/timeline/index.js";
import { roomIdFromTimelineKey } from "../src/timeline/router.js";

// ─── parseTimelineKey: Matrix shapes ─────────────────────────────────────────

test("parseTimelineKey: plain Matrix room key", () => {
  const parsed = parseTimelineKey("matrix:mybot:room:!abc:hs.org");
  assert.deepEqual(parsed, {
    provider: "matrix",
    accountId: "mybot",
    kind: "room",
    channelId: "!abc:hs.org",
    threadId: undefined,
  });
});

test("parseTimelineKey: Matrix DM key", () => {
  const parsed = parseTimelineKey("matrix:main:dm:!dm-room:example.com");
  assert.deepEqual(parsed, {
    provider: "matrix",
    accountId: "main",
    kind: "dm",
    channelId: "!dm-room:example.com",
    threadId: undefined,
  });
});

test("parseTimelineKey: Matrix thread key (room id with colon)", () => {
  const parsed = parseTimelineKey("matrix:mybot:room:!abc:hs.org:thread:$rootEvt123");
  assert.deepEqual(parsed, {
    provider: "matrix",
    accountId: "mybot",
    kind: "room",
    channelId: "!abc:hs.org",
    threadId: "$rootEvt123",
  });
});

test("parseTimelineKey: Matrix DM thread key", () => {
  const parsed = parseTimelineKey("matrix:main:dm:!dm:server:thread:$root");
  assert.deepEqual(parsed, {
    provider: "matrix",
    accountId: "main",
    kind: "dm",
    channelId: "!dm:server",
    threadId: "$root",
  });
});

test("parseTimelineKey: Matrix room id with multiple colons", () => {
  // Room ids can legitimately contain colons (e.g. homeserver with a port or sub-domain)
  const parsed = parseTimelineKey("matrix:acct:room:!room:sub.home.example.org");
  assert.equal(parsed?.channelId, "!room:sub.home.example.org");
  assert.equal(parsed?.threadId, undefined);
});

// ─── parseTimelineKey: Discord shapes (grammar-level, provider not yet implemented) ───

test("parseTimelineKey: Discord guild text channel key", () => {
  const parsed = parseTimelineKey("discord:main:room:123456789012345678");
  assert.deepEqual(parsed, {
    provider: "discord",
    accountId: "main",
    kind: "room",
    channelId: "123456789012345678",
    threadId: undefined,
  });
});

test("parseTimelineKey: Discord DM channel key", () => {
  const parsed = parseTimelineKey("discord:bot:dm:987654321098765432");
  assert.deepEqual(parsed, {
    provider: "discord",
    accountId: "bot",
    kind: "dm",
    channelId: "987654321098765432",
    threadId: undefined,
  });
});

test("parseTimelineKey: Discord thread key", () => {
  const parsed = parseTimelineKey("discord:main:room:111222333444555666:thread:777888999000111222");
  assert.deepEqual(parsed, {
    provider: "discord",
    accountId: "main",
    kind: "room",
    channelId: "111222333444555666",
    threadId: "777888999000111222",
  });
});

// ─── Malformed keys → undefined ──────────────────────────────────────────────

test("parseTimelineKey: undefined for empty string", () => {
  assert.equal(parseTimelineKey(""), undefined);
});

test("parseTimelineKey: undefined for no colon", () => {
  assert.equal(parseTimelineKey("nocolons"), undefined);
});

test("parseTimelineKey: undefined for missing kind segment", () => {
  assert.equal(parseTimelineKey("matrix:acct"), undefined);
});

test("parseTimelineKey: undefined for invalid kind (not room|dm)", () => {
  assert.equal(parseTimelineKey("matrix:acct:space:!abc:hs"), undefined);
  assert.equal(parseTimelineKey("matrix:acct:channel:!abc:hs"), undefined);
});

test("parseTimelineKey: undefined for empty channelId", () => {
  assert.equal(parseTimelineKey("matrix:acct:room:"), undefined);
});

test("parseTimelineKey: undefined for upper-case provider (regex requires [a-z0-9-])", () => {
  assert.equal(parseTimelineKey("Matrix:acct:room:!abc:hs"), undefined);
  assert.equal(parseTimelineKey("MATRIX:acct:room:!abc:hs"), undefined);
});

test("parseTimelineKey: undefined when thread suffix present but threadId is empty", () => {
  // ":thread:" at end with nothing after it
  assert.equal(parseTimelineKey("matrix:acct:room:!abc:hs:thread:"), undefined);
});

test("parseTimelineKey: undefined when thread suffix present but channelId becomes empty", () => {
  // This would require channelId to disappear after stripping :thread:X, which
  // can't happen in practice but the parser defends against it.
  // The key ":thread:x" in rest position means channelId = "" → invalid.
  // We simulate by constructing the exact raw string:
  const key = "matrix:acct:room::thread:x"; // channelId segment is empty
  // rest = ":thread:x" → threadIdx=0 → channelId = "" → undefined
  assert.equal(parseTimelineKey(key), undefined);
});

// ─── buildTimelineKey / parseTimelineKey round-trip ──────────────────────────

const ROUND_TRIP_CASES = [
  { provider: "matrix", accountId: "main", kind: "room" as const, channelId: "!abc:hs.org" },
  { provider: "matrix", accountId: "main", kind: "dm" as const, channelId: "!dm:hs.org" },
  { provider: "matrix", accountId: "acct", kind: "room" as const, channelId: "!abc:hs.org", threadId: "$root" },
  { provider: "discord", accountId: "bot", kind: "room" as const, channelId: "123456789" },
  { provider: "discord", accountId: "bot", kind: "dm" as const, channelId: "987654321" },
  {
    provider: "discord",
    accountId: "bot",
    kind: "room" as const,
    channelId: "111222333",
    threadId: "444555666",
  },
];

test("buildTimelineKey / parseTimelineKey are mutual inverses (round-trip)", () => {
  for (const parts of ROUND_TRIP_CASES) {
    const key = buildTimelineKey(parts);
    const reparsed = parseTimelineKey(key);
    assert.deepEqual(
      reparsed,
      { threadId: undefined, ...parts },
      `round-trip failed for ${key}`,
    );
  }
});

// ─── channelIdFromTimelineKey ─────────────────────────────────────────────────

test("channelIdFromTimelineKey: extracts Matrix room ids correctly", () => {
  assert.equal(channelIdFromTimelineKey("matrix:bot:room:!abc:hs.org"), "!abc:hs.org");
  assert.equal(channelIdFromTimelineKey("matrix:bot:dm:!dm:hs.org"), "!dm:hs.org");
  assert.equal(channelIdFromTimelineKey("matrix:bot:room:!abc:hs.org:thread:$root"), "!abc:hs.org");
});

test("channelIdFromTimelineKey: returns undefined for absent/malformed key", () => {
  assert.equal(channelIdFromTimelineKey(undefined), undefined);
  assert.equal(channelIdFromTimelineKey(""), undefined);
  assert.equal(channelIdFromTimelineKey("not-a-key"), undefined);
  assert.equal(channelIdFromTimelineKey("matrix:acct:space:!x:hs"), undefined);
});

// ─── roomIdFromTimelineKeyOpt (deprecated alias) ──────────────────────────────

test("roomIdFromTimelineKeyOpt: backward-compatible alias of channelIdFromTimelineKey", () => {
  // Pre-existing Matrix representative set
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:room:!abc:hs.org"), "!abc:hs.org");
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:dm:!dmroom:hs.org"), "!dmroom:hs.org");
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:room:!abc:hs.org:thread:$root123"), "!abc:hs.org");
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:dm:!dmroom:hs.org:thread:$root123"), "!dmroom:hs.org");
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:channel:!x:hs"), undefined); // unknown kind
  assert.equal(roomIdFromTimelineKeyOpt("not-a-timeline-key"), undefined);
  assert.equal(roomIdFromTimelineKeyOpt("matrix:bot:room:"), undefined);
  assert.equal(roomIdFromTimelineKeyOpt(""), undefined);
  assert.equal(roomIdFromTimelineKeyOpt(undefined), undefined);
});

// ─── timelineKindOf ──────────────────────────────────────────────────────────

test("timelineKindOf: returns kind for valid keys", () => {
  assert.equal(timelineKindOf("matrix:bot:room:!abc:hs.org"), "room");
  assert.equal(timelineKindOf("matrix:bot:dm:!dm:hs.org"), "dm");
  assert.equal(timelineKindOf("discord:bot:room:123"), "room");
  assert.equal(timelineKindOf("discord:bot:dm:456"), "dm");
});

test("timelineKindOf: returns undefined for malformed/absent keys", () => {
  assert.equal(timelineKindOf(undefined), undefined);
  assert.equal(timelineKindOf(""), undefined);
  assert.equal(timelineKindOf("matrix:acct:channel:!x"), undefined);
});

// ─── isDmTimeline (router wrapper) ───────────────────────────────────────────

test("isDmTimeline: true for dm kind, false for room kind (Matrix)", () => {
  assert.equal(isDmTimeline("matrix:acct:dm:!room:server"), true);
  assert.equal(isDmTimeline("matrix:acct:room:!room:server"), false);
  assert.equal(isDmTimeline("matrix:acct:room:!room:server:thread:$r"), false);
});

test("isDmTimeline: true for dm kind (Discord-shaped keys)", () => {
  assert.equal(isDmTimeline("discord:bot:dm:123456"), true);
  assert.equal(isDmTimeline("discord:bot:room:123456"), false);
});

test("isDmTimeline: false (safe default) for malformed keys", () => {
  assert.equal(isDmTimeline("not-a-key"), false);
  assert.equal(isDmTimeline(""), false);
});

// ─── DM detection via key: Matrix behaviour unchanged ────────────────────────

test("DM detection via timelineKindOf: existing Matrix keys behave identically", () => {
  // These were the cases that the old `includes(":dm:")` check covered.
  // New grammar-based check must produce the same result.
  const dmKeys = [
    "matrix:acct:dm:!room:server",
    "matrix:acct:dm:!room:server:thread:$root",
  ];
  const roomKeys = [
    "matrix:acct:room:!room:server",
    "matrix:acct:room:!room:server:thread:$root",
  ];
  for (const k of dmKeys) {
    assert.equal(timelineKindOf(k), "dm", `expected dm for ${k}`);
  }
  for (const k of roomKeys) {
    assert.equal(timelineKindOf(k), "room", `expected room for ${k}`);
  }
});

// ─── Adversarial grammar: channelId containing ":thread:" as substring ───────

test("parseTimelineKey: room id containing ':thread:' as substring (impossible in practice — locks tie-break contract)", () => {
  // A Matrix room id looks like "!local:server" — colons appear only as the
  // local-part/homeserver separator and the homeserver segment cannot itself be
  // the literal string "thread". This key shape is therefore IMPOSSIBLE for real
  // Matrix room ids. The test exists solely to document and lock the parser's
  // tie-break behaviour: when the remainder of a key after the kind segment
  // contains ":thread:", lastIndexOf wins — the LAST occurrence is treated as the
  // thread marker, making the channelId everything before it.
  //
  // Key: matrix:acct:room:!abc:thread:hs.org
  // rest after "room:" = "!abc:thread:hs.org"
  // lastIndexOf(":thread:") = 4  → channelId = "!abc", threadId = "hs.org"
  const parsed = parseTimelineKey("matrix:acct:room:!abc:thread:hs.org");
  assert.equal(parsed?.channelId, "!abc", "channelId is the part before the last :thread:");
  assert.equal(parsed?.threadId, "hs.org", "threadId is the part after the last :thread:");
});

// ─── roomIdFromTimelineKey (timeline re-export) agrees with channelIdFromTimelineKey ──

test("roomIdFromTimelineKey (timeline) agrees with channelIdFromTimelineKey across Matrix keys", () => {
  const keys = [
    "matrix:bot:room:!abc:hs.org",
    "matrix:bot:dm:!dmroom:hs.org",
    "matrix:bot:room:!abc:hs.org:thread:$root123",
    "matrix:bot:dm:!dmroom:hs.org:thread:$root123",
    "matrix:bot:channel:!x:hs",
    "",
  ];
  for (const k of keys) {
    assert.equal(
      roomIdFromTimelineKey(k),
      channelIdFromTimelineKey(k),
      `mismatch for "${k}"`,
    );
  }
});
