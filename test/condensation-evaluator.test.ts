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

test("a same-level summary between members is found by hasSummaryBetween (level >= L)", async () => {
  const storage = await openStorage();
  // Four level-1 summaries — not enough for fanout on their own.
  for (let i = 0; i < 4; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }

  // Verify hasSummaryBetween detects a same-level summary (level >= L, not just > L).
  // Insert a level-1 summary whose range falls between s1 and s2.
  // It sorts between them by earliest_timestamp, becoming a candidate in the walk.
  await insertSummary(storage, {
    id: "same_level_between",
    level: 1,
    earliestTimestamp: 155,
    latestTimestamp: 195,
  });

  // The same-level summary joins the candidate walk (getSummariesByLevel returns it),
  // making the run [s0, s1, same_level_between, s2, s3] = 5, which equals fanout.
  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  const jobs = storage.getActiveSummarizationJobs(TK, 2);
  assert.equal(jobs.length, 1, "5 contiguous same-level summaries should form a run reaching fanout");
  assert.equal(jobs[0]!.inputStartId, "s0");
  assert.equal(jobs[0]!.inputEndId, "s3");

  // Also verify that hasSummaryBetween with level >= 1 finds same-level summaries.
  // The "same_level_between" summary has earliest=155, latest=195. If we check
  // the gap [150, 200] (s1.latest to s2.earliest), hasSummaryBetween should find it.
  const found = storage.hasSummaryBetween(TK, 1, 150, 200);
  assert.equal(found, true, "hasSummaryBetween should detect same-level (level >= L) summaries");

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

test("edge-aligned interruptor breaks contiguity (inclusive boundary)", async () => {
  const storage = await openStorage();
  // Six level-1 summaries with timestamps: [0,50], [100,150], [200,250], [300,350], [400,450], [500,550]
  for (let i = 0; i < 6; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }
  // A level-2 summary whose earliest_timestamp exactly equals s2's latest_timestamp (250).
  // With inclusive boundaries (>=, <=), this falls between s2 (latest=250) and s3 (earliest=300),
  // breaking the run into [s0..s2] (3) and [s3..s5] (3), both below fanout=5.
  await insertSummary(storage, {
    id: "edge_interruptor",
    level: 2,
    earliestTimestamp: 250,
    latestTimestamp: 290,
  });

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  assert.equal(
    storage.getActiveSummarizationJobs(TK, 2).length,
    0,
    "edge-aligned interruptor should split the run so neither half reaches fanout",
  );
  storage.close();
});

test("oversized run is chunked into fanout-sized segments", async () => {
  const storage = await openStorage();
  // 13 contiguous level-1 summaries, fanout=5.
  // Expected: chunk [s0..s4] (5) and chunk [s5..s9] (5) are enqueued.
  // Leftover [s10..s12] (3) is below fanout, not enqueued.
  for (let i = 0; i < 13; i++) {
    await insertSummary(storage, {
      id: `s${i}`,
      level: 1,
      earliestTimestamp: i * 100,
      latestTimestamp: i * 100 + 50,
    });
  }

  await evaluateCondensation({ storage, config, timelineKey: TK, level: 1, logger: silentLogger });

  const jobs = storage.getActiveSummarizationJobs(TK, 2);
  assert.equal(jobs.length, 2, "should enqueue exactly 2 jobs for 13 summaries with fanout=5");

  // First chunk covers s0..s4
  const job1 = jobs.find((j) => j.inputStartId === "s0");
  assert.ok(job1, "first job should start at s0");
  assert.equal(job1.inputEndId, "s4");

  // Second chunk covers s5..s9
  const job2 = jobs.find((j) => j.inputStartId === "s5");
  assert.ok(job2, "second job should start at s5");
  assert.equal(job2.inputEndId, "s9");

  storage.close();
});
