import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { SummarizationIndexer, SummarizationWorkerPool, evaluateCondensation } from "../src/summarization/index.js";
import { estimateTokens } from "../src/context/index.js";
import { loadConfig } from "../src/config/loader.js";
import { createExpandSummaryTool } from "../src/tools/index.js";
import { createSummaryTool } from "../src/tools/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Summary budget (spec SUMMARY-LAYER-BUDGET) test suite.
//
// Covers: off-by-default, latch semantics, shape choice (absorb/bootstrap),
// same-level supersession, ordering, live-edge guard, top-level guard,
// guaranteed-saving guards, convergence, mirrored timeline no-op, config
// validation bounds.
// ---------------------------------------------------------------------------

const TK = "matrix:miku:room:!budget-test";

// Minimal tiers so compact rendering doesn't consume the whole token budget
// in the indexer's level-1 path.
const BASE_TIERS = {
  rich_target_tokens: 1,
  rich_max_tokens: 2,
  compact_target_tokens: 40_000,
  compact_max_tokens: 80_000,
  summary_target_tokens: 0, // disabled by default
  summary_max_tokens: 0,
};

function testEvent(o: {
  id: string;
  body: string;
  timestamp: number;
  role?: "user" | "assistant";
}): CanonicalChatEvent {
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

type TiersOverride = Partial<typeof BASE_TIERS>;
type SummConfig = {
  condense_fanout?: number;
  condense_target_tokens?: number;
  max_retries?: number;
  eager_condense_min_children?: number;
  eager_absorb_max_children?: number;
};

function makeIndexer(
  storage: Storage,
  store: TimelineStore,
  tiers: TiersOverride,
  summConfig: SummConfig = {},
  opts?: {
    onJobEnqueued?: () => void;
    isMirroredTimeline?: (key: string) => boolean;
    logger?: Parameters<InstanceType<typeof SummarizationIndexer>["stop"]>[0] extends never
      ? never
      : any;
  },
): SummarizationIndexer {
  return new SummarizationIndexer({
    storage,
    store,
    config: {
      enabled: true,
      condense_fanout: 5,
      condense_target_tokens: 800,
      max_retries: 2,
      ...summConfig,
    } as any,
    tiers: { ...BASE_TIERS, ...tiers } as any,
    onJobEnqueued: opts?.onJobEnqueued,
    isMirroredTimeline: opts?.isMirroredTimeline,
    logger: opts?.logger,
  });
}

/** Insert a summarization job + summary row into the DB (for test seeding). */
async function insertSummary(
  storage: Storage,
  id: string,
  content: string,
  level: number,
  earliestTs: number,
  latestTs: number,
  jobId: string,
  opts?: {
    parentIds?: string[];
    eventIds?: string[];
    absorbedParentId?: string;
  },
): Promise<void> {
  const startId = opts?.parentIds?.[0] ?? opts?.eventIds?.[0] ?? id;
  const endId =
    opts?.parentIds?.[opts.parentIds.length - 1] ??
    opts?.eventIds?.[opts.eventIds.length - 1] ??
    id;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey: TK,
    level,
    inputStartId: startId,
    inputEndId: endId,
    inputTokenCount: 10,
    targetTokenCount: 800,
    maxRetries: 2,
    absorbedParentId: opts?.absorbedParentId,
  });
  await storage.insertSummaryWithLineage({
    id,
    timelineKey: TK,
    level,
    content,
    earliestTimestamp: earliestTs,
    latestTimestamp: latestTs,
    latestEventId: endId,
    eventCount: 1,
    tokenCount: estimateTokens(content),
    modelId: "test-model",
    status: "complete",
    generatedAt: Date.now(),
    eventIds: opts?.eventIds,
    parentIds: opts?.parentIds,
    jobId,
    absorbedParentId: opts?.absorbedParentId,
  });
}

/**
 * Add a "live-edge sentinel" that raises newestLatestTs above all test summaries
 * (ts ≤ ~2100) so any test run is NOT treated as the live edge.
 *
 * Approach: insert 10 L1 summaries (se_l1_0..9, ts 2000-2009) condensed by a
 * single L2 parent se_P_full (ts 2000-2010, 10 children).
 *
 * - se_P_full.latestTimestamp=2010 > any test summary → newestLatestTs=2010 ✓
 * - se_P_full is at capacity (10 children = default absorbMax=2×fanout=10) so
 *   no test run can be absorbed into it, even if se_P_full is a rightCandidate.
 * - The L1 sentinel summaries are condensed by se_P_full, so they do NOT appear
 *   in any uncondensed L1 run and do not disrupt run detection.
 */
async function addSentinel(storage: Storage): Promise<void> {
  const parentIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `se_l1_${i}`;
    parentIds.push(id);
    await insertSummary(storage, id, "x", 1, 2000 + i, 2001 + i, `j_se_l1_${i}`, {
      eventIds: ["ev0"],
    });
  }
  // earliestTs=1999 (strictly before the L1 children at 2000+) so se_P_full sorts
  // first in selectSummaryCoverage and is added to the selection before any L1 child
  // is processed. All se_l1_* (latestTs ≤ 2010) are then skipped as covered.
  await insertSummary(storage, "se_P_full", "sentinel", 2, 1999, 2010, "j_se_P_full", {
    parentIds,
  });
}

// ---------------------------------------------------------------------------
// §9.1 Off-by-default regression
// ---------------------------------------------------------------------------

test("budget: feature is off when summary_target_tokens = 0; no eager jobs enqueued", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

    const bigContent = "word ".repeat(200);
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", bigContent, 1, 1002, 1003, "j2", { eventIds: ["ev0"] });

    let budgetJobs = 0;
    // summary_target_tokens = 0 → feature disabled.
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 0 },
      {},
      { onJobEnqueued: () => { budgetJobs++; } },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    assert.equal(budgetJobs, 0, "no budget jobs when feature is disabled");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.2 Latch semantics
// ---------------------------------------------------------------------------

test("budget: latch enters when layer > max (episode start event emitted)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

    // Big summary (~200 tokens) → layer > max (150).
    const bigContent = "word ".repeat(200);
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1000, "j1", { eventIds: ["ev0"] });
    // Sentinel so s1 is not the live edge.
    await addSentinel(storage);

    const logs: Array<{ event: string; phase?: string }> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      { condense_fanout: 5, condense_target_tokens: 800, max_retries: 2 },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    assert.ok(
      logs.some((l) => l.event === "summary_budget_episode" && l.phase === "start"),
      "episode start event emitted when layer > max",
    );
    assert.ok(
      !logs.some((l) => l.event === "summary_budget_episode" && l.phase === "end"),
      "no episode end yet (layer still over target after one pass with no worker)",
    );
  } finally {
    storage.close();
  }
});

test("budget: max=0 degenerates to single threshold (no hysteresis)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(200);
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1000, "j1", { eventIds: ["ev0"] });
    await addSentinel(storage);

    const logs: Array<{ event: string; phase?: string }> = [];
    // max=0 means effectiveMax = target (no hysteresis band).
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 0 },
      {},
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    assert.ok(
      logs.some((l) => l.event === "summary_budget_episode" && l.phase === "start"),
      "episode fires when layer > target (max=0 means effectiveMax=target)",
    );
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.3 Shape choice: absorb vs bootstrap
// ---------------------------------------------------------------------------

test("budget: absorb shape — adjacent under-capacity parent absorbs run members", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100); // ~100 tokens each

    // P (L2) covers s1 and s2. s3 (L1) is the uncondensed run, adjacent to P.
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", content, 1, 1004, 1005, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent content words here", 2, 1000, 1003, "j_P", {
      parentIds: ["s1", "s2"],
    });
    // Sentinel L3 at ts 99000 so s3 is not the live edge.
    await addSentinel(storage);

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 10,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const condensePending = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(condensePending, "a budget condense job was enqueued");
    assert.equal(condensePending!.shape, "absorb", "shape is absorb");
    assert.equal(condensePending!.parentId, "P", "absorbs into P");
  } finally {
    storage.close();
  }
});

test("budget: absorb — declared children = P's original children ∪ run members", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", content, 1, 1004, 1005, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent words", 2, 1000, 1003, "j_P", {
      parentIds: ["s1", "s2"],
    });
    await addSentinel(storage);

    let enqueuedJobId: string | undefined;
    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 10,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) => {
            if (event === "summarization_job_enqueued") {
              enqueuedJobId = (data as any).jobId as string;
            }
            logs.push({ event, ...(data as any) });
          },
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    assert.ok(enqueuedJobId, "a job was enqueued");
    const job = storage.getSummarizationJobById(enqueuedJobId!);
    assert.ok(job, "job exists in DB");
    assert.equal(job!.absorbedParentId, "P", "job carries absorbedParentId=P");

    // The job span must cover s1 (P's first child) through s3 (run member).
    const startSummary = storage.getSummaryById(job!.inputStartId);
    const endSummary = storage.getSummaryById(job!.inputEndId);
    assert.equal(startSummary?.earliestTimestamp, 1000, "job starts at s1");
    assert.equal(endSummary?.latestTimestamp, 1005, "job ends at s3");
  } finally {
    storage.close();
  }
});

test("budget: bootstrap — when all adjacent parents are at capacity", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    // P_full has 5 children (= fanout) — fully occupied.
    for (let i = 1; i <= 5; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    await insertSummary(storage, "P_full", "condensed parent", 2, 1001, 1006, "j_P", {
      parentIds: ["s1", "s2", "s3", "s4", "s5"],
    });
    // Additional L1 summaries adjacent to P_full — the run to be bootstrapped.
    for (let i = 6; i <= 8; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    // Sentinel at L3 so run [s6,s7,s8] is not the live edge.
    await addSentinel(storage);

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        eager_absorb_max_children: 5, // = fanout; P_full is already full
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const condensePending = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(condensePending, "a budget condense job was enqueued");
    assert.equal(condensePending!.shape, "bootstrap", "bootstrap (P_full is at capacity)");
  } finally {
    storage.close();
  }
});

test("budget: bootstrap — when no adjacent parent exists at all", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    // Just L1 summaries, no L2 parent.
    for (let i = 1; i <= 4; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    // Sentinel at L3: no L2 summaries exist, so sentinel won't be a L2-parent
    // candidate for the L1 run (tryEagerJobAtLevel level=1 looks for level+1=L2 parents).
    await addSentinel(storage);

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const condensePending = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(condensePending, "a budget condense job was enqueued");
    assert.equal(condensePending!.shape, "bootstrap", "bootstrap when no L2 parent exists");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.4 Same-level supersession (direct storage tests — no indexer needed)
// ---------------------------------------------------------------------------

test("budget: absorption marks P and run members as superseded", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

    await insertSummary(storage, "s1", "child1 words", 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", "child2 words", 1, 1002, 1003, "j2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", "runmember words", 1, 1004, 1005, "j3", { eventIds: ["ev0"] });
    // P covers s1, s2.
    await insertSummary(storage, "P", "parent old", 2, 1000, 1003, "jP", { parentIds: ["s1", "s2"] });

    // Simulate completed absorption: P_prime replaces P and absorbs s3.
    // parentIds = P's original children (s1, s2) ∪ run members (s3).
    await storage.insertSummarizationJob({
      id: "j_abs",
      timelineKey: TK,
      level: 2,
      inputStartId: "s1",
      inputEndId: "s3",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P",
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "new combined parent",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "j3",
      eventCount: 3,
      tokenCount: estimateTokens("new combined parent"),
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3"],
      jobId: "j_abs",
      absorbedParentId: "P",
    });

    // P must be superseded.
    assert.equal(storage.getSummaryById("P")?.status, "superseded", "P is superseded");
    // s3 (run member = parentIds − P's original children) must be superseded.
    assert.equal(storage.getSummaryById("s3")?.status, "superseded", "s3 (run member) superseded");
    // P's original children (s1, s2) are NOT superseded.
    assert.notEqual(storage.getSummaryById("s1")?.status, "superseded", "s1 not superseded");
    assert.notEqual(storage.getSummaryById("s2")?.status, "superseded", "s2 not superseded");
    // P_prime is complete.
    assert.equal(storage.getSummaryById("P_prime")?.status, "complete", "P_prime is complete");
  } finally {
    storage.close();
  }
});

test("budget: superseded P excluded from getSummaryCandidates", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "s1", "c1", 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", "c2", 1, 1002, 1003, "j2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", "rm", 1, 1004, 1005, "j3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "old parent", 2, 1000, 1003, "jP", { parentIds: ["s1", "s2"] });

    await storage.insertSummarizationJob({
      id: "j_abs",
      timelineKey: TK,
      level: 2,
      inputStartId: "s1",
      inputEndId: "s3",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P",
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "P prime",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "j3",
      eventCount: 3,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3"],
      jobId: "j_abs",
      absorbedParentId: "P",
    });

    const candidates = storage.getSummaryCandidates(TK);
    const ids = candidates.map((c) => c.id);
    assert.ok(!ids.includes("P"), "P not in candidates (superseded)");
    assert.ok(ids.includes("P_prime"), "P_prime in candidates");

    const level1 = storage.getSummariesByLevel(TK, 1);
    assert.ok(!level1.map((s) => s.id).includes("s3"), "s3 not in level-1 (superseded)");
  } finally {
    storage.close();
  }
});

test("budget: superseded rows excluded from summary search", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "s1", "child1 words", 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", "child2 words", 1, 1002, 1003, "j2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", "runmember_unique_term", 1, 1004, 1005, "j3", {
      eventIds: ["ev0"],
    });
    await insertSummary(storage, "P", "oldparent_unique_term", 2, 1000, 1003, "jP", {
      parentIds: ["s1", "s2"],
    });

    await storage.insertSummarizationJob({
      id: "j_abs",
      timelineKey: TK,
      level: 2,
      inputStartId: "s1",
      inputEndId: "s3",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P",
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "prime_unique_term new content",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "j3",
      eventCount: 3,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3"],
      jobId: "j_abs",
      absorbedParentId: "P",
    });

    // Superseded P not in search.
    const pSearch = storage.searchSummaries({
      timelineKey: TK,
      query: "oldparent_unique_term",
      limit: 10,
    });
    assert.ok(!pSearch.hits.some((h) => h.id === "P"), "P not in search results (superseded)");

    // Superseded s3 not in search.
    const s3Search = storage.searchSummaries({
      timelineKey: TK,
      query: "runmember_unique_term",
      limit: 10,
    });
    assert.ok(!s3Search.hits.some((h) => h.id === "s3"), "s3 not in search results (superseded)");

    // P_prime is searchable.
    const primeSearch = storage.searchSummaries({
      timelineKey: TK,
      query: "prime_unique_term",
      limit: 10,
    });
    assert.ok(primeSearch.hits.some((h) => h.id === "P_prime"), "P_prime is searchable");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.4 continued — expand_summary after absorption (Finding 1 regression tests)
// ---------------------------------------------------------------------------

test("budget: expand superseded P by id works after absorption (no error, returns its children)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "s1", "child1", 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", "child2", 1, 1002, 1003, "j2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", "runmember", 1, 1004, 1005, "j3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "old parent", 2, 1000, 1003, "jP", { parentIds: ["s1", "s2"] });

    // Simulate absorption: P_prime replaces P.
    await storage.insertSummarizationJob({
      id: "j_abs",
      timelineKey: TK,
      level: 2,
      inputStartId: "s1",
      inputEndId: "s3",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P",
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "combined parent",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "j3",
      eventCount: 3,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3"],
      jobId: "j_abs",
      absorbedParentId: "P",
    });

    assert.equal(storage.getSummaryById("P")?.status, "superseded", "P is superseded");

    const tool = createExpandSummaryTool({ storage, defaults: { tokenCap: 4000, maxDepth: 3 } });
    const res = await tool.execute("c1", { id: "P" });
    const text = (res.content[0] as { text: string }).text;

    // Must not return an error — superseded root should expand normally.
    assert.doesNotMatch(text, /cannot be expanded/, "no hard error on superseded root");
    assert.doesNotMatch(text, /^error:/, "no error message");
    // P's children (s1, s2) should be present.
    assert.match(text, /id=s1/, "s1 is in expanded output");
    assert.match(text, /id=s2/, "s2 is in expanded output");
    // The root P is superseded but it still expands — output contains child summaries.
    assert.match(text, /Finer summaries/, "finer summaries section present");
  } finally {
    storage.close();
  }
});

test("budget: expand P_prime includes absorbed run members (superseded children visible)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "s1", "child1", 1, 1000, 1001, "j1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", "child2", 1, 1002, 1003, "j2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", "runmember unique", 1, 1004, 1005, "j3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "old parent", 2, 1000, 1003, "jP", { parentIds: ["s1", "s2"] });

    await storage.insertSummarizationJob({
      id: "j_abs",
      timelineKey: TK,
      level: 2,
      inputStartId: "s1",
      inputEndId: "s3",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P",
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "combined parent",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "j3",
      eventCount: 3,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3"],
      jobId: "j_abs",
      absorbedParentId: "P",
    });

    assert.equal(storage.getSummaryById("s3")?.status, "superseded", "s3 is superseded");

    const tool = createExpandSummaryTool({ storage, defaults: { tokenCap: 4000, maxDepth: 3 } });
    const res = await tool.execute("c2", { id: "P_prime" });
    const text = (res.content[0] as { text: string }).text;

    // P_prime's children = [s1, s2, s3]; all must appear including superseded s3.
    assert.match(text, /id=s1/, "s1 in P_prime expansion");
    assert.match(text, /id=s2/, "s2 in P_prime expansion");
    assert.match(text, /id=s3/, "s3 (superseded run member) in P_prime expansion");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.4 continued — condensed parent is not an absorption target (Finding 2)
// ---------------------------------------------------------------------------

test("budget: condensed parent excluded from absorption — run falls through to bootstrap", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);

    // Build: s1, s2 (L1) → P (L2, parentIds=[s1,s2]) → G (L3, parentIds=[P]).
    // P is condensed into G, so P is NOT resident in the summary layer.
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent condensed", 2, 1000, 1003, "j_P", {
      parentIds: ["s1", "s2"],
    });
    // earliestTs=999 (strictly before P.earliestTs=1000) ensures G is processed first
    // in selectSummaryCoverage and covers P (latestTs=1003 ≤ G's coverageEnd=1003).
    // If G and P share earliestTs=1000, SQLite's unstable sort may process P first,
    // putting P into the selection where it becomes an absorb candidate for [s3,s4].
    await insertSummary(storage, "G", "grandparent", 3, 999, 1003, "j_G", {
      parentIds: ["P"],
    });
    // Uncondensed L1 run [s3, s4] adjacent to P (which is condensed).
    await insertSummary(storage, "s3", content, 1, 1004, 1005, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "s4", content, 1, 1006, 1007, "j_s4", { eventIds: ["ev0"] });
    // Sentinel: newestLatestTs above test data. Also raises maxLevel to 3 via G,
    // but se_P_full is also L3 so it doesn't add a new level.
    // Use a dedicated L1+L2 sentinel to avoid level conflicts.
    const sentinelParentIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `se2_l1_${i}`;
      sentinelParentIds.push(id);
      await insertSummary(storage, id, "x", 1, 5000 + i, 5001 + i, `j_se2_l1_${i}`, {
        eventIds: ["ev0"],
      });
    }
    // earliestTs=4999 (before the L1 children at 5000+) so se2_P_full sorts first.
    await insertSummary(storage, "se2_P_full", "sentinel", 2, 4999, 5010, "j_se2_P_full", {
      parentIds: sentinelParentIds,
    });

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        eager_absorb_max_children: 10,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const enq = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued for the run");
    // P is condensed (into G), so absorption into P must NOT happen.
    // The run [s3,s4] falls through to bootstrap (no resident parent).
    assert.equal(enq!.shape, "bootstrap", "bootstrap (condensed P excluded from candidates)");
    assert.notEqual(enq!.parentId, "P", "job does not absorb into the condensed parent P");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.5 Ordering
// ---------------------------------------------------------------------------

test("budget: lowest level wins — L1 run processed before L2 run", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);

    // s1, s2 at L1 — uncondensed (no L2 parent covering them).
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });

    // s_old1, s_old2 condensed into l2_a, l2_b respectively → uncondensed L2 run.
    await insertSummary(storage, "s_old1", content, 1, 500, 501, "j_so1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s_old2", content, 1, 502, 503, "j_so2", { eventIds: ["ev0"] });
    await insertSummary(storage, "l2_a", content, 2, 500, 501, "j_l2a", { parentIds: ["s_old1"] });
    await insertSummary(storage, "l2_b", content, 2, 502, 503, "j_l2b", { parentIds: ["s_old2"] });

    // Sentinel: se_l1_0..9 (L1) condensed by se_P_full (L2, at capacity).
    // Raises newestLatestTs=2010 so neither [s1,s2] nor [l2_a,l2_b] are live edge.
    // se_P_full is L2, same level as l2_a/l2_b, but it is at capacity so no
    // absorption into it is possible.
    await addSentinel(storage);

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const enq = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued");
    // The first job must be at level 2 (L1→L2), not level 3 (L2→L3).
    assert.equal(enq!.summaryLevel, 2, "job is at level 2 (L1 run wins over L2 run)");
  } finally {
    storage.close();
  }
});

test("budget: capacity-truncated absorption takes oldest run members", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(50);

    // P has 3 children (s1, s2, s3). absorbMax=4 → only 1 slot left.
    for (let i = 1; i <= 3; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    await insertSummary(storage, "P", "parent words here", 2, 1001, 1004, "j_P", {
      parentIds: ["s1", "s2", "s3"],
    });
    // Run [s4, s5, s6]: only s4 (oldest) should be absorbed (1 slot left).
    for (let i = 4; i <= 6; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    // Sentinel at L3 so s4-s6 are not the live edge.
    await addSentinel(storage);

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 4, // 3 existing + 1 new = 4
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const enq = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued");
    assert.equal(enq!.shape, "absorb", "absorb shape");
    assert.equal(enq!.runLength, 1, "only 1 run member (oldest s4) absorbed (capacity cap)");
    assert.equal(enq!.childCount, 4, "total 4 children (3 from P + 1 = s4)");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.6 Live-edge guard
// ---------------------------------------------------------------------------

test("budget: live-edge guard — sole run containing newest summary never selected", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    // s1 and s2 are in one run; s2 is the newest (live edge).
    // NO sentinel — newestLatestTs must come from s2.
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1100, "j_s2", { eventIds: ["ev0"] });

    let jobCount = 0;
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      { condense_fanout: 5, condense_target_tokens: 5, max_retries: 2 },
      { onJobEnqueued: () => { jobCount++; } },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    // The only run [s1, s2] contains s2 (live edge) → blocked.
    assert.equal(jobCount, 0, "no job enqueued — live-edge run is blocked");
  } finally {
    storage.close();
  }
});

test("budget: live-edge guard — older non-live-edge run IS eligible when newer run exists", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);

    // Old run [s1, s2] at ts ~1000-1003.
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });

    // Gap: 5 condensed L1 summaries covered by P_mid (full at fanout=5).
    // hasSummaryBetween(TK, 1, 1003, 2000) → these gap summaries in [1003,2000] create gap.
    for (let i = 0; i < 5; i++) {
      await insertSummary(storage, `s_gap${i}`, content, 1, 1500 + i, 1501 + i, `j_gap${i}`, {
        eventIds: ["ev0"],
      });
    }
    await insertSummary(storage, "P_mid", "gap parent", 2, 1500, 1505, "j_Pmid", {
      parentIds: ["s_gap0", "s_gap1", "s_gap2", "s_gap3", "s_gap4"],
    });

    // New run [s3, s4] at ts ~2000-2100. s4 is the newest (live edge).
    await insertSummary(storage, "s3", content, 1, 2000, 2001, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "s4", content, 1, 2002, 2100, "j_s4", { eventIds: ["ev0"] });

    const logs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        eager_absorb_max_children: 5, // P_mid is full at 5
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) =>
            logs.push({ event, ...(data as any) }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    const enq = logs.find((l) => l.event === "summary_budget_condense_enqueued");
    // The old run [s1, s2] is not the live edge → should be selected.
    assert.ok(enq, "a job was enqueued for the non-live-edge run [s1, s2]");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.7 Top-level guard
// ---------------------------------------------------------------------------

test("budget: top-level guard — no bootstrap at timeline's max level", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(200);

    // L1 summaries condensed by L2 summaries — so the L2 summaries form the max-level run.
    for (let i = 1; i <= 3; i++) {
      await insertSummary(storage, `s${i}`, content, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    for (let i = 1; i <= 3; i++) {
      await insertSummary(storage, `l2_${i}`, content, 2, 1010 + i, 1011 + i, `j_l2_${i}`, {
        parentIds: [`s${i}`],
      });
    }
    // maxLevel = 2. The L2 run [l2_1..l2_3] is at max level.
    // Top-level guard + live-edge guard both block any L3 job.
    assert.equal(storage.getMaxSummaryLevel(TK), 2, "maxLevel is 2");

    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    assert.equal(
      storage.getActiveSummarizationJobs(TK, 3).length,
      0,
      "no L3 jobs — top-level guard prevents bootstrap at max level",
    );
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.8 Guaranteed-saving guards + soft threshold
// ---------------------------------------------------------------------------

test("budget: bootstrap saving guard — run too small → no job", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    // Very small summaries (1-3 tokens each) well below 2 × condenseTarget.
    const tinyContent = "short";
    for (let i = 1; i <= 3; i++) {
      await insertSummary(storage, `s${i}`, tinyContent, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    // Sentinel makes newestLatestTs high so the run is not the live edge.
    await addSentinel(storage);

    let jobCount = 0;
    // condenseTarget=1000: saving guard requires Σ rendered(run) >= 2000 tokens.
    // tinyContent "short" ≈ 1-2 tokens × 3 << 2000.
    // Layer trigger: tiny content rendered to summary-layer << max, but we need
    // the trigger to fire. Use target=1, max=2 so even tiny summaries exceed max.
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 1, summary_max_tokens: 2 },
      {
        condense_fanout: 5,
        condense_target_tokens: 1000,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      { onJobEnqueued: () => { jobCount++; } },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    assert.equal(jobCount, 0, "no job — saving guard blocks bootstrap (run too small)");
  } finally {
    storage.close();
  }
});

test("budget: soft threshold — over budget, no eligible run → no job, no loop", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    // ONE big L1 summary at the live edge (no sentinel). The only run IS the live edge.
    const bigContent = "word ".repeat(200);
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });

    let jobCount = 0;
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      { condense_fanout: 5, condense_target_tokens: 5, max_retries: 2 },
      { onJobEnqueued: () => { jobCount++; } },
    );
    // Run reconcile several times — must quiesce with no job.
    for (let i = 0; i < 3; i++) indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    assert.equal(jobCount, 0, "no job (soft threshold: over budget but only run is live edge)");
    // Summary untouched.
    assert.equal(storage.getSummaryById("s1")?.status, "complete", "s1 is not truncated");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.9 Convergence
// ---------------------------------------------------------------------------

test("budget: convergence — manual job completion drives layer to ≤ target", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(100); // ~100 tokens each

    // 5 L1 summaries → ~500 tokens total. target=200, max=400.
    for (let i = 1; i <= 5; i++) {
      await insertSummary(storage, `s${i}`, bigContent, 1, 1000 + i, 1001 + i, `j_s${i}`, {
        eventIds: ["ev0"],
      });
    }
    // Sentinel so no summary is the live edge.
    await addSentinel(storage);

    let jobEnqueued = false;
    let jobId: string | undefined;
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 200, summary_max_tokens: 400 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      {
        onJobEnqueued: () => { jobEnqueued = true; },
        logger: {
          info: (event: string, data?: unknown) => {
            if (event === "summarization_job_enqueued") {
              jobId = (data as any).jobId as string;
            }
          },
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as any,
      },
    );

    // First pass: layer ~500 tokens > max(400) → episode starts, job enqueued.
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    assert.ok(jobEnqueued, "first pass enqueues a job");
    assert.ok(jobId, "job ID captured");

    // Manually "complete" the job: insert a tiny condensed summary that covers
    // all 5 L1 summaries. This drives the layer below target.
    const job = storage.getSummarizationJobById(jobId!);
    assert.ok(job, "job exists");
    const tinyContent = "condensed summary"; // ~4 tokens
    await storage.insertSummaryWithLineage({
      id: "condensed_1",
      timelineKey: TK,
      level: job!.level,
      content: tinyContent,
      earliestTimestamp: 1001,
      latestTimestamp: 1006,
      latestEventId: job!.inputEndId,
      eventCount: 5,
      tokenCount: estimateTokens(tinyContent),
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["s1", "s2", "s3", "s4", "s5"],
      jobId: jobId!,
      absorbedParentId: job!.absorbedParentId ?? undefined,
    });

    // Second pass with a fresh indexer: layer is now tiny → no episode starts → no job.
    jobEnqueued = false;
    const indexer2 = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 200, summary_max_tokens: 400 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      { onJobEnqueued: () => { jobEnqueued = true; } },
    );
    indexer2.enqueueReconcileTimeline(TK);
    await indexer2.stop();
    // Layer = condensed_1 (~4 tokens) + sentinel (~1 token) << target(200) << max(400).
    // No episode → no job.
    assert.ok(!jobEnqueued, "no more jobs after convergence (layer ≤ target)");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.10 Mirrored timeline no-op
// ---------------------------------------------------------------------------

test("budget: mirrored timeline — no eager jobs regardless of budget pressure", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(200);
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", bigContent, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await addSentinel(storage);

    let jobCount = 0;
    const indexer = makeIndexer(
      storage,
      store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      { condense_fanout: 5, condense_target_tokens: 5, max_retries: 2 },
      {
        onJobEnqueued: () => { jobCount++; },
        isMirroredTimeline: () => true, // all timelines are mirrored
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();
    assert.equal(jobCount, 0, "no budget jobs for mirrored timeline");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9.11 Config validation bounds
// ---------------------------------------------------------------------------

/** Minimal TOML that loadConfig accepts (env substitution disabled). */
const BASE_TOML = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"
`;

async function withConfigDir(extra: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-cfg-"));
  try {
    // Write base and override as separate files so [section] headers never
    // collide within a single TOML file (which would be a parse error).
    // The config loader merges files in lexicographic order; 01 wins over 00.
    await writeFile(path.join(dir, "00-test.toml"), BASE_TOML, "utf8");
    await writeFile(path.join(dir, "01-override.toml"), extra, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: summary_target_tokens = 0 is valid (feature disabled)", async () => {
  await withConfigDir(
    `
[context.tiers]
summary_target_tokens = 0
summary_max_tokens = 0
`,
    async (dir) => {
      const cfg = await loadConfig(dir, { env: false });
      assert.equal(cfg.context.tiers.summary_target_tokens, 0);
      assert.equal(cfg.context.tiers.summary_max_tokens, 0);
    },
  );
});

test("config: summary_target_tokens below range (500) fails validation", async () => {
  await withConfigDir(
    `
[context.tiers]
summary_target_tokens = 500
`,
    async (dir) => {
      await assert.rejects(loadConfig(dir, { env: false }), /summary_target_tokens/);
    },
  );
});

test("config: summary_max_tokens < summary_target_tokens fails validation", async () => {
  await withConfigDir(
    `
[context.tiers]
summary_target_tokens = 8000
summary_max_tokens = 6000
`,
    async (dir) => {
      await assert.rejects(
        loadConfig(dir, { env: false }),
        /summary_max_tokens.*summary_target_tokens/,
      );
    },
  );
});

test("config: eager_condense_min_children > condense_fanout fails validation", async () => {
  await withConfigDir(
    `
[summarization]
condense_fanout = 5
eager_condense_min_children = 7
`,
    async (dir) => {
      await assert.rejects(loadConfig(dir, { env: false }), /eager_condense_min_children/);
    },
  );
});

test("config: eager_absorb_max_children > 4 × condense_fanout fails validation", async () => {
  await withConfigDir(
    `
[summarization]
condense_fanout = 5
eager_absorb_max_children = 25
`,
    async (dir) => {
      await assert.rejects(loadConfig(dir, { env: false }), /eager_absorb_max_children/);
    },
  );
});

test("config: eager_absorb_max_children < condense_fanout fails validation", async () => {
  await withConfigDir(
    `
[summarization]
condense_fanout = 5
eager_absorb_max_children = 3
`,
    async (dir) => {
      await assert.rejects(loadConfig(dir, { env: false }), /eager_absorb_max_children/);
    },
  );
});

test("config: eager_absorb_max_children = 0 is valid (means auto = 2 × fanout)", async () => {
  await withConfigDir(
    `
[summarization]
condense_fanout = 5
eager_absorb_max_children = 0
`,
    async (dir) => {
      const cfg = await loadConfig(dir, { env: false });
      assert.equal(cfg.summarization?.eager_absorb_max_children, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// §9.12 P4 idempotency — active job prevents re-enqueue
// ---------------------------------------------------------------------------

test("budget: P4 idempotency — active job prevents re-enqueue on repeated reconcile", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", content, 1, 1004, 1005, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent words here", 2, 1000, 1003, "j_P", {
      parentIds: ["s1", "s2"],
    });
    // Sentinel so s3 is not the live edge.
    await addSentinel(storage);

    let jobCount = 0;
    const tiers: TiersOverride = { summary_target_tokens: 100, summary_max_tokens: 150 };
    const summ: SummConfig = {
      condense_fanout: 5,
      condense_target_tokens: 5,
      eager_absorb_max_children: 10,
      max_retries: 2,
    };

    // First pass: enqueues one job.
    const idx1 = makeIndexer(storage, store, tiers, summ, {
      onJobEnqueued: () => { jobCount++; },
    });
    idx1.enqueueReconcileTimeline(TK);
    await idx1.stop();
    assert.equal(jobCount, 1, "first pass enqueues exactly one job");

    // Second pass with the job still active: must not enqueue again.
    const idx2 = makeIndexer(storage, store, tiers, summ, {
      onJobEnqueued: () => { jobCount++; },
    });
    idx2.enqueueReconcileTimeline(TK);
    await idx2.stop();
    assert.equal(jobCount, 1, "second pass does not re-enqueue (P4 idempotency)");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9b post-deployment fix: explicit child id list, span-integrity guard,
// legacy-row handling, declared-vs-rendered guard.
// ---------------------------------------------------------------------------

const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return this as any; },
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Migrations v13→v14 (column added, poisoned rows deleted) and v14→v15 (cleanup).
// ---------------------------------------------------------------------------

test("migration v13→v14: input_child_ids column added; poisoned eager rows deleted; idempotent re-open", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-migrate-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      // 1. Open fresh v14 DB, insert a summary + a legacy poisoned eager job.
      const storage = await Storage.open({ databasePath: dbPath });
      // Insert a minimal L1 summary so the job's inputStartId/inputEndId resolve.
      await storage.insertSummarizationJob({
        id: "poisoned_job",
        timelineKey: TK,
        level: 2,
        inputStartId: "c1",
        inputEndId: "c2",
        inputTokenCount: 100,
        targetTokenCount: 800,
        maxRetries: 2,
        absorbedParentId: "P_old",
        // No inputChildIds → null in the DB.
      });
      // Simulate v13: drop input_child_ids column, re-stamp version.
      await storage.write((db) => {
        db.exec("ALTER TABLE summarization_jobs DROP COLUMN input_child_ids");
        db.pragma("user_version = 13");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // 2. Re-open: migration v13→v14 runs.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 16, "migrations stamp v16");

      // Column must now exist.
      const cols = storage.read((db) =>
        (db.prepare("PRAGMA table_info(summarization_jobs)").all() as Array<{ name: string }>).map(c => c.name),
      );
      assert.ok(cols.includes("input_child_ids"), "input_child_ids column added by migration");

      // Poisoned row must be deleted outright — never a lingering failed row.
      const job = storage.getSummarizationJobById("poisoned_job");
      assert.equal(job, undefined, "poisoned eager job deleted by migration");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }

    // 3. Idempotent re-open: no error, version unchanged.
    const storage2 = await Storage.open({ databasePath: dbPath });
    try {
      const version2 = storage2.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version2, 16, "idempotent re-open: version still 16");
      assert.equal(storage2.getSummarizationJobById("poisoned_job"), undefined, "idempotent re-open: row still absent");
    } finally {
      await storage2.waitForIdle();
      storage2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Explicit child id list: new eager (absorb) jobs carry inputChildIds; worker
// pool resolves from those ids (not from the span query).
// ---------------------------------------------------------------------------

test("budget: eager absorb job carries inputChildIds = P's children ∪ run members", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const content = "word ".repeat(100);
    await insertSummary(storage, "s1", content, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", content, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });
    await insertSummary(storage, "s3", content, 1, 1004, 1005, "j_s3", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent words here", 2, 1000, 1003, "j_P", {
      parentIds: ["s1", "s2"],
    });
    await addSentinel(storage);

    let enqueuedJobId: string | undefined;
    const indexer = makeIndexer(
      storage, store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      { condense_fanout: 5, condense_target_tokens: 5, eager_absorb_max_children: 10, max_retries: 2 },
      {
        logger: {
          info: (event: string, data?: unknown) => {
            if (event === "summarization_job_enqueued") enqueuedJobId = (data as any).jobId as string;
          },
          warn: () => {}, error: () => {}, debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    assert.ok(enqueuedJobId, "job was enqueued");
    const job = storage.getSummarizationJobById(enqueuedJobId!);
    assert.ok(job, "job exists");
    assert.ok(Array.isArray(job!.inputChildIds), "inputChildIds is an array (not null)");
    // Absorb: declared = P's children [s1, s2] ∪ run member [s3] = [s1, s2, s3]
    const ids = new Set(job!.inputChildIds!);
    assert.ok(ids.has("s1") && ids.has("s2") && ids.has("s3"), "declared children = s1,s2,s3");
    assert.equal(ids.size, 3, "exactly 3 declared children");
  } finally {
    storage.close();
  }
});

test("budget: lazy condense job (evaluateCondensation) carries inputChildIds = chunk members", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const content = "word ".repeat(50);
    // Insert 5 L1 summaries with a dummy event so insertSummarizationJob succeeds.
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 100 }));
    for (let i = 0; i < 5; i++) {
      await insertSummary(storage, `ls${i}`, content, 1, 100 + i * 10, 105 + i * 10, `jls${i}`, {
        eventIds: ["ev0"],
      });
    }

    await evaluateCondensation({
      storage,
      config: { enabled: true, condense_fanout: 5, condense_target_tokens: 800, max_retries: 2 } as any,
      timelineKey: TK,
      level: 1,
      logger: silentLogger as any,
    });

    const jobs = storage.getActiveSummarizationJobs(TK, 2);
    assert.equal(jobs.length, 1, "one L2 job enqueued");
    const job = jobs[0]!;
    assert.ok(Array.isArray(job.inputChildIds), "inputChildIds set on lazy job");
    const ids = new Set(job.inputChildIds!);
    for (let i = 0; i < 5; i++) assert.ok(ids.has(`ls${i}`), `ls${i} in inputChildIds`);
    assert.equal(ids.size, 5, "all 5 chunk members declared");
  } finally {
    storage.close();
  }
});

test("budget: worker pool resolves L2 job from explicit inputChildIds, not span query", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Insert two L1 summaries as the declared children of a level-2 job.
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "c1", "child one content", 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child two content", 1, 1002, 1003, "jc2", { eventIds: ["ev0"] });

    await storage.insertSummarizationJob({
      id: "l2_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      inputChildIds: ["c1", "c2"],
    });

    // A factory that captures condenseInputs and returns their ids as renderedInputIds.
    let capturedSummaryIds: string[] = [];
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async (_session: unknown, tools: AgentTool[], opts: any) => {
        const summaries: Array<{ id: string }> = opts?.condenseInputs?.summaries ?? [];
        capturedSummaryIds = summaries.map((s) => s.id);
        const summaryTool = tools[0]!;
        await summaryTool.execute("t", { command: "create", file_text: "Condensed summary." });
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          renderedInputIds: capturedSummaryIds,
        };
      },
    } as any;

    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("l2_job")?.status === "complete");
    await pool.stop();

    assert.deepEqual(capturedSummaryIds.sort(), ["c1", "c2"], "factory received exactly c1, c2");
    assert.equal(storage.getSummarizationJobById("l2_job")?.status, "complete");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9b absorb job — same-level supersession via worker pool (seam test).
// Storage-layer tests pass absorbedParentId directly; these tests exercise the
// worker→storage seam to catch the class of bug where the worker omits the
// field and supersession silently no-ops.
// ---------------------------------------------------------------------------

test("budget: absorb job — worker pool supersedes old parent and run members on success path", async () => {
  // P (L2) has original children c1, c2.  Run members r1, r2 are absorbed into
  // P on the success path.  After completion P and {r1, r2} are superseded;
  // {c1, c2} — P's own recorded children — remain complete.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

    await insertSummary(storage, "c1", "child 1 words", 1, 1000, 1001, "j_c1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child 2 words", 1, 1002, 1003, "j_c2", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent summary", 2, 1000, 1003, "j_P", {
      parentIds: ["c1", "c2"],
    });
    await insertSummary(storage, "r1", "run member 1", 1, 1004, 1005, "j_r1", { eventIds: ["ev0"] });
    await insertSummary(storage, "r2", "run member 2", 1, 1006, 1007, "j_r2", { eventIds: ["ev0"] });

    // Absorb job: P' = condense([c1, c2, r1, r2]), superseding P and {r1, r2}.
    await storage.insertSummarizationJob({
      id: "absorb_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "r2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      absorbedParentId: "P",
      inputChildIds: ["c1", "c2", "r1", "r2"],
    });

    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async (_session: unknown, tools: AgentTool[], opts: any) => {
        const summaries: Array<{ id: string }> = opts?.condenseInputs?.summaries ?? [];
        const ids = summaries.map((s) => s.id);
        await tools[0]!.execute("t", { command: "create", file_text: "Combined summary." });
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          renderedInputIds: ids,
        };
      },
    } as any;

    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger as any,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("absorb_job")?.status === "complete");
    await pool.stop();

    // Old parent and run members superseded; P's original children untouched.
    assert.equal(storage.getSummaryById("P")?.status, "superseded", "P superseded");
    assert.equal(storage.getSummaryById("r1")?.status, "superseded", "run member r1 superseded");
    assert.equal(storage.getSummaryById("r2")?.status, "superseded", "run member r2 superseded");
    assert.equal(storage.getSummaryById("c1")?.status, "complete", "P's child c1 untouched");
    assert.equal(storage.getSummaryById("c2")?.status, "complete", "P's child c2 untouched");

    // Replacement P' exists and is complete.
    const job = storage.getSummarizationJobById("absorb_job")!;
    const pPrime = storage.getSummaryById(job.resultSummaryId!)!;
    assert.equal(pPrime.level, 2, "P' at L2");
    assert.equal(pPrime.status, "complete", "P' complete");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("budget: absorb job — worker pool supersedes old parent and run members on truncation path", async () => {
  // Same setup as above, but the factory forces agent failure so the truncation
  // (best-effort draft) path is exercised.  Supersession must fire there too.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

    await insertSummary(storage, "c1", "child 1 words", 1, 1000, 1001, "j_c1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child 2 words", 1, 1002, 1003, "j_c2", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent summary", 2, 1000, 1003, "j_P", {
      parentIds: ["c1", "c2"],
    });
    await insertSummary(storage, "r1", "run member 1", 1, 1004, 1005, "j_r1", { eventIds: ["ev0"] });
    await insertSummary(storage, "r2", "run member 2", 1, 1006, 1007, "j_r2", { eventIds: ["ev0"] });

    await storage.insertSummarizationJob({
      id: "absorb_trunc",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "r2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      absorbedParentId: "P",
      inputChildIds: ["c1", "c2", "r1", "r2"],
    });

    // Writes a draft then throws — triggers the truncation fallback.
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async (_session: unknown, tools: AgentTool[]) => {
        await tools[0]!.execute("t", { command: "create", file_text: "Best-effort combined summary." });
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => { throw new Error("forced failure"); },
            subscribe: () => () => {},
            state: { messages: [] },
          },
          renderedInputIds: [],
        };
      },
    } as any;

    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0, summary_max_overage_factor: 2.5 } as any,
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger as any,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("absorb_trunc")?.status === "complete");
    await pool.stop();

    assert.equal(storage.getSummaryById("P")?.status, "superseded", "P superseded via truncation path");
    assert.equal(storage.getSummaryById("r1")?.status, "superseded", "r1 superseded via truncation path");
    assert.equal(storage.getSummaryById("r2")?.status, "superseded", "r2 superseded via truncation path");
    assert.equal(storage.getSummaryById("c1")?.status, "complete", "c1 untouched");
    assert.equal(storage.getSummaryById("c2")?.status, "complete", "c2 untouched");

    const job = storage.getSummarizationJobById("absorb_trunc")!;
    const pPrime = storage.getSummaryById(job.resultSummaryId!)!;
    assert.equal(pPrime.level, 2, "P' at L2");
    assert.equal(pPrime.status, "truncated", "P' truncated (best-effort path)");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// §9b selection-based discovery: phantom masking, skip-continue, reproduction.
// ---------------------------------------------------------------------------

test("budget: pre-lineage phantom L1 masked by higher-level selection — not a candidate, resident band processed", async () => {
  // With selection-based discovery, a phantom L1 that falls within the timestamp
  // span of an already-selected higher-level summary is skipped by selectSummaryCoverage
  // and never becomes a run candidate.
  //
  // old_L2 (L2, 100-501) has earliestTs=100 < phantom1.earliestTs=500. In the sorted
  // candidate list old_L2 is processed first and added with coverageEnd=501. When
  // phantom1 (latestTs=501) is processed, latestTs ≤ coverageEnd → skipped.
  //
  // The genuine over-budget band [s1, s2] IS selected at level 1 and bootstrapped.
  // No span-integrity event fires because phantom1 never forms a run candidate.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(100);

    // old_L2 covers [100, 501]; real L1 children give it lineage.
    await insertSummary(storage, "real1", bigContent, 1, 100, 200, "j_real1", { eventIds: ["ev0"] });
    await insertSummary(storage, "real2", bigContent, 1, 201, 300, "j_real2", { eventIds: ["ev0"] });
    await insertSummary(storage, "old_L2", "old parent summary", 2, 100, 501, "j_old_L2", {
      parentIds: ["real1", "real2"],
    });

    // Phantom L1: no summary_parents rows. latestTs=501 ≤ old_L2.coverageEnd=501 → masked.
    await insertSummary(storage, "phantom1", bigContent, 1, 500, 501, "j_phantom1", {
      eventIds: ["ev0"],
    });

    // Over-budget resident band — genuinely uncondensed, in the selection.
    await insertSummary(storage, "s1", bigContent, 1, 1000, 1001, "j_s1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s2", bigContent, 1, 1002, 1003, "j_s2", { eventIds: ["ev0"] });

    // Sentinel pushes newestLatestTs >> 1003 and old_L2 has 2 children (absorbMax=2
    // → capacity=0) so the run [s1, s2] falls through to bootstrap without hitting
    // span-integrity (no absorb attempt touches the phantom's timestamp range).
    await addSentinel(storage);

    const warnLogs: Array<Record<string, unknown>> = [];
    const infoLogs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage, store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 2, // old_L2 at capacity → no absorb → no span-integrity check
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) => infoLogs.push({ event, ...(data as any) }),
          warn: (event: string, data?: unknown) => warnLogs.push({ event, ...(data as any) }),
          error: () => {}, debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    // Phantom was masked by the selection — no span-integrity guard needed or fired.
    assert.ok(
      !warnLogs.some((l) => l.event === "summary_budget_span_integrity_skip"),
      "no span-integrity skip — phantom1 never became a run candidate",
    );

    // The legitimate resident band [s1, s2] was discovered and bootstrapped.
    const enq = infoLogs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued for the resident band");
    assert.equal(enq!.shape, "bootstrap", "bootstrap — no absorb parent with capacity");
    assert.equal(enq!.childCount, 2, "only s1 and s2; phantom1 excluded");
  } finally {
    storage.close();
  }
});

test("budget: span-integrity skip-continue — first run's absorb fails span check, second run's bootstrap succeeds", async () => {
  // Verifies that a span-integrity failure on a run's absorb does not abort the
  // entire pass: the indexer continues to the next run and enqueues for that.
  //
  // A phantom L1 (phantom_in_P) lives inside P's historical child span. It is
  // masked from the selection by P (P.earliestTs=999 < phantom_in_P.earliestTs=1200,
  // so P is added to selection first with coverageEnd=1999; phantom_in_P.latestTs=1300
  // ≤ 1999 → skipped). phantom_in_P is NOT a run candidate. But it IS in the DB
  // at level 1, so getSummariesBetween(cond1..s_a2, 1) returns it as an extra —
  // span-integrity fires on the absorb into P → `continue`.
  //
  // inter_L2 (L2, 2999-3209) in the selection creates the run-A / run-B split
  // (latestTs=3209 > s_a2.latestTs=2999, earliestTs=2999 < s_b1.earliestTs=4000).
  // inter_L2 is at absorbMax capacity (4 children, absorbMax=4) → no absorb into it.
  // Run B [s_b1, s_b2] has no adjacent parent with capacity → bootstrap succeeds.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(100);

    // P (L2, 999-1999): earliestTs=999 ensures P precedes phantom_in_P in the sort.
    await insertSummary(storage, "cond1", bigContent, 1, 1000, 1499, "j_cond1", { eventIds: ["ev0"] });
    await insertSummary(storage, "cond2", bigContent, 1, 1500, 1999, "j_cond2", { eventIds: ["ev0"] });
    await insertSummary(storage, "P", "parent summary words", 2, 999, 1999, "j_P", {
      parentIds: ["cond1", "cond2"],
    });

    // Phantom inside P's span: masked from selection, but present in DB at level 1.
    await insertSummary(storage, "phantom_in_P", bigContent, 1, 1200, 1300, "j_phantom", {
      eventIds: ["ev0"],
    });

    // Run A: left-adjacent to P. Absorb into P fires span-integrity (phantom_in_P
    // sits between cond1 and s_a2 in the DB → 5 materialized vs 4 declared).
    await insertSummary(storage, "s_a1", bigContent, 1, 2000, 2499, "j_sa1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s_a2", bigContent, 1, 2500, 2999, "j_sa2", { eventIds: ["ev0"] });

    // inter_L2 (L2, 2999-3209): splits run A from run B in the selection.
    // 4 children → at absorbMax=4 capacity → cannot absorb run-B members.
    await insertSummary(storage, "ic1", "x", 1, 3010, 3059, "j_ic1", { eventIds: ["ev0"] });
    await insertSummary(storage, "ic2", "x", 1, 3060, 3109, "j_ic2", { eventIds: ["ev0"] });
    await insertSummary(storage, "ic3", "x", 1, 3110, 3159, "j_ic3", { eventIds: ["ev0"] });
    await insertSummary(storage, "ic4", "x", 1, 3160, 3209, "j_ic4", { eventIds: ["ev0"] });
    await insertSummary(storage, "inter_L2", "inter parent", 2, 2999, 3209, "j_inter", {
      parentIds: ["ic1", "ic2", "ic3", "ic4"],
    });

    // Run B: bootstrap target. No adjacent parent with spare capacity.
    await insertSummary(storage, "s_b1", bigContent, 1, 4000, 4499, "j_sb1", { eventIds: ["ev0"] });
    await insertSummary(storage, "s_b2", bigContent, 1, 4500, 4999, "j_sb2", { eventIds: ["ev0"] });

    // Sentinel at L3 to push newestLatestTs >> 5000 and maxLevel=3.
    const sIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `sl1_${i}`;
      sIds.push(id);
      await insertSummary(storage, id, "x", 1, 8000 + i, 8001 + i, `j_sl1_${i}`, { eventIds: ["ev0"] });
    }
    // sl2.earliestTs=7999 < sl1_0.earliestTs=8000, sl3.earliestTs=7998 < sl2.earliestTs=7999.
    // This ensures sl3 sorts first in selectSummaryCoverage (coverageEnd=8005), masking
    // sl2 and all sl1_* so they don't appear as stray candidates.
    await insertSummary(storage, "sl2", "x", 2, 7999, 8005, "j_sl2", { parentIds: sIds });
    await insertSummary(storage, "sl3", "x", 3, 7998, 8005, "j_sl3", { parentIds: ["sl2"] });

    const warnLogs: Array<Record<string, unknown>> = [];
    const infoLogs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage, store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 4, // P (2 children): capacity=2; inter_L2 (4): capacity=0
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) => infoLogs.push({ event, ...(data as any) }),
          warn: (event: string, data?: unknown) => warnLogs.push({ event, ...(data as any) }),
          error: () => {}, debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    // Run A's absorb into P fires span-integrity (phantom_in_P is an interloper).
    assert.ok(
      warnLogs.some((l) => l.event === "summary_budget_span_integrity_skip"),
      "span-integrity skip emitted for run A's absorb into P",
    );

    // The pass continued to run B and enqueued a bootstrap.
    const enq = infoLogs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued for run B (skip-continue worked)");
    assert.equal(enq!.shape, "bootstrap", "run B falls back to bootstrap");
    assert.equal(enq!.summaryLevel, 2, "bootstrap at level 2 (L1→L2)");
    assert.equal(enq!.childCount, 2, "run B: s_b1 and s_b2");
  } finally {
    storage.close();
  }
});

test("budget: reproduction fixture — pre-lineage phantoms masked by L3, over-budget L2 band absorbed", async () => {
  // Mirrors the production stall that triggered this fix. The timeline had:
  //   - Pre-lineage L1 phantoms (no summary_parents rows) at old timestamps
  //   - A wide old_L3 (earliestTs=50) covering those timestamps in the selection
  //   - 4 uncondensed L2 summaries forming the over-budget resident band
  //   - Live-edge L1s not eligible
  //
  // Raw-pool discovery always found the phantoms first (declared 7 inputs vs 682
  // materialized → span-integrity fired every pass → stall). With selection-based
  // discovery old_L3 (earliestTs=50 < phantom timestamps) is added to the selection
  // first (coverageEnd=500); the phantoms (latestTs ≤ 500) are skipped. The L2 band
  // IS in the selection and gets absorbed into old_L3 on the first eligible pass.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(100);

    // Historical L1→L2→L3 chain. old_L3.earliestTs=1 ensures it sorts first in
    // selectSummaryCoverage (coverageEnd=500); the phantoms (latestTs ≤ 500) are
    // then skipped as covered. old_l2 and old_l1_* (latestTs ≤ 49) are also skipped.
    await insertSummary(storage, "old_l1_a", bigContent, 1, 1, 24, "j_old_l1_a", { eventIds: ["ev0"] });
    await insertSummary(storage, "old_l1_b", bigContent, 1, 25, 49, "j_old_l1_b", { eventIds: ["ev0"] });
    await insertSummary(storage, "old_l2", "old l2", 2, 1, 49, "j_old_l2", {
      parentIds: ["old_l1_a", "old_l1_b"],
    });
    await insertSummary(storage, "old_L3", "old top-level summary", 3, 1, 500, "j_old_L3", {
      parentIds: ["old_l2"],
    });

    // Phantom L1s: no parents; timestamps within old_L3's span → masked.
    await insertSummary(storage, "phantom1", bigContent, 1, 100, 150, "j_ph1", { eventIds: ["ev0"] });
    await insertSummary(storage, "phantom2", bigContent, 1, 200, 250, "j_ph2", { eventIds: ["ev0"] });

    // Over-budget resident L2 band: 4 uncondensed L2 summaries (no L3 parent).
    // Each L2 needs a real L1 child to satisfy insertSummaryWithLineage's constraint.
    // Each l2_i.earliestTs = base-1 (one tick before its L1 child at base) so l2_i
    // sorts before lc_i in selectSummaryCoverage and is added to the selection first;
    // lc_i (latestTs=base+99 ≤ l2_i.latestTs=base+99) is then skipped as covered.
    for (let i = 1; i <= 4; i++) {
      const base = 600 + (i - 1) * 100;
      const lc_id = `lc_${i}`;
      const l2_id = `l2_${i}`;
      await insertSummary(storage, lc_id, bigContent, 1, base, base + 99, `j_lc_${i}`, { eventIds: ["ev0"] });
      await insertSummary(storage, l2_id, bigContent, 2, base - 1, base + 99, `j_l2_${i}`, {
        parentIds: [lc_id],
      });
    }

    // Live-edge L1s (live-edge guard fires — newestLatestTs = live2.latestTs = 5003).
    await insertSummary(storage, "live1", bigContent, 1, 5000, 5001, "j_live1", { eventIds: ["ev0"] });
    await insertSummary(storage, "live2", bigContent, 1, 5002, 5003, "j_live2", { eventIds: ["ev0"] });

    const warnLogs: Array<Record<string, unknown>> = [];
    const infoLogs: Array<Record<string, unknown>> = [];
    const indexer = makeIndexer(
      storage, store,
      { summary_target_tokens: 100, summary_max_tokens: 150 },
      {
        condense_fanout: 5,
        condense_target_tokens: 5,
        eager_absorb_max_children: 10,
        eager_condense_min_children: 2,
        max_retries: 2,
      },
      {
        logger: {
          info: (event: string, data?: unknown) => infoLogs.push({ event, ...(data as any) }),
          warn: (event: string, data?: unknown) => warnLogs.push({ event, ...(data as any) }),
          error: () => {}, debug: () => {},
        } as any,
      },
    );
    indexer.enqueueReconcileTimeline(TK);
    await indexer.stop();

    // Phantoms were masked — no span-integrity event fired.
    assert.ok(
      !warnLogs.some((l) => l.event === "summary_budget_span_integrity_skip"),
      "no span-integrity skip — phantoms masked by old_L3 in selection",
    );

    // L2 band discovered and absorbed into old_L3.
    const enq = infoLogs.find((l) => l.event === "summary_budget_condense_enqueued");
    assert.ok(enq, "a job was enqueued for the over-budget L2 band");
    assert.equal(enq!.shape, "absorb", "L2 band absorbed into old_L3");
    assert.equal(enq!.parentId, "old_L3", "absorption target is old_L3");
    // runLength = the 4 new run members; childCount includes old_L3's existing child (old_l2).
    assert.equal(enq!.runLength, 4, "4 L2 summaries in the absorb run (no phantoms included)");
    assert.equal(enq!.summaryLevel, 3, "new summary at level 3");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Legacy eager job (absorbed_parent_id set, null input_child_ids, pending)
// → terminated by worker pool; no failed-range marker; timeline proceeds.
// ---------------------------------------------------------------------------

test("budget: legacy eager job (absorbed_parent_id set, no inputChildIds) is deleted; reconcile re-enqueues fresh job", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await store.append(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    const bigContent = "word ".repeat(100);

    // Seed two L1 summaries that a fresh job would condense.
    await insertSummary(storage, "c1", bigContent, 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", bigContent, 1, 1002, 1003, "jc2", { eventIds: ["ev0"] });

    // Insert a legacy eager job: absorbed_parent_id set, inputChildIds omitted → null.
    await storage.insertSummarizationJob({
      id: "legacy_eager_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 0,
      absorbedParentId: "P_phantom",
      // No inputChildIds
    });

    const errors: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory: {
        resolveModelId: () => "test-model",
        resolveSessionCostCeiling: () => 0.5,
        create: async () => ({ agent: { prompt: async () => {}, waitForIdle: async () => {}, subscribe: () => () => {}, state: { messages: [] } }, renderedInputIds: [] }),
      } as any,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: (jobId) => errors.push(jobId),
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("legacy_eager_job") === undefined);
    await pool.stop();

    assert.equal(storage.getSummarizationJobById("legacy_eager_job"), undefined, "legacy eager job row deleted");
    assert.deepEqual(errors, ["legacy_eager_job"]);

    // Deletion (not terminal failure) means nothing lingers to block anything:
    // no failed-range marker, no failed L2 row for the evaluator's chunk-skip
    // guard, no red badge in the pipeline monitor. c1 and c2 remain complete
    // and re-eligible for a fresh, well-formed L2 job on the next reconcile.
    assert.equal(storage.getSummaryById("c1")?.status, "complete");
    assert.equal(storage.getSummaryById("c2")?.status, "complete");

    // No L1 content is lost — the timeline reconcile can proceed cleanly.
    const l1s = storage.getSummariesByLevel(TK, 1);
    assert.equal(l1s.length, 2, "both L1 summaries still visible");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("migration v14→v15: rows cancelled-to-failed by the original v14 are deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-migrate15-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.insertSummarizationJob({
        id: "old_cancelled_job",
        timelineKey: TK,
        level: 2,
        inputStartId: "c1",
        inputEndId: "c2",
        inputTokenCount: 100,
        targetTokenCount: 800,
        maxRetries: 2,
        absorbedParentId: "P_old",
      });
      // Simulate a DB migrated by the ORIGINAL v13→v14 (row marked failed, v14 stamp).
      await storage.write((db) => {
        db.prepare("update summarization_jobs set status = 'failed', error = 'cancelled by v13→v14 migration: poisoned eager job (absorbed_parent_id set, no input_child_ids)' where id = 'old_cancelled_job'").run();
        db.pragma("user_version = 14");
      });
      await storage.waitForIdle();
      storage.close();
    }
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 16, "v14→v15 runs (chain continues to v16)");
      assert.equal(storage.getSummarizationJobById("old_cancelled_job"), undefined, "previously cancelled row deleted");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration v15→v16: missed supersessions from completed absorb jobs are backfilled", async () => {
  // Simulates a production DB that ran through one or more absorb jobs while the
  // worker pool was omitting absorbedParentId from insertSummaryWithLineage.
  // The v15→v16 migration (supersedeOrphanedAbsorbedParents) must retroactively
  // supersede P and the run members, leaving P's original children untouched.
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-migrate16-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const TK16 = "matrix:test:room:!migrate16";
      await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));

      // P (L2, children c1+c2) and run members r1, r2 all still 'complete'
      // because the worker never fired the supersession.
      await insertSummary(storage, "c1", "child 1", 1, 1000, 1001, "j_c1_16", { eventIds: ["ev0"] });
      await insertSummary(storage, "c2", "child 2", 1, 1002, 1003, "j_c2_16", { eventIds: ["ev0"] });
      await insertSummary(storage, "P16", "old parent", 2, 1000, 1003, "j_P16", {
        parentIds: ["c1", "c2"],
      });
      await insertSummary(storage, "r1_16", "run member 1", 1, 1004, 1005, "j_r1_16", { eventIds: ["ev0"] });
      await insertSummary(storage, "r2_16", "run member 2", 1, 1006, 1007, "j_r2_16", { eventIds: ["ev0"] });

      // Insert P_prime and its absorb job directly, bypassing supersession,
      // to faithfully represent what the buggy worker path produced.
      await storage.write((db) => {
        const now = Date.now();
        // P_prime summary (no supersession triggered — no absorbedParentId in the call).
        db.prepare(`
          insert into summaries
            (id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
             latest_event_id, event_count, token_count, model_id, status, generated_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run("P_prime_16", TK16, 2, "replacement summary", 1000, 1007, "r2_16", 4, 5,
               "test-model", "complete", now, now);
        const insertPar = db.prepare(
          `insert into summary_parents (summary_id, parent_id, ordinal) values (?, ?, ?)`,
        );
        ["c1", "c2", "r1_16", "r2_16"].forEach((pid, i) => insertPar.run("P_prime_16", pid, i));

        // Absorb job completed without firing supersession (the bug).
        db.prepare(`
          insert into summarization_jobs
            (id, timeline_key, level, status, priority,
             input_start_id, input_end_id, input_token_count, target_token_count,
             attempts, max_retries, result_summary_id,
             absorbed_parent_id, input_child_ids, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "absorb_job_16", TK16, 2, "complete", "background",
          "c1", "r2_16", 50, 800, 1, 0, "P_prime_16",
          "P16", JSON.stringify(["c1", "c2", "r1_16", "r2_16"]), now, now,
        );

        db.pragma("user_version = 15");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // Reopen — v15→v16 migration runs supersedeOrphanedAbsorbedParents.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 16, "v15→v16 ran");

      assert.equal(storage.getSummaryById("P16")?.status, "superseded", "P retroactively superseded");
      assert.equal(storage.getSummaryById("r1_16")?.status, "superseded", "r1 retroactively superseded");
      assert.equal(storage.getSummaryById("r2_16")?.status, "superseded", "r2 retroactively superseded");
      assert.equal(storage.getSummaryById("c1")?.status, "complete", "c1 (P's original child) untouched");
      assert.equal(storage.getSummaryById("c2")?.status, "complete", "c2 (P's original child) untouched");
      assert.equal(storage.getSummaryById("P_prime_16")?.status, "complete", "P' untouched");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Legacy lazy job (null inputChildIds, no absorbedParentId) → builds via span.
// ---------------------------------------------------------------------------

test("budget: legacy lazy job (no inputChildIds, no absorbedParentId) builds successfully via span fallback", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "c1", "child one content words here", 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child two content words here", 1, 1002, 1003, "jc2", { eventIds: ["ev0"] });

    // Legacy lazy job: no absorbedParentId, no inputChildIds (old-style pre-fix row).
    await storage.insertSummarizationJob({
      id: "legacy_lazy_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      // No absorbedParentId, no inputChildIds → legacy lazy path
    });

    let capturedSummaryIds: string[] = [];
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async (_session: unknown, tools: AgentTool[], opts: any) => {
        const summaries: Array<{ id: string }> = opts?.condenseInputs?.summaries ?? [];
        capturedSummaryIds = summaries.map((s) => s.id);
        const summaryTool = tools[0]!;
        await summaryTool.execute("t", { command: "create", file_text: "Legacy condense result." });
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          // For a legacy lazy job, inputChildIds is null; declared = input.parentIds from span query.
          renderedInputIds: capturedSummaryIds,
        };
      },
    } as any;

    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const j = storage.getSummarizationJobById("legacy_lazy_job");
      return j?.status === "complete" || j?.status === "failed";
    });
    await pool.stop();

    const job = storage.getSummarizationJobById("legacy_lazy_job")!;
    assert.equal(job.status, "complete", "legacy lazy job completes via span fallback");
    assert.deepEqual(capturedSummaryIds.sort(), ["c1", "c2"], "span query returned c1 and c2");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Declared-vs-rendered mismatch → terminal failure, no artifact committed.
// ---------------------------------------------------------------------------

test("budget: declared-vs-rendered mismatch on L2 job fails terminally and commits no summary", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "c1", "child one", 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child two", 1, 1002, 1003, "jc2", { eventIds: ["ev0"] });

    // L2 job with explicit inputChildIds = [c1, c2].
    await storage.insertSummarizationJob({
      id: "mismatch_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      inputChildIds: ["c1", "c2"],
    });

    // Factory renders only c1 but declares it rendered [c1] → mismatch vs declared [c1, c2].
    // IMPORTANT: do NOT call summaryTool.execute here — assertDeclaredInputsRendered
    // fires after factory.create() returns (before agent.prompt), so no draft is written,
    // giving the truncation fallback nothing to salvage and ensuring a true terminal failure.
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async () => {
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          renderedInputIds: ["c1"], // declares only c1, but job says [c1, c2]
        };
      },
    } as any;

    const errors: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: (jobId) => errors.push(jobId),
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("mismatch_job")?.status === "failed");
    await pool.stop();

    const job = storage.getSummarizationJobById("mismatch_job")!;
    assert.equal(job.status, "failed", "declared-vs-rendered mismatch fails job");
    assert.match(job.error ?? "", /input integrity violation/i);
    assert.deepEqual(errors, ["mismatch_job"]);

    // No L2 summary committed.
    assert.equal(storage.getSummariesByLevel(TK, 2).length, 0, "no L2 summary committed on mismatch");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Missing/superseded declared child → resolveInputFromChildIds terminal failure.
// ---------------------------------------------------------------------------

test("budget: declared child missing at build time deletes the job, no failed-range marker", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "c1", "child one", 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    // c2 is declared but never inserted.

    await storage.insertSummarizationJob({
      id: "missing_child_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c1", // end points at c1 (c2 doesn't exist in DB)
      inputTokenCount: 30,
      targetTokenCount: 800,
      maxRetries: 0,
      inputChildIds: ["c1", "c2_MISSING"],
    });

    const errors: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory: {
        resolveModelId: () => "test-model",
        resolveSessionCostCeiling: () => 0.5,
        create: async () => ({ agent: { prompt: async () => {}, waitForIdle: async () => {}, subscribe: () => () => {}, state: { messages: [] } }, renderedInputIds: [] }),
      } as any,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: (jobId) => errors.push(jobId),
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("missing_child_job") === undefined);
    await pool.stop();

    assert.equal(storage.getSummarizationJobById("missing_child_job"), undefined, "missing declared child deletes the job row");
    assert.deepEqual(errors, ["missing_child_job"]);

    // No L2 summary committed.
    assert.equal(storage.getSummariesByLevel(TK, 2).length, 0, "no artifact on missing child");

    // c1 still available (no failed-range supersession).
    assert.equal(storage.getSummaryById("c1")?.status, "complete");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("budget: superseded declared child at build time deletes the job", async () => {
  // c3_runmember is superseded by an absorption (P_base → P_prime absorbs c3).
  // A subsequent job that declares c3_runmember as a child fails terminally
  // because resolveInputFromChildIds rejects superseded summaries.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(testEvent({ id: "ev0", body: "x", timestamp: 1000 }));
    await insertSummary(storage, "c1", "child one", 1, 1000, 1001, "jc1", { eventIds: ["ev0"] });
    await insertSummary(storage, "c2", "child two", 1, 1002, 1003, "jc2", { eventIds: ["ev0"] });
    await insertSummary(storage, "c3_runmember", "run member", 1, 1004, 1005, "jc3", { eventIds: ["ev0"] });

    // Create P_base (L2, covers c1+c2).
    await storage.insertSummarizationJob({
      id: "j_P",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 2,
    });
    await storage.insertSummaryWithLineage({
      id: "P_base",
      timelineKey: TK,
      level: 2,
      content: "parent base",
      earliestTimestamp: 1000,
      latestTimestamp: 1003,
      latestEventId: "c2",
      eventCount: 2,
      tokenCount: 20,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["c1", "c2"],
      jobId: "j_P",
    });

    // Absorb c3_runmember into P_base → creates P_prime, marks c3_runmember superseded.
    await storage.insertSummarizationJob({
      id: "j_P_prime",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c3_runmember",
      inputTokenCount: 100,
      targetTokenCount: 800,
      maxRetries: 2,
      absorbedParentId: "P_base",
      inputChildIds: ["c1", "c2", "c3_runmember"],
    });
    await storage.insertSummaryWithLineage({
      id: "P_prime",
      timelineKey: TK,
      level: 2,
      content: "new parent",
      earliestTimestamp: 1000,
      latestTimestamp: 1005,
      latestEventId: "c3_runmember",
      eventCount: 3,
      tokenCount: 20,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      parentIds: ["c1", "c2", "c3_runmember"],
      jobId: "j_P_prime",
      absorbedParentId: "P_base",
    });

    // c3_runmember is now superseded.
    assert.equal(storage.getSummaryById("c3_runmember")?.status, "superseded", "c3_runmember is superseded");

    // A new job that wrongly declares c3_runmember as one of its children.
    await storage.insertSummarizationJob({
      id: "superseded_child_job",
      timelineKey: TK,
      level: 2,
      inputStartId: "c1",
      inputEndId: "c2",
      inputTokenCount: 50,
      targetTokenCount: 800,
      maxRetries: 0,
      inputChildIds: ["c1", "c3_runmember"],
    });

    const errors: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory: {
        resolveModelId: () => "test-model",
        resolveSessionCostCeiling: () => 0.5,
        create: async () => ({ agent: { prompt: async () => {}, waitForIdle: async () => {}, subscribe: () => () => {}, state: { messages: [] } }, renderedInputIds: [] }),
      } as any,
      config: { worker_count: 1, max_retries: 0 } as any,
      onComplete: () => {},
      onError: (jobId) => errors.push(jobId),
      logger: silentLogger as any,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("superseded_child_job") === undefined);
    await pool.stop();

    assert.equal(storage.getSummarizationJobById("superseded_child_job"), undefined, "superseded declared child deletes the job row");
    assert.deepEqual(errors, ["superseded_child_job"]);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
