import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, type Summary, type TimelineCursor } from "../src/storage/index.js";
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

// ── insertSummaryWithLineage rolls back when job ID is invalid (#2) ──

test("insertSummaryWithLineage rolls back entire transaction when job update affects 0 rows", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // No job row exists for "nonexistent_job", so the UPDATE will affect 0 rows.
    const promise = storage.insertSummaryWithLineage({
      id: "sum_rollback",
      timelineKey: TK,
      level: 1,
      content: "should be rolled back",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev1",
      eventCount: 2,
      tokenCount: 50,
      modelId: null,
      status: "complete",
      generatedAt: Date.now(),
      eventIds: ["ev1", "ev2"],
      jobId: "nonexistent_job",
    });

    await assert.rejects(promise, /expected to update exactly 1 job row/);

    // The summary must NOT have been persisted (transaction rolled back).
    const summary = storage.getSummaryById("sum_rollback");
    assert.equal(summary, undefined, "summary should not exist after rollback");

    // Lineage rows must also not exist.
    const lineageCount = storage.read((db) =>
      (db.prepare("select count(*) as c from summary_events where summary_id = ?").get("sum_rollback") as { c: number }).c,
    );
    assert.equal(lineageCount, 0, "lineage rows should not exist after rollback");
  } finally {
    storage.close();
  }
});

test("insertSummaryWithLineage succeeds and marks job complete when job exists", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Create a pending job first.
    await storage.insertSummarizationJob({
      id: "job_valid",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev2",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });

    await storage.insertSummaryWithLineage({
      id: "sum_valid",
      timelineKey: TK,
      level: 1,
      content: "valid summary",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev2",
      eventCount: 2,
      tokenCount: 50,
      modelId: null,
      status: "complete",
      generatedAt: Date.now(),
      eventIds: ["ev1", "ev2"],
      jobId: "job_valid",
    });

    // Summary should be persisted.
    const summary = storage.getSummaryById("sum_valid");
    assert.ok(summary, "summary should exist");
    assert.equal(summary!.content, "valid summary");

    // Job should be marked complete with the result summary ID.
    const job = storage.getSummarizationJobById("job_valid");
    assert.ok(job, "job should exist");
    assert.equal(job!.status, "complete");
    assert.equal(job!.resultSummaryId, "sum_valid");
  } finally {
    storage.close();
  }
});

// ── getTimelineEventsAfter falls back when cursor missing (#2) ──

test("getTimelineEventsAfter falls back to recent events when cursor event does not exist", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Insert some events so getTimelineEvents would return them.
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev1", body: "one", timestamp: 1000 }),
    );
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev2", body: "two", timestamp: 2000 }),
    );

    const result = storage.getTimelineEventsAfter(TK, "nonexistent_event");
    // Should fall back to getTimelineEvents instead of returning empty array.
    const ids = result.map((e: CanonicalChatEvent) => e.id);
    assert.deepEqual(ids, ["ev1", "ev2"], "should fall back to recent events when cursor is missing");
  } finally {
    storage.close();
  }
});

test("getTimelineEventsAfter uses structured logger when cursor event missing", async () => {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const mockLogger = {
    debug() {},
    info() {},
    warn(message: string, fields?: Record<string, unknown>) { warnings.push({ message, fields }); },
    error() {},
    child() { return mockLogger; },
  };
  const storage = await Storage.open({ databasePath: ":memory:", logger: mockLogger });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev1", body: "one", timestamp: 1000 }),
    );

    storage.getTimelineEventsAfter(TK, "nonexistent_event");
    assert.equal(warnings.length, 1, "should have logged exactly one warning via structured logger");
    assert.ok(
      warnings[0]!.message.includes("cursor event not found"),
      "warning message should mention cursor event not found",
    );
    assert.equal(warnings[0]!.fields?.afterEventId, "nonexistent_event");
  } finally {
    storage.close();
  }
});

test("getTimelineEventsAfter returns events after cursor when it exists", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev1", body: "one", timestamp: 1000 }),
    );
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev2", body: "two", timestamp: 2000 }),
    );
    await storage.appendTimelineEvent(
      assistantEvent({ id: "ev3", body: "three", timestamp: 3000 }),
    );

    const result = storage.getTimelineEventsAfter(TK, "ev1");
    const ids = result.map((e: CanonicalChatEvent) => e.id);
    assert.deepEqual(ids, ["ev2", "ev3"], "should return only events after the cursor (exclusive)");
  } finally {
    storage.close();
  }
});

// ── insertSummaryWithLineage rejects both eventIds and parentIds (#8) ──

test("insertSummaryWithLineage rejects when both eventIds and parentIds are provided", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Create a job so the transaction doesn't fail on the job update.
    await storage.insertSummarizationJob({
      id: "job_both",
      timelineKey: "matrix:test:room:!room",
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev2",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });

    const result = storage.insertSummaryWithLineage({
      id: "bad_both",
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
      eventIds: ["ev1", "ev2"],
      parentIds: ["parent1"],
      jobId: "job_both",
    });

    await assert.rejects(result, { message: "Summary cannot have both eventIds and parentIds" });

    // The summary must NOT have been persisted (transaction rolled back).
    const summary = storage.getSummaryById("bad_both");
    assert.equal(summary, undefined, "summary should not exist after guard rejection");
  } finally {
    storage.close();
  }
});

// ── claimNextSummarizationJob CAS tests (#10) ────────────────────

test("claimNextSummarizationJob returns claimed job with status processing and attempts 1", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.insertSummarizationJob({
      id: "job_claim",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev5",
      inputTokenCount: 200,
      targetTokenCount: 100,
      maxRetries: 3,
    });

    const claimed = await storage.claimNextSummarizationJob();
    assert.ok(claimed, "should return a job");
    assert.equal(claimed!.id, "job_claim");
    assert.equal(claimed!.status, "processing");
    assert.equal(claimed!.attempts, 1);
  } finally {
    storage.close();
  }
});

test("claimNextSummarizationJob returns undefined when no pending jobs exist", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const claimed = await storage.claimNextSummarizationJob();
    assert.equal(claimed, undefined, "should return undefined when no pending jobs");
  } finally {
    storage.close();
  }
});

test("claimNextSummarizationJob does not return the same job twice", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.insertSummarizationJob({
      id: "job_once",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev3",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });

    const first = await storage.claimNextSummarizationJob();
    assert.ok(first, "first claim should succeed");
    assert.equal(first!.id, "job_once");

    const second = await storage.claimNextSummarizationJob();
    assert.equal(second, undefined, "second claim should return undefined — job already processing");
  } finally {
    storage.close();
  }
});

// ── getMetadata / setMetadata round-trip tests (#10) ─────────────

test("getMetadata returns null for a nonexistent key", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const value = storage.getMetadata("no_such_key");
    assert.equal(value, null);
  } finally {
    storage.close();
  }
});

test("setMetadata then getMetadata round-trips the value", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setMetadata("test_key", "test_value");
    const value = storage.getMetadata("test_key");
    assert.equal(value, "test_value");
  } finally {
    storage.close();
  }
});

test("setMetadata with same key overwrites (upsert)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.setMetadata("overwrite_key", "first");
    await storage.setMetadata("overwrite_key", "second");
    const value = storage.getMetadata("overwrite_key");
    assert.equal(value, "second");
  } finally {
    storage.close();
  }
});

// ── getTimelineEventsBetween cursor range tests (#10) ────────────

test("getTimelineEventsBetween returns events within inclusive cursor range", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Insert 5 events with distinct timestamps.
    for (let i = 1; i <= 5; i++) {
      await storage.appendTimelineEvent(
        assistantEvent({ id: `ev${i}`, body: `body ${i}`, timestamp: i * 1000 }),
      );
    }

    // Get cursors for the boundary events.
    const startCursor = storage.getEventCursor(TK, "ev2");
    const endCursor = storage.getEventCursor(TK, "ev4");
    assert.ok(startCursor, "start cursor should exist");
    assert.ok(endCursor, "end cursor should exist");

    const events = storage.getTimelineEventsBetween(TK, startCursor!, endCursor!);
    const ids = events.map((e) => e.id);

    // ev2, ev3, ev4 are in range (inclusive).
    assert.deepEqual(ids, ["ev2", "ev3", "ev4"]);
  } finally {
    storage.close();
  }
});

test("getTimelineEventsBetween excludes events outside the range", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 1; i <= 5; i++) {
      await storage.appendTimelineEvent(
        assistantEvent({ id: `ev${i}`, body: `body ${i}`, timestamp: i * 1000 }),
      );
    }

    const startCursor = storage.getEventCursor(TK, "ev2");
    const endCursor = storage.getEventCursor(TK, "ev4");
    assert.ok(startCursor);
    assert.ok(endCursor);

    const events = storage.getTimelineEventsBetween(TK, startCursor!, endCursor!);
    const ids = events.map((e) => e.id);

    // ev1 (before range) and ev5 (after range) must be excluded.
    assert.ok(!ids.includes("ev1"), "ev1 should be excluded (before range)");
    assert.ok(!ids.includes("ev5"), "ev5 should be excluded (after range)");
  } finally {
    storage.close();
  }
});

// ── resetStaleSummarizationJobs (#6) ────────────────────────────────

test("resetStaleSummarizationJobs resets processing jobs to pending with attempts unchanged", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Insert a pending job, claim it (sets status='processing', attempts=1).
    await storage.insertSummarizationJob({
      id: "job_stale",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev3",
      inputTokenCount: 200,
      targetTokenCount: 100,
      maxRetries: 2,
    });
    const claimed = await storage.claimNextSummarizationJob();
    assert.ok(claimed);
    assert.equal(claimed!.status, "processing");
    assert.equal(claimed!.attempts, 1);

    // Reset stale processing jobs (simulates startup after crash).
    const resetCount = await storage.resetStaleSummarizationJobs();
    assert.equal(resetCount, 1, "should reset exactly 1 processing job");

    // Verify the job is now pending with attempts unchanged.
    const job = storage.getSummarizationJobById("job_stale");
    assert.ok(job);
    assert.equal(job!.status, "pending", "status should be reset to pending");
    assert.equal(job!.attempts, 1, "attempts should be left as-is (spec: not modified)");
  } finally {
    storage.close();
  }
});

test("resetStaleSummarizationJobs does not affect pending/complete/failed jobs", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    // Pending job: should remain pending.
    await storage.insertSummarizationJob({
      id: "job_pending",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev2",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });

    // Complete job: create pending, claim it, then complete it via insertSummaryWithLineage.
    await storage.insertSummarizationJob({
      id: "job_complete",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev3",
      inputEndId: "ev4",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });
    await storage.claimNextSummarizationJob(); // claims job_pending (oldest)
    await storage.retrySummarizationJob("job_pending", "retry test"); // back to pending
    await storage.claimNextSummarizationJob(); // claims job_complete
    await storage.insertSummaryWithLineage({
      id: "sum_complete",
      timelineKey: TK,
      level: 1,
      content: "done",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev4",
      eventCount: 2,
      tokenCount: 50,
      modelId: null,
      status: "complete",
      generatedAt: Date.now(),
      eventIds: ["ev3", "ev4"],
      jobId: "job_complete",
    });

    // Failed job: create, claim, then fail it.
    await storage.insertSummarizationJob({
      id: "job_failed",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev5",
      inputEndId: "ev6",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 0,
    });
    await storage.claimNextSummarizationJob(); // claims job_pending again (it's pending again)
    // Manually fail job_failed by first claiming it.
    await storage.retrySummarizationJob("job_pending", "retry again"); // back to pending
    // We need job_failed to be in 'pending' state first so we can claim it.
    // Let's just directly set its status via failSummarizationJob.
    await storage.failSummarizationJob("job_failed", "permanent failure");

    // Now reset stale. Only processing jobs should be affected.
    const resetCount = await storage.resetStaleSummarizationJobs();
    assert.equal(resetCount, 0, "should not reset any jobs (none are processing)");

    // Verify each job's status is unchanged.
    const pending = storage.getSummarizationJobById("job_pending");
    assert.equal(pending!.status, "pending", "pending job should remain pending");

    const complete = storage.getSummarizationJobById("job_complete");
    assert.equal(complete!.status, "complete", "complete job should remain complete");

    const failed = storage.getSummarizationJobById("job_failed");
    assert.equal(failed!.status, "failed", "failed job should remain failed");
  } finally {
    storage.close();
  }
});

// ── saveBestEffortDraft (#7) ────────────────────────────────────────

test("saveBestEffortDraft saves draft text on the job row", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.insertSummarizationJob({
      id: "job_draft",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev3",
      inputTokenCount: 200,
      targetTokenCount: 100,
      maxRetries: 2,
    });

    // Before save, best_effort_draft should be null.
    const before = storage.getSummarizationJobById("job_draft");
    assert.ok(before);
    assert.equal(before!.bestEffortDraft, null, "draft should be null before save");

    // Save a draft.
    await storage.saveBestEffortDraft("job_draft", "partial summary content here");

    // After save, the draft should be persisted.
    const after = storage.getSummarizationJobById("job_draft");
    assert.ok(after);
    assert.equal(after!.bestEffortDraft, "partial summary content here", "draft should match saved text");
  } finally {
    storage.close();
  }
});

test("saveBestEffortDraft overwrites a previous draft", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const TK = "matrix:miku:room:!room";
  try {
    await storage.insertSummarizationJob({
      id: "job_draft2",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev1",
      inputEndId: "ev3",
      inputTokenCount: 200,
      targetTokenCount: 100,
      maxRetries: 2,
    });

    await storage.saveBestEffortDraft("job_draft2", "first attempt");
    await storage.saveBestEffortDraft("job_draft2", "second attempt shorter");

    const job = storage.getSummarizationJobById("job_draft2");
    assert.ok(job);
    assert.equal(job!.bestEffortDraft, "second attempt shorter", "should overwrite previous draft");
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
