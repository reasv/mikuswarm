import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { SummaryStatus } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { createExpandSummaryTool } from "../src/tools/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:test:room:!room";

function event(id: string, body: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@u:test", displayName: "U", isSelf: false },
    body,
    timestamp,
    receivedAt: timestamp,
  };
}

let seq = 0;

async function insertSummary(
  storage: Storage,
  opts: {
    id: string;
    content: string;
    level: number;
    earliest: number;
    latest: number;
    status?: SummaryStatus;
    eventIds?: string[];
    parentIds?: string[];
  },
): Promise<void> {
  const jobId = `job-${opts.id}-${seq++}`;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey: TK,
    level: opts.level,
    inputStartId: `s-${opts.id}`,
    inputEndId: `e-${opts.id}`,
    inputTokenCount: 10,
    targetTokenCount: 100,
    maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id: opts.id,
    timelineKey: TK,
    level: opts.level,
    content: opts.content,
    earliestTimestamp: opts.earliest,
    latestTimestamp: opts.latest,
    latestEventId: opts.eventIds?.[opts.eventIds.length - 1] ?? `e-${opts.id}`,
    eventCount: opts.eventIds?.length ?? 4,
    tokenCount: 10,
    modelId: "m",
    status: opts.status ?? "complete",
    generatedAt: opts.latest,
    eventIds: opts.level === 1 ? opts.eventIds : undefined,
    parentIds: opts.level > 1 ? opts.parentIds : undefined,
    jobId,
  });
}

/** Build: 4 events → L1a([e1,e2]) + L1b([e3,e4]) → L2([L1a,L1b]). */
async function withHierarchy(
  run: (storage: Storage, tool: ReturnType<typeof createExpandSummaryTool>) => Promise<void>,
  tokenCap = 4000,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-expand-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const timeline = new TimelineStore(storage);
    await timeline.append(event("e1", "first message about alpha", 1000));
    await timeline.append(event("e2", "second message about beta", 2000));
    await timeline.append(event("e3", "third message about gamma", 3000));
    await timeline.append(event("e4", "fourth message about delta", 4000));
    // Realistic-sized content (~150 tokens each) so a 200-token cap genuinely truncates
    // after the first child rather than fitting both.
    const filler = "more context follows here. ".repeat(40);
    await insertSummary(storage, { id: "L1a", content: `summary of alpha and beta. ${filler}`, level: 1, earliest: 1000, latest: 2000, eventIds: ["e1", "e2"] });
    await insertSummary(storage, { id: "L1b", content: `summary of gamma and delta. ${filler}`, level: 1, earliest: 3000, latest: 4000, eventIds: ["e3", "e4"] });
    await insertSummary(storage, { id: "L2", content: "coarse summary of the whole conversation", level: 2, earliest: 1000, latest: 4000, parentIds: ["L1a", "L1b"] });

    const tool = createExpandSummaryTool({ storage, defaults: { tokenCap, maxDepth: 3 } });
    await run(storage, tool);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("expanding a level-1 summary returns its raw messages, hydrated", async () => {
  await withHierarchy(async (_storage, tool) => {
    const res = await tool.execute("c1", { id: "L1a" });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /Raw messages/);
    assert.match(text, /first message about alpha/);
    assert.match(text, /second message about beta/);
    assert.doesNotMatch(text, /gamma/); // L1b's events not included
    const details = res.details as { level: number; messageCount: number; children: unknown[] };
    assert.equal(details.level, 1);
    assert.equal(details.messageCount, 2);
    assert.equal(details.children.length, 0);
  });
});

test("expanding a level-2 summary returns its child summaries with expandable ids", async () => {
  await withHierarchy(async (_storage, tool) => {
    const res = await tool.execute("c2", { id: "L2" });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /Finer summaries/);
    assert.match(text, /id=L1a/);
    assert.match(text, /id=L1b/);
    assert.match(text, /summary of alpha and beta/);
    // depth 1 on a level-2 does NOT reach raw messages.
    assert.doesNotMatch(text, /Raw messages/);
    const details = res.details as { children: Array<{ id: string; level: number }>; messageCount: number };
    assert.deepEqual(details.children.map((c) => c.id), ["L1a", "L1b"]);
    assert.equal(details.children[0]?.level, 1);
    assert.equal(details.messageCount, 0);
  });
});

test("depth 2 drills a level-2 down to raw messages", async () => {
  await withHierarchy(async (_storage, tool) => {
    const res = await tool.execute("c3", { id: "L2", depth: 2 });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /Raw messages/);
    assert.match(text, /first message about alpha/);
    assert.match(text, /fourth message about delta/);
    const details = res.details as { messageCount: number; children: unknown[] };
    assert.equal(details.messageCount, 4);
    assert.equal(details.children.length, 0);
  });
});

test("include_messages drills level-1 leaves to raw messages at depth 1", async () => {
  await withHierarchy(async (_storage, tool) => {
    const res = await tool.execute("c4", { id: "L2", include_messages: true });
    const details = res.details as { messageCount: number; children: unknown[] };
    assert.equal(details.messageCount, 4);
    assert.equal(details.children.length, 0);
  });
});

test("token_cap truncates and reports omitted constituents", async () => {
  // Tiny cap so only the first child summary fits.
  await withHierarchy(async (_storage, tool) => {
    const res = await tool.execute("c5", { id: "L2", token_cap: 200 });
    const text = (res.content[0] as { text: string }).text;
    const details = res.details as { truncated: boolean; omitted: number; children: unknown[] };
    assert.equal(details.truncated, true);
    assert.ok(details.omitted >= 1);
    assert.match(text, /Output cap reached/);
    // At least one constituent is always included even under a tight cap.
    assert.ok(details.children.length >= 1);
  }, 200);
});

test("depth above the configured max is capped with a note", async () => {
  await withHierarchy(async (_storage, tool) => {
    // maxDepth is 3 in the harness; ask for 5.
    const res = await tool.execute("c6", { id: "L2", depth: 5 });
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /depth capped at the configured max 3/);
    const details = res.details as { depth: number };
    assert.equal(details.depth, 3);
  });
});

test("a superseded child is skipped during a drill", async () => {
  await withHierarchy(async (storage, tool) => {
    await insertSummary(storage, { id: "L1c", content: "superseded child summary", level: 1, earliest: 5000, latest: 6000, eventIds: ["e1"], status: "superseded" });
    await insertSummary(storage, { id: "L2b", content: "coarse summary with a superseded child", level: 2, earliest: 1000, latest: 6000, parentIds: ["L1a", "L1c"] });
    const res = await tool.execute("c9", { id: "L2b" });
    const details = res.details as { children: Array<{ id: string }> };
    // L1c (superseded) is skipped; only the live child is offered as a drill affordance.
    assert.deepEqual(details.children.map((c) => c.id), ["L1a"]);
    assert.doesNotMatch((res.content[0] as { text: string }).text, /id=L1c/);
  });
});

test("unknown and superseded ids return clear errors", async () => {
  await withHierarchy(async (storage, tool) => {
    const missing = await tool.execute("c7", { id: "nope" });
    assert.match((missing.content[0] as { text: string }).text, /not found/);
    assert.equal((missing.details as { error: string }).error, "not_found");

    await insertSummary(storage, { id: "dead", content: "gone", level: 1, earliest: 1000, latest: 2000, eventIds: ["e1"], status: "superseded" });
    const sup = await tool.execute("c8", { id: "dead" });
    assert.match((sup.content[0] as { text: string }).text, /superseded/);
    assert.equal((sup.details as { error: string }).error, "superseded");
  });
});
