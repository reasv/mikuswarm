import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { AssistantEchoResolver, TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// Assistant-echo duplicate prevention (ARCHITECTURE.md "Assistant echo
// enrichment"). A bot-sent message has two persistence paths racing: the
// send_message tool's own append (canonical id `assistant:{session}:{eventId}:{chunk}`)
// and the Matrix sync echo / re-fetched history (canonical id
// `matrix:{account}:{eventId}`). Exactly one row per Matrix event must survive,
// whichever side wins.

const TK = "matrix:miku:room:!room";

function assistantSend(over: Partial<CanonicalChatEvent> & { externalId?: string } = {}): CanonicalChatEvent {
  return {
    id: `assistant:sess-1:${over.externalId ?? "$evt"}:0`,
    externalId: over.externalId ?? "$evt",
    timelineKey: TK,
    provider: "matrix",
    agentSessionId: "sess-1",
    role: "assistant",
    sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
    body: "hello from the tool",
    timestamp: 1_000,
    receivedAt: 1_500,
    ...over,
  };
}

function echoEvent(over: Partial<CanonicalChatEvent> & { externalId?: string } = {}): CanonicalChatEvent {
  const externalId = over.externalId ?? "$evt";
  return {
    id: `matrix:miku:${externalId}`,
    externalId,
    timelineKey: TK,
    provider: "matrix",
    role: "assistant",
    sender: { id: "@miku:example.org", displayName: "Miku", isSelf: true },
    body: "hello from the tool",
    timestamp: 2_000,
    receivedAt: 2_100,
    ...over,
  };
}

function rowCount(storage: Storage, externalId: string): number {
  return storage.read((db) =>
    (db.prepare(`select count(*) as n from timeline_events where external_id = ?`).get(externalId) as { n: number }).n,
  );
}

async function withStorage(run: (storage: Storage, timeline: TimelineStore) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(storage, new TimelineStore(storage));
  } finally {
    storage.close();
  }
}

// ── appendIfMissing external-id dedup (gap backfetch / initial backfill) ──

test("appendIfMissing dedups a re-fetched self message against its assistant row by external id", async () => {
  await withStorage(async (storage, timeline) => {
    await timeline.append(assistantSend({ externalId: "$sent" }));

    // Gap backfetch re-keys the same Matrix event as matrix:{account}:{eventId} —
    // the canonical ids differ, only (provider, external_id, timeline_key) match.
    const refetched = echoEvent({ externalId: "$sent" });
    const result = await timeline.appendIfMissing(refetched, "skipped");

    assert.equal(result.duplicate, true, "the re-fetched copy must dedup");
    assert.equal(result.event.id, "assistant:sess-1:$sent:0", "returns the stored assistant row");
    assert.equal(rowCount(storage, "$sent"), 1);
  });
});

test("appendIfMissing does not dedup across timeline keys (multi-account safety)", async () => {
  await withStorage(async (storage, timeline) => {
    await timeline.append(assistantSend({ externalId: "$shared" }));

    // Another account's copy of the same Matrix event lives on its own timeline
    // key and must still be stored.
    const otherAccount = echoEvent({
      externalId: "$shared",
      id: "matrix:other:$shared",
      timelineKey: "matrix:other:room:!room",
      role: "user",
      sender: { id: "@miku:example.org", isSelf: false },
    });
    const result = await timeline.appendIfMissing(otherAccount, "skipped");

    assert.equal(result.duplicate, false);
    assert.equal(rowCount(storage, "$shared"), 2);
  });
});

// ── ingestAssistantSend (the send side of the echo race) ──

test("ingestAssistantSend merges into an echo-created row instead of appending a duplicate", async () => {
  await withStorage(async (storage, timeline) => {
    // Echo wins the race: ingestOwnEcho finds no assistant row and appends the
    // matrix:{account}:{eventId} row (with the echo's attachment metadata).
    const echo = echoEvent({
      externalId: "$race",
      attachments: [{ id: "$race:0", filename: "pic.png", mimeType: "image/png", mediaType: "image" }],
    });
    const echoResult = await new AssistantEchoResolver(timeline).ingestOwnEcho(echo);
    assert.equal(echoResult, "appended");

    // send_message's post-send append arrives second.
    const sendResult = await timeline.ingestAssistantSend(assistantSend({ externalId: "$race" }));
    assert.equal(sendResult, "merged");

    const events = timeline.query({ timelineKey: TK, limit: 10 });
    assert.equal(events.length, 1, "exactly one row per Matrix event");
    const merged = events[0]!;
    assert.equal(merged.id, "matrix:miku:$race", "the stored row keeps its canonical id");
    assert.equal(merged.agentSessionId, "sess-1", "the send's session attribution is adopted");
    assert.equal(merged.body, "hello from the tool");
    assert.equal(merged.timestamp, 2_000, "the echo's server timestamp wins (mirrors ingestAssistantEcho)");
    assert.equal(merged.receivedAt, 1_500, "receivedAt is the min of both sides");
    assert.equal(merged.attachments?.length, 1, "the echo's attachments (mxc refs) survive the merge");
  });
});

test("ingestAssistantSend appends normally when the send wins the race, and the echo then enriches", async () => {
  await withStorage(async (storage, timeline) => {
    const sendResult = await timeline.ingestAssistantSend(assistantSend({ externalId: "$plain" }));
    assert.equal(sendResult, "appended");

    const echo = echoEvent({
      externalId: "$plain",
      attachments: [{ id: "$plain:0", filename: "pic.png", mimeType: "image/png", mediaType: "image" }],
    });
    const echoResult = await new AssistantEchoResolver(timeline).ingestOwnEcho(echo);
    assert.equal(echoResult, "enriched");

    const events = timeline.query({ timelineKey: TK, limit: 10 });
    assert.equal(events.length, 1, "exactly one row per Matrix event");
    assert.equal(events[0]!.id, "assistant:sess-1:$plain:0");
    assert.equal(
      events[0]!.attachments?.length,
      1,
      "the echo's attachments are adopted onto the assistant row (enrichment downloads from their mxc refs)",
    );
  });
});

test("ingestAssistantSend re-homes a DM self-echo row to the send's timeline key", async () => {
  await withStorage(async (storage, timeline) => {
    // A DM self-echo can derive a mismatched timeline key (see
    // findAssistantEchoCandidate); the send's target key is authoritative.
    const echo = echoEvent({ externalId: "$dm", timelineKey: "matrix:miku:dm:@miku:example.org" });
    await new AssistantEchoResolver(timeline).ingestOwnEcho(echo);

    const send = assistantSend({ externalId: "$dm", timelineKey: "matrix:miku:dm:@alice:example.org" });
    send.id = "assistant:sess-1:$dm:0";
    const result = await timeline.ingestAssistantSend(send);

    assert.equal(result, "merged");
    assert.equal(rowCount(storage, "$dm"), 1);
    const homed = timeline.query({ timelineKey: "matrix:miku:dm:@alice:example.org", limit: 10 });
    assert.equal(homed.length, 1, "the merged row lives on the send's timeline key");
  });
});

// ── v1 → v2 cleanup migration ──

test("v1→v2 migration removes existing matrix: duplicates and remaps references to the assistant row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-dedup-migration-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const timeline = new TimelineStore(storage);

      // The historical duplicate pair: assistant row + matrix echo/backfetch dup,
      // same (provider, external_id, timeline_key), dup has a later received_at.
      const a = assistantSend({ externalId: "$dup" });
      const m: CanonicalChatEvent = { ...echoEvent({ externalId: "$dup" }), timestamp: a.timestamp, receivedAt: 9_000 };
      await timeline.append(a);
      await timeline.append(m);
      // A non-duplicated bystander that must survive untouched.
      await timeline.append(echoEvent({ externalId: "$solo", id: "matrix:miku:$solo" }));

      await storage.write((db) => {
        // A summary that rendered BOTH rows and ends at the dup.
        db.prepare(
          `insert into summaries (
            id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
            latest_event_id, event_count, token_count, model_id, status,
            backfill_job_id, generated_at, created_at
          ) values ('sum1', ?, 1, 'x', 0, 9000, 'matrix:miku:$dup', 2, 10, null, 'complete', null, 0, 0)`,
        ).run(TK);
        const lineage = db.prepare(`insert into summary_events (summary_id, event_id, ordinal) values (?, ?, ?)`);
        lineage.run("sum1", "assistant:sess-1:$dup:0", 0);
        lineage.run("sum1", "matrix:miku:$dup", 1);
        // A second summary that referenced ONLY the dup — must be remapped, not dropped.
        db.prepare(
          `insert into summaries (
            id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
            latest_event_id, event_count, token_count, model_id, status,
            backfill_job_id, generated_at, created_at
          ) values ('sum2', ?, 1, 'y', 0, 9000, 'matrix:miku:$solo', 1, 10, null, 'complete', null, 0, 0)`,
        ).run(TK);
        lineage.run("sum2", "matrix:miku:$dup", 0);
        // A failed job whose declared range ends at the dup (the sumjob_X2vHfBBTC_ shape).
        db.prepare(
          `insert into summarization_jobs (id, timeline_key, level, status, input_start_id, input_end_id, target_token_count, created_at, updated_at)
           values ('job1', ?, 1, 'failed', 'assistant:sess-1:$dup:0', 'matrix:miku:$dup', 100, 0, 0)`,
        ).run(TK);
        // Compaction cursors pointing at the dup.
        db.prepare(
          `insert into timeline_compaction_state (timeline_key, compact_start_event_id, rich_start_event_id, state_json, timeline_state, context_floor_event_id, updated_at)
           values (?, 'matrix:miku:$dup', 'matrix:miku:$dup', '{}', 'active', 'matrix:miku:$dup', 0)`,
        ).run(TK);
        // A chat-search projection of the dup (must vanish via the FK cascade).
        db.prepare(
          `insert into chat_index (event_id, timeline_key, sender_id, role, timestamp, body, content_sig, indexed_at)
           values ('matrix:miku:$dup', ?, '@miku:example.org', 'assistant', 1000, 'hello', 'sig', 0)`,
        ).run(TK);
        // Re-stamp as v1 so the next open applies the v1→v2 step.
        db.pragma("user_version = 1");
      });
      storage.close();
    }

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 2, "migration stamps v2");

      const ids = storage.read((db) =>
        (db.prepare(`select id from timeline_events order by id`).all() as Array<{ id: string }>).map((r) => r.id),
      );
      assert.deepEqual(ids, ["assistant:sess-1:$dup:0", "matrix:miku:$solo"], "the matrix dup is gone, everything else survives");

      const lineage = storage.read((db) =>
        db.prepare(`select summary_id, event_id from summary_events order by summary_id, ordinal`).all() as Array<{
          summary_id: string;
          event_id: string;
        }>,
      );
      assert.deepEqual(lineage, [
        { summary_id: "sum1", event_id: "assistant:sess-1:$dup:0" }, // dup's row dropped (assistant already listed)
        { summary_id: "sum2", event_id: "assistant:sess-1:$dup:0" }, // dup-only row remapped
      ]);

      const summaryCursor = storage.read((db) =>
        (db.prepare(`select latest_event_id from summaries where id = 'sum1'`).get() as { latest_event_id: string }).latest_event_id,
      );
      assert.equal(summaryCursor, "assistant:sess-1:$dup:0");

      const job = storage.read((db) =>
        db.prepare(`select input_start_id, input_end_id from summarization_jobs where id = 'job1'`).get() as {
          input_start_id: string;
          input_end_id: string;
        },
      );
      assert.equal(job.input_start_id, "assistant:sess-1:$dup:0");
      assert.equal(job.input_end_id, "assistant:sess-1:$dup:0");

      const compaction = storage.read((db) =>
        db.prepare(
          `select compact_start_event_id, rich_start_event_id, context_floor_event_id from timeline_compaction_state where timeline_key = ?`,
        ).get(TK) as { compact_start_event_id: string; rich_start_event_id: string; context_floor_event_id: string },
      );
      assert.equal(compaction.compact_start_event_id, "assistant:sess-1:$dup:0");
      assert.equal(compaction.rich_start_event_id, "assistant:sess-1:$dup:0");
      assert.equal(compaction.context_floor_event_id, "assistant:sess-1:$dup:0");

      const chatIndexCount = storage.read((db) =>
        (db.prepare(`select count(*) as n from chat_index where event_id = 'matrix:miku:$dup'`).get() as { n: number }).n,
      );
      assert.equal(chatIndexCount, 0, "the dup's chat_index projection is cascade-deleted");
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v1→v2 migration is a no-op on a database with no duplicates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-dedup-migration-noop-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const timeline = new TimelineStore(storage);
      await timeline.append(assistantSend({ externalId: "$only" }));
      await timeline.append(echoEvent({ externalId: "$user", id: "matrix:miku:$user", role: "user", sender: { id: "@alice:example.org", isSelf: false } }));
      await storage.write((db) => db.pragma("user_version = 1"));
      storage.close();
    }
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const n = storage.read((db) => (db.prepare(`select count(*) as n from timeline_events`).get() as { n: number }).n);
      assert.equal(n, 2, "no rows removed");
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
