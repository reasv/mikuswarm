/**
 * Participant tags from provenance, the presence lane, display-name history,
 * and the `recall_memory` user scope (ARCHITECTURE.md §9d "Participant tags").
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { MemoryIndexer, resolveRetrievalConfig } from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import { ParticipantTagger, parseDiaryHeaderLine } from "../src/retrieval/participants.js";
import { resolveUserScope } from "../src/retrieval/user-scope.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TZ = "UTC";
const TK = "matrix:acc:!room";

function ev(id: string, sender: string, name: string, ts: number, extra: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: sender, displayName: name },
    body: `message ${id}`,
    timestamp: ts,
    receivedAt: ts,
    ...extra,
  };
}

async function withFixture(run: (f: { storage: Storage; store: MemoryRetrievalStore; indexer: MemoryIndexer; root: string; start: number }) => Promise<void>) {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-participants-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  const timeline = new TimelineStore(storage);
  const start = parseZonedWallClock("2026-05-01 10:00", TZ)!;
  // Source range: alice (2 msgs, two display names over time), bob (1), the bot (1), another bot (1).
  await timeline.append(ev("e1", "@alice:x", "Alice Old", start));
  await timeline.append(ev("e2", "@bob:x", "Bob", start + 60_000));
  await timeline.append(ev("e3", "@alice:x", "Alice", start + 120_000));
  await timeline.append(ev("e4", "@miku:x", "Miku", start + 180_000, { role: "assistant", sender: { id: "@miku:x", displayName: "Miku", isSelf: true } }));
  await timeline.append(ev("e5", "@bot:x", "SomeBot", start + 240_000, { sender: { id: "@bot:x", displayName: "SomeBot", isBot: true } }));
  const end = start + 240_000;
  await storage.write((db) => {
    db.prepare(
      `insert into summaries (id, timeline_key, level, content, earliest_timestamp, latest_timestamp, latest_event_id,
         event_count, token_count, status, generated_at, created_at, diary_status)
       values ('sum1', ?, 1, 'c', ?, ?, 'e5', 5, 10, 'complete', 1, 1, 'done')`,
    ).run(TK, start + 5_000, end + 7_000);
    const ins = db.prepare(`insert into summary_events (summary_id, event_id, ordinal) values ('sum1', ?, ?)`);
    ["e1", "e2", "e3", "e4", "e5"].forEach((id, i) => ins.run(id, i));
  });
  const header = buildDiaryHeader({ earliestTimestamp: start + 5_000, latestTimestamp: end + 7_000, room: "general", timezone: TZ });
  await writeFile(
    path.join(root, "memory", "2026-05-01.md"),
    `# 2026-05-01\n\n${header}\nWe planned the garden party with everyone.\n\n`,
  );
  await writeFile(path.join(root, "memory", "notes.md"), "Legacy note without a header about Alice.\n");
  const config = resolveRetrievalConfig({ enabled: true });
  const indexer = new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() });
  await indexer.reconcileAll();
  const store = new MemoryRetrievalStore(storage);
  try {
    await run({ storage, store, indexer, root, start });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

test("parseDiaryHeaderLine reads the range in the header's own zone", () => {
  const h = parseDiaryHeaderLine("## 2026-05-01 10:00 → 2026-05-01 11:30 · Asia/Tokyo · Project (Space)\nbody");
  assert.ok(h);
  assert.equal(h!.room, "Project (Space)");
  assert.equal(h!.endTs - h!.startTs, 90 * 60_000);
  assert.equal(parseDiaryHeaderLine("no header"), null);
});

test("tagger: header block tagged with the human senders of its range; legacy block none; backfill is the same pass", async () => {
  await withFixture(async ({ store }) => {
    const tagger = new ParticipantTagger({ store });
    const result = await tagger.run();
    assert.deepEqual(result, { tagged: 1, none: 1, ambiguous: 0 });
    assert.deepEqual(store.provenanceCounts(), { tagged: 1, none: 1, ambiguous: 0 });
    const rows = store.chunksWithParticipants(null, [{ provider: "matrix", senderId: "@alice:x" }], 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.messageCount, 2);
    const tags = store.participantsOf(null, [rows[0]!.contentHash]).map((t) => t.senderId).sort();
    assert.deepEqual(tags, ["@alice:x", "@bob:x"], "bots and the agent itself are not participants");
    // Nothing left to tag: a second run is a no-op.
    assert.deepEqual(await tagger.run(), { tagged: 0, none: 0, ambiguous: 0 });
  });
});

test("tagger: two ranges with the same minutes are disambiguated by room label, else ambiguous", async () => {
  await withFixture(async ({ storage, store, start }) => {
    await storage.write((db) =>
      db
        .prepare(
          `insert into summaries (id, timeline_key, level, content, earliest_timestamp, latest_timestamp, latest_event_id,
             event_count, token_count, status, generated_at, created_at, diary_status)
           values ('sum2', 'matrix:acc:!other', 1, 'c', ?, ?, 'x', 1, 1, 'complete', 1, 1, 'done')`,
        )
        .run(start + 5_000, start + 247_000),
    );
    const ambiguous = await new ParticipantTagger({ store }).run();
    assert.equal(ambiguous.ambiguous, 1);
    await storage.write((db) => db.exec("delete from memory_block_provenance"));
    const labelled = await new ParticipantTagger({
      store,
      roomLabelFor: async (tk) => (tk === TK ? "general" : "elsewhere"),
    }).run();
    assert.equal(labelled.tagged, 1);
  });
});

test("display-name history: newest first, the current name excluded", async () => {
  await withFixture(async ({ store }) => {
    assert.deepEqual(store.senderDisplayNameHistory("matrix", "@alice:x", 4, "Alice"), ["Alice Old"]);
    assert.deepEqual(store.senderDisplayNameHistory("matrix", "@alice:x", 4), ["Alice", "Alice Old"]);
  });
});

test("display-name history: rows older than the triggers are back-filled in small background batches", async () => {
  await withFixture(async ({ storage, store }) => {
    // As on an upgraded database: the history table starts empty, the rows already exist.
    await storage.write((db) => db.exec(`delete from memory_sender_names; delete from index_meta where key = 'memory_sender_names_backfill'`));
    assert.deepEqual(store.senderDisplayNameHistory("matrix", "@alice:x", 4), []);
    let batches = 0;
    while (!(await store.backfillSenderNames(2))) batches++;
    assert.ok(batches >= 2, "several bounded batches");
    assert.deepEqual(store.senderDisplayNameHistory("matrix", "@alice:x", 4), ["Alice", "Alice Old"]);
    assert.equal(await store.backfillSenderNames(2), true, "done stays done");
    assert.equal(
      storage.read((db) => (db.prepare(`select count(*) as n from sqlite_master where name = 'idx_timeline_events_sender'`).get() as { n: number }).n),
      0,
      "no multi-second index build on timeline_events",
    );
  });
});

test("user scope: by sender id or a (former) display name, plus entries naming them", async () => {
  await withFixture(async ({ storage, store }) => {
    await new ParticipantTagger({ store }).run();
    const byId = resolveUserScope(storage, store, "@alice:x", null);
    assert.ok(byId.rowids.length >= 2, "the tagged block and the legacy note naming Alice");
    const byOldName = resolveUserScope(storage, store, "Alice Old", null);
    assert.deepEqual(byOldName.senderIds, ["@alice:x"]);
    const nobody = resolveUserScope(storage, store, "@nobody:x", null);
    assert.equal(nobody.rowids.length, 0);
  });
});
