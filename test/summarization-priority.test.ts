import assert from "node:assert/strict";
import test from "node:test";

import { Storage } from "../src/storage/index.js";

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
