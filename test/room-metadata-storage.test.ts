import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:miku:room:!room:example.org";

function event(id: string, timelineKey = TK): CanonicalChatEvent {
  return {
    id,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice", isSelf: false },
    body: "hello",
    timestamp: 1_000,
    receivedAt: 1_000,
  };
}

test("listConsoleRooms shows the cached room label when one is set", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(event("e1"));
    await storage.setRoomDisplayName(TK, "General (My Space)");

    const rooms = storage.listConsoleRooms();
    const row = rooms.find((r) => r.timeline_key === TK);
    assert.ok(row, "expected a room row for the timeline");
    assert.equal(row.display_name, "General (My Space)");
  } finally {
    storage.close();
  }
});

test("listConsoleRooms falls back to the timeline key when no label is cached", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(event("e1"));

    const rooms = storage.listConsoleRooms();
    const row = rooms.find((r) => r.timeline_key === TK);
    assert.ok(row);
    assert.equal(row.display_name, TK);
  } finally {
    storage.close();
  }
});

test("listConsoleRooms folds thread sub-timelines into their parent room", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const thread = `${TK}:thread:$root`;
    const sibling = "matrix:miku:room:!other:example.org";
    // Room with one own event + two thread events, plus an unrelated sibling room.
    await storage.appendTimelineEvent(event("e1", TK));
    await storage.appendTimelineEvent(event("t1", thread));
    await storage.appendTimelineEvent(event("t2", thread));
    await storage.appendTimelineEvent(event("o1", sibling));
    await storage.setRoomDisplayName(TK, "General");

    const rooms = storage.listConsoleRooms();
    // The thread is NOT a separate row — it collapses into the room.
    assert.equal(
      rooms.filter((r) => r.timeline_key === thread).length,
      0,
      "thread sub-timeline must not list as its own room",
    );
    const row = rooms.find((r) => r.timeline_key === TK);
    assert.ok(row, "expected a single room row keyed by the room (not the thread)");
    assert.equal(row.display_name, "General");
    // event_count sums the room + its threads (1 own + 2 thread = 3).
    assert.equal(row.event_count, 3);
    // The sibling room is unaffected (no over-matching across rooms).
    assert.equal(rooms.find((r) => r.timeline_key === sibling)?.event_count, 1);
  } finally {
    storage.close();
  }
});

test("setRoomDisplayName upserts the label and refreshes resolved_at", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setRoomDisplayName(TK, "First");
    const first = storage.getRoomMetadata(TK);
    assert.ok(first);
    assert.equal(first.displayName, "First");

    await storage.setRoomDisplayName(TK, "Renamed");
    const second = storage.getRoomMetadata(TK);
    assert.ok(second);
    assert.equal(second.displayName, "Renamed");
    assert.ok(second.resolvedAt >= first.resolvedAt);
  } finally {
    storage.close();
  }
});

test("getRoomMetadata returns undefined for an unknown timeline", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    assert.equal(storage.getRoomMetadata("matrix:miku:room:!nope"), undefined);
  } finally {
    storage.close();
  }
});

test("setChannelMetadata: resolved_at unchanged on identical upsert, bumped on changed values", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const DISCORD_TK = "discord:main:room:200000000000000001";

    // First write.
    await storage.setChannelMetadata(DISCORD_TK, {
      displayName: "#general (MyServer)",
      serverId: "111111111111111111",
      serverName: "MyServer",
    });
    const first = storage.getRoomMetadata(DISCORD_TK);
    assert.ok(first, "metadata row created on first write");
    assert.equal(first.displayName, "#general (MyServer)");

    // Wait to ensure Date.now() inside the second write would return a later value
    // if the change-guard were absent (so the assertion is non-trivially meaningful).
    await new Promise<void>((r) => setTimeout(r, 5));

    // Identical second write — resolved_at must stay the same.
    await storage.setChannelMetadata(DISCORD_TK, {
      displayName: "#general (MyServer)",
      serverId: "111111111111111111",
      serverName: "MyServer",
    });
    const second = storage.getRoomMetadata(DISCORD_TK);
    assert.ok(second);
    assert.equal(second.resolvedAt, first.resolvedAt,
      "identical upsert must not bump resolved_at (change-guard)");

    // Wait, then change display_name → resolved_at must be bumped.
    await new Promise<void>((r) => setTimeout(r, 5));
    await storage.setChannelMetadata(DISCORD_TK, {
      displayName: "#general (RenamedServer)",
      serverId: "111111111111111111",
      serverName: "RenamedServer",
    });
    const third = storage.getRoomMetadata(DISCORD_TK);
    assert.ok(third);
    assert.ok(third.resolvedAt > first.resolvedAt,
      "changed display_name/serverName must bump resolved_at");
    assert.equal(third.displayName, "#general (RenamedServer)");
  } finally {
    storage.close();
  }
});

test("listKnownTimelineKeys unions event and session timelines", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(event("e1", TK));
    await storage.appendTimelineEvent(event("e2", "matrix:miku:dm:@bob:example.org"));

    const keys = storage.listKnownTimelineKeys();
    assert.ok(keys.includes(TK));
    assert.ok(keys.includes("matrix:miku:dm:@bob:example.org"));
  } finally {
    storage.close();
  }
});
