/**
 * memory_retrievals growth (ARCHITECTURE.md §9d "Observability"): stored
 * reports are bounded, and rows past the retention are pruned in the
 * background. Synthetic rows only.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { capReportJson, MemoryRetrievalStore, PRUNE_BATCH, REPORT_MAX_ITEMS } from "../src/storage/memory-retrieval-store.js";

test("report cap: kept, hidden and judged items stay, the best-scored rest fill the cap, the others are counted", () => {
  const items = Array.from({ length: 4000 }, (_, i) => ({
    contentHash: `h${i}`,
    citation: `memory/x.md#L${i}`,
    stage: i === 3999 ? "kept" : i === 3998 ? "hidden" : "cut_late",
    judged: i === 3997,
    hybrid: i / 4000,
    late: i % 7 === 0 ? 0.99 : 0.1,
  }));
  const json = JSON.stringify({ source: "model", items });
  const capped = JSON.parse(capReportJson(json)!) as { items: typeof items; itemsOmitted: number; source: string };
  assert.equal(capped.items.length, REPORT_MAX_ITEMS);
  assert.equal(capped.itemsOmitted, 4000 - REPORT_MAX_ITEMS);
  assert.equal(capped.source, "model");
  const hashes = new Set(capped.items.map((i) => i.contentHash));
  for (const h of ["h3999", "h3998", "h3997"]) assert.ok(hashes.has(h), `${h} kept`);
  assert.ok(capped.items.filter((i) => i.stage === "cut_late").every((i) => i.late === 0.99), "the best late scores fill the rest");
  const small = JSON.stringify({ items: items.slice(0, 10) });
  assert.equal(capReportJson(small), small, "a small report is stored as is");
});

test("retention: rows older than the configured days are pruned (in the background, at most hourly)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-retr-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const store = new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 30 });
    const day = 86_400_000;
    const now = 400 * day;
    const row = (id: string, ts: number) => ({
      id, agentSessionId: "s", agent: null, timelineKey: null, ts, source: "none", decisionGroup: null,
      candidates: 0, judged: 0, kept: 0, hidden: 0, tokens: 0, ms: 0, reportJson: null,
    });
    // Old rows, written while pruning is not yet due.
    const old = new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 0 });
    for (let i = 0; i < 50; i++) await old.insertRetrieval(row(`old${i}`, now - (40 + i) * day));
    await store.insertRetrieval(row("recent", now - 2 * day));
    await store.insertRetrieval(row("new", now));
    await storage.waitForIdle();
    await new Promise((r) => setTimeout(r, 50));
    const ids = storage.read((db) => (db.prepare(`select id from memory_retrievals order by id`).all() as Array<{ id: string }>).map((r) => r.id));
    assert.deepEqual(ids, ["new", "recent"]);
    assert.equal(await new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 0 }).pruneRetrievals(now * 2), 0, "0 keeps forever");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retention: the prune deletes in small batches and yields to the event loop between them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-retr-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    assert.ok(PRUNE_BATCH <= 500, "a batch is a few ms of the writer");
    const day = 86_400_000;
    const now = 400 * day;
    const writer = new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 0 });
    for (let i = 0; i < 45; i++) {
      await writer.insertRetrieval({
        id: `old${i}`, agentSessionId: "s", agent: null, timelineKey: null, ts: now - 100 * day, source: "none", decisionGroup: null,
        candidates: 0, judged: 0, kept: 0, hidden: 0, tokens: 0, ms: 0, reportJson: null,
      });
    }
    await storage.waitForIdle();
    let ticks = 0;
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const deleted = await new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 30 }).pruneRetrievals(now, 10);
    ticking = false;
    assert.equal(deleted, 45);
    assert.ok(ticks >= 4, `the event loop ran between the 5 batches (${ticks} ticks)`);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stats count only confirmed builds: a row recorded as aborted is left out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-retr-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const store = new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 0 });
    const row = (id: string, kept: number, report: Record<string, unknown>) => ({
      id, agentSessionId: id, agent: null, timelineKey: null, ts: 1000, source: "model", decisionGroup: null,
      candidates: 3, judged: 3, kept, hidden: 0, tokens: kept * 10, ms: 1, reportJson: JSON.stringify(report),
    });
    await store.insertRetrieval(row("shown", 2, { source: "model", items: [] }));
    await store.insertRetrieval(row("cancelled", 0, { source: "model", aborted: true, items: [] }));
    await storage.waitForIdle();
    assert.deepEqual(store.sourceCounts(0), { model: 1 });
    assert.equal(store.followUpStats(0).sessionsWithBlock, 1);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the latest shown build of a timeline (the room preview's pointer) skips aborted rows and other timelines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-retr-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const store = new MemoryRetrievalStore(storage, { retrievalsRetentionDays: 0 });
    const row = (id: string, timelineKey: string, ts: number, report: Record<string, unknown>) => ({
      id, agentSessionId: id, agent: null, timelineKey, ts, source: "model", decisionGroup: null,
      candidates: 3, judged: 3, kept: 2, hidden: 0, tokens: 20, ms: 1, reportJson: JSON.stringify(report),
    });
    assert.equal(store.latestRetrievalForTimeline("tk:a"), null);
    await store.insertRetrieval(row("shown", "tk:a", 1000, { items: [] }));
    await store.insertRetrieval(row("cancelled", "tk:a", 2000, { aborted: true, items: [] }));
    await store.insertRetrieval(row("other", "tk:b", 3000, { items: [] }));
    await storage.waitForIdle();
    assert.deepEqual({ ...store.latestRetrievalForTimeline("tk:a") }, { ts: 1000, source: "model", kept: 2, tokens: 20 });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
