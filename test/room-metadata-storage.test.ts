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
