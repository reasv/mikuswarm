import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { SummarizationWorkerPool, truncateToBudget } from "../src/summarization/index.js";
import { estimateTokens } from "../src/context/index.js";
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

test("truncateToBudget respects CJK sentence-boundary punctuation", () => {
  // Uses real BPE tokenizer. Build text where the CJK 。 followed by a space
  // lands within the last 20% of the token-truncated region so the sentence
  // boundary logic fires.
  const filler = "QQQQ";                       // marker not in the truncation annotation
  const prefix = "word ".repeat(12);            // ~13 tokens of filler words
  const before = prefix + "。";                 // prefix + sentence-ending 。
  const after = " " + filler.repeat(10);        // trailing content after boundary
  const text = before + after;                  // ~34 tokens total, exceeds target

  const result = truncateToBudget(text, 30);
  // Should truncate at the 。 boundary, not at the raw token limit.
  assert.ok(result.startsWith(before), "should keep text up to and including 。");
  assert.ok(!result.includes(filler), "should not include text after 。 boundary");
  assert.match(result, /\[Summary truncated/);
});

test("truncateToBudget respects fullwidth exclamation and question marks", () => {
  // Uses real BPE tokenizer. Same layout as the CJK test above but with ！ and ？.
  const filler = "QQQQ";
  const prefix = "word ".repeat(12);
  const before = prefix + "！";
  const after = " " + filler.repeat(10);
  const text = before + after;

  const result = truncateToBudget(text, 30);
  assert.ok(result.startsWith(before), "should keep text up to and including ！");
  assert.ok(!result.includes(filler), "should not include text after ！ boundary");

  // Also test ？
  const before2 = prefix + "？";
  const text2 = before2 + " " + filler.repeat(10);
  const result2 = truncateToBudget(text2, 30);
  assert.ok(result2.startsWith(before2), "should keep text up to and including ？");
  assert.ok(!result2.includes(filler), "should not include text after ？ boundary");
});

test("truncation fallback uses the shorter draft when DB has a shorter best-effort draft than the current attempt", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id: "job_draft",
    timelineKey: TK,
    level: 1,
    inputStartId: "ev0",
    inputEndId: "ev1",
    inputTokenCount: 50,
    targetTokenCount: 200,
    maxRetries: 1, // two attempts: first saves short draft, second produces long draft
  });

  // A short draft (first attempt) and a long draft (second attempt).
  const shortDraft = "Short summary. Done.";
  const longDraft = Array.from({ length: 30 }, (_, i) => `Detailed sentence ${i} here.`).join(" ");
  assert.ok(
    estimateTokens(shortDraft) < estimateTokens(longDraft),
    "precondition: short draft has fewer tokens than long draft",
  );

  let callCount = 0;
  const factory = {
    resolveModelId: () => "test-model",
    create: async (_session: unknown, tools: AgentTool[]) => {
      callCount++;
      const summaryTool = tools[0]!;
      // First attempt writes the short draft; second writes the long draft.
      const text = callCount === 1 ? shortDraft : longDraft;
      await summaryTool.execute("t", { command: "create", file_text: text });
      return {
        prompt: async () => {},
        waitForIdle: async () => {
          throw new Error("forced agent failure");
        },
      };
    },
  } as any;

  const pool = new SummarizationWorkerPool({
    storage,
    factory,
    config: { worker_count: 1, summary_max_overage_factor: 2.5, max_retries: 1 },
    onComplete: () => {},
    onError: () => {},
    logger: silentLogger,
  });

  await pool.start();
  pool.notifyNewWork();
  await waitFor(() => {
    const j = storage.getSummarizationJobById("job_draft");
    return j?.status === "complete" || j?.status === "failed";
  });
  await pool.stop();

  assert.equal(callCount, 2, "factory should have been called twice");
  const job = storage.getSummarizationJobById("job_draft")!;
  assert.equal(job.status, "complete");
  assert.ok(job.resultSummaryId);

  const summary = storage.getSummaryById(job.resultSummaryId!)!;
  // The summary content should be based on the shorter draft, not the longer one.
  // Since shortDraft is well within budget, it should be used as-is (no truncation needed).
  assert.ok(
    summary.content.includes("Short summary"),
    "truncation fallback should have picked the shorter draft from the DB",
  );
  assert.ok(
    !summary.content.includes("Detailed sentence"),
    "truncation fallback should NOT have used the longer current draft",
  );

  storage.close();
});

test("truncateToBudget result stays within the token budget", () => {
  // Build a text that is well over the target budget; verify the truncated
  // result (including the trailer) does not exceed the target.
  const longText = "The quick brown fox jumps over the lazy dog. ".repeat(50);
  const target = 40;
  assert.ok(estimateTokens(longText) > target, "precondition: text exceeds budget");

  const result = truncateToBudget(longText, target);
  const resultTokens = estimateTokens(result);
  assert.ok(
    resultTokens <= target,
    `truncated result should be at most ${target} tokens, got ${resultTokens}`,
  );
  assert.match(result, /\[Summary truncated/);
});
