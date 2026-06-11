import assert from "node:assert/strict";
import test from "node:test";

import { Storage } from "../src/storage/index.js";
import { createEscalateSummary } from "../src/summarization/index.js";
import type { Logger } from "../src/observability/index.js";

// ---------------------------------------------------------------------------
// Priority inheritance, job-row half (spec CONCURRENCY-AND-RATE-LIMITING §5.5):
// the `summarization_jobs.priority` column, priority-ordered claiming, and the
// raise-only `escalateSummarizationJob` primitive. (The scheduler half — sticky
// `escalate` on queued/unregistered entries — is covered in llm-scheduler.test.ts.)
// ---------------------------------------------------------------------------

async function openStorage(): Promise<Storage> {
  return Storage.open({ databasePath: ":memory:" });
}

function jobInsert(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    timelineKey: "matrix:acct:room:!r1",
    level: 1,
    inputStartId: `${id}-start`,
    inputEndId: `${id}-end`,
    inputTokenCount: 100,
    targetTokenCount: 600,
    maxRetries: 2,
    ...overrides,
  };
}

test("jobs default to background priority and claim FIFO within a class", async () => {
  const storage = await openStorage();
  try {
    await storage.insertSummarizationJob(jobInsert("job-a"));
    await storage.insertSummarizationJob(jobInsert("job-b"));

    const a = storage.getSummarizationJobById("job-a");
    assert.equal(a?.priority, "background");

    const first = await storage.claimNextSummarizationJob();
    const second = await storage.claimNextSummarizationJob();
    assert.equal(first?.id, "job-a", "FIFO by created_at within a class");
    assert.equal(second?.id, "job-b");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("an escalated job is claimed ahead of older background jobs (state 1 of §5.5)", async () => {
  const storage = await openStorage();
  try {
    await storage.insertSummarizationJob(jobInsert("job-old-1"));
    await storage.insertSummarizationJob(jobInsert("job-old-2"));
    await storage.insertSummarizationJob(jobInsert("job-needed"));

    const raised = await storage.escalateSummarizationJob("job-needed", "interactive");
    assert.equal(raised, true);
    assert.equal(storage.getSummarizationJobById("job-needed")?.priority, "interactive");

    const first = await storage.claimNextSummarizationJob();
    assert.equal(first?.id, "job-needed", "escalated job must be claimed next despite later created_at");
    const second = await storage.claimNextSummarizationJob();
    assert.equal(second?.id, "job-old-1");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("escalation is raise-only and skips terminal jobs", async () => {
  const storage = await openStorage();
  try {
    await storage.insertSummarizationJob(jobInsert("job-x", { priority: "interactive" }));
    // A demotion attempt must be a no-op.
    const demoted = await storage.escalateSummarizationJob("job-x", "background_low");
    assert.equal(demoted, false);
    assert.equal(storage.getSummarizationJobById("job-x")?.priority, "interactive");

    // Same-class escalation is also a no-op (no spurious row churn).
    const same = await storage.escalateSummarizationJob("job-x", "interactive");
    assert.equal(same, false);

    // A failed (terminal) job is never escalated.
    await storage.insertSummarizationJob(jobInsert("job-dead"));
    await storage.claimNextSummarizationJob(); // claims job-x (interactive)
    await storage.claimNextSummarizationJob(); // claims job-dead
    await storage.failSummarizationJob("job-dead", "boom");
    const terminal = await storage.escalateSummarizationJob("job-dead", "interactive");
    assert.equal(terminal, false);
    assert.equal(storage.getSummarizationJobById("job-dead")?.priority, "background");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// createEscalateSummary — the app-wiring callback (review issue #5): the
// escalate-vs-terminal race must not re-insert a sticky scheduler entry after
// the pool's clearEscalation already ran (job ids are never reused, so a late
// sticky insert would leak forever).
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function waitForMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

test("issue #5: escalateSummary escalates the scheduler + wakes the pool for a live job", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertSummarizationJob(jobInsert("job-live"));
    await storage.claimNextSummarizationJob();

    const escalated: Array<{ key: string; priority: string }> = [];
    let woken = 0;
    const escalateSummary = createEscalateSummary({
      storage,
      escalateScheduled: (key, priority) => escalated.push({ key, priority }),
      notifyPool: () => { woken += 1; },
      logger: silentLogger,
    });

    escalateSummary("job-live", "interactive");
    await waitForMicrotasks();

    assert.equal(storage.getSummarizationJobById("job-live")?.priority, "interactive");
    assert.deepEqual(escalated, [{ key: "sumjob:job-live", priority: "interactive" }]);
    assert.equal(woken, 1);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("issue #5: a job that reaches terminal between the row write and the continuation never re-pins the scheduler", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertSummarizationJob(jobInsert("job-race"));
    await storage.claimNextSummarizationJob();

    const escalated: string[] = [];
    let woken = 0;
    const escalateSummary = createEscalateSummary({
      storage: {
        // Deterministic race: the job goes terminal (and the pool's onComplete
        // would run clearEscalation) AFTER the row write resolves but BEFORE
        // the callback's continuation runs.
        escalateSummarizationJob: async (jobId, priority) => {
          const raised = await storage.escalateSummarizationJob(jobId, priority);
          await storage.failSummarizationJob(jobId, "completed during the race window");
          return raised;
        },
        getSummarizationJobById: (id) => storage.getSummarizationJobById(id),
      },
      escalateScheduled: (key) => escalated.push(key),
      notifyPool: () => { woken += 1; },
      logger: silentLogger,
    });

    escalateSummary("job-race", "interactive");
    await waitForMicrotasks();

    assert.deepEqual(escalated, [], "no late sticky escalation after the job is terminal");
    assert.equal(woken, 0, "no pool wake for a terminal job");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("issue #5: a vanished job id is skipped without throwing", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const escalated: string[] = [];
    const escalateSummary = createEscalateSummary({
      storage,
      escalateScheduled: (key) => escalated.push(key),
      notifyPool: () => {},
      logger: silentLogger,
    });

    escalateSummary("job-ghost", "interactive");
    await waitForMicrotasks();
    assert.deepEqual(escalated, []);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("a processing (claimed) job can still be escalated — covers retry re-claims", async () => {
  const storage = await openStorage();
  try {
    await storage.insertSummarizationJob(jobInsert("job-p"));
    const claimed = await storage.claimNextSummarizationJob();
    assert.equal(claimed?.id, "job-p");
    assert.equal(claimed?.status, "processing");

    const raised = await storage.escalateSummarizationJob("job-p", "interactive");
    assert.equal(raised, true, "processing rows are escalatable (future attempts inherit the class)");

    // A Layer-3 retry sets it back to pending; the raised class must persist so
    // the re-claim happens at the inherited priority.
    await storage.insertSummarizationJob(jobInsert("job-q"));
    await storage.retrySummarizationJob("job-p", "transient");
    const reclaimed = await storage.claimNextSummarizationJob();
    assert.equal(reclaimed?.id, "job-p");
    assert.equal(reclaimed?.priority, "interactive");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
