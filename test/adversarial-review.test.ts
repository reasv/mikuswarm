/**
 * Adversarial review tests for commit a4414d4.
 * Attacks: migration data integrity, timeline range semantics, getUserLabels edge cases,
 * snapshot/transcript race safety, migration idempotency, UNION ALL dedup/LIMIT.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { Storage, LATEST_SCHEMA_VERSION } from "../src/storage/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 1: Migration copies every blob variant correctly; OR IGNORE is safe
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/migration: all blob variants migrate without OR IGNORE data loss", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-adv-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // Create v10-shaped DB
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => {
        db.exec(`
          alter table agent_sessions add column context_snapshot_json text;
          alter table agent_sessions add column transcript_json text;
        `);
        const now = Date.now();
        const stmt = db.prepare(`
          insert into agent_sessions
            (id, timeline_key, session_type, status,
             context_snapshot_json, transcript_json,
             created_at, updated_at)
          values (?, ?, 'default', 'completed', ?, ?, ?, ?)
        `);
        // Both blobs
        stmt.run("s-both", "matrix:bot:room:!r1:srv", "snap-both", "tx-both", now, now);
        // Only snapshot
        stmt.run("s-snap-only", "matrix:bot:room:!r1:srv", "snap-only", null, now, now);
        // Only transcript
        stmt.run("s-tx-only", "matrix:bot:room:!r1:srv", null, "tx-only", now, now);
        // Both null
        stmt.run("s-both-null", "matrix:bot:room:!r1:srv", null, null, now, now);
        // Huge blobs
        stmt.run("s-huge", "matrix:bot:room:!r1:srv", "x".repeat(100000), "y".repeat(100000), now, now);
        db.pragma("user_version = 10");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // Reopen → v10→v11 migration runs
    {
      const storage = await Storage.open({ databasePath: dbPath });
      try {
        const ver = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
        assert.equal(ver, LATEST_SCHEMA_VERSION, "version stamped to 13");

        const cols = storage.read((db) =>
          (db.pragma("table_info(agent_sessions)") as Array<{ name: string }>).map((r) => r.name),
        );
        assert.ok(!cols.includes("context_snapshot_json"), "context_snapshot_json dropped");
        assert.ok(!cols.includes("transcript_json"), "transcript_json dropped");

        // both-blobs
        const both = storage.getAgentSession("s-both");
        assert.equal(both?.context_snapshot_json, "snap-both", "s-both: snapshot");
        assert.equal(both?.transcript_json, "tx-both", "s-both: transcript");

        // snapshot-only
        const snapOnly = storage.getAgentSession("s-snap-only");
        assert.equal(snapOnly?.context_snapshot_json, "snap-only");
        assert.equal(snapOnly?.transcript_json, null, "s-snap-only: transcript null");

        // transcript-only
        const txOnly = storage.getAgentSession("s-tx-only");
        assert.equal(txOnly?.context_snapshot_json, null, "s-tx-only: snapshot null");
        assert.equal(txOnly?.transcript_json, "tx-only");

        // both-null: no payload row → LEFT JOIN returns null
        const bothNull = storage.getAgentSession("s-both-null");
        assert.ok(bothNull !== undefined, "s-both-null session exists");
        assert.equal(bothNull?.context_snapshot_json, null);
        assert.equal(bothNull?.transcript_json, null);
        const noPayload = storage.read((db) =>
          db.prepare("select 1 from agent_session_payloads where session_id = ?").get("s-both-null"),
        );
        assert.equal(noPayload, undefined, "s-both-null: no payload row (WHERE skipped it)");

        // huge blobs
        const huge = storage.getAgentSession("s-huge");
        assert.equal(huge?.context_snapshot_json?.length, 100000, "huge snapshot length preserved");
        assert.equal(huge?.transcript_json?.length, 100000, "huge transcript length preserved");

        // Verify payload count: 4 rows (s-both, s-snap-only, s-tx-only, s-huge); s-both-null excluded
        const n = (
          storage.read((db) =>
            db.prepare("select count(*) as n from agent_session_payloads").get(),
          ) as { n: number }
        ).n;
        assert.equal(n, 4, "exactly 4 payload rows (s-both-null excluded)");
      } finally {
        await storage.waitForIdle();
        storage.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 2: Timeline range — LIKE metacharacters in room key
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/timeline-range: LIKE metacharacters in room key (%, _)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();
    const roomKey = "matrix:bot:room:!room%1:server";
    const threadKey = `${roomKey}:thread:$event1`;
    const otherRoom = "matrix:bot:room:!room_1:server";
    const otherThread = `${otherRoom}:thread:$event2`;
    const unrelated = "matrix:bot:room:!roomABC:server:thread:$evt3";

    for (const [id, key] of [
      ["s-room", roomKey],
      ["s-thread", threadKey],
      ["s-other-room", otherRoom],
      ["s-other-thread", otherThread],
      ["s-unrelated", unrelated],
    ] as [string, string][]) {
      await storage.insertAgentSession({
        id, timelineKey: key, sessionType: "default", status: "completed",
        createdAt: now, updatedAt: now,
      });
    }
    await storage.waitForIdle();

    const ids = storage.getAgentSessionsByTimeline(roomKey).map((r) => r.id);
    assert.ok(ids.includes("s-room"), `room % key: room session included; got: ${ids}`);
    assert.ok(ids.includes("s-thread"), `room % key: thread session included; got: ${ids}`);
    assert.ok(!ids.includes("s-other-room"), `room % key: other room excluded; got: ${ids}`);
    assert.ok(!ids.includes("s-other-thread"), `room % key: other thread excluded; got: ${ids}`);
    assert.ok(!ids.includes("s-unrelated"), `room % key: unrelated excluded; got: ${ids}`);

    const ids2 = storage.getAgentSessionsByTimeline(otherRoom).map((r) => r.id);
    assert.ok(ids2.includes("s-other-room"), "_ room: room session included");
    assert.ok(ids2.includes("s-other-thread"), "_ room: thread session included");
    assert.ok(!ids2.includes("s-room"), "_ room: % room excluded");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 3: Thread ID chars at and around the ';' (59) boundary
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/timeline-range: thread IDs with high-ASCII chars (above and at semicolon)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();
    const roomKey = "matrix:bot:room:!r:server";

    // Thread IDs to test — ALL should be captured by the range [roomKey:thread:, roomKey:thread;)
    // because the colon (':') in 'roomKey:thread:X' is at ASCII 58, which is < ';' (59).
    // No matter what X is, roomKey:thread:X < roomKey:thread; (they differ at the ':' vs ';' position).
    const threadCases: [string, string][] = [
      ["$normal", "s-dollar"],       // $ = 36
      ["9event", "s-nine"],          // 9 = 57
      [":event", "s-colon"],         // : = 58
      [";event", "s-semi"],          // ; = 59 — key is ...thread:;event
      ["<event", "s-lt"],            // < = 60
      ["Zevent", "s-Z"],             // Z = 90
      ["zevent", "s-z"],             // z = 122
      ["~event", "s-tilde"],         // ~ = 126
    ];

    await storage.insertAgentSession({ id: "s-room", timelineKey: roomKey, sessionType: "default", status: "completed", createdAt: now, updatedAt: now });
    for (const [threadId, id] of threadCases) {
      await storage.insertAgentSession({
        id, timelineKey: `${roomKey}:thread:${threadId}`,
        sessionType: "default", status: "completed", createdAt: now, updatedAt: now,
      });
    }
    await storage.waitForIdle();

    const ids = storage.getAgentSessionsByTimeline(roomKey).map((r) => r.id);

    // All thread cases should be IN range
    for (const [threadId, id] of threadCases) {
      assert.ok(ids.includes(id), `thread ID "${threadId}": should be in range; got: ${ids.join(",")}`);
    }
    assert.ok(ids.includes("s-room"), "room session included");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 4: UNION ALL dedup and LIMIT ordering
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/union-all: no duplicates; ORDER BY created_at desc LIMIT applies to combined result", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();
    const roomKey = "matrix:bot:room:!r:server";
    const t1 = `${roomKey}:thread:$evt1`;
    const t2 = `${roomKey}:thread:$evt2`;

    // 3 sessions: room (now), thread1 (now+1), thread2 (now+2)
    await storage.insertAgentSession({ id: "s-room", timelineKey: roomKey, sessionType: "default", status: "completed", createdAt: now, updatedAt: now });
    await storage.insertAgentSession({ id: "s-t1", timelineKey: t1, sessionType: "default", status: "completed", createdAt: now + 1, updatedAt: now + 1 });
    await storage.insertAgentSession({ id: "s-t2", timelineKey: t2, sessionType: "default", status: "completed", createdAt: now + 2, updatedAt: now + 2 });
    await storage.waitForIdle();

    // Full result: 3 sessions in reverse-chron order
    const all = storage.getAgentSessionsByTimeline(roomKey);
    assert.equal(all.length, 3, `expected 3, got ${all.length}`);
    assert.equal(all[0]?.id, "s-t2", "most recent first");
    assert.equal(all[1]?.id, "s-t1");
    assert.equal(all[2]?.id, "s-room", "oldest last");

    // LIMIT = 2 → the 2 most recent
    const top2 = storage.getAgentSessionsByTimeline(roomKey, 2);
    assert.equal(top2.length, 2, `limit=2: expected 2, got ${top2.length}`);
    assert.equal(top2[0]?.id, "s-t2");
    assert.equal(top2[1]?.id, "s-t1");

    // LIMIT = 1 → just the most recent
    const top1 = storage.getAgentSessionsByTimeline(roomKey, 1);
    assert.equal(top1.length, 1, `limit=1: expected 1, got ${top1.length}`);
    assert.equal(top1[0]?.id, "s-t2");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 5: getAgentSessionTimelineFacets — DISTINCT collapses UNION ALL duplicates
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/facets: DISTINCT after UNION ALL correctly deduplicates session_type", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();
    const roomKey = "matrix:bot:room:!r:server";
    const threadKey = `${roomKey}:thread:$evt1`;

    // Both room and thread have session_type='default' → UNION ALL yields 2 rows of 'default'
    await storage.insertAgentSession({ id: "s1", timelineKey: roomKey, sessionType: "default", status: "completed", createdAt: now, updatedAt: now });
    await storage.insertAgentSession({ id: "s2", timelineKey: threadKey, sessionType: "default", status: "completed", createdAt: now, updatedAt: now });
    await storage.insertAgentSession({ id: "s3", timelineKey: threadKey, sessionType: "summarize", status: "completed", createdAt: now, updatedAt: now });
    await storage.waitForIdle();

    const facets = storage.getAgentSessionTimelineFacets(roomKey);
    const defaultCount = facets.types.filter((t) => t === "default").length;
    assert.equal(defaultCount, 1, `'default' must appear once; got types: ${facets.types}`);
    assert.equal(facets.types.length, 2, `expected 2 distinct types; got: ${facets.types}`);
    assert.ok(facets.types.includes("summarize"), "summarize present");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 6: saveSnapshot / saveTranscript race — each call only touches its own column
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/write-race: saveSnapshot and saveTranscript never clobber each other's column", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const base = { timelineKey: "matrix:bot:room:!r", sessionType: "default", status: "created" as const, createdAt: 1000, updatedAt: 1000 };

    // Case 1: transcript written BEFORE snapshot
    await storage.insertAgentSession({ id: "s-tx-first", ...base });
    await storage.saveAgentSessionTranscript("s-tx-first", '["tx1"]', 2000);
    await storage.saveAgentSessionSnapshot("s-tx-first", { snapshotJson: '["snap1"]', dumpPath: null, tokenEstimate: null, updatedAt: 3000 });
    const r1 = storage.getAgentSession("s-tx-first");
    assert.equal(r1?.context_snapshot_json, '["snap1"]', "tx-first: snapshot present");
    assert.equal(r1?.transcript_json, '["tx1"]', "tx-first: transcript not nulled by snapshot");

    // Case 2: snapshot BEFORE transcript (normal order)
    await storage.insertAgentSession({ id: "s-snap-first", ...base });
    await storage.saveAgentSessionSnapshot("s-snap-first", { snapshotJson: '["snap2"]', dumpPath: null, tokenEstimate: null, updatedAt: 2000 });
    await storage.saveAgentSessionTranscript("s-snap-first", '["tx2"]', 3000);
    const r2 = storage.getAgentSession("s-snap-first");
    assert.equal(r2?.transcript_json, '["tx2"]', "snap-first: transcript present");
    assert.equal(r2?.context_snapshot_json, '["snap2"]', "snap-first: snapshot not nulled by transcript");

    // Case 3: multiple transcript updates — snapshot survives all
    await storage.insertAgentSession({ id: "s-multi", ...base });
    await storage.saveAgentSessionSnapshot("s-multi", { snapshotJson: '["snap3"]', dumpPath: null, tokenEstimate: null, updatedAt: 2000 });
    for (let i = 1; i <= 5; i++) {
      await storage.saveAgentSessionTranscript("s-multi", `["tx-${i}"]`, 3000 + i);
    }
    const r3 = storage.getAgentSession("s-multi");
    assert.equal(r3?.context_snapshot_json, '["snap3"]', "multi-tx: snapshot survived 5 updates");
    assert.equal(r3?.transcript_json, '["tx-5"]', "multi-tx: final transcript is turn 5");

    // Case 4: non-existent session → result.changes = 0 → no orphan payload row
    await storage.saveAgentSessionTranscript("s-ghost", '["orphan"]', 5000);
    const orphanTx = storage.read((db) =>
      db.prepare("select 1 from agent_session_payloads where session_id = ?").get("s-ghost"),
    );
    assert.equal(orphanTx, undefined, "transcript for ghost session: no orphan payload row");

    await storage.saveAgentSessionSnapshot("s-ghost2", { snapshotJson: '["snap"]', dumpPath: null, tokenEstimate: null, updatedAt: 5000 });
    const orphanSnap = storage.read((db) =>
      db.prepare("select 1 from agent_session_payloads where session_id = ?").get("s-ghost2"),
    );
    assert.equal(orphanSnap, undefined, "snapshot for ghost session: no orphan payload row");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 7: getUserLabels adversarial edge cases
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/getUserLabels: identity fallback, multiple identity rows, nulls, duplicates, absent users", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();

    // Seed sessions for fallback users (B and C)
    await storage.insertAgentSession({
      id: "s-for-b", timelineKey: "matrix:bot:room:!r", sessionType: "default", status: "completed",
      triggerSenderId: "@userB:example.org", triggerSenderDisplayName: "User B Name",
      createdAt: now, updatedAt: now,
    });
    await storage.insertAgentSession({
      id: "s-for-c-old", timelineKey: "matrix:bot:room:!r", sessionType: "default", status: "completed",
      triggerSenderId: "@userC:example.org", triggerSenderDisplayName: "User C Old Name",
      createdAt: now, updatedAt: now,
    });
    await storage.insertAgentSession({
      id: "s-for-c-new", timelineKey: "matrix:bot:room:!r", sessionType: "default", status: "completed",
      triggerSenderId: "@userC:example.org", triggerSenderDisplayName: "User C New Name",
      createdAt: now + 1000, updatedAt: now + 1000, completedAt: now + 1000,
    });
    await storage.waitForIdle();

    // Seed user_identities
    await storage.write((db) => {
      const t = Date.now();
      const ins = db.prepare(
        `insert into user_identities (provider, user_id, username, display_name, first_seen, last_seen, updated_at) values (?, ?, ?, ?, ?, ?, ?)`,
      );
      // User A: has display_name
      ins.run("matrix", "@userA:example.org", "userA", "User A", t, t, t);
      // User B: identity exists, display_name is null → needs fallback
      ins.run("matrix", "@userB:example.org", "userB", null, t, t, t);
      // User M: multiple identity rows (different providers) → most-recent wins
      ins.run("matrix", "@userM:example.org", "oldname", "Old M", t - 5000, t - 5000, t - 5000);
      ins.run("discord", "@userM:example.org", "newname", "New M", t, t, t);
    });

    const labels = storage.getUserLabels([
      "@userA:example.org",
      "@userB:example.org",
      "@userC:example.org",
      "@userD:example.org",  // not in any table
    ]);

    // User A: display_name from identity
    const a = labels.get("@userA:example.org");
    assert.equal(a?.displayName, "User A", `userA displayName`);
    assert.equal(a?.username, "userA");

    // User B: identity has null display_name → fallback to session
    const b = labels.get("@userB:example.org");
    assert.equal(b?.displayName, "User B Name", `userB displayName; got: ${JSON.stringify(b)}`);
    assert.equal(b?.username, "userB", "userB: username from identity");

    // User C: no identity → display_name from most-recent session (New > Old)
    const c = labels.get("@userC:example.org");
    assert.equal(c?.displayName, "User C New Name", `userC displayName; got: ${JSON.stringify(c)}`);
    assert.equal(c?.username, null, "userC: username null (no identity)");

    // User D: no identity, no sessions
    const d = labels.get("@userD:example.org");
    assert.equal(d?.displayName, null, "userD: null displayName");
    assert.equal(d?.username, null, "userD: null username");

    // All 4 in map
    assert.equal(labels.size, 4, `map size: ${labels.size}`);

    // Multiple identity rows → most-recent updated_at wins
    const mLabels = storage.getUserLabels(["@userM:example.org"]);
    const m = mLabels.get("@userM:example.org");
    assert.equal(m?.displayName, "New M", `userM: most-recent display_name; got: ${JSON.stringify(m)}`);
    assert.equal(m?.username, "newname", "userM: most-recent username");

    // Duplicate userId in input: map deduplicates by key
    const dupLabels = storage.getUserLabels(["@userA:example.org", "@userA:example.org"]);
    assert.equal(dupLabels.size, 1, `duplicate input: map size should be 1; got ${dupLabels.size}`);
    assert.equal(dupLabels.get("@userA:example.org")?.displayName, "User A");

    // Empty input
    const emptyLabels = storage.getUserLabels([]);
    assert.equal(emptyLabels.size, 0, "empty input: empty map");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 8: Migration with FK children (session_interjections on session_id)
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/migration: FK children (session_interjections) survive migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-adv-fk-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => {
        db.exec(`
          alter table agent_sessions add column context_snapshot_json text;
          alter table agent_sessions add column transcript_json text;
        `);
        const now = Date.now();
        db.prepare(`insert into agent_sessions (id, timeline_key, session_type, status, context_snapshot_json, transcript_json, created_at, updated_at)
                    values (?, ?, 'default', 'completed', ?, ?, ?, ?)`).run(
          "s-fk", "matrix:bot:room:!r", "snap", "tx", now, now,
        );
        // session_interjections schema: rowid (autoincrement), session_id, event_id, sender_id, kind (not null), body (not null), created_at
        db.prepare(`insert into session_interjections (session_id, event_id, sender_id, kind, body, created_at)
                    values (?, ?, ?, ?, ?, ?)`).run(
          "s-fk", "evt-1", "@user:example.org", "reply", "hello", now,
        );
        db.pragma("user_version = 10");
      });
      await storage.waitForIdle();
      storage.close();
    }

    {
      const storage = await Storage.open({ databasePath: dbPath });
      try {
        const row = storage.getAgentSession("s-fk");
        assert.ok(row !== undefined, "session readable after migration");
        assert.equal(row?.context_snapshot_json, "snap");
        assert.equal(row?.transcript_json, "tx");

        const inj = storage.read((db) =>
          db.prepare("select 1 from session_interjections where event_id = ?").get("evt-1"),
        );
        assert.ok(inj !== undefined, "session_interjections preserved");

        const payload = storage.read((db) =>
          db
            .prepare("select context_snapshot_json from agent_session_payloads where session_id = ?")
            .get("s-fk") as { context_snapshot_json: string } | undefined,
        );
        assert.equal(payload?.context_snapshot_json, "snap", "payload row exists with FK");
      } finally {
        await storage.waitForIdle();
        storage.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 9: Re-open after migration (idempotency + data integrity)
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/migration: re-open + forced user_version=10 re-run is safe (no double-copy)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-adv-idem-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // First open: fresh v11 DB, write session
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.insertAgentSession({ id: "s1", timelineKey: "matrix:bot:room:!r", sessionType: "default", status: "created", createdAt: 1000, updatedAt: 1000 });
      await storage.saveAgentSessionSnapshot("s1", { snapshotJson: '["snap"]', dumpPath: null, tokenEstimate: null, updatedAt: 2000 });
      await storage.waitForIdle();
      storage.close();
    }

    // Second open: no-op (already v11)
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const r = storage.getAgentSession("s1");
      assert.equal(r?.context_snapshot_json, '["snap"]', "re-open: snapshot intact");
      await storage.waitForIdle();
      storage.close();
    }

    // Force downgrade user_version to 10 (test: migration re-run safety)
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => { db.pragma("user_version = 10"); });
      await storage.waitForIdle();
      storage.close();
    }

    // Third open: migration re-runs. agent_sessions has NO blob columns (v11 schema).
    // splitSessionPayloads detects hasSnapshotCol=false → skips INSERT → no double-copy.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const r = storage.getAgentSession("s1");
      assert.equal(r?.context_snapshot_json, '["snap"]', "post-re-migrate: snapshot still present");
      const n = (
        storage.read((db) =>
          db.prepare("select count(*) as n from agent_session_payloads").get(),
        ) as { n: number }
      ).n;
      assert.equal(n, 1, `post-re-migrate: exactly 1 payload row (no duplicate); got ${n}`);
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 10: schema version constant and indexes present in fresh DB
// ─────────────────────────────────────────────────────────────────────────────
test("adversarial/schema: LATEST_SCHEMA_VERSION = 14; all four expected indexes present on fresh DB", async () => {
  assert.equal(LATEST_SCHEMA_VERSION, 14, "LATEST_SCHEMA_VERSION is 14");

  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const indexes = storage.read((db) =>
      (
        db
          .prepare("select name from sqlite_master where type = 'index'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const idx of [
      "idx_agent_sessions_timeline",
      "idx_agent_sessions_status",
      "idx_agent_sessions_recent",
      "idx_agent_sessions_sender_recent",
    ]) {
      assert.ok(indexes.includes(idx), `index ${idx} present on fresh DB; got: ${indexes.join(",")}`);
    }
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
