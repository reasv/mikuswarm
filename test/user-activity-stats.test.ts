import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ChatSearchIndexer } from "../src/search/index.js";
import { createUserActivityTool, type RoomMemberLite } from "../src/tools/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const ROOM_A = "matrix:test:room:!a";
const ROOM_B = "matrix:test:room:!b";
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function ev(senderId: string, room: string, timestamp: number, id: string): CanonicalChatEvent {
  return {
    id,
    timelineKey: room,
    provider: "matrix",
    role: "user",
    sender: { id: senderId, displayName: senderId, isSelf: false },
    body: `msg ${id}`,
    timestamp,
    receivedAt: timestamp,
  };
}

async function withTool(
  events: CanonicalChatEvent[],
  roomMembers: ((tk: string) => Promise<RoomMemberLite[]>) | undefined,
  run: (tool: ReturnType<typeof createUserActivityTool>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-user-activity-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const timeline = new TimelineStore(storage);
    for (const e of events) await timeline.append(e);
    const indexer = new ChatSearchIndexer({ storage });
    await indexer.reconcileAll();
    const tool = createUserActivityTool({ storage, indexer, currentTimelineKey: ROOM_A, now: () => NOW, roomMembers });
    await run(tool);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// @a: 3 in A + 1 in B (total 4); @b: 1 in A; @c: 2 in B. All within the last few days.
const RECENT: CanonicalChatEvent[] = [
  ev("@a", ROOM_A, NOW - 1 * DAY, "a1"),
  ev("@a", ROOM_A, NOW - 2 * DAY, "a2"),
  ev("@a", ROOM_A, NOW - 3 * DAY, "a3"),
  ev("@a", ROOM_B, NOW - 1 * DAY, "a4"),
  ev("@b", ROOM_A, NOW - 1 * DAY, "b1"),
  ev("@c", ROOM_B, NOW - 1 * DAY, "c1"),
  ev("@c", ROOM_B, NOW - 2 * DAY, "c2"),
];

test("order:least_active ranks the quietest posters first", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c1", { rooms: "all", order: "least_active" });
    const ids = (res.details as { senders: Array<{ senderId: string }> }).senders.map((s) => s.senderId);
    assert.deepEqual(ids, ["@b", "@c", "@a"]); // 1, 2, 4
    assert.match((res.content[0] as { text: string }).text, /Inactivity roster/);
  });
});

test("max_messages keeps only senders below the threshold", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c2", { rooms: "all", max_messages: 1 });
    const details = res.details as { senderCount: number; senders: Array<{ senderId: string; total: number }> };
    assert.deepEqual(details.senders.map((s) => s.senderId), ["@b"]); // only total <= 1
    assert.equal(details.senderCount, 1);
  });
});

test("all_time removes the default 30d lower bound", async () => {
  // One message 50 days ago — outside the default 30d window, inside all-time.
  const old = [ev("@z", ROOM_A, NOW - 50 * DAY, "z1")];
  await withTool(old, undefined, async (tool) => {
    const within = await tool.execute("c3", { rooms: "all" });
    assert.equal((within.details as { senderCount: number }).senderCount, 0, "excluded by default 30d");

    const ever = await tool.execute("c4", { rooms: "all", all_time: true });
    const d = ever.details as { senderCount: number; senders: Array<{ senderId: string }> };
    assert.equal(d.senderCount, 1);
    assert.deepEqual(d.senders.map((s) => s.senderId), ["@z"]);
    assert.match((ever.content[0] as { text: string }).text, /all time/);
  });
});

test("top-3 channel breakdown shows for multi-room scans and is omitted for single-room", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const multi = await tool.execute("c5", { rooms: "all" });
    const multiText = (multi.content[0] as { text: string }).text;
    // @a posted in two rooms → its line carries a per-channel breakdown.
    assert.match(multiText, /@a —[^\n]*top: \{matrix:test:room:!a\}:3, \{matrix:test:room:!b\}:1/);

    const single = await tool.execute("c6", { rooms: [ROOM_A] });
    assert.doesNotMatch((single.content[0] as { text: string }).text, /top:/);
  });
});

test("include_silent surfaces current members who never posted (total 0)", async () => {
  const members = async (tk: string): Promise<RoomMemberLite[]> =>
    tk === ROOM_A
      ? [{ userId: "@a" }, { userId: "@b" }, { userId: "@d", displayName: "Dee" }, { userId: "@e" }]
      : [];
  await withTool(RECENT, members, async (tool) => {
    const res = await tool.execute("c7", { rooms: [ROOM_A], include_silent: true });
    const senders = (res.details as { senders: Array<{ senderId: string; total: number; neverPosted: boolean }> }).senders;
    const byId = new Map(senders.map((s) => [s.senderId, s]));
    // Never-posted members appear at total 0.
    assert.equal(byId.get("@d")?.total, 0);
    assert.equal(byId.get("@d")?.neverPosted, true);
    assert.equal(byId.get("@e")?.neverPosted, true);
    // A member who DID post is not in the zero set.
    assert.equal(byId.get("@a")?.neverPosted, false);
    assert.ok((byId.get("@a")?.total ?? 0) > 0);
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /never posted/);
    // A resolved display name is shown so the opaque mxid is recognizable.
    assert.match(text, /@d \(Dee\)/);
  });
});

test("include_silent + max_messages:0 + least_active isolates only the never-posted", async () => {
  const members = async (tk: string): Promise<RoomMemberLite[]> =>
    tk === ROOM_A ? [{ userId: "@a" }, { userId: "@b" }, { userId: "@d" }, { userId: "@e" }] : [];
  await withTool(RECENT, members, async (tool) => {
    const res = await tool.execute("c11", { rooms: [ROOM_A], include_silent: true, order: "least_active", max_messages: 0 });
    const senders = (res.details as { senders: Array<{ senderId: string; total: number }> }).senders;
    // @a (3 in A) and @b (1 in A) are filtered out by max_messages:0; only the silent remain.
    assert.deepEqual(senders.map((s) => s.senderId).sort(), ["@d", "@e"]);
    assert.ok(senders.every((s) => s.total === 0));
  });
});

test("top-3 channel breakdown caps at three rooms", async () => {
  const ROOM_C = "matrix:test:room:!c";
  const ROOM_D = "matrix:test:room:!d";
  // @a posts in four rooms with distinct counts: A=4, B=3, C=2, D=1.
  const events = [
    ev("@a", ROOM_A, NOW - 1 * DAY, "qa1"),
    ev("@a", ROOM_A, NOW - 2 * DAY, "qa2"),
    ev("@a", ROOM_A, NOW - 3 * DAY, "qa3"),
    ev("@a", ROOM_A, NOW - 4 * DAY, "qa4"),
    ev("@a", ROOM_B, NOW - 1 * DAY, "qb1"),
    ev("@a", ROOM_B, NOW - 2 * DAY, "qb2"),
    ev("@a", ROOM_B, NOW - 3 * DAY, "qb3"),
    ev("@a", ROOM_C, NOW - 1 * DAY, "qc1"),
    ev("@a", ROOM_C, NOW - 2 * DAY, "qc2"),
    ev("@a", ROOM_D, NOW - 1 * DAY, "qd1"),
  ];
  await withTool(events, undefined, async (tool) => {
    const res = await tool.execute("c12", { rooms: "all" });
    const text = (res.content[0] as { text: string }).text;
    // Top 3 by count are A:4, B:3, C:2; the 4th (D:1) is omitted.
    assert.match(text, /top: \{matrix:test:room:!a\}:4, \{matrix:test:room:!b\}:3, \{matrix:test:room:!c\}:2/);
    assert.doesNotMatch(text, /!d\}:1/);
  });
});

test("a member who later posts drops out of the never-posted set", async () => {
  // @d is a member AND posted once in A → must not be flagged never-posted.
  const events = [...RECENT, ev("@d", ROOM_A, NOW - 1 * DAY, "d1")];
  const members = async (tk: string): Promise<RoomMemberLite[]> =>
    tk === ROOM_A ? [{ userId: "@d" }, { userId: "@e" }] : [];
  await withTool(events, members, async (tool) => {
    const res = await tool.execute("c8", { rooms: [ROOM_A], include_silent: true });
    const byId = new Map(
      (res.details as { senders: Array<{ senderId: string; total: number; neverPosted: boolean }> }).senders.map((s) => [s.senderId, s]),
    );
    assert.equal(byId.get("@d")?.neverPosted, false);
    assert.equal(byId.get("@d")?.total, 1);
    assert.equal(byId.get("@e")?.neverPosted, true); // still silent
  });
});

test("include_silent fetches roomMembers once per UNIQUE room when thread keys collapse", async () => {
  // Two timeline keys of the SAME room: the base room and a thread within it. Both
  // resolve to room id `!a`, so the member roster must be fetched exactly once.
  const ROOM_A_THREAD = `${ROOM_A}:thread:$root1`;
  const events = [
    ev("@a", ROOM_A, NOW - 1 * DAY, "ta1"),
    ev("@b", ROOM_A_THREAD, NOW - 1 * DAY, "tb1"),
  ];
  const calls: string[] = [];
  const members = async (tk: string): Promise<RoomMemberLite[]> => {
    calls.push(tk);
    return [{ userId: "@a" }, { userId: "@b" }, { userId: "@d", displayName: "Dee" }];
  };
  await withTool(events, members, async (tool) => {
    const res = await tool.execute("c-dedup", {
      rooms: [ROOM_A, ROOM_A_THREAD],
      include_silent: true,
    });
    // Both keys collapse to room `!a` → exactly one native fetch.
    assert.equal(calls.length, 1, `expected a single fetch per unique room, got ${calls.length}: ${calls.join(", ")}`);
    // The union is still correct: @d (a member who never posted) surfaces at total 0.
    const byId = new Map(
      (res.details as { senders: Array<{ senderId: string; total: number; neverPosted: boolean }> }).senders.map((s) => [s.senderId, s]),
    );
    assert.equal(byId.get("@d")?.total, 0);
    assert.equal(byId.get("@d")?.neverPosted, true);
    assert.equal(byId.get("@a")?.neverPosted, false);
  });
});

test("include_silent for rooms:all is rejected with a note (no concrete scope)", async () => {
  const members = async (): Promise<RoomMemberLite[]> => [{ userId: "@x" }];
  await withTool(RECENT, members, async (tool) => {
    const res = await tool.execute("c9", { rooms: "all", include_silent: true });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /include_silent needs a concrete room scope/);
    // @x (silent) must NOT have been added under the all-rooms scope.
    assert.doesNotMatch(text, /@x/);
  });
});

test("include_silent without a membership source notes the gap", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c10", { rooms: [ROOM_A], include_silent: true });
    assert.match((res.content[0] as { text: string }).text, /membership source unavailable/);
  });
});

test("single-user reports its share of total and the considered span", async () => {
  // RECENT: 7 messages total (@a=4, @b=1, @c=2). @a's share is 4/7 ≈ 57%.
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c13", { user: "@a", rooms: "all" });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /@a: 4 message\(s\) \(57%\)/);
    assert.match(text, /7 message\(s\) from 3 sender\(s\) considered, actual span /);
    const d = res.details as {
      scope: { totalMessages: number; distinctSenders: number; firstAt: number | null; lastAt: number | null };
      senders: Array<{ senderId: string; percentOfTotal: number | null }>;
    };
    assert.equal(d.scope.totalMessages, 7);
    assert.equal(d.scope.distinctSenders, 3);
    assert.ok(d.scope.firstAt !== null && d.scope.lastAt !== null && d.scope.firstAt <= d.scope.lastAt);
    assert.ok(Math.abs((d.senders[0].percentOfTotal ?? 0) - 4 / 7) < 1e-9);
  });
});

test("roster lines carry each sender's share of total", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c14", { rooms: "all" });
    const text = (res.content[0] as { text: string }).text;
    // most_active order: @a (4/7=57%), @c (2/7=29%), @b (1/7=14%).
    assert.match(text, /@a — 4 msg\(s\) \(57%\)/);
    assert.match(text, /@c — 2 msg\(s\) \(29%\)/);
    assert.match(text, /@b — 1 msg\(s\) \(14%\)/);
    assert.match(text, /7 message\(s\) from 3 sender\(s\) considered/);
  });
});

test("roster reports the combined weight of the listed senders", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    // All 3 senders shown → they account for the full 7/7 (100%).
    const all = await tool.execute("c18a", { rooms: "all" });
    assert.match(
      (all.content[0] as { text: string }).text,
      /These 3 sender\(s\) account for 7 of 7 message\(s\) \(100%\)/,
    );
    const dAll = all.details as { shown: { senderCount: number; messages: number; percentOfTotal: number | null } };
    assert.equal(dAll.shown.senderCount, 3);
    assert.equal(dAll.shown.messages, 7);
    assert.equal(dAll.shown.percentOfTotal, 1);

    // Capped to the top sender → a proper slice: @a's 4 of 7 (57%).
    const top = await tool.execute("c18b", { rooms: "all", limit: 1 });
    const topText = (top.content[0] as { text: string }).text;
    assert.match(topText, /These 1 sender\(s\) account for 4 of 7 message\(s\) \(57%\)/);
    assert.match(topText, /\(\+2 more\)/);
    const dTop = top.details as { shown: { messages: number; percentOfTotal: number | null } };
    assert.equal(dTop.shown.messages, 4);
    assert.ok(Math.abs((dTop.shown.percentOfTotal ?? 0) - 4 / 7) < 1e-9);
  });
});

test("coverage footnote fires when data spans less than the requested window", async () => {
  // RECENT spans only the last 3 days, but the default window asks for 30d.
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c15", { rooms: "all" }); // default 30d
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /⚠ Coverage:/);
    assert.match(text, /30d/); // the requested span
    assert.match(text, /first 27d of the window/); // the uncovered head
  });
});

test("no coverage footnote when the window is covered, but the span still shows", async () => {
  // last:"3d" matches the actual data span exactly — nothing uncovered.
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c16", { rooms: "all", last: "3d" });
    const text = (res.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /⚠ Coverage:/);
    assert.match(text, /7 message\(s\) from 3 sender\(s\) considered/);
  });
});

test("open lower bound (all_time) shows the span without a coverage warning", async () => {
  await withTool(RECENT, undefined, async (tool) => {
    const res = await tool.execute("c17", { rooms: "all", all_time: true });
    const text = (res.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /⚠ Coverage:/);
    assert.match(text, /message\(s\) from 3 sender\(s\) considered/);
  });
});
