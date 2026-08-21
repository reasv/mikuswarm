import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { SummarizationIndexer } from "../src/summarization/index.js";
import { estimateTokens } from "../src/context/index.js";
import { loadConfig } from "../src/config/loader.js";
import { createExpandSummaryTool } from "../src/tools/index.js";
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
  await insertSummary(storage, "se_P_full", "sentinel", 2, 2000, 2010, "j_se_P_full", {
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
    await insertSummary(storage, "G", "grandparent", 3, 1000, 1003, "j_G", {
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
    await insertSummary(storage, "se2_P_full", "sentinel", 2, 5000, 5010, "j_se2_P_full", {
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
