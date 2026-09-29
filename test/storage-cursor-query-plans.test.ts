import assert from "node:assert/strict";
import test from "node:test";
import type Database from "better-sqlite3";
import { Storage, type Summary } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// The cursor queries behind summary coverage selection and context building run
// on the agent's main thread once per selected summary per reconcile. Their
// (timestamp, received_at, id) cursor predicate is an OR chain SQLite cannot
// derive a seek range from, so without an explicit plain-timestamp bound each
// call scans the timeline's whole index prefix — seconds of event-loop stall
// per pass on a large room. These tests capture the SQL each method actually
// executes and assert on its real query plan.

const TK = "matrix:miku:room:!room";

type Captured = { sql: string; args: unknown[] };

function capture(storage: Storage, run: () => void): Captured[] {
  const db = storage.read((d) => d) as Database.Database & { prepare: Database.Database["prepare"] };
  const original = db.prepare;
  const seen: Captured[] = [];
  db.prepare = ((sql: string) => {
    const stmt = original.call(db, sql);
    return new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "get" || key === "all") {
          return (...args: unknown[]) => {
            seen.push({ sql, args });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as Database.Database["prepare"];
  try {
    run();
  } finally {
    db.prepare = original;
  }
  return seen;
}

function planOf(storage: Storage, c: Captured): string {
  return (
    storage.read((db) => db.prepare(`explain query plan ${c.sql}`).all(...c.args)) as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(" | ");
}

/** Every captured statement touching `table` must seek a timestamp range, never scan the prefix. */
function assertRangeSeeks(storage: Storage, seen: Captured[], table: string, column: string): void {
  const relevant = seen.filter((c) => new RegExp(`from ${table}\\b`).test(c.sql) && c.sql.includes(`${column} >`));
  assert.ok(relevant.length > 0, `expected a ${table} cursor query to be executed`);
  for (const c of relevant) {
    const plan = planOf(storage, c);
    assert.match(plan, new RegExp(`${column}>\\?`), `cursor query must seek a ${column} range; got: ${plan}`);
  }
}

function event(id: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice", isSelf: false },
    body: id,
    timestamp,
    receivedAt: timestamp,
  };
}

async function withEvents(run: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    for (let i = 0; i < 20; i++) await timeline.append(event(`e${i}`, 1_000 + i * 10));
    await run(storage);
  } finally {
    storage.close();
  }
}

function summaryRow(id: string, level: number, earliest: number, latest: number, latestEventId: string): Summary {
  return {
    id,
    timelineKey: TK,
    level,
    earliestTimestamp: earliest,
    latestTimestamp: latest,
    latestEventId,
  } as Summary;
}

test("hasEventsBetweenSummaries seeks a timestamp range", async () => {
  await withEvents(async (storage) => {
    const prev = summaryRow("s1", 1, 1_000, 1_040, "e4");
    const next = { ...summaryRow("s2", 1, 1_050, 1_090, "e9"), earliestEventId: "e5" } as Summary;
    let contiguous = false;
    const seen = capture(storage, () => {
      contiguous = !storage.hasEventsBetweenSummaries(TK, prev, next);
    });
    assert.equal(contiguous, true);
    assertRangeSeeks(storage, seen, "timeline_events", "timestamp");
  });
});

test("getTimelineEventsAfter / ForContext / Between seek a timestamp range", async () => {
  await withEvents(async (storage) => {
    const start = storage.getEventCursor(TK, "e5")!;
    const end = storage.getEventCursor(TK, "e12")!;
    let after: CanonicalChatEvent[] = [];
    let forContext: CanonicalChatEvent[] = [];
    let between: CanonicalChatEvent[] = [];
    const seen = capture(storage, () => {
      after = storage.getTimelineEventsAfter(TK, "e15", 100);
      forContext = storage.getTimelineEventsForContext(TK, "e15", 100);
      between = storage.getTimelineEventsBetween(TK, start, end);
    });
    assert.deepEqual(after.map((e) => e.id), ["e16", "e17", "e18", "e19"]);
    assert.deepEqual(forContext.map((e) => e.id), ["e15", "e16", "e17", "e18", "e19"]);
    assert.equal(between.length, 8);
    assertRangeSeeks(storage, seen, "timeline_events", "timestamp");
  });
});

test("getSummaryEarliestEventCursor walks lineage via primary keys, no automatic index", async () => {
  await withEvents(async (storage) => {
    await storage.write((db) => {
      const ins = db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
           latest_event_id, event_count, token_count, model_id, status, backfill_job_id, generated_at, created_at)
         values (?, ?, ?, 'body', ?, ?, ?, 1, 100, 'model', 'complete', null, 0, 0)`,
      );
      ins.run("l1a", TK, 1, 1_000, 1_040, "e4");
      ins.run("l1b", TK, 1, 1_050, 1_090, "e9");
      ins.run("l2", TK, 2, 1_000, 1_090, "e9");
      const se = db.prepare(`insert into summary_events (summary_id, event_id, ordinal) values (?, ?, ?)`);
      for (let i = 0; i < 5; i++) se.run("l1a", `e${i}`, i);
      for (let i = 5; i < 10; i++) se.run("l1b", `e${i}`, i - 5);
      const sp = db.prepare(`insert into summary_parents (summary_id, parent_id, ordinal) values (?, ?, ?)`);
      sp.run("l2", "l1a", 0);
      sp.run("l2", "l1b", 1);
    });
    let cursor: ReturnType<Storage["getSummaryEarliestEventCursor"]>;
    const seen = capture(storage, () => {
      cursor = storage.getSummaryEarliestEventCursor(TK, "l2");
    });
    assert.equal(cursor!?.id, "e0");
    const lineage = seen.filter((c) => c.sql.includes("with recursive chain"));
    assert.equal(lineage.length, 1);
    const plan = planOf(storage, lineage[0]!);
    assert.doesNotMatch(plan, /AUTOMATIC/, `lineage walk must not build an automatic index; got: ${plan}`);
    assert.match(plan, /SEARCH se USING (COVERING )?INDEX sqlite_autoindex_summary_events_1 \(summary_id=\?\)/);
  });
});

test("getSummariesBetween with a level filter seeks an earliest_timestamp range", async () => {
  await withEvents(async (storage) => {
    await storage.write((db) => {
      const ins = db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
           latest_event_id, event_count, token_count, model_id, status, backfill_job_id, generated_at, created_at)
         values (?, ?, 1, 'body', ?, ?, ?, 1, 100, 'model', 'complete', null, 0, 0)`,
      );
      for (let i = 0; i < 5; i++) ins.run(`s${i}`, TK, 1_000 + i * 20, 1_010 + i * 20, `e${i * 2}`);
    });
    let rows: Summary[] = [];
    const seen = capture(storage, () => {
      rows = storage.getSummariesBetween(TK, "s1", "s3", 1);
    });
    assert.deepEqual(rows.map((s) => s.id), ["s1", "s2", "s3"]);
    assertRangeSeeks(storage, seen, "summaries", "earliest_timestamp");
  });
});

test("getChatProjectionInputs looks captions up by event, not by caption status", async () => {
  await withEvents(async (storage) => {
    let rows: unknown[] = [];
    const seen = capture(storage, () => {
      rows = storage.getChatProjectionInputs({ afterRowid: 0, limit: 50 });
    });
    assert.equal(rows.length, 20);
    const projection = seen.filter((c) => c.sql.includes("group_concat(ma.caption"));
    assert.equal(projection.length, 1);
    const plan = planOf(storage, projection[0]!);
    // Seeking by caption_status walks every captioned asset in the DB per event.
    assert.doesNotMatch(plan, /\(caption_status=\?/, `caption subquery must seek by event_id; got: ${plan}`);
  });
});
