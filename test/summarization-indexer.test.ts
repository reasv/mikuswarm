import assert from "node:assert/strict";
import test from "node:test";

import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { SummarizationIndexer } from "../src/summarization/index.js";
import { ContextBuilder } from "../src/context/builder.js";
import { estimateTokens } from "../src/context/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

// ---------------------------------------------------------------------------
// Eager level-1 summarization + wait-or-omit (spec CONCURRENCY-AND-RATE-LIMITING §7).
//
// The SummarizationIndexer owns the generation-threshold evaluation, off the
// context-build hot path (the threshold tests here were ported from the old
// in-builder `maybeEnqueueLevel1`). The builder's wait-or-omit path is covered
// below: wait-until-terminal on a covering active job (with escalation), and
// the failure placeholder for a terminally failed range.
// ---------------------------------------------------------------------------

const TK = "matrix:miku:room:!room";

const TINY_RICH_TIERS = {
  rich_target_tokens: 1,
  rich_max_tokens: 1,
  compact_target_tokens: 40000,
  compact_max_tokens: 80000,
};

function testEvent(o: { id: string; body: string; timestamp: number; role?: "user" | "assistant" }): CanonicalChatEvent {
  return {
    id: o.id,
    timelineKey: TK,
    provider: "matrix",
    role: o.role ?? "user",
    sender: { id: "alice", displayName: "Alice" },
    body: o.body,
    timestamp: o.timestamp,
    receivedAt: o.timestamp,
  };
}

const emptyWorkspace: WorkspaceContent = {
  files: new Map(),
  tailContent: null,
  skills: { listed: [], inlined: [] },
};

function minimalConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
    },
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
      },
    },
    context: { tiers: TINY_RICH_TIERS },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...overrides,
  } as AppConfig;
}

async function seedTimeline(storage: Storage, count = 20, spacingMs = 1): Promise<TimelineStore> {
  const timeline = new TimelineStore(storage);
  for (let i = 0; i < count; i++) {
    await timeline.append(
      testEvent({
        id: `ev${String(i).padStart(4, "0")}`,
        body: `message content with some words ${i}`,
        timestamp: 1000 + i * spacingMs,
      }),
    );
  }
  return timeline;
}

/** Insert a pending level-1 job covering [startId, endId]. */
async function insertJob(
  storage: Storage,
  id: string,
  startId: string,
  endId: string,
): Promise<void> {
  await storage.insertSummarizationJob({
    id,
    timelineKey: TK,
    level: 1,
    inputStartId: startId,
    inputEndId: endId,
    inputTokenCount: 100,
    targetTokenCount: 50,
    maxRetries: 2,
  });
}

/** Complete a job by inserting its summary with full lineage over [from, to]. */
async function completeJob(
  storage: Storage,
  jobId: string,
  summaryId: string,
  content: string,
  fromIndex: number,
  toIndex: number,
  spacingMs = 1,
): Promise<string[]> {
  const eventIds = Array.from(
    { length: toIndex - fromIndex + 1 },
    (_, i) => `ev${String(fromIndex + i).padStart(4, "0")}`,
  );
  await storage.insertSummaryWithLineage({
    id: summaryId,
    timelineKey: TK,
    level: 1,
    content,
    earliestTimestamp: 1000 + fromIndex * spacingMs,
    latestTimestamp: 1000 + toIndex * spacingMs,
    latestEventId: eventIds[eventIds.length - 1]!,
    eventCount: eventIds.length,
    tokenCount: estimateTokens(content),
    modelId: "test-model",
    status: "complete",
    generatedAt: Date.now(),
    eventIds,
    jobId,
  });
  return eventIds;
}

function makeIndexer(
  storage: Storage,
  store: TimelineStore,
  summarization: Record<string, unknown>,
  onJobEnqueued?: () => void,
): SummarizationIndexer {
  return new SummarizationIndexer({
    storage,
    store,
    config: summarization,
    tiers: TINY_RICH_TIERS,
    onJobEnqueued,
  });
}

function drainTail(indexer: SummarizationIndexer): Promise<void> {
  // stop() awaits the FIFO tail; fine for tests (each test uses a fresh indexer).
  return indexer.stop();
}

test("indexer enqueues a level-1 job when the threshold is crossed (enabled undefined)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    let jobEnqueued = false;
    const indexer = makeIndexer(
      storage,
      timeline,
      { generation_threshold_tokens: 1, leaf_input_tokens: 10, leaf_target_tokens: 5 },
      () => { jobEnqueued = true; },
    );
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);

    assert.equal(jobEnqueued, true, "enabled key missing defaults to enabled");
    const jobs = storage.getActiveSummarizationJobs(TK, 1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.level, 1);
    assert.equal(jobs[0]!.priority, "background");
  } finally {
    storage.close();
  }
});

test("indexer does not enqueue a duplicate when a pending job covers the same range", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    await storage.insertSummarizationJob({
      id: "existing_job",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev0000",
      inputEndId: "ev0009",
      inputTokenCount: 50,
      targetTokenCount: 5,
      maxRetries: 2,
    });
    let jobEnqueued = false;
    const indexer = makeIndexer(
      storage,
      timeline,
      { generation_threshold_tokens: 1, leaf_input_tokens: 10, leaf_target_tokens: 5 },
      () => { jobEnqueued = true; },
    );
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);

    assert.equal(jobEnqueued, false);
    const jobs = storage.getActiveSummarizationJobs(TK, 1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, "existing_job");
  } finally {
    storage.close();
  }
});

test("indexer skips when summarization.enabled is explicitly false", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    let jobEnqueued = false;
    const indexer = makeIndexer(
      storage,
      timeline,
      { enabled: false, generation_threshold_tokens: 1, leaf_input_tokens: 10, leaf_target_tokens: 5 },
      () => { jobEnqueued = true; },
    );
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);
    assert.equal(jobEnqueued, false);
    assert.equal(storage.getActiveSummarizationJobs(TK, 1).length, 0);
  } finally {
    storage.close();
  }
});

test("indexer stays idle under the threshold", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage, 2);
    const indexer = makeIndexer(storage, timeline, {
      generation_threshold_tokens: 100000,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    });
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);
    assert.equal(storage.getActiveSummarizationJobs(TK, 1).length, 0);
  } finally {
    storage.close();
  }
});

test("reconcileAll sweeps active timelines (startup catch-up)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    await storage.setTimelineState(TK, "active");
    const indexer = makeIndexer(storage, timeline, {
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    });
    await indexer.reconcileAll();
    await drainTail(indexer);
    assert.equal(storage.getActiveSummarizationJobs(TK, 1).length, 1, "threshold crossed while down is caught");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Wait-or-omit (§7.2) — the builder waits on a covering job until terminal,
// escalating it; a failed range renders as a placeholder, never a silent drop.
// ---------------------------------------------------------------------------

/** Config with a compact ceiling small enough that 20 events overflow it. */
function overflowConfig(compactMax = 20, compactTarget = 10): AppConfig {
  return minimalConfig({
    summarization: {
      enabled: true,
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    },
    context: {
      tiers: {
        rich_target_tokens: 1,
        rich_max_tokens: 1,
        compact_target_tokens: compactTarget,
        compact_max_tokens: compactMax,
      },
    },
  } as any);
}

test("wait-or-omit: a live build escalates and waits for the covering job, then uses the summary", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    const builder = new ContextBuilder(timeline, overflowConfig(), storage);

    // A pending job covering the whole backlog (what the eager indexer enqueues).
    await storage.insertSummarizationJob({
      id: "job_wait",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev0000",
      inputEndId: "ev0018",
      inputTokenCount: 200,
      targetTokenCount: 50,
      maxRetries: 2,
    });

    const escalations: Array<{ jobId: string; priority: string }> = [];
    builder.escalateSummary = (jobId, priority) => escalations.push({ jobId, priority });

    // Complete the job (insert its summary) shortly after the build starts
    // waiting — simulating the escalated worker finishing.
    const completeLater = (async () => {
      await new Promise((r) => setTimeout(r, 400));
      await storage.insertSummaryWithLineage({
        id: "sum_wait",
        timelineKey: TK,
        level: 1,
        content: "summarized backlog of nineteen messages",
        earliestTimestamp: 1000,
        latestTimestamp: 1018,
        latestEventId: "ev0018",
        eventCount: 19,
        tokenCount: estimateTokens("summarized backlog of nineteen messages"),
        modelId: "test-model",
        status: "complete",
        generatedAt: Date.now(),
        eventIds: Array.from({ length: 19 }, (_, i) => `ev${String(i).padStart(4, "0")}`),
        jobId: "job_wait",
      });
    })();

    const trigger = testEvent({ id: "trigger-w", body: "hi", timestamp: 2000 });
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    await completeLater;

    // The build waited for the job (escalating it to interactive) and rendered
    // the freshly completed summary instead of dropping history.
    assert.deepEqual(escalations, [{ jobId: "job_wait", priority: "interactive" }]);
    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "summary layer present after the wait");
    assert.match(layer!.content, /summarized backlog/);
  } finally {
    storage.close();
  }
});

test("wait-or-omit (issue #6): a proactive build escalates the covering job at its OWN class, not interactive", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    const builder = new ContextBuilder(timeline, overflowConfig(), storage);
    await insertJob(storage, "job_pro", "ev0000", "ev0018");

    const escalations: Array<{ jobId: string; priority: string }> = [];
    builder.escalateSummary = (jobId, priority) => escalations.push({ jobId, priority });

    const completeLater = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await completeJob(storage, "job_pro", "sum_pro", "summarized backlog", 0, 18);
    })();

    const trigger = testEvent({ id: "trigger-p", body: "", timestamp: 2000 });
    await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      proactive: true,
      priority: "proactive",
    });
    await completeLater;

    assert.deepEqual(
      escalations,
      [{ jobId: "job_pro", priority: "proactive" }],
      "spec §5.5: the waiting class is the building session's own class",
    );
  } finally {
    storage.close();
  }
});

test("wait-or-omit (issue #7): aborting the drain signal rejects a waiting build cleanly with AbortError", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    const builder = new ContextBuilder(timeline, overflowConfig(), storage);
    // A pending covering job that NO worker will ever finish (shutdown shape:
    // the pool is being torn down).
    await insertJob(storage, "job_stuck", "ev0000", "ev0018");
    builder.escalateSummary = () => {};

    const drain = new AbortController();
    const pending = builder.build({
      timelineKey: TK,
      trigger: testEvent({ id: "trigger-a", body: "hi", timestamp: 2000 }),
      activeSessions: [],
      workspace: emptyWorkspace,
      abortSignal: drain.signal,
    });
    // Let the build enter the wait loop, then fire the drain abort.
    setTimeout(() => drain.abort(), 150);

    await assert.rejects(pending, (err: Error) => {
      assert.equal(err.name, "AbortError", "clean AbortError, not a hang or unhandled rejection");
      assert.match(err.message, /aborted/);
      return true;
    });
    // The job is untouched — the build never terminalized or dropped anything.
    assert.equal(storage.getSummarizationJobById("job_stuck")?.status, "pending");
  } finally {
    storage.close();
  }
});

test("wait-or-omit: a terminally failed range renders an explicit placeholder, not a silent gap", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    // Ceiling sized so the FULL backlog overflows (19 compact renders ≈ 400
    // tokens > 120) but the post-placeholder remainder (3 events ≈ 65) fits —
    // the test isolates the placeholder substitution, not compaction's
    // ordinary bounds.
    const builder = new ContextBuilder(timeline, overflowConfig(120, 60), storage);

    // A job covering most of the backlog that failed permanently (no draft).
    await storage.insertSummarizationJob({
      id: "job_dead",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev0000",
      inputEndId: "ev0015",
      inputTokenCount: 200,
      targetTokenCount: 50,
      maxRetries: 2,
    });
    await storage.failSummarizationJob("job_dead", "model exploded");

    const trigger = testEvent({ id: "trigger-f", body: "hi", timestamp: 2000 });
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });

    // The failed range's events are omitted, replaced by a placeholder summary
    // in the layer with the usual envelope.
    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "placeholder renders in the summary layer slot");
    assert.match(layer!.content, /could not be generated/);
    assert.match(layer!.content, /events="16"/, "envelope carries the omitted-range metadata");
    const chatContent = built.messages
      .filter((m) => m.type === "chatEvent")
      .map((m) => m.content)
      .join("\n");
    assert.ok(!chatContent.includes("words 3"), "covered events are omitted from the raw turns");
    assert.ok(chatContent.includes("words 17"), "uncovered newer events remain");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Regressions for the Design C correctness review (issues #1-#3):
//   #1 — the coverage cursor must advance past a waited summary (event-based
//        contiguity, not the old 1ms timestamp tolerance), so completion of a
//        waited job trims the raw set instead of double-rendering + dropping.
//   #2 — a terminally failed range is terminal: never re-enqueued; its
//        placeholder takes over the slot.
//   #3 — a deep multi-chunk backlog build triggers awaited indexer reconciles
//        instead of concluding "nothing covers the oldest" and dropping.
// ---------------------------------------------------------------------------

const SPACING = 10_000; // realistic inter-message interval (10s), >> the old 1ms tolerance

test("issue #1: waited-summary completion advances coverage past an adjacent summary — no drop, no double render", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage, 20, SPACING);
    const builder = new ContextBuilder(timeline, overflowConfig(), storage);

    // S1 already covers ev0000..ev0009 (a previous chunk). J2 covers the next
    // chunk ev0010..ev0018 and is still pending when the build starts.
    await insertJob(storage, "j1", "ev0000", "ev0009");
    await completeJob(storage, "j1", "sum_1", "first chunk summary", 0, 9, SPACING);
    await insertJob(storage, "j2", "ev0010", "ev0018");

    const escalations: Array<{ jobId: string; priority: string }> = [];
    builder.escalateSummary = (jobId, priority) => escalations.push({ jobId, priority });

    const completeLater = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await completeJob(storage, "j2", "sum_2", "second chunk summary", 10, 18, SPACING);
    })();

    const trigger = testEvent({ id: "trigger-adv", body: "hi", timestamp: 1000 + 25 * SPACING });
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    await completeLater;

    assert.deepEqual(escalations, [{ jobId: "j2", priority: "interactive" }]);

    // Both summaries render in the layer (the chain crossed the real
    // inter-message interval between them).
    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "summary layer present");
    assert.match(layer!.content, /first chunk summary/);
    assert.match(layer!.content, /second chunk summary/, "waited summary renders in the layer");

    const chatContent = built.messages
      .filter((m) => m.type === "chatEvent")
      .map((m) => m.content)
      .join("\n");
    // No double render: events covered by the waited summary must not render raw.
    for (let i = 10; i <= 18; i++) {
      assert.ok(!chatContent.includes(`words ${i}<`) && !chatContent.includes(`words ${i}\n`) && !new RegExp(`words ${i}\\b`).test(chatContent),
        `covered event ${i} must not render raw`);
    }
    // No silent drop: the only uncovered timeline event still renders raw.
    assert.match(chatContent, /words 19\b/, "uncovered newest event remains raw");
  } finally {
    storage.close();
  }
});

test("issue #1 (indexer side): adjacent summaries do not get their ranges re-counted or re-enqueued", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage, 20, SPACING);
    await insertJob(storage, "j1", "ev0000", "ev0009");
    await completeJob(storage, "j1", "sum_1", "first chunk summary", 0, 9, SPACING);
    await insertJob(storage, "j2", "ev0010", "ev0018");
    await completeJob(storage, "j2", "sum_2", "second chunk summary", 10, 18, SPACING);

    // Remaining un-summarized: ev0019 only (and it is the rich tail). With the
    // old timestamp-tolerance cursor the indexer re-counted ev0010..ev0019 as
    // un-summarized and re-enqueued an already-summarized range.
    const indexer = makeIndexer(storage, timeline, {
      generation_threshold_tokens: 50,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    });
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);

    assert.equal(
      storage.getActiveSummarizationJobs(TK, 1).length,
      0,
      "no job enqueued over already-summarized ranges",
    );
  } finally {
    storage.close();
  }
});

test("issue #2: a terminally failed range is never re-enqueued; the next chunk starts after it; builds render the placeholder", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage, 20, SPACING);
    await insertJob(storage, "job_dead", "ev0000", "ev0015");
    await storage.failSummarizationJob("job_dead", "model exploded");

    const indexer = makeIndexer(storage, timeline, {
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    });
    indexer.enqueueReconcileTimeline(TK);
    await drainTail(indexer);

    // The failed range is terminal: the new chunk starts strictly after it.
    const active = storage.getActiveSummarizationJobs(TK, 1);
    assert.equal(active.length, 1, "exactly one new job");
    assert.equal(active[0]!.inputStartId, "ev0016", "chunk starts after the failed range");

    // A second reconcile is a no-op (active overlap + failed terminality).
    const indexer2 = makeIndexer(storage, timeline, {
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    });
    indexer2.enqueueReconcileTimeline(TK);
    await drainTail(indexer2);
    assert.equal(storage.getActiveSummarizationJobs(TK, 1).length, 1, "no duplicate job");

    // An under-budget build renders the placeholder deterministically and
    // omits the failed range's raw events (the placeholder advanced the
    // cursor) — no wait on the unrelated active job is needed.
    const builder = new ContextBuilder(timeline, overflowConfig(100000, 50000), storage);
    const trigger = testEvent({ id: "trigger-f2", body: "hi", timestamp: 1000 + 25 * SPACING });
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "placeholder renders in the summary layer slot");
    assert.match(layer!.content, /could not be generated/);
    assert.match(layer!.content, /events="16"/);
    const chatContent = built.messages
      .filter((m) => m.type === "chatEvent")
      .map((m) => m.content)
      .join("\n");
    assert.ok(!/words 3\b/.test(chatContent), "failed-covered events omitted from raw turns");
    assert.match(chatContent, /words 17\b/, "events after the failed range remain raw");
  } finally {
    storage.close();
  }
});

test("issue #3: deep multi-chunk backlog — the build reconciles, waits each chunk, and never drops events", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const count = 36;
    const timeline = new TimelineStore(storage);
    for (let i = 0; i < count; i++) {
      await timeline.append(
        testEvent({
          id: `ev${String(i).padStart(4, "0")}`,
          body: `unique marker-${i}.`,
          timestamp: 1000 + i * SPACING,
        }),
      );
    }

    const config = minimalConfig({
      summarization: {
        enabled: true,
        generation_threshold_tokens: 30,
        leaf_input_tokens: 60,
        leaf_target_tokens: 5,
      },
      context: {
        tiers: {
          rich_target_tokens: 1,
          rich_max_tokens: 1,
          compact_target_tokens: 40,
          compact_max_tokens: 80,
        },
      },
    } as any);
    const builder = new ContextBuilder(timeline, config, storage);
    const indexer = new SummarizationIndexer({
      storage,
      store: timeline,
      config: (config as any).summarization,
      tiers: (config as any).context.tiers,
    });
    // NO jobs exist up front and there is no app-level onComplete reconcile in
    // this harness — chunk N+1 only ever appears because the builder asks for
    // an awaited reconcile (the fix for the onComplete race).
    builder.reconcileSummaries = (tl) => indexer.reconcileTimeline(tl).catch(() => {});

    // Fake worker: claim each job and complete it with a real lineage summary.
    const coveredIds = new Set<string>();
    let stopWorker = false;
    const worker = (async () => {
      while (!stopWorker) {
        const job = await storage.claimNextSummarizationJob();
        if (!job) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        const start = storage.getEventCursor(TK, job.inputStartId)!;
        const end = storage.getEventCursor(TK, job.inputEndId)!;
        const events = storage.getTimelineEventsBetween(TK, start, end);
        await storage.insertSummaryWithLineage({
          id: `sum_${job.id}`,
          timelineKey: TK,
          level: 1,
          content: `summary of ${job.inputStartId}..${job.inputEndId}`,
          earliestTimestamp: events[0]!.timestamp,
          latestTimestamp: events[events.length - 1]!.timestamp,
          latestEventId: events[events.length - 1]!.id,
          eventCount: events.length,
          tokenCount: 10,
          modelId: "test-model",
          status: "complete",
          generatedAt: Date.now(),
          eventIds: events.map((e) => e.id),
          jobId: job.id,
        });
        for (const e of events) coveredIds.add(e.id);
      }
    })();

    const trigger = testEvent({ id: "trigger-deep", body: "hi", timestamp: 1000 + 50 * SPACING });
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });
    stopWorker = true;
    await worker;

    assert.ok(coveredIds.size > 0, "the backlog required at least one summarization wait");

    const chatContent = built.messages
      .filter((m) => m.type === "chatEvent")
      .map((m) => m.content)
      .join("\n");
    // NO event may be silently dropped: every seeded event renders raw or is
    // covered by a summary that the layer renders. And no covered event may
    // double-render raw.
    const layer = built.messages.find((m) => m.type === "summaryLayer");
    assert.ok(layer, "summary layer present");
    for (let i = 0; i < count; i++) {
      const id = `ev${String(i).padStart(4, "0")}`;
      const inChat = chatContent.includes(`marker-${i}.`);
      if (coveredIds.has(id)) {
        assert.ok(!inChat, `covered event ${id} must not double-render raw`);
      } else {
        assert.ok(inChat, `uncovered event ${id} must render raw (was silently dropped)`);
      }
    }
  } finally {
    storage.close();
  }
});

test("wait-or-omit (spec LLM-FAILURE-HANDLING §7.1): an interactive build's wait is bounded by the wall-clock budget", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = await seedTimeline(storage);
    const cfg = overflowConfig();
    // Tiny interactive wall-clock budget: the covering job never completes
    // (model-outage shape), so the wait must reject with the typed timeout —
    // never block indefinitely, never proceed on degraded context.
    (cfg as any).recovery = { llm_request_max_wait_ms: 400 };
    const builder = new ContextBuilder(timeline, cfg, storage);
    await insertJob(storage, "job_outage", "ev0000", "ev0018");
    builder.escalateSummary = () => {};

    await assert.rejects(
      builder.build({
        timelineKey: TK,
        trigger: testEvent({ id: "trigger-t", body: "hi", timestamp: 2000 }),
        activeSessions: [],
        workspace: emptyWorkspace,
      }),
      (err: Error) => {
        assert.equal(err.name, "BuildWaitTimeoutError", "typed timeout, not a hang");
        assert.match(err.message, /job_outage/);
        return true;
      },
    );
    // The job is UNTOUCHED: still queued, completed whenever its model
    // recovers, improving every later build on this timeline.
    assert.equal(storage.getSummarizationJobById("job_outage")?.status, "pending");
  } finally {
    storage.close();
  }
});
