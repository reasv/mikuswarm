import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ChatSearchIndexer } from "../src/search/index.js";
import { createRecapTool } from "../src/tools/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:test:room:!room";
const NOW = 1_700_000_000_000;

function event(id: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@u:test", displayName: "U", isSelf: false },
    body: `message ${id}`,
    timestamp,
    receivedAt: timestamp,
  };
}

/** Insert a level-1 summary covering [evIds] via a completed summarization job. */
async function insertLevel1Summary(
  storage: Storage,
  id: string,
  evIds: string[],
  earliestTimestamp: number,
  latestTimestamp: number,
): Promise<void> {
  const jobId = `job-${id}`;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey: TK,
    level: 1,
    inputStartId: evIds[0]!,
    inputEndId: evIds[evIds.length - 1]!,
    inputTokenCount: 10,
    targetTokenCount: 100,
    maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id,
    timelineKey: TK,
    level: 1,
    content: `summary ${id}`,
    earliestTimestamp,
    latestTimestamp,
    latestEventId: evIds[evIds.length - 1]!,
    eventCount: evIds.length,
    tokenCount: 10,
    modelId: "m",
    status: "complete",
    generatedAt: latestTimestamp,
    eventIds: evIds,
    jobId,
  });
}

async function withStorage(
  run: (storage: Storage, indexer: ChatSearchIndexer) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-recap-ids-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const indexer = new ChatSearchIndexer({ storage });
    await run(storage, indexer);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("recap visible text cites each summary's id (recap→expand handoff, Piece C)", async () => {
  await withStorage(async (storage, indexer) => {
    const timeline = new TimelineStore(storage);
    // Two messages an hour apart, ~2 days ago, summarized into one level-1 summary.
    const t0 = NOW - 49 * 60 * 60 * 1000;
    const t1 = NOW - 48 * 60 * 60 * 1000;
    await timeline.append(event("e0", t0));
    await timeline.append(event("e1", t1));
    await insertLevel1Summary(storage, "sum_abc", ["e0", "e1"], t0, t1);
    await indexer.reconcileAll();

    const tool = createRecapTool({
      storage,
      indexer,
      currentTimelineKey: TK,
      askerId: "@asker:test",
      defaults: { budgetTokens: 6000, gapThresholdMs: 3 * 60 * 60 * 1000, defaultLookbackMs: 24 * 60 * 60 * 1000 },
      now: () => NOW,
    });

    const result = await tool.execute("call-1", { after: new Date(t0 - 1000).toISOString() });
    const text = (result.content[0] as { text: string }).text;

    // The visible body — not just `details` — must carry the id so a bot that learned
    // about a period via recap can pass it to expand_summary.
    assert.match(text, /id=sum_abc/);
    // And it still appears in details (unchanged contract).
    const details = result.details as { rooms: Array<{ summaryIds: string[] }> };
    assert.deepEqual(details.rooms[0]?.summaryIds, ["sum_abc"]);
  });
});
