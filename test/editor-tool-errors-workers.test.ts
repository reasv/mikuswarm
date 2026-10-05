import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Storage, MemoryFileWriter } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import { DiaryWorkerPool, buildDiaryHeader } from "../src/diary/index.js";
import { configureAgentTimezone } from "../src/time/index.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { runToolCalls } from "./helpers/pi-tool-run.js";

configureAgentTimezone("UTC");

// ---------------------------------------------------------------------------
// The editor tools (summary_tool, diary_tool) report failures by THROWING, so
// pi-agent-core flags the toolResult isError. A failed edit is model-facing
// feedback, never a run failure: the workers judge the outcome purely by the
// draft state left behind. Each fake agent here runs its scripted calls through
// a real pi Agent loop, so the tool errors are exactly what a live run produces.
// ---------------------------------------------------------------------------

const TK = "matrix:test:room:!room:server";
const ROOM_LABEL = "Test Room";

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

/** A factory whose agent runs `calls` through a real pi loop and records the toolResults. */
function scriptedFactory(calls: Array<Record<string, unknown>>, seen: ToolResultMessage[], extra: Record<string, unknown> = {}) {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => 0.5,
    resolveSessionType: () => undefined,
    create: async (_session: unknown, tools: AgentTool[]) => ({
      agent: {
        prompt: async () => {
          seen.push(...(await runToolCalls(tools[0]!, calls)).results);
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
        abort: () => {},
      },
      ...extra,
    }),
  } as any;
}

// --- summarization ---------------------------------------------------------

async function withSummarization(
  calls: Array<Record<string, unknown>>,
  run: (ctx: { storage: Storage; seen: ToolResultMessage[] }) => Promise<void>,
): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.appendTimelineEvent(event("ev0", 1000));
    await storage.appendTimelineEvent(event("ev1", 2000));
    await storage.insertSummarizationJob({
      id: "job",
      timelineKey: TK,
      level: 1,
      inputStartId: "ev0",
      inputEndId: "ev1",
      inputTokenCount: 50,
      targetTokenCount: 10, // limit 25 tokens at the pool's default 2.5 overage factor
      maxRetries: 0,
    });
    const seen: ToolResultMessage[] = [];
    const pool = new SummarizationWorkerPool({
      storage,
      factory: scriptedFactory(calls, seen, { renderedInputIds: ["ev0", "ev1"] }),
      config: { worker_count: 1, max_retries: 0 },
      onComplete: () => {},
      onError: () => {},
      logger: silentLogger,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const status = storage.getSummarizationJobById("job")?.status;
      return status === "complete" || status === "failed";
    });
    await pool.stop();
    await run({ storage, seen });
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

function summaryContents(storage: Storage): string[] {
  return (storage.read((db) => db.prepare("select content from summaries").all()) as Array<{ content: string }>)
    .map((r) => r.content);
}

test("summarization: an errored edit followed by a valid finalize commits the valid draft", async () => {
  await withSummarization(
    [
      { command: "create", file_text: "word ".repeat(500), finalize: true },
      { command: "create", file_text: "A short summary.", finalize: true },
    ],
    async ({ storage, seen }) => {
      assert.deepEqual(seen.map((r) => r.isError), [true, false], "the over-budget call is a pi tool error");
      assert.equal(storage.getSummarizationJobById("job")!.status, "complete");
      assert.deepEqual(summaryContents(storage), ["A short summary."]);
    },
  );
});

test("summarization: a run whose only edits errored leaves no draft and fails the job", async () => {
  await withSummarization(
    [{ command: "create", file_text: "word ".repeat(500), finalize: true }, { command: "finalize" }],
    async ({ storage, seen }) => {
      assert.deepEqual(seen.map((r) => r.isError), [true, true]);
      assert.equal(storage.getSummarizationJobById("job")!.status, "failed");
      assert.deepEqual(summaryContents(storage), []);
    },
  );
});

// --- diary -----------------------------------------------------------------

const HEADER = buildDiaryHeader({ earliestTimestamp: 1000, latestTimestamp: 2000, room: ROOM_LABEL });

async function withDiary(
  calls: Array<Record<string, unknown>>,
  run: (ctx: { storage: Storage; seen: ToolResultMessage[]; memoryDir: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-editor-errors-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    for (const e of [event("dv0", 1000), event("dv1", 2000, "assistant")]) await storage.appendTimelineEvent(e);
    await storage.insertSummarizationJob({
      id: "job-sum",
      timelineKey: TK,
      level: 1,
      inputStartId: "dv0",
      inputEndId: "dv1",
      inputTokenCount: 10,
      targetTokenCount: 100,
      maxRetries: 0,
    });
    await storage.insertSummaryWithLineage({
      id: "sum",
      timelineKey: TK,
      level: 1,
      content: "summary",
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "dv1",
      eventCount: 2,
      tokenCount: 10,
      modelId: "m",
      status: "complete",
      generatedAt: 2000,
      eventIds: ["dv0", "dv1"],
      jobId: "job-sum",
    });
    const seen: ToolResultMessage[] = [];
    const pool = new DiaryWorkerPool({
      storage,
      factory: scriptedFactory(calls, seen),
      memoryWriter: new MemoryFileWriter(dir),
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      workspaceRoot: dir,
      resolveChannelLabel: async () => ROOM_LABEL,
      logger: silentLogger,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => {
      const status = storage.getDiaryStatus("sum");
      return status === "done" || status === "failed";
    });
    await pool.stop();
    await run({ storage, seen, memoryDir: path.join(dir, "memory") });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function diaryFiles(memoryDir: string): Promise<string[]> {
  const names = await readdir(memoryDir).catch(() => [] as string[]);
  return Promise.all(names.map((n) => readFile(path.join(memoryDir, n), "utf8")));
}

test("diary: a header-mismatch error then a valid entry appends only the valid entry", async () => {
  await withDiary(
    [
      { command: "create", file_text: "no header here", finalize: true },
      { command: "create", file_text: `${HEADER}\nthe real entry`, finalize: true },
    ],
    async ({ storage, seen, memoryDir }) => {
      assert.deepEqual(seen.map((r) => r.isError), [true, false]);
      assert.ok(seen[0]!.content.some((c) => c.type === "text" && c.text.includes(HEADER)), "error echoes the header");
      assert.equal(storage.getDiaryStatus("sum"), "done");
      const files = await diaryFiles(memoryDir);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /the real entry/);
      assert.doesNotMatch(files[0]!, /no header here/);
    },
  );
});

test("diary: errored edits then finalize on the still-empty draft is the legitimate skip", async () => {
  await withDiary(
    [{ command: "create", file_text: "no header here" }, { command: "finalize" }],
    async ({ storage, seen, memoryDir }) => {
      assert.deepEqual(seen.map((r) => r.isError), [true, false]);
      assert.equal(storage.getDiaryStatus("sum"), "done");
      assert.deepEqual(await diaryFiles(memoryDir), [], "nothing appended");
    },
  );
});
