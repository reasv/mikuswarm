/**
 * Phase 5c multi-agent support tests (spec MULTI-AGENT-SUPPORT §10b).
 *
 * Summary mirroring: secondary agents receive mirrored L1/L2+ summaries from a
 * donor agent instead of running their own LLM summarization. These tests cover:
 *
 *   - Schema: summaries.mirrored_from column + index
 *   - Config validation: self-reference, chain, undeclared donor errors
 *   - buildMirrorTopology: topology from config (empty default-off, filled with config)
 *   - isMirroredTimeline: basic eligibility, one-way flip, inverse topology
 *   - insertMirroredSummary: L1 diary_status='pending', L2+ diary_status=null
 *   - getMirroredSummaryIdByDonor: idempotency lookup
 *   - hasNativeSummaries: returns true when secondary has native (mirrored_from IS NULL) row
 *   - onDonorComplete: L1 immediate mirror path via external hook
 *   - Sweep L1 catch-up: mirrors un-mirrored donor L1s via sweep
 *   - Sweep L2+ mirroring: condensation tree translated to secondary
 *   - Status propagation: superseded donor summary propagates to mirror
 *   - Indexer skip: isMirroredTimeline guard prevents native job enqueue
 *   - Condensation evaluator skip: mirrored timelines are not condensed natively
 *   - No mirrored_from pollution on native insertSummaryWithLineage
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { SummarizationIndexer } from "../src/summarization/index.js";
import { MirrorWorker, buildMirrorTopology, type AgentMirrorEntry } from "../src/summarization/mirror-worker.js";
import { evaluateCondensation } from "../src/summarization/evaluator.js";
import { estimateTokens } from "../src/context/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const DONOR_KEY = "matrix:donor:room:!room1";
const SECONDARY_KEY = "matrix:secondary:room:!room1";
const PROVIDER = "matrix";

const TIERS = {
  rich_target_tokens: 1,
  rich_max_tokens: 1,
  compact_target_tokens: 40000,
  compact_max_tokens: 80000,
};

function testEvent(id: string, body: string, ts: number, timelineKey = DONOR_KEY, externalId?: string): CanonicalChatEvent {
  return {
    id,
    timelineKey,
    provider: PROVIDER,
    role: "user" as const,
    sender: { id: "alice", displayName: "Alice" },
    body,
    timestamp: ts,
    receivedAt: ts,
    externalId,
  };
}

/** Insert events onto a timeline, returning the TimelineStore. */
async function seedTimeline(
  storage: Storage,
  timelineKey: string,
  events: Array<{ id: string; body: string; ts: number; externalId?: string }>,
): Promise<TimelineStore> {
  const store = new TimelineStore(storage);
  for (const e of events) {
    await store.append(testEvent(e.id, e.body, e.ts, timelineKey, e.externalId));
  }
  return store;
}

/**
 * Insert a completed L1 native summary (creates and auto-claims the backing job).
 * Works for any timeline — donor, secondary, or otherwise.
 */
async function insertTestL1(
  storage: Storage,
  summaryId: string,
  timelineKey: string,
  eventIds: string[],
  opts?: { ts?: number; content?: string; status?: "complete" | "truncated" },
): Promise<void> {
  const ts = opts?.ts ?? 1000;
  const content = opts?.content ?? `Summary of ${eventIds.length} events`;
  const jobId = `job_${summaryId}`;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey,
    level: 1,
    inputStartId: eventIds[0]!,
    inputEndId: eventIds[eventIds.length - 1]!,
    inputTokenCount: 50,
    targetTokenCount: 50,
    maxRetries: 0,
  });
  // Claim the job so it can be completed (insertSummaryWithLineage requires status=processing)
  await storage.write((db) => {
    db.prepare(`update summarization_jobs set status = 'processing', updated_at = ? where id = ?`).run(Date.now(), jobId);
  });
  await storage.insertSummaryWithLineage({
    id: summaryId,
    timelineKey,
    level: 1,
    content,
    earliestTimestamp: ts,
    latestTimestamp: ts + eventIds.length,
    latestEventId: eventIds[eventIds.length - 1]!,
    eventCount: eventIds.length,
    tokenCount: estimateTokens(content),
    modelId: "test-model",
    status: opts?.status ?? "complete",
    generatedAt: Date.now(),
    eventIds,
    jobId,
  });
}

/** Alias for L1 inserts on the donor timeline. */
const insertDonorL1 = insertTestL1;

/**
 * Insert a completed L2+ native summary (creates and auto-claims a backing condensation job).
 */
async function insertTestL2(
  storage: Storage,
  summaryId: string,
  timelineKey: string,
  parentIds: string[],
  opts?: { ts?: number; content?: string; status?: "complete" | "truncated" },
): Promise<void> {
  const ts = opts?.ts ?? 1000;
  const content = opts?.content ?? `L2 condensed ${summaryId}`;
  const jobId = `job_${summaryId}`;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey,
    level: 2,
    inputStartId: parentIds[0]!,
    inputEndId: parentIds[parentIds.length - 1]!,
    inputTokenCount: 100,
    targetTokenCount: 80,
    maxRetries: 0,
  });
  await storage.write((db) => {
    db.prepare(`update summarization_jobs set status = 'processing', updated_at = ? where id = ?`).run(Date.now(), jobId);
  });
  // Get timestamps from parent summaries
  const parents = parentIds.map((pid) => storage.getSummaryById(pid)).filter(Boolean);
  const earliestTs = parents[0]?.earliestTimestamp ?? ts;
  const latestTs = parents[parents.length - 1]?.latestTimestamp ?? ts;
  const latestEventId = parents[parents.length - 1]?.latestEventId ?? parentIds[0]!;
  await storage.insertSummaryWithLineage({
    id: summaryId,
    timelineKey,
    level: 2,
    content,
    earliestTimestamp: earliestTs,
    latestTimestamp: latestTs,
    latestEventId,
    eventCount: parents.reduce((sum, p) => sum + (p?.eventCount ?? 1), 0),
    tokenCount: estimateTokens(content),
    modelId: "test-model",
    status: opts?.status ?? "complete",
    generatedAt: Date.now(),
    parentIds,
    jobId,
  });
}

/** Build a minimal AgentMirrorEntry for the test topology (one donor, one secondary, matrix only). */
function testMirrorEntry(overrides?: Partial<AgentMirrorEntry>): AgentMirrorEntry {
  return {
    secondaryAgentName: "secondary",
    donorAgentName: "donor",
    donorAccountByProvider: new Map([[PROVIDER, "donor"]]),
    secondaryAccountsByProvider: new Map([[PROVIDER, ["secondary"]]]),
    ...overrides,
  };
}

/** Build a minimal AppConfig with matrix accounts wired for mirror topology. */
function mirrorConfig(summariesFrom?: string): AppConfig {
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
    context: { tiers: TIERS },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        donor: { homeserver: "https://example.com", agent: "donor" } as any,
        secondary: {
          homeserver: "https://example.com",
          agent: "secondary",
          summaries_from: summariesFrom,
        } as any,
      },
    },
    agents: {
      donor: {},
      secondary: summariesFrom ? { summaries_from: summariesFrom } : {},
    },
  } as AppConfig;
}

// ---------------------------------------------------------------------------
// Schema: mirrored_from column
// ---------------------------------------------------------------------------

test("phase5c: summaries table has mirrored_from column", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const cols: Array<{ name: string }> = storage.read((db) =>
      db.pragma("table_info(summaries)") as any[],
    );
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("mirrored_from"), "mirrored_from column present");
  } finally {
    storage.close();
  }
});

test("phase5c: mirrored_from defaults to null on native insertSummaryWithLineage", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedTimeline(storage, DONOR_KEY, [{ id: "ev001", body: "hi", ts: 1000 }]);
    await insertDonorL1(storage, "sum_native", DONOR_KEY, ["ev001"]);
    const row = storage.getSummaryById("sum_native");
    assert.ok(row, "native summary exists");
    assert.equal(row!.mirroredFrom, null, "native row has null mirroredFrom");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// buildMirrorTopology
// ---------------------------------------------------------------------------

test("phase5c: buildMirrorTopology returns empty array when no agents have summaries_from", () => {
  const cfg = mirrorConfig(); // no summaries_from
  const entries = buildMirrorTopology(cfg);
  assert.equal(entries.length, 0, "default-off: no topology when summaries_from absent");
});

test("phase5c: buildMirrorTopology returns one entry when secondary has summaries_from", () => {
  const cfg = mirrorConfig("donor");
  const entries = buildMirrorTopology(cfg);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e!.secondaryAgentName, "secondary");
  assert.equal(e!.donorAgentName, "donor");
  assert.equal(e!.donorAccountByProvider.get("matrix"), "donor");
  assert.deepEqual(e!.secondaryAccountsByProvider.get("matrix"), ["secondary"]);
});

test("phase5c: buildMirrorTopology no topology when donor has no matching accounts", () => {
  // Config where secondary is on matrix but donor is on discord only — no shared provider
  const cfg = {
    ...mirrorConfig("donor"),
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        // donor NOT on matrix here
        secondary: { homeserver: "https://example.com", agent: "secondary" } as any,
      },
    },
    discord: {
      enabled: true,
      accounts: { donor: { token: "x", agent: "donor" } as any },
    },
  } as AppConfig;
  const entries = buildMirrorTopology(cfg);
  // secondary is on matrix, donor is on discord — no shared provider → no mirror
  assert.equal(entries.length, 1, "entry is built for secondary");
  // But the donorAccountByProvider should not have 'matrix' for the donor
  assert.equal(entries[0]!.donorAccountByProvider.get("matrix"), undefined);
  assert.equal(entries[0]!.donorAccountByProvider.get("discord"), "donor");
});

// ---------------------------------------------------------------------------
// insertMirroredSummary: diary_status
// ---------------------------------------------------------------------------

test("phase5c: insertMirroredSummary sets diary_status=pending for L1, null for L2+", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Seed secondary with one event (required for latestEventId FK)
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "hello", ts: 1001 }]);

    // L1 mirror
    await storage.insertMirroredSummary({
      id: "mir_l1",
      timelineKey: SECONDARY_KEY,
      level: 1,
      content: "Mirrored L1",
      earliestTimestamp: 1001,
      latestTimestamp: 1001,
      latestEventId: "sev001",
      eventCount: 1,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      mirroredFrom: "donor_sum_001",
      eventIds: ["sev001"],
    });

    // Insert a secondary L1 first to be parent for L2
    await storage.insertMirroredSummary({
      id: "mir_l1_parent",
      timelineKey: SECONDARY_KEY,
      level: 1,
      content: "Mirrored L1 parent",
      earliestTimestamp: 1002,
      latestTimestamp: 1002,
      latestEventId: "sev001",
      eventCount: 1,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      mirroredFrom: "donor_sum_002",
    });

    // L2 mirror
    await storage.insertMirroredSummary({
      id: "mir_l2",
      timelineKey: SECONDARY_KEY,
      level: 2,
      content: "Mirrored L2",
      earliestTimestamp: 1001,
      latestTimestamp: 1002,
      latestEventId: "sev001",
      eventCount: 2,
      tokenCount: 20,
      modelId: "test-model",
      status: "complete",
      generatedAt: Date.now(),
      mirroredFrom: "donor_sum_l2",
      parentIds: ["mir_l1", "mir_l1_parent"],
    });

    // Check diary_status via raw read
    const rows = storage.read((db) =>
      db
        .prepare(`select id, diary_status from summaries where timeline_key = ?`)
        .all(SECONDARY_KEY) as Array<{ id: string; diary_status: string | null }>,
    );
    const byId = new Map(rows.map((r) => [r.id, r.diary_status]));
    assert.equal(byId.get("mir_l1"), "pending", "L1 mirror gets diary_status=pending");
    assert.equal(byId.get("mir_l1_parent"), "pending", "L1 mirror gets diary_status=pending");
    assert.equal(byId.get("mir_l2"), null, "L2 mirror gets diary_status=null");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// getMirroredSummaryIdByDonor
// ---------------------------------------------------------------------------

test("phase5c: getMirroredSummaryIdByDonor returns undefined before mirror, id after", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "x", ts: 1000 }]);

    assert.equal(
      storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "donor_sum_001"),
      undefined,
      "not yet mirrored → undefined",
    );

    await storage.insertMirroredSummary({
      id: "mir_001",
      timelineKey: SECONDARY_KEY,
      level: 1,
      content: "c",
      earliestTimestamp: 1000,
      latestTimestamp: 1000,
      latestEventId: "sev001",
      eventCount: 1,
      tokenCount: 5,
      modelId: "m",
      status: "complete",
      generatedAt: Date.now(),
      mirroredFrom: "donor_sum_001",
    });

    assert.equal(
      storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "donor_sum_001"),
      "mir_001",
      "after mirror → returns secondary summary id",
    );
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// hasNativeSummaries
// ---------------------------------------------------------------------------

test("phase5c: hasNativeSummaries false for all-mirrored, true after any native insert", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "x", ts: 1000 }]);

    assert.equal(storage.hasNativeSummaries(SECONDARY_KEY), false, "no summaries at all → false");

    // Insert mirrored
    await storage.insertMirroredSummary({
      id: "mir_001",
      timelineKey: SECONDARY_KEY,
      level: 1,
      content: "c",
      earliestTimestamp: 1000,
      latestTimestamp: 1000,
      latestEventId: "sev001",
      eventCount: 1,
      tokenCount: 5,
      modelId: "m",
      status: "complete",
      generatedAt: Date.now(),
      mirroredFrom: "donor_sum_001",
    });
    assert.equal(storage.hasNativeSummaries(SECONDARY_KEY), false, "only mirrored → false");

    // Insert native
    await insertTestL1(storage, "nat_001", SECONDARY_KEY, ["sev001"], { ts: 1000 });
    assert.equal(storage.hasNativeSummaries(SECONDARY_KEY), true, "native row present → true");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// isMirroredTimeline
// ---------------------------------------------------------------------------

test("phase5c: isMirroredTimeline false when no mirrorEntries (default-off)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [], // no entries → default-off
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    assert.equal(worker.isMirroredTimeline(SECONDARY_KEY), false, "no topology → not mirrored");
  } finally {
    storage.close();
  }
});

test("phase5c: isMirroredTimeline true for eligible secondary, false for donor", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    assert.equal(worker.isMirroredTimeline(SECONDARY_KEY), true, "secondary is mirrored");
    assert.equal(worker.isMirroredTimeline(DONOR_KEY), false, "donor is not mirrored");
  } finally {
    storage.close();
  }
});

test("phase5c: isMirroredTimeline false when secondary has native summaries (one-way flip)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "x", ts: 1000 }]);
    // Insert a native (non-mirrored) summary
    await insertTestL1(storage, "nat_001", SECONDARY_KEY, ["sev001"], { ts: 1000 });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    assert.equal(worker.isMirroredTimeline(SECONDARY_KEY), false, "has native summary → not mirrored");
  } finally {
    storage.close();
  }
});

test("phase5c: isMirroredTimeline false for inverse topology (secondary older than donor's coverage)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    // Donor has a summary starting at ts=5000
    await seedTimeline(storage, DONOR_KEY, [{ id: "dev001", body: "d", ts: 5000 }]);
    await insertDonorL1(storage, "dsum_001", DONOR_KEY, ["dev001"], { ts: 5000 });
    // Secondary has events starting at ts=1000 (older than donor's coverage)
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "s", ts: 1000 }]);

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    assert.equal(worker.isMirroredTimeline(SECONDARY_KEY), false, "inverse topology → not mirrored");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// resolveDonorTimeline
// ---------------------------------------------------------------------------

test("phase5c: resolveDonorTimeline maps secondary key to donor key", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);
    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    assert.equal(worker.resolveDonorTimeline(SECONDARY_KEY), DONOR_KEY);
    assert.equal(worker.resolveDonorTimeline(DONOR_KEY), undefined, "donor key has no donor");
    assert.equal(worker.resolveDonorTimeline("matrix:unknown:room:!room1"), undefined);
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// onDonorComplete: L1 immediate mirror
// ---------------------------------------------------------------------------

test("phase5c: onDonorComplete mirrors an L1 donor summary to eligible secondaries", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    // Seed both timelines with the same external_id so lineage translates
    await seedTimeline(storage, DONOR_KEY, [
      { id: "dev001", body: "hello world", ts: 1000, externalId: "ext-001" },
      { id: "dev002", body: "follow-up", ts: 2000, externalId: "ext-002" },
    ]);
    await seedTimeline(storage, SECONDARY_KEY, [
      { id: "sev001", body: "hello world", ts: 1000, externalId: "ext-001" },
      { id: "sev002", body: "follow-up", ts: 2000, externalId: "ext-002" },
    ]);

    // Donor completes a L1 summary
    await insertDonorL1(storage, "dsum_001", DONOR_KEY, ["dev001", "dev002"], { ts: 1000 });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    await worker.onDonorComplete("dsum_001");

    // Secondary should now have a mirrored summary
    const mirId = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_001");
    assert.ok(mirId, "secondary has a mirrored summary after onDonorComplete");

    const mir = storage.getSummaryById(mirId!);
    assert.ok(mir, "mirrored summary row exists");
    assert.equal(mir!.level, 1);
    assert.equal(mir!.mirroredFrom, "dsum_001");
    assert.equal(mir!.timelineKey, SECONDARY_KEY);
  } finally {
    storage.close();
  }
});

test("phase5c: onDonorComplete is idempotent — does not double-mirror", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    await seedTimeline(storage, DONOR_KEY, [{ id: "dev001", body: "hi", ts: 1000, externalId: "e1" }]);
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "hi", ts: 1000, externalId: "e1" }]);
    await insertDonorL1(storage, "dsum_001", DONOR_KEY, ["dev001"], { ts: 1000 });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    await worker.onDonorComplete("dsum_001");
    const firstMirId = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_001");

    await worker.onDonorComplete("dsum_001"); // second call — must be no-op
    const secondMirId = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_001");

    assert.equal(firstMirId, secondMirId, "idempotent: same mirror id on second call");

    // Only one secondary summary exists
    const count = storage.read((db) =>
      (db.prepare(`select count(*) as n from summaries where timeline_key = ?`).get(SECONDARY_KEY) as any).n,
    );
    assert.equal(count, 1, "exactly one secondary summary row");
  } finally {
    storage.close();
  }
});

test("phase5c: onDonorComplete skips non-L1 summaries", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    await seedTimeline(storage, DONOR_KEY, [{ id: "dev001", body: "hi", ts: 1000 }]);
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "hi", ts: 1000 }]);

    // Insert a donor L1 first, then a donor L2 on top
    await insertDonorL1(storage, "dsum_l1", DONOR_KEY, ["dev001"], { ts: 1000 });
    await insertTestL2(storage, "dsum_l2", DONOR_KEY, ["dsum_l1"]);

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    // L2 should be silently skipped by onDonorComplete (L2+ go via sweep)
    await worker.onDonorComplete("dsum_l2");
    assert.equal(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_l2"), undefined,
      "L2+ donor completion via hook → no immediate mirror");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Sweep: L1 catch-up
// ---------------------------------------------------------------------------

test("phase5c: sweep mirrors un-mirrored donor L1s on the secondary", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    await seedTimeline(storage, DONOR_KEY, [
      { id: "dev001", body: "msg1", ts: 1000, externalId: "e1" },
      { id: "dev002", body: "msg2", ts: 2000, externalId: "e2" },
    ]);
    await seedTimeline(storage, SECONDARY_KEY, [
      { id: "sev001", body: "msg1", ts: 1000, externalId: "e1" },
      { id: "sev002", body: "msg2", ts: 2000, externalId: "e2" },
    ]);
    // The sweep uses listActiveTimelineKeys() — timelines default to 'inactive',
    // so we must activate the secondary for the sweep to find it.
    await storage.setTimelineState(SECONDARY_KEY, "active");

    // Two donor L1 summaries
    await insertDonorL1(storage, "dsum_001", DONOR_KEY, ["dev001"], { ts: 1000 });
    await insertDonorL1(storage, "dsum_002", DONOR_KEY, ["dev002"], { ts: 2000 });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    // Don't call start() — call sweep() directly to test the catch-up path
    worker.start();
    await worker.sweep();
    worker.stop();

    assert.ok(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_001"), "dsum_001 mirrored after sweep");
    assert.ok(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_002"), "dsum_002 mirrored after sweep");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Sweep: status propagation
// ---------------------------------------------------------------------------

test("phase5c: sweep propagates superseded donor status to mirror", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    await seedTimeline(storage, DONOR_KEY, [{ id: "dev001", body: "hi", ts: 1000, externalId: "e1" }]);
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "hi", ts: 1000, externalId: "e1" }]);
    await storage.setTimelineState(SECONDARY_KEY, "active");
    await insertDonorL1(storage, "dsum_001", DONOR_KEY, ["dev001"], { ts: 1000 });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    // Mirror the summary first
    worker.start();
    await worker.sweep();
    worker.stop();
    const mirId = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_001");
    assert.ok(mirId);

    // Now mark donor summary as superseded
    await storage.updateSummaryStatus("dsum_001", "superseded");

    // Sweep again — should propagate superseded to the mirror
    worker.start();
    await worker.sweep();
    worker.stop();

    const mirRow = storage.getSummaryById(mirId!);
    assert.equal(mirRow?.status, "superseded", "mirror status propagated to superseded");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Indexer skip for mirrored timelines
// ---------------------------------------------------------------------------

test("phase5c: indexer skips mirrored timeline (no job enqueued)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    // Seed secondary with enough tokens to cross threshold
    for (let i = 0; i < 20; i++) {
      await store.append(testEvent(`sev${i.toString().padStart(3, "0")}`, `msg ${"word ".repeat(50)} ${i}`, 1000 + i, SECONDARY_KEY));
    }

    let jobEnqueued = false;
    const indexer = new SummarizationIndexer({
      storage,
      store,
      config: { generation_threshold_tokens: 1, leaf_input_tokens: 10, leaf_target_tokens: 5 },
      tiers: TIERS,
      onJobEnqueued: () => { jobEnqueued = true; },
      // Always report secondary as mirrored
      isMirroredTimeline: (tk) => tk === SECONDARY_KEY,
    });

    indexer.enqueueReconcileTimeline(SECONDARY_KEY);
    await indexer.stop();

    assert.equal(jobEnqueued, false, "indexer skipped mirrored timeline — no job enqueued");
    const jobs = storage.getActiveSummarizationJobs(SECONDARY_KEY, 1);
    assert.equal(jobs.length, 0, "no active jobs for mirrored timeline");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Condensation evaluator skip for mirrored timelines
// ---------------------------------------------------------------------------

test("phase5c: evaluateCondensation skips mirrored timelines", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    // Seed secondary with enough L1 summaries to trigger condensation (fanout=5 default)
    const secEvents = Array.from({ length: 5 }, (_, i) => ({
      id: `sev${i.toString().padStart(3, "0")}`,
      body: "msg",
      ts: 1000 + i,
    }));
    await seedTimeline(storage, SECONDARY_KEY, secEvents);
    for (let i = 0; i < 5; i++) {
      await insertTestL1(
        storage, `ssum_${i}`, SECONDARY_KEY,
        [`sev${i.toString().padStart(3, "0")}`], { ts: 1000 + i },
      );
    }

    await evaluateCondensation({
      storage,
      config: { condense_fanout: 5 },
      timelineKey: SECONDARY_KEY,
      level: 1,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      isMirroredTimeline: (tk) => tk === SECONDARY_KEY,
    });

    const condensationJobs = storage.getActiveSummarizationJobs(SECONDARY_KEY, 2);
    assert.equal(condensationJobs.length, 0, "no condensation jobs for mirrored timeline");
  } finally {
    storage.close();
  }
});

test("phase5c: evaluateCondensation proceeds normally for non-mirrored timelines", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    const donorEvents = Array.from({ length: 5 }, (_, i) => ({
      id: `dev${i.toString().padStart(3, "0")}`,
      body: "msg",
      ts: 1000 + i,
    }));
    await seedTimeline(storage, DONOR_KEY, donorEvents);
    for (let i = 0; i < 5; i++) {
      await insertDonorL1(
        storage, `dsum_${i}`, DONOR_KEY,
        [`dev${i.toString().padStart(3, "0")}`], { ts: 1000 + i },
      );
    }

    await evaluateCondensation({
      storage,
      config: { condense_fanout: 5 },
      timelineKey: DONOR_KEY,
      level: 1,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      // Donor is not mirrored — condensation should proceed
      isMirroredTimeline: (tk) => tk === SECONDARY_KEY,
    });

    const condensationJobs = storage.getActiveSummarizationJobs(DONOR_KEY, 2);
    assert.equal(condensationJobs.length, 1, "condensation job enqueued for donor (non-mirrored)");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Sweep: L2+ condensation tree mirroring
// ---------------------------------------------------------------------------

test("phase5c: sweep mirrors L2+ donor summaries to secondary when all parents are mirrored", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new TimelineStore(storage);

    // Seed both timelines
    await seedTimeline(storage, DONOR_KEY, [
      { id: "dev001", body: "a", ts: 1000, externalId: "e1" },
      { id: "dev002", body: "b", ts: 2000, externalId: "e2" },
    ]);
    await seedTimeline(storage, SECONDARY_KEY, [
      { id: "sev001", body: "a", ts: 1000, externalId: "e1" },
      { id: "sev002", body: "b", ts: 2000, externalId: "e2" },
    ]);
    // Activate the secondary so listActiveTimelineKeys() finds it during sweep
    await storage.setTimelineState(SECONDARY_KEY, "active");

    // Donor L1 summaries
    await insertDonorL1(storage, "dl1_a", DONOR_KEY, ["dev001"], { ts: 1000 });
    await insertDonorL1(storage, "dl1_b", DONOR_KEY, ["dev002"], { ts: 2000 });

    // Donor L2 condensing the two L1s
    await insertTestL2(storage, "dl2_ab", DONOR_KEY, ["dl1_a", "dl1_b"], { content: "Condensed A+B" });

    const worker = new MirrorWorker({
      storage,
      store,
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    worker.start();
    await worker.sweep();
    worker.stop();

    // L1s should be mirrored
    const mirL1a = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dl1_a");
    const mirL1b = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dl1_b");
    assert.ok(mirL1a, "L1 dl1_a mirrored");
    assert.ok(mirL1b, "L1 dl1_b mirrored");

    // L2 should be mirrored
    const mirL2 = storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dl2_ab");
    assert.ok(mirL2, "L2 dl2_ab mirrored");

    const mirL2Row = storage.getSummaryById(mirL2!);
    assert.equal(mirL2Row?.level, 2);
    assert.equal(mirL2Row?.mirroredFrom, "dl2_ab");
    assert.equal(mirL2Row?.content, "Condensed A+B");

    // Parent ids of the secondary L2 should point to the secondary L1 mirrors
    const parents = storage.getSummaryParentIds(mirL2!);
    assert.equal(parents.length, 2);
    assert.ok(parents.includes(mirL1a!));
    assert.ok(parents.includes(mirL1b!));
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// getFirstSummaryEarliestTimestamp
// ---------------------------------------------------------------------------

test("phase5c: getFirstSummaryEarliestTimestamp returns the min L1 summary timestamp", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedTimeline(storage, DONOR_KEY, [
      { id: "dev001", body: "a", ts: 3000 },
      { id: "dev002", body: "b", ts: 1500 },
    ]);
    assert.equal(storage.getFirstSummaryEarliestTimestamp(DONOR_KEY), undefined, "no summaries → undefined");
    await insertDonorL1(storage, "s1", DONOR_KEY, ["dev001"], { ts: 3000 });
    await insertDonorL1(storage, "s2", DONOR_KEY, ["dev002"], { ts: 1500 });
    assert.equal(storage.getFirstSummaryEarliestTimestamp(DONOR_KEY), 1500, "returns min timestamp");
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 1: UNIQUE constraint — concurrent mirror attempts produce exactly one row
// ---------------------------------------------------------------------------

test("phase5c: concurrent mirror attempts for same donor summary produce exactly one row", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Seed both timelines so lineage translation works
    await seedTimeline(storage, DONOR_KEY, [{ id: "dev001", body: "hi", ts: 1000, externalId: "ext-c1" }]);
    await seedTimeline(storage, SECONDARY_KEY, [{ id: "sev001", body: "hi", ts: 1000, externalId: "ext-c1" }]);
    await storage.setTimelineState(SECONDARY_KEY, "active");
    await insertDonorL1(storage, "dsum_c1", DONOR_KEY, ["dev001"], { ts: 1000 });

    const worker = new MirrorWorker({
      storage,
      store: new TimelineStore(storage),
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    // Simulate concurrency: both paths fire without awaiting each other first.
    // onDonorComplete (immediate hook path) and sweep() (timer path) can both
    // pass the getMirroredSummaryIdByDonor guard before either write commits.
    // The UNIQUE index on (timeline_key, mirrored_from) must absorb the race.
    await Promise.all([
      worker.onDonorComplete("dsum_c1"),
      worker.sweep(),
    ]);

    // Exactly one secondary summary row must exist
    const count = storage.read((db) =>
      (db.prepare(`select count(*) as n from summaries where timeline_key = ?`).get(SECONDARY_KEY) as any).n,
    );
    assert.equal(count, 1, "exactly one mirror row even under concurrent attempts");
    assert.ok(
      storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_c1"),
      "the mirror is findable by idempotency lookup",
    );
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 2: Full-scan L1 sweep — failed S2 picked up after successful S3
// ---------------------------------------------------------------------------

test("phase5c: sweep picks up skipped S2 after S3 was already mirrored (no cursor regression)", async () => {
  // Scenario: S1 mirrored OK, S2 hook failure (skipped), S3 mirrored OK via
  // earlier sweep. The cursor-based approach (MAX(latest_timestamp)) would set
  // the cursor to S3's ts and permanently skip S2. The full-scan approach must
  // pick S2 up on the next sweep.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedTimeline(storage, DONOR_KEY, [
      { id: "dev001", body: "a", ts: 1000, externalId: "e1" },
      { id: "dev002", body: "b", ts: 2000, externalId: "e2" },
      { id: "dev003", body: "c", ts: 3000, externalId: "e3" },
    ]);
    await seedTimeline(storage, SECONDARY_KEY, [
      { id: "sev001", body: "a", ts: 1000, externalId: "e1" },
      { id: "sev002", body: "b", ts: 2000, externalId: "e2" },
      { id: "sev003", body: "c", ts: 3000, externalId: "e3" },
    ]);
    await storage.setTimelineState(SECONDARY_KEY, "active");

    // Three donor summaries
    await insertDonorL1(storage, "dsum_s1", DONOR_KEY, ["dev001"], { ts: 1000 });
    await insertDonorL1(storage, "dsum_s2", DONOR_KEY, ["dev002"], { ts: 2000 });
    await insertDonorL1(storage, "dsum_s3", DONOR_KEY, ["dev003"], { ts: 3000 });

    const worker = new MirrorWorker({
      storage,
      store: new TimelineStore(storage),
      config: {},
      tiers: TIERS,
      mirrorEntries: [testMirrorEntry()],
      indexer: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    // Mirror S1 directly (simulates the onDonorComplete hook succeeding for S1)
    await worker.onDonorComplete("dsum_s1");
    assert.ok(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_s1"), "S1 mirrored");

    // Simulate S2 hook failure: skip it entirely (no mirror for S2).
    // Then mirror S3 via a sweep that happens to succeed for S3 only.
    // To simulate "sweep ran and only S3 landed" we mirror S3 directly.
    await worker.onDonorComplete("dsum_s3");
    assert.ok(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_s3"), "S3 mirrored");
    assert.equal(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_s2"), undefined, "S2 not yet mirrored");

    // Next sweep: full-scan approach must pick up S2 despite S3's ts being higher.
    worker.start();
    await worker.sweep();
    worker.stop();

    assert.ok(storage.getMirroredSummaryIdByDonor(SECONDARY_KEY, "dsum_s2"), "S2 picked up by subsequent sweep");

    // All three mirrored
    const count = storage.read((db) =>
      (db.prepare(`select count(*) as n from summaries where timeline_key = ?`).get(SECONDARY_KEY) as any).n,
    );
    assert.equal(count, 3, "all three donor summaries mirrored");
  } finally {
    storage.close();
  }
});
