import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage, MemoryFileWriter } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import { DiaryWorkerPool } from "../src/diary/index.js";
import { configureAgentTimezone } from "../src/time/index.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

configureAgentTimezone("UTC");

// ---------------------------------------------------------------------------
// Post-claim terminality (spec CONCURRENCY-AND-RATE-LIMITING §6.3 / review
// issue #4): a storage rejection escaping processJob's guarded agent-run path
// (insertAgentSession, updateAgentSessionStatus, insertSummaryWithLineage, …)
// must route to the retry/fail terminalization — never strand the job at
// 'processing' for the process lifetime (wait-or-omit builds poll a claimed
// job until terminal with no wall clock). Covers both pools; the guard must
// also never overwrite a row that already left 'processing'.
// ---------------------------------------------------------------------------

const TK = "matrix:test:room:!room:server";

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function event(id: string, timestamp: number, role: "user" | "assistant" = "user"): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role,
    sender: { id: role === "assistant" ? "@miku:test" : "@u:test", displayName: "X", isSelf: role === "assistant" },
    body: `message ${id}`,
    timestamp,
    receivedAt: timestamp,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Fake factory whose agent run succeeds after writing a valid summary draft. */
function makeSucceedingSummaryFactory() {
  return {
    resolveModelId: () => "test-model",
    create: async (_session: unknown, tools: AgentTool[]) => {
      const summaryTool = tools[0]!;
      await summaryTool.execute("t", { command: "create", file_text: "A perfectly fine summary." });
      return {
        agent: {
          prompt: async () => {},
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state: { messages: [] },
        },
      };
    },
  } as any;
}

async function seedSummarizationJob(storage: Storage, id: string, maxRetries: number): Promise<void> {
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id,
    timelineKey: TK,
    level: 1,
    inputStartId: "ev0",
    inputEndId: "ev1",
    inputTokenCount: 50,
    targetTokenCount: 100,
    maxRetries,
  });
}

test("issue #4: a storage rejection outside the agent-run guard terminalizes the job (failed, not stranded processing)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_strand", 0);
    // insertAgentSession is awaited BEFORE the guarded agent-run try/catch;
    // reject it to simulate a storage failure on the unguarded path.
    (storage as any).insertAgentSession = () => Promise.reject(new Error("disk full"));

    const failures: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory: makeSucceedingSummaryFactory(),
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: (jobId) => failures.push(jobId),
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_strand")?.status === "failed");
    await pool.stop();

    const job = storage.getSummarizationJobById("job_strand")!;
    assert.equal(job.status, "failed", "job must terminalize, never stay 'processing'");
    assert.match(job.error ?? "", /disk full/);
    assert.deepEqual(failures, ["job_strand"], "permanent failure fires onError");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("issue #4: a storage rejection with retry budget left re-pends the job; the retry then completes", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_retry", 1);
    const realInsert = storage.insertAgentSession.bind(storage);
    let rejectedOnce = false;
    (storage as any).insertAgentSession = (row: unknown) => {
      if (!rejectedOnce) {
        rejectedOnce = true;
        return Promise.reject(new Error("transient write failure"));
      }
      return realInsert(row as any);
    };

    const pool = new SummarizationWorkerPool({
      storage,
      factory: makeSucceedingSummaryFactory(),
      config: { worker_count: 1, max_retries: 1 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const j = storage.getSummarizationJobById("job_retry");
      return j?.status === "complete" || j?.status === "failed";
    });
    await pool.stop();

    assert.equal(rejectedOnce, true, "first attempt hit the rejection");
    const job = storage.getSummarizationJobById("job_retry")!;
    assert.equal(job.status, "complete", "the escaped rejection consumed a retry, the second attempt completed");
    assert.equal(job.attempts, 2);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("issue #4: a rejection escaping AFTER the job is terminal never overwrites the terminal row", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_done", 2);
    const pool = new SummarizationWorkerPool({
      storage,
      factory: makeSucceedingSummaryFactory(),
      config: { worker_count: 1, max_retries: 2 },
      // The job is already 'complete' (insertSummaryWithLineage) when
      // onComplete runs — a throw here escapes the run body and must NOT be
      // "terminalized" into a retry of the completed job.
      onComplete: () => {
        throw new Error("wiring callback exploded");
      },
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_done")?.status === "complete");
    // Give the escaped rejection time to (wrongly) flip the row back.
    await new Promise((r) => setTimeout(r, 150));
    await pool.stop();

    const job = storage.getSummarizationJobById("job_done")!;
    assert.equal(job.status, "complete", "terminal row must not be re-pended or failed by the guard");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Diary pool mirror (same §6.3 shape; the stranded row here is the level-1
// summary's diary_status, healed only at startup).
// ---------------------------------------------------------------------------

async function withDiaryFixture(
  run: (ctx: { storage: Storage; workspaceRoot: string; memoryWriter: MemoryFileWriter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-terminality-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run({ storage, workspaceRoot: dir, memoryWriter: new MemoryFileWriter(dir) });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Insert a diary-pending level-1 summary whose range includes bot participation. */
async function seedDiaryJob(storage: Storage, summaryId: string): Promise<void> {
  const evs = [event("dv0", 1000), event("dv1", 2000, "assistant")];
  for (const e of evs) await storage.appendTimelineEvent(e);
  await storage.insertSummarizationJob({
    id: `job-${summaryId}`,
    timelineKey: TK,
    level: 1,
    inputStartId: "dv0",
    inputEndId: "dv1",
    inputTokenCount: 10,
    targetTokenCount: 100,
    maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id: summaryId,
    timelineKey: TK,
    level: 1,
    content: `summary ${summaryId}`,
    earliestTimestamp: 1000,
    latestTimestamp: 2000,
    latestEventId: "dv1",
    eventCount: 2,
    tokenCount: 10,
    modelId: "m",
    status: "complete",
    generatedAt: 2000,
    eventIds: ["dv0", "dv1"],
    jobId: `job-${summaryId}`,
  });
}

/** Fake factory whose diary agent run succeeds without writing a draft (the legitimate skip). */
function makeIdleDiaryFactory() {
  return {
    resolveModelId: () => "test-model",
    resolveSessionType: () => undefined,
    create: async () => ({
      agent: {
        prompt: async () => {},
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      },
    }),
  } as any;
}

function makeDiaryPool(ctx: { storage: Storage; workspaceRoot: string; memoryWriter: MemoryFileWriter }, maxRetries: number): DiaryWorkerPool {
  return new DiaryWorkerPool({
    storage: ctx.storage,
    factory: makeIdleDiaryFactory(),
    memoryWriter: ctx.memoryWriter,
    config: { worker_count: 1, max_retries: maxRetries, per_session_budget_tokens: 1000 },
    workspaceRoot: ctx.workspaceRoot,
    resolveChannelLabel: async () => "Test Room (Earendil)",
    logger: silentLogger,
  });
}

test("issue #4 (diary mirror): a storage rejection terminalizes diary_status (failed, not stranded processing)", async () => {
  await withDiaryFixture(async (ctx) => {
    await seedDiaryJob(ctx.storage, "sum_diary_strand");
    (ctx.storage as any).insertAgentSession = () => Promise.reject(new Error("disk full"));

    const pool = makeDiaryPool(ctx, 0);
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => ctx.storage.getDiaryStatus("sum_diary_strand") === "failed");
    await pool.stop();

    assert.equal(ctx.storage.getDiaryStatus("sum_diary_strand"), "failed");
  });
});

test("issue #4 (diary mirror): a storage rejection with retry budget left re-pends; the retry then finishes", async () => {
  await withDiaryFixture(async (ctx) => {
    await seedDiaryJob(ctx.storage, "sum_diary_retry");
    const realInsert = ctx.storage.insertAgentSession.bind(ctx.storage);
    let rejectedOnce = false;
    (ctx.storage as any).insertAgentSession = (row: unknown) => {
      if (!rejectedOnce) {
        rejectedOnce = true;
        return Promise.reject(new Error("transient write failure"));
      }
      return realInsert(row as any);
    };

    const pool = makeDiaryPool(ctx, 1);
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const s = ctx.storage.getDiaryStatus("sum_diary_retry");
      return s === "done" || s === "failed";
    });
    await pool.stop();

    assert.equal(rejectedOnce, true, "first attempt hit the rejection");
    assert.equal(ctx.storage.getDiaryStatus("sum_diary_retry"), "done", "second attempt finished the job");
  });
});
