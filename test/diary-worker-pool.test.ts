import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage, MemoryFileWriter } from "../src/storage/index.js";
import { DiaryWorkerPool, diaryHeaderRegex, roomIdFromTimelineKey } from "../src/diary/index.js";
import { configureAgentTimezone } from "../src/time/index.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

configureAgentTimezone("UTC");

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

type Behavior = (tool: AgentTool, kickoff: string) => Promise<void>;

/** A fake factory that drives the diary tool from the agent's prompt(kickoff). */
function makeFakeFactory(behavior: Behavior, createdRef?: { created: boolean }) {
  return {
    resolveModelId: () => "test-model",
    resolveSessionType: () => ({
      session_instruction: "Write your entry. Begin with EXACTLY this header:\n{{header}}\n(room {{room}}, date {{date}})",
    }),
    create: async (_session: unknown, tools: AgentTool[]) => {
      if (createdRef) createdRef.created = true;
      const tool = tools[0]!;
      return {
        agent: {
          prompt: async (kickoff: string) => behavior(tool, kickoff),
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state: { messages: [] },
          abort: () => {},
        },
        snapshot: undefined,
        tokenEstimate: undefined,
      };
    },
  } as any;
}

async function withFixture(
  run: (ctx: { storage: Storage; workspaceRoot: string; memoryWriter: MemoryFileWriter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-pool-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run({ storage, workspaceRoot: dir, memoryWriter: new MemoryFileWriter(dir) });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function insertLevel1(storage: Storage, id: string, evs: CanonicalChatEvent[]): Promise<void> {
  for (const e of evs) await storage.appendTimelineEvent(e);
  const jobId = `job-${id}`;
  const latest = Math.max(...evs.map((e) => e.timestamp));
  await storage.insertSummarizationJob({
    id: jobId, timelineKey: TK, level: 1,
    inputStartId: evs[0]!.id, inputEndId: evs[evs.length - 1]!.id,
    inputTokenCount: 10, targetTokenCount: 100, maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id, timelineKey: TK, level: 1, content: `summary ${id}`,
    earliestTimestamp: evs[0]!.timestamp, latestTimestamp: latest,
    latestEventId: evs[evs.length - 1]!.id, eventCount: evs.length,
    tokenCount: 10, modelId: "m", status: "complete", generatedAt: latest,
    eventIds: evs.map((e) => e.id), jobId,
  });
}

function diaryStatus(storage: Storage, id: string): string | null {
  return (storage.read((db) => db.prepare(`select diary_status from summaries where id = ?`).get(id)) as { diary_status: string | null }).diary_status;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makePool(opts: {
  storage: Storage; memoryWriter: MemoryFileWriter; workspaceRoot: string;
  factory: any; resolveChannelLabel?: (tk: string) => Promise<string>;
}): DiaryWorkerPool {
  return new DiaryWorkerPool({
    storage: opts.storage,
    factory: opts.factory,
    memoryWriter: opts.memoryWriter,
    config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
    workspaceRoot: opts.workspaceRoot,
    resolveChannelLabel: opts.resolveChannelLabel ?? (async () => "Test Room (Earendil)"),
    logger: silentLogger,
  });
}

test("roomIdFromTimelineKey extracts the room id, ignoring a thread suffix", () => {
  assert.equal(roomIdFromTimelineKey("matrix:acct:room:!abc:server"), "!abc:server");
  assert.equal(roomIdFromTimelineKey("matrix:acct:dm:!abc:server"), "!abc:server");
  assert.equal(roomIdFromTimelineKey("matrix:acct:room:!abc:server:thread:$root"), "!abc:server");
  assert.equal(roomIdFromTimelineKey("matrix:acct"), undefined);
});

test("a participated range writes a diary entry and marks the summary done", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "sum1", [event("u0", 1000), event("a0", 2000, "assistant")]);

    const factory = makeFakeFactory(async (tool, kickoff) => {
      const header = kickoff.match(diaryHeaderRegex())?.[0];
      assert.ok(header, "kickoff must carry the dictated header");
      await tool.execute("t", { command: "create", file_text: `${header}\nI helped out today.`, finalize: true });
    });
    const pool = makePool({ storage, memoryWriter, workspaceRoot, factory });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => diaryStatus(storage, "sum1") === "done");
    await pool.stop();

    // The entry landed in the range's last-day file.
    const files = await readdir(path.join(workspaceRoot, "memory"));
    assert.equal(files.length, 1);
    const content = await readFile(path.join(workspaceRoot, "memory", files[0]!), "utf8");
    assert.match(content, /# .* Daily Memory/);
    assert.match(content, /· Test Room \(Earendil\)/);
    assert.match(content, /I helped out today\./);
  });
});

test("the skip-gate marks ranges with no assistant message 'skipped' without a session", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "sum1", [event("u0", 1000), event("u1", 2000)]); // all user

    const createdRef = { created: false };
    const factory = makeFakeFactory(async () => {}, createdRef);
    const pool = makePool({ storage, memoryWriter, workspaceRoot, factory });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => diaryStatus(storage, "sum1") === "skipped");
    await pool.stop();

    assert.equal(createdRef.created, false, "no diary session is spawned for an un-participated range");
    // No day file written.
    const files = await readdir(path.join(workspaceRoot, "memory")).catch(() => []);
    assert.equal(files.length, 0);
  });
});

test("an empty finalize is the legitimate 'nothing to record' skip → done, nothing appended", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "sum1", [event("a0", 2000, "assistant")]);

    const factory = makeFakeFactory(async (tool) => {
      await tool.execute("t", { command: "view", finalize: true }); // empty draft
    });
    const pool = makePool({ storage, memoryWriter, workspaceRoot, factory });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => diaryStatus(storage, "sum1") === "done");
    await pool.stop();

    const files = await readdir(path.join(workspaceRoot, "memory")).catch(() => []);
    assert.equal(files.length, 0, "an empty entry appends nothing");
  });
});

test("a failed run with exhausted retries marks the summary 'failed'", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "sum1", [event("a0", 2000, "assistant")]);

    const factory = makeFakeFactory(async () => {
      throw new Error("forced agent failure");
    });
    const pool = makePool({ storage, memoryWriter, workspaceRoot, factory });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => diaryStatus(storage, "sum1") === "failed");
    await pool.stop();
  });
});

test("channel-label resolution failure falls back to the room id in the header", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "sum1", [event("a0", 2000, "assistant")]);

    const factory = makeFakeFactory(async (tool, kickoff) => {
      const header = kickoff.match(diaryHeaderRegex())?.[0]!;
      await tool.execute("t", { command: "create", file_text: `${header}\nfallback test`, finalize: true });
    });
    const pool = makePool({
      storage, memoryWriter, workspaceRoot, factory,
      resolveChannelLabel: async () => { throw new Error("native unavailable"); },
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => diaryStatus(storage, "sum1") === "done");
    await pool.stop();

    const files = await readdir(path.join(workspaceRoot, "memory"));
    const content = await readFile(path.join(workspaceRoot, "memory", files[0]!), "utf8");
    // roomIdFromTimelineKey("matrix:test:room:!room:server") === "!room:server".
    assert.match(content, /· !room:server\n/);
  });
});
