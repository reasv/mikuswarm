import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { Summary } from "../src/storage/index.js";
import { evaluateCondensation } from "../src/summarization/index.js";
import type { SummarizationConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/index.js";

const TK = "matrix:test:room:!room";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

const config: SummarizationConfig = {
  condense_fanout: 5,
  condense_target_tokens: 800,
  max_retries: 2,
};

async function openStorage(): Promise<Storage> {
  return Storage.open({ databasePath: ":memory:" });
}

function insertSummary(
  storage: Storage,
  s: Pick<Summary, "id" | "level" | "earliestTimestamp" | "latestTimestamp"> & Partial<Summary>,
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
      s.timelineKey ?? TK,
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

test("enqueues a level-2 job for a contiguous run >= fanout", async () => {
  const storage = await openStorage();
  for (let i = 0; i < 5; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  const jobs = storage.getActiveSummarizationJobs(TK, 2);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.inputStartId, "s0");
  assert.equal(jobs[0]!.inputEndId, "s4");
  assert.equal(jobs[0]!.level, 2);
  assert.equal(jobs[0]!.targetTokenCount, 800);
  storage.close();
});

test("does not enqueue when the run is shorter than fanout", async () => {
  const storage = await openStorage();
  for (let i = 0; i < 4; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  assert.equal(storage.getActiveSummarizationJobs(TK, 2).length, 0);
  storage.close();
});

test("a higher-level summary between members splits the run", async () => {
  const storage = await openStorage();
  // Six level-1 summaries that would otherwise form one run of 6...
  for (let i = 0; i < 6; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }
  // ...but a level-2 summary sits strictly between s2 and s3, splitting into
  // runs of length 3 and 3 (both < fanout=5).
  await insertSummary(storage, {
    id: "interrupt",
    level: 2,
    earliestTimestamp: 255,
    latestTimestamp: 295,
  });

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  assert.equal(storage.getActiveSummarizationJobs(TK, 2).length, 0);
  storage.close();
});

test("does not enqueue a duplicate when an active job already covers the run", async () => {
  const storage = await openStorage();
  for (let i = 0; i < 5; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }
  await storage.insertSummarizationJob({
    id: "existing",
    timelineKey: TK,
    level: 2,
    inputStartId: "s0",
    inputEndId: "s4",
    inputTokenCount: 500,
    targetTokenCount: 800,
    maxRetries: 2,
  });

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  const jobs = storage.getActiveSummarizationJobs(TK, 2);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "existing");
  storage.close();
});

test("skips enqueueing when an active job references nonexistent (deleted) summary IDs", async () => {
  const storage = await openStorage();
  // Five contiguous level-1 summaries — enough for condensation.
  for (let i = 0; i < 5; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }
  // An active (processing) level-2 job whose input IDs reference summaries that
  // no longer exist in the DB (e.g. deleted). The evaluator cannot resolve their
  // timestamps, so it conservatively treats them as overlapping to avoid
  // enqueueing a duplicate.
  await storage.insertSummarizationJob({
    id: "ghost_job",
    timelineKey: TK,
    level: 2,
    inputStartId: "deleted_s0",
    inputEndId: "deleted_s4",
    inputTokenCount: 500,
    targetTokenCount: 800,
    maxRetries: 2,
  });

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  // The only active job should be the ghost one — no new job enqueued.
  const jobs = storage.getActiveSummarizationJobs(TK, 2);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "ghost_job");
  storage.close();
});

test("cascade: level-2 completion triggers evaluation for level-3 eligibility", async () => {
  const storage = await openStorage();
  for (let i = 0; i < 5; i++) {
    await insertSummary(storage, {
      id: `l2_${i}`,
      level: 2,
      earliestTimestamp: i * 1000,
      latestTimestamp: i * 1000 + 500,
    });
  }

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 2, logger: silentLogger });

  const jobs = storage.getActiveSummarizationJobs(TK, 3);
  assert.equal(jobs.length, 1, "should enqueue a level-3 job");
  assert.equal(jobs[0]!.inputStartId, "l2_0");
  assert.equal(jobs[0]!.inputEndId, "l2_4");
  assert.equal(jobs[0]!.level, 3);
  storage.close();
});
