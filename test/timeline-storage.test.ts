import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, type Summary } from "../src/storage/index.js";
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

// ── getSummariesBetween level filter ────────────────────────────────

test("getSummariesBetween filters by level when provided", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Insert summaries at levels 1 and 2 in the same timestamp range.
    for (let i = 0; i < 4; i++) {
      await insertSummary(storage, {
        id: `l1_${i}`,
        timelineKey: TK,
        level: 1,
        earliestTimestamp: i * 100,
        latestTimestamp: i * 100 + 50,
      });
    }
    // A level-2 summary spanning the same range.
    await insertSummary(storage, {
      id: "l2_0",
      timelineKey: TK,
      level: 2,
      earliestTimestamp: 100,
      latestTimestamp: 250,
    });

    // Without level filter: returns both levels.
    const all = storage.getSummariesBetween(TK, "l1_0", "l1_3");
    assert.equal(all.length, 5);

    // With level=1 filter: returns only L1 summaries.
    const l1Only = storage.getSummariesBetween(TK, "l1_0", "l1_3", 1);
    assert.equal(l1Only.length, 4);
    assert.ok(l1Only.every((s) => s.level === 1));

    // With level=2 filter: returns only the L2 summary.
    const l2Only = storage.getSummariesBetween(TK, "l1_0", "l1_3", 2);
    assert.equal(l2Only.length, 1);
    assert.equal(l2Only[0]!.id, "l2_0");
  } finally {
    storage.close();
  }
});

// ── insertSummaryWithLineage precondition throws via promise ────────

test("insertSummaryWithLineage rejects with precondition error via .catch()", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Level-1 summary without eventIds should be caught by .catch().
    const result = storage.insertSummaryWithLineage({
      id: "bad1",
      timelineKey: "matrix:test:room:!room",
      level: 1,
      content: "test",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev1",
      eventCount: 2,
      tokenCount: 50,
      modelId: null,
      status: "complete",
      generatedAt: Date.now(),
      eventIds: [],
      jobId: "job1",
    });

    await assert.rejects(result, { message: "Level-1 summary must have eventIds" });

    // Level 2+ summary without parentIds should also reject.
    const result2 = storage.insertSummaryWithLineage({
      id: "bad2",
      timelineKey: "matrix:test:room:!room",
      level: 2,
      content: "test",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev1",
      eventCount: 2,
      tokenCount: 50,
      modelId: null,
      status: "complete",
      generatedAt: Date.now(),
      parentIds: [],
      jobId: "job2",
    });

    await assert.rejects(result2, { message: "Level 2+ summary must have parentIds" });
  } finally {
    storage.close();
  }
});

// ── getSummaryCandidates inclusive boundary (#4) ────────────────────

test("getSummaryCandidates includes summaries whose latestTimestamp equals beforeTimestamp", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Summary whose latestTimestamp is exactly the cutoff.
    await insertSummary(storage, {
      id: "s_exact",
      timelineKey: TK,
      level: 1,
      earliestTimestamp: 100,
      latestTimestamp: 500,
    });
    // Summary whose latestTimestamp is before the cutoff.
    await insertSummary(storage, {
      id: "s_before",
      timelineKey: TK,
      level: 1,
      earliestTimestamp: 50,
      latestTimestamp: 400,
    });
    // Summary whose latestTimestamp is after the cutoff.
    await insertSummary(storage, {
      id: "s_after",
      timelineKey: TK,
      level: 1,
      earliestTimestamp: 200,
      latestTimestamp: 600,
    });

    const candidates = storage.getSummaryCandidates(TK, 500);
    const ids = candidates.map((s) => s.id);

    // The summary at exactly 500 must be included (inclusive <=), the one at 600 must not.
    assert.ok(ids.includes("s_exact"), "summary at exactly beforeTimestamp should be included");
    assert.ok(ids.includes("s_before"), "summary before beforeTimestamp should be included");
    assert.ok(!ids.includes("s_after"), "summary after beforeTimestamp should be excluded");
  } finally {
    storage.close();
  }
});

// ── Helpers ────────────────────────────────────────────────────────

function insertSummary(
  storage: Storage,
  s: Pick<Summary, "id" | "level" | "earliestTimestamp" | "latestTimestamp"> & { timelineKey?: string } & Partial<Summary>,
): Promise<void> {
  return storage.write((db) => {
    db.prepare(
      `insert into summaries (
        id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
        latest_event_id, event_count, token_count, model_id, status,
        backfill_job_id, generated_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
    ).run(
      s.id,
      s.timelineKey ?? "matrix:miku:room:!room",
      s.level,
      s.content ?? "body",
      s.earliestTimestamp,
      s.latestTimestamp,
      s.latestEventId ?? `ev_${s.id}`,
      s.eventCount ?? 1,
      s.tokenCount ?? 100,
      s.modelId ?? "model",
      s.status ?? "complete",
      s.generatedAt ?? 0,
      0,
    );
  });
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
