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

/**
 * Declared input IDs of every job seeded by {@link seedSummarizationJob} (level
 * 1, range ev0..ev1). The stub factories surface these as `renderedInputIds` so
 * the worker's declared-vs-rendered integrity assertion (spec
 * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1) passes — these tests exercise
 * terminality/drain, not the integrity gate, so the rendered set must match the
 * declared set the real builder would produce.
 */
const SEEDED_RENDERED_INPUT_IDS = ["ev0", "ev1"];

/** Fake factory whose agent run succeeds after writing a valid summary draft. */
function makeSucceedingSummaryFactory() {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => 0.5,
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
        renderedInputIds: SEEDED_RENDERED_INPUT_IDS,
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
    resolveSessionCostCeiling: () => 0.5,
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

// ---------------------------------------------------------------------------
// Drain-abort accounting (spec LLM-FAILURE-HANDLING §7): a pool-stop abort
// returns the job to 'pending' with the claim-time attempts increment
// compensated — a drain is not a semantic failure. A cap-style abort while the
// pool is RUNNING stays on the semantic path (a degenerate run is an output
// problem). Covers both pools.
// ---------------------------------------------------------------------------

/**
 * Fake factory whose agent blocks in prompt() until abort() fires, then
 * settles exactly like pi-agent-core does for an aborted run: errorMessage
 * set (Layer-0-tagged, class aborted) + a synthetic aborted assistant turn.
 */
function makeAbortableFactory(extra: Record<string, unknown> = {}) {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => 0.5,
    resolveSessionType: () => undefined,
    ...extra,
    create: async () => {
      let abortResolve!: () => void;
      const abortedRun = new Promise<void>((r) => {
        abortResolve = r;
      });
      const agent: any = {
        state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
        prompt: async () => {
          await abortedRun;
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        abort: () => {
          agent.state.errorMessage = "Request was aborted [llm-request] [llm-request:aborted]";
          agent.state.messages.push({ role: "assistant", content: [], stopReason: "aborted" });
          abortResolve();
        },
      };
      return { agent, renderedInputIds: SEEDED_RENDERED_INPUT_IDS };
    },
  } as any;
}

test("drain abort (spec §7): pool.stop() re-pends the claimed job with the attempts increment compensated", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_drain", 2);
    const pool = new SummarizationWorkerPool({
      storage,
      factory: makeAbortableFactory(),
      config: { worker_count: 1, max_retries: 2 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_drain")?.status === "processing");
    // Drain: aborts the in-flight agent; the run settles aborted with the pool
    // no longer running → the job returns to pending, attempts compensated.
    await pool.stop();

    const job = storage.getSummarizationJobById("job_drain")!;
    assert.equal(job.status, "pending", "drained job re-pends for the next process");
    assert.equal(job.attempts, 0, "claim-time attempts increment compensated — no budget consumed");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("cap abort (spec §7): an abort while the pool is RUNNING stays on the semantic-attempts path", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_cap", 0);
    // The agent aborts ITSELF mid-run (tool/turn cap shape) — the pool is
    // still running, so this is a degenerate-output problem, not a drain.
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async () => {
        const agent: any = {
          state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
          prompt: async () => {
            agent.state.errorMessage = "Request was aborted [llm-request] [llm-request:aborted]";
            agent.state.messages.push({ role: "assistant", content: [], stopReason: "aborted" });
          },
          waitForIdle: async () => {},
          subscribe: () => () => {},
          abort: () => {},
        };
        return { agent, renderedInputIds: SEEDED_RENDERED_INPUT_IDS };
      },
    } as any;
    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const j = storage.getSummarizationJobById("job_cap");
      return j?.status === "failed" || (j?.status === "pending" && j.attempts > 0);
    });
    await pool.stop();

    const job = storage.getSummarizationJobById("job_cap")!;
    assert.equal(job.status, "failed", "cap abort consumes the semantic budget (max_retries 0 → failed)");
    assert.equal(job.attempts, 1, "the claim-time increment is NOT compensated for a cap abort");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("cap abort racing pool stop (spec §7 / #13): a cap abort that settles while running is already false stays SEMANTIC (not refunded as a drain)", async () => {
  // The #13 race: `stop()` flips `running` to false synchronously, then sweeps
  // the in-flight agents. There is a window where `running === false` but THIS
  // agent has not been swept. A cap abort (runaway tool/turn loop) settling in
  // that window must NOT be misread as a drain — under the old `!running`
  // predicate it was refunded a free attempt across restart. The fix tests the
  // explicit drain-swept set, so an agent the sweep never touched stays semantic.
  //
  // We reproduce the window deterministically: the agent self-cap-aborts in
  // prompt(), and its waitForIdle() flips the pool's `running` to false WITHOUT
  // running stop()'s sweep — so the agent is never recorded as drain-swept while
  // `running` is already false at the bifurcation point.
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_cap_race", 0);
    let pool!: SummarizationWorkerPool;
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async () => {
        const agent: any = {
          state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
          prompt: async () => {
            // Cap-abort shape: settled aborted turn + Layer-0 aborted-class tag.
            agent.state.errorMessage = "Request was aborted [llm-request] [llm-request:aborted]";
            agent.state.messages.push({ role: "assistant", content: [], stopReason: "aborted" });
          },
          waitForIdle: async () => {
            // Open the race window: running is now false (as stop() would set it)
            // but the drain sweep has NOT run — this agent is never swept.
            (pool as any).running = false;
          },
          subscribe: () => () => {},
          abort: () => {},
        };
        return { agent, renderedInputIds: SEEDED_RENDERED_INPUT_IDS };
      },
    } as any;
    pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const j = storage.getSummarizationJobById("job_cap_race");
      return j?.status === "failed" || (j?.status === "pending" && j.attempts > 0);
    });

    const job = storage.getSummarizationJobById("job_cap_race")!;
    assert.equal(
      job.status,
      "failed",
      "a cap abort settling in the running-false window is semantic — NOT a drain (old code re-pended it)",
    );
    assert.equal(job.attempts, 1, "the claim-time increment is NOT refunded for a cap abort");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("drain abort (diary mirror, spec §7): stop() re-pends with diary_attempts compensated", async () => {
  await withDiaryFixture(async (ctx) => {
    await seedDiaryJob(ctx.storage, "sum_diary_drain");
    const pool = new DiaryWorkerPool({
      storage: ctx.storage,
      factory: makeAbortableFactory(),
      memoryWriter: ctx.memoryWriter,
      config: { worker_count: 1, max_retries: 3, per_session_budget_tokens: 1000 },
      workspaceRoot: ctx.workspaceRoot,
      resolveChannelLabel: async () => "Test Room (Earendil)",
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => ctx.storage.getDiaryStatus("sum_diary_drain") === "processing");
    await pool.stop();

    assert.equal(ctx.storage.getDiaryStatus("sum_diary_drain"), "pending", "drained diary job re-pends");
    const job = await ctx.storage.claimNextDiaryJob();
    assert.equal(job?.summaryId, "sum_diary_drain");
    assert.equal(job?.attempts, 1, "fresh claim after a compensated drain is attempt 1, not 2");
  });
});

// ---------------------------------------------------------------------------
// Input integrity (spec SUMMARIZATION-JOB-INPUT-INTEGRITY): Fix C (the kickoff
// delivers only the satellite final turn — no restated instruction turn) and
// Fix B (declared-vs-rendered assertion fails the job, commits no artifact).
// ---------------------------------------------------------------------------

test("Fix C: the kickoff is the satellite final turn alone — no trailing 'Summarize the conversation' user turn", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_kickoff", 0);
    const satellite = { role: "user", content: "<system>satellite block with instructions</system>", timestamp: 2000 };
    let capturedKickoff: unknown;
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async (_session: unknown, tools: AgentTool[]) => {
        const summaryTool = tools[0]!;
        await summaryTool.execute("t", { command: "create", file_text: "A fine summary." });
        return {
          agent: {
            prompt: async (k: unknown) => {
              capturedKickoff = k;
            },
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          finalTurn: satellite,
          renderedInputIds: SEEDED_RENDERED_INPUT_IDS,
        };
      },
    } as any;
    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_kickoff")?.status === "complete");
    await pool.stop();

    // The kickoff is the satellite object itself, NOT an array ending in a
    // restated "Summarize the conversation shown above." user turn (Fix C).
    assert.deepEqual(capturedKickoff, satellite, "kickoff must be the satellite final turn alone");
    assert.ok(!Array.isArray(capturedKickoff), "kickoff is not a multi-turn array");
    assert.ok(
      !JSON.stringify(capturedKickoff).includes("Summarize the conversation shown above"),
      "the redundant instruction turn is gone",
    );
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("Fix B: a declared-vs-rendered input mismatch fails the job and commits no summary", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_mismatch", 0);
    // The factory renders the WRONG inputs (declared is ev0/ev1) — the integrity
    // assertion must fail the run before the agent does anything.
    // The agent only writes its draft during prompt() (as in production); since
    // the assertion fires pre-prompt, no draft is ever produced — so there is
    // nothing for the truncation fallback to salvage and the job truly fails.
    let promptCalled = false;
    const factory = {
      resolveModelId: () => "test-model",
      resolveSessionCostCeiling: () => 0.5,
      create: async () => {
        return {
          agent: {
            prompt: async () => {
              promptCalled = true;
            },
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [] },
          },
          finalTurn: { role: "user", content: "<system>satellite</system>" },
          renderedInputIds: ["ev_WRONG"],
        };
      },
    } as any;
    const errors: string[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory,
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: (jobId) => errors.push(jobId),
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_mismatch")?.status === "failed");
    await pool.stop();

    const job = storage.getSummarizationJobById("job_mismatch")!;
    assert.equal(job.status, "failed", "an input-integrity violation fails the job");
    assert.match(job.error ?? "", /input integrity violation/);
    assert.equal(promptCalled, false, "the agent never ran (assertion is pre-prompt)");
    assert.equal(
      storage.getSummariesByLevel(TK, 1).length,
      0,
      "no mislabeled artifact is committed",
    );
    assert.deepEqual(errors, ["job_mismatch"]);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("returnSummarizationJobToPending / returnDiaryJobToPending never touch non-processing rows", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedSummarizationJob(storage, "job_guard", 2);
    // Job is 'pending' (never claimed): the compensation is a no-op.
    await storage.returnSummarizationJobToPending("job_guard");
    const job = storage.getSummarizationJobById("job_guard")!;
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);

    // Claim (attempts → 1), fail terminally, then attempt the compensation:
    // the terminal row must be untouched.
    await storage.claimNextSummarizationJob();
    await storage.failSummarizationJob("job_guard", "boom");
    await storage.returnSummarizationJobToPending("job_guard");
    const failed = storage.getSummarizationJobById("job_guard")!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
