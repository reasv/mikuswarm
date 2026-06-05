import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { SummaryStatus } from "../src/storage/index.js";
import { ChatSearchIndexer } from "../src/search/index.js";
import { createSearchMessagesTool } from "../src/tools/index.js";

const TK = "matrix:test:room:!room";
const TK2 = "matrix:test:room:!other";

async function withStorage(run: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-summary-search-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

let seq = 0;

/** Insert a level-1 summary with the given content/status via a completed job. */
async function insertSummary(
  storage: Storage,
  opts: {
    id: string;
    content: string;
    timelineKey?: string;
    level?: number;
    earliest: number;
    latest: number;
    status?: SummaryStatus;
    parentIds?: string[];
  },
): Promise<void> {
  const timelineKey = opts.timelineKey ?? TK;
  const level = opts.level ?? 1;
  const jobId = `job-${opts.id}-${seq++}`;
  await storage.insertSummarizationJob({
    id: jobId,
    timelineKey,
    level,
    inputStartId: `start-${opts.id}`,
    inputEndId: `end-${opts.id}`,
    inputTokenCount: 10,
    targetTokenCount: 100,
    maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id: opts.id,
    timelineKey,
    level,
    content: opts.content,
    earliestTimestamp: opts.earliest,
    latestTimestamp: opts.latest,
    latestEventId: `end-${opts.id}`,
    eventCount: 5,
    tokenCount: 10,
    modelId: "m",
    status: opts.status ?? "complete",
    generatedAt: opts.latest,
    // level 1 needs eventIds; level 2+ needs parentIds.
    eventIds: level === 1 ? [`start-${opts.id}`, `end-${opts.id}`] : undefined,
    parentIds: level > 1 ? opts.parentIds : undefined,
    jobId,
  });
}

test("summaries_fts trigger makes a newly inserted summary searchable; delete retracts it", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "s1", content: "the deployment pipeline failed overnight", earliest: 1000, latest: 2000 });
    let res = storage.searchSummaries({ match: "{content} : (\"deployment\")", limit: 10, order: "newest" });
    assert.equal(res.total, 1);
    assert.equal(res.hits[0]?.id, "s1");

    // Delete the summary → the AFTER DELETE trigger retracts the FTS row.
    await storage.write((db) => db.prepare(`delete from summaries where id = ?`).run("s1"));
    res = storage.searchSummaries({ match: "{content} : (\"deployment\")", limit: 10, order: "newest" });
    assert.equal(res.total, 0);
  });
});

test("superseded summaries are never returned; truncated are retained", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "ok", content: "alpha beta gamma", earliest: 1000, latest: 2000, status: "complete" });
    await insertSummary(storage, { id: "trunc", content: "alpha beta delta", earliest: 1000, latest: 2000, status: "truncated" });
    await insertSummary(storage, { id: "gone", content: "alpha beta epsilon", earliest: 1000, latest: 2000, status: "superseded" });

    // Default status set excludes superseded.
    let res = storage.searchSummaries({ match: "{content} : (\"alpha\")", limit: 10, order: "newest" });
    assert.deepEqual(res.hits.map((h) => h.id).sort(), ["ok", "trunc"]);

    // Even explicitly requesting it cannot surface superseded.
    res = storage.searchSummaries({
      match: "{content} : (\"alpha\")",
      statuses: ["complete", "truncated", "superseded"] as SummaryStatus[],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(res.hits.map((h) => h.id).sort(), ["ok", "trunc"]);

    // status filter narrows to truncated only.
    res = storage.searchSummaries({ match: "{content} : (\"alpha\")", statuses: ["truncated"], limit: 10, order: "newest" });
    assert.deepEqual(res.hits.map((h) => h.id), ["trunc"]);
  });
});

test("reconcileSummariesFts repairs a summary inserted while the trigger was absent", async () => {
  await withStorage(async (storage) => {
    // Simulate a trigger gap by dropping the insert trigger, then inserting.
    await storage.write((db) => db.exec(`drop trigger summaries_ai`));
    await insertSummary(storage, { id: "missed", content: "orphaned summary content", earliest: 1000, latest: 2000 });

    let res = storage.searchSummaries({ match: "{content} : (\"orphaned\")", limit: 10, order: "newest" });
    assert.equal(res.total, 0, "row should be missing from FTS before reconcile");

    // The 'rebuild' convergence re-derives the whole index from the content table.
    await storage.reconcileSummariesFts();
    res = storage.searchSummaries({ match: "{content} : (\"orphaned\")", limit: 10, order: "newest" });
    assert.equal(res.total, 1);
    assert.equal(res.hits[0]?.id, "missed");

    // Idempotent: a second sweep leaves the index consistent.
    await storage.reconcileSummariesFts();
    res = storage.searchSummaries({ match: "{content} : (\"orphaned\")", limit: 10, order: "newest" });
    assert.equal(res.total, 1);
  });
});

test("level / min_level / time / room filters apply to summary search", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "l1a", content: "topic apple", level: 1, earliest: 1000, latest: 2000 });
    await insertSummary(storage, { id: "l1b", content: "topic apple", level: 1, earliest: 5000, latest: 6000 });
    await insertSummary(storage, { id: "l2", content: "topic apple", level: 2, earliest: 1000, latest: 6000, parentIds: ["l1a", "l1b"] });
    await insertSummary(storage, { id: "other", content: "topic apple", timelineKey: TK2, level: 1, earliest: 1000, latest: 2000 });

    // level filter
    let res = storage.searchSummaries({ match: "{content} : (\"apple\")", levels: [2], limit: 10, order: "newest" });
    assert.deepEqual(res.hits.map((h) => h.id), ["l2"]);

    // min_level
    res = storage.searchSummaries({ match: "{content} : (\"apple\")", minLevel: 2, limit: 10, order: "newest" });
    assert.deepEqual(res.hits.map((h) => h.id), ["l2"]);

    // room scope
    res = storage.searchSummaries({ match: "{content} : (\"apple\")", timelineKeys: [TK2], limit: 10, order: "newest" });
    assert.deepEqual(res.hits.map((h) => h.id), ["other"]);

    // time overlap: window [5500, 5600] only overlaps l1b (and l2 spans it) within TK
    res = storage.searchSummaries({
      match: "{content} : (\"apple\")",
      timelineKeys: [TK],
      afterTs: 5500,
      beforeTs: 5600,
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(res.hits.map((h) => h.id).sort(), ["l1b", "l2"]);
  });
});

test("relevance order ranks the better bm25 match first", async () => {
  await withStorage(async (storage) => {
    // Same matching term; the shorter document scores better under bm25.
    await insertSummary(storage, { id: "short", content: "needle", earliest: 1000, latest: 2000 });
    await insertSummary(storage, { id: "long", content: "needle haystack haystack haystack haystack haystack", earliest: 3000, latest: 4000 });
    const res = storage.searchSummaries({ match: "{content} : (\"needle\")", limit: 10, order: "relevance" });
    assert.equal(res.total, 2);
    assert.deepEqual(res.hits.map((h) => h.id), ["short", "long"]);
    // bm25 cost is populated only under relevance (lower = better → first).
    assert.ok(res.hits[0]!.bm25 <= res.hits[1]!.bm25);
  });
});

test("keyset pagination pages summaries by (latest_timestamp, rowid) cursor", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "s1", content: "topic zebra", earliest: 1000, latest: 2000 });
    await insertSummary(storage, { id: "s2", content: "topic zebra", earliest: 3000, latest: 4000 });
    await insertSummary(storage, { id: "s3", content: "topic zebra", earliest: 5000, latest: 6000 });

    const first = storage.searchSummaries({ match: "{content} : (\"zebra\")", limit: 2, order: "newest" });
    assert.equal(first.total, 3);
    assert.deepEqual(first.hits.map((h) => h.id), ["s3", "s2"]); // newest-first
    const last = first.hits[first.hits.length - 1]!;
    const second = storage.searchSummaries({
      match: "{content} : (\"zebra\")",
      limit: 2,
      order: "newest",
      cursor: { timestamp: last.latestTimestamp, rowid: last.rowid },
    });
    assert.deepEqual(second.hits.map((h) => h.id), ["s1"]);
  });
});

test("metadata-only summary search (no query) filters by level and time without FTS", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "a", content: "anything", level: 1, earliest: 1000, latest: 2000 });
    await insertSummary(storage, { id: "b", content: "anything", level: 2, earliest: 3000, latest: 4000, parentIds: ["a"] });
    // No match → metadata-only scan; level filter still applies, ordered oldest.
    const res = storage.searchSummaries({ levels: [2], limit: 10, order: "oldest" });
    assert.deepEqual(res.hits.map((h) => h.id), ["b"]);
    assert.equal(res.hits[0]!.bm25, 0); // no FTS → bm25 defaults to 0
  });
});

test("search_messages(corpus:summaries) returns summary hits and rejects message-only filters", async () => {
  await withStorage(async (storage) => {
    await insertSummary(storage, { id: "sum_abc", content: "release planning discussion", earliest: 1000, latest: 2000 });
    const indexer = new ChatSearchIndexer({ storage });
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: TK, now: () => 10_000 });

    // Happy path: a summary hit, citing its id, in the visible text.
    const ok = await tool.execute("c1", { corpus: "summaries", query: "release", rooms: "all" });
    const okText = (ok.content[0] as { text: string }).text;
    assert.match(okText, /id: sum_abc/);
    assert.match(okText, /expand_summary/);
    const okDetails = ok.details as { corpus: string; hits: Array<{ id: string }> };
    assert.equal(okDetails.corpus, "summaries");
    assert.equal(okDetails.hits[0]?.id, "sum_abc");

    // Rejection: a message-only filter under corpus:summaries fails fast, naming the field.
    const bad = await tool.execute("c2", { corpus: "summaries", query: "release", from: ["@u:test"] });
    const badText = (bad.content[0] as { text: string }).text;
    assert.match(badText, /do not apply to corpus:"summaries"/);
    assert.match(badText, /from/);
    const badDetails = bad.details as { error: string; rejected: string[] };
    assert.equal(badDetails.error, "inapplicable_filters");
    assert.deepEqual(badDetails.rejected, ["from"]);
  });
});
