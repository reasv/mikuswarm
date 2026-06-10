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
        multimodal: false,
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

async function seedTimeline(storage: Storage, count = 20): Promise<TimelineStore> {
  const timeline = new TimelineStore(storage);
  for (let i = 0; i < count; i++) {
    await timeline.append(
      testEvent({
        id: `ev${String(i).padStart(4, "0")}`,
        body: `message content with some words ${i}`,
        timestamp: 1000 + i,
      }),
    );
  }
  return timeline;
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
