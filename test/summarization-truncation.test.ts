import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import type { SummarizationConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

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

function event(id: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@u:test", displayName: "U" },
    body: `message ${id}`,
    timestamp,
    receivedAt: timestamp,
  };
}

// An over-target but within-overage draft (target 100, overage 2.5 → limit 250).
// ~30 short sentences ≈ 150 tokens: over target 100, under limit 250.
const draftText = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(" ");

/**
 * Fake factory: on create it writes an over-budget-but-acceptable draft via the
 * summary_tool, then returns an agent whose run always throws — forcing the
 * failure path and (with max_retries=0) the truncation fallback.
 */
function makeFakeFactory() {
  return {
    resolveModelId: () => "test-model",
    create: async (_session: unknown, tools: AgentTool[]) => {
      const summaryTool = tools[0]!;
      await summaryTool.execute("t", { command: "create", file_text: draftText });
      return {
        prompt: async () => {},
        waitForIdle: async () => {
          throw new Error("forced agent failure");
        },
      };
    },
  } as any;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("truncation fallback salvages an over-budget draft after retries exhaust", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id: "job1",
    timelineKey: TK,
    level: 1,
    inputStartId: "ev0",
    inputEndId: "ev1",
    inputTokenCount: 50,
    targetTokenCount: 100,
    maxRetries: 0, // first failure goes straight to truncation
  });

  const config: SummarizationConfig = { worker_count: 1, summary_max_overage_factor: 2.5, max_retries: 0 };
  const pool = new SummarizationWorkerPool({
    storage,
    factory: makeFakeFactory(),
    config,
    onComplete: () => {},
    onError: () => {},
    logger: silentLogger,
  });

  await pool.start();
  pool.notifyNewWork();
  await waitFor(() => storage.getSummarizationJobById("job1")?.status === "complete");
  await pool.stop();

  const job = storage.getSummarizationJobById("job1")!;
  assert.equal(job.status, "complete");
  assert.ok(job.resultSummaryId);

  const summary = storage.getSummaryById(job.resultSummaryId!)!;
  assert.equal(summary.status, "truncated");
  assert.match(summary.content, /\[Summary truncated/);
  // Truncated content is no larger than the original best-effort draft.
  assert.ok(summary.tokenCount <= storage.getSummarizationJobById("job1")!.targetTokenCount * 1.5);
  assert.equal(summary.level, 1);
  assert.equal(summary.latestEventId, "ev1");
  assert.equal(summary.eventCount, 2);

  storage.close();
});

test("a job with no salvageable draft is marked failed", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id: "job2",
    timelineKey: TK,
    level: 1,
    inputStartId: "ev0",
    inputEndId: "ev1",
    inputTokenCount: 50,
    targetTokenCount: 100,
    maxRetries: 0,
  });

  // Factory that never writes a draft and always fails.
  const factory = {
    resolveModelId: () => "test-model",
    create: async () => ({
      prompt: async () => {},
      waitForIdle: async () => {
        throw new Error("forced agent failure");
      },
    }),
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
  await waitFor(() => storage.getSummarizationJobById("job2")?.status === "failed");
  await pool.stop();

  assert.equal(storage.getSummarizationJobById("job2")!.status, "failed");
  storage.close();
});
