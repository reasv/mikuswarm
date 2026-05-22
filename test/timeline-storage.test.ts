import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { AssistantEchoResolver, TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

test("assistant echo enriches local sends with matching external id instead of appending duplicates", async () => {
  await withTimeline(async (timeline) => {
    await timeline.append(
      assistantEvent({
        id: "local-send",
        externalId: "$server-event",
        body: "already sent",
        timestamp: 1_000,
      }),
    );

    const result = await new AssistantEchoResolver(timeline).ingestOwnEcho(
      assistantEvent({
        id: "matrix:miku:$server-event",
        externalId: "$server-event",
        body: "already sent",
        timestamp: 2_000,
      }),
    );

    const events = timeline.query({ timelineKey: "matrix:miku:room:!room", limit: 10 });
    assert.equal(result, "enriched");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, "local-send");
    assert.equal(events[0]?.externalId, "$server-event");
  });
});

test("assistant echo matches by external id across DM self-echo timeline mismatch", async () => {
  await withTimeline(async (timeline) => {
    await timeline.append({
      ...assistantEvent({
        id: "assistant:s1:$server-event",
        externalId: "$server-event",
        body: "already sent",
        timestamp: 1_000,
      }),
      timelineKey: "matrix:miku:dm:@alice:example.org",
      agentSessionId: "s1",
    });

    const result = await new AssistantEchoResolver(timeline).ingestOwnEcho({
      ...assistantEvent({
        id: "matrix:miku:$server-event",
        externalId: "$server-event",
        body: "already sent",
        timestamp: 2_000,
      }),
      timelineKey: "matrix:miku:dm:@miku:example.org",
      sender: { id: "@miku:example.org", displayName: "Miku", isSelf: true },
    });

    const humanDmEvents = timeline.query({ timelineKey: "matrix:miku:dm:@alice:example.org", limit: 10 });
    const selfDmEvents = timeline.query({ timelineKey: "matrix:miku:dm:@miku:example.org", limit: 10 });

    assert.equal(result, "enriched");
    assert.equal(humanDmEvents.length, 1);
    assert.equal(selfDmEvents.length, 0);
    assert.equal(humanDmEvents[0]?.id, "assistant:s1:$server-event");
    assert.equal(humanDmEvents[0]?.timestamp, 2_000);
  });
});

test("timeline enrichment keeps query columns in sync with event json", async () => {
  await withTimeline(async (timeline) => {
    await timeline.append(
      assistantEvent({
        id: "event-1",
        externalId: undefined,
        body: "old",
        timestamp: 1_000,
      }),
    );

    await timeline.enrich("event-1", (event) => ({
      ...event,
      body: "new",
      timestamp: 10_000,
      receivedAt: 10_001,
      sender: { id: "mikuswarm", displayName: "Miku Updated", isSelf: true },
    }));

    const oldRange = timeline.query({
      timelineKey: "matrix:miku:room:!room",
      toTimestamp: 5_000,
      limit: 10,
    });
    const newRange = timeline.query({
      timelineKey: "matrix:miku:room:!room",
      fromTimestamp: 9_000,
      limit: 10,
    });

    assert.equal(oldRange.length, 0);
    assert.equal(newRange.length, 1);
    assert.equal(newRange[0]?.body, "new");
    assert.equal(newRange[0]?.sender.displayName, "Miku Updated");
  });
});

test("context queries start at persisted retained compaction cursor", async () => {
  await withTimeline(async (timeline) => {
    await timeline.append(assistantEvent({ id: "old", body: "old", timestamp: 1_000 }));
    await timeline.append(assistantEvent({ id: "rich-start", body: "rich start", timestamp: 2_000 }));
    await timeline.append(assistantEvent({ id: "new", body: "new", timestamp: 3_000 }));
    await timeline.saveCompactionState({
      schemaVersion: 1,
      timelineKey: "matrix:miku:room:!room",
      compactStartEventId: null,
      richStartEventId: "rich-start",
      updatedAt: 4_000,
    });

    const events = timeline.queryForContext(
      "matrix:miku:room:!room",
      timeline.getCompactionState("matrix:miku:room:!room"),
    );

    assert.deepEqual(
      events.map((event) => event.id),
      ["rich-start", "new"],
    );
  });
});

test("context cursor queries respect limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-storage-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const timeline = new TimelineStore(storage);
    for (let index = 0; index < 5; index += 1) {
      await timeline.append(assistantEvent({ id: `event-${index}`, body: `body ${index}`, timestamp: 1_000 + index }));
    }

    const events = storage.getTimelineEventsForContext("matrix:miku:room:!room", "event-1", 2);
    assert.deepEqual(
      events.map((event: CanonicalChatEvent) => event.id),
      ["event-1", "event-2"],
    );
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("append upsert preserves original created_at", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-storage-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const event = assistantEvent({ id: "same", body: "first", timestamp: 1_000 });
    await storage.appendTimelineEvent(event);
    const createdAt = storage.read((db) =>
      (db.prepare("select created_at from timeline_events where id = ?").get("same") as { created_at: number }).created_at,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await storage.appendTimelineEvent({ ...event, body: "second" });
    const row = storage.read((db) =>
      db.prepare("select created_at, body from timeline_events where id = ?").get("same") as {
        created_at: number;
        body: string;
      },
    );
    assert.equal(row.created_at, createdAt);
    assert.equal(row.body, "second");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function withTimeline(run: (timeline: TimelineStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-storage-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(new TimelineStore(storage));
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function assistantEvent(overrides: {
  id: string;
  externalId?: string;
  body: string;
  timestamp: number;
}): CanonicalChatEvent {
  return {
    id: overrides.id,
    externalId: overrides.externalId,
    timelineKey: "matrix:miku:room:!room",
    provider: "matrix",
    role: "assistant",
    sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
    body: overrides.body,
    timestamp: overrides.timestamp,
    receivedAt: overrides.timestamp,
  };
}
