import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, LATEST_SCHEMA_VERSION } from "../src/storage/index.js";

// v10 → v11 migration: split context_snapshot_json and transcript_json out of
// agent_sessions into agent_session_payloads. The migration copies existing blobs,
// drops the two columns, and creates three new indexes.

const hasTable = (storage: Storage, name: string): boolean =>
  storage.read(
    (db) =>
      db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
        .get(name) !== undefined,
  );

const hasIndex = (storage: Storage, name: string): boolean =>
  storage.read(
    (db) =>
      db
        .prepare("select 1 from sqlite_master where type = 'index' and name = ?")
        .get(name) !== undefined,
  );

const columnNames = (storage: Storage, table: string): string[] =>
  storage.read((db) =>
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((r) => r.name),
  );

test("v10→v11: pre-migration blobs land in agent_session_payloads; agent_sessions drops the columns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-payload-split-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // Step 1: Simulate a v10 database that still has the blob columns inline.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => {
        // Rebuild agent_sessions with the old v10 schema (blobs inline) so the
        // migration has something to copy.  Use the same approach as other migration
        // tests: alter the live schema and stamp the version.
        db.exec(`
          alter table agent_sessions add column context_snapshot_json text;
          alter table agent_sessions add column transcript_json text;
        `);

        // Insert two sessions: one with blobs, one without.
        const now = Date.now();
        const sessionStmt = db.prepare(`
          insert into agent_sessions
            (id, timeline_key, session_type, status,
             context_snapshot_json, transcript_json,
             created_at, updated_at)
          values (?, ?, 'default', 'completed', ?, ?, ?, ?)
        `);
        sessionStmt.run(
          "s-with-blobs",
          "matrix:bot:room:!r1",
          JSON.stringify([{ type: "system", content: "snap" }]),
          JSON.stringify([{ role: "user", content: "tx" }]),
          now,
          now,
        );
        sessionStmt.run(
          "s-no-blobs",
          "matrix:bot:room:!r2",
          null,
          null,
          now,
          now,
        );

        // Downgrade to v10 so the next open runs step 10 (splitSessionPayloads).
        db.pragma("user_version = 10");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // Step 2: Reopen — the v10→v11 migration runs automatically.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      try {
        // Version is now at LATEST.
        const ver = storage.read((db) =>
          Number(db.pragma("user_version", { simple: true })),
        );
        assert.equal(ver, LATEST_SCHEMA_VERSION, "version stamped to LATEST");

        // agent_session_payloads table was created.
        assert.ok(hasTable(storage, "agent_session_payloads"), "payload table exists");

        // The blob columns are gone from agent_sessions.
        const asCols = columnNames(storage, "agent_sessions");
        assert.ok(
          !asCols.includes("context_snapshot_json"),
          "context_snapshot_json removed from agent_sessions",
        );
        assert.ok(
          !asCols.includes("transcript_json"),
          "transcript_json removed from agent_sessions",
        );

        // The session with blobs has its data in agent_session_payloads.
        const payload = storage.read((db) =>
          db
            .prepare(
              "select context_snapshot_json, transcript_json from agent_session_payloads where session_id = ?",
            )
            .get("s-with-blobs") as
            | { context_snapshot_json: string | null; transcript_json: string | null }
            | undefined,
        );
        assert.ok(payload, "payload row exists for s-with-blobs");
        assert.ok(
          payload?.context_snapshot_json?.includes("snap"),
          "context_snapshot_json migrated",
        );
        assert.ok(
          payload?.transcript_json?.includes("tx"),
          "transcript_json migrated",
        );

        // The no-blob session has no payload row (INSERT OR IGNORE with NULL data
        // was skipped by the WHERE clause in the migration).
        const noPayload = storage.read((db) =>
          db
            .prepare("select 1 from agent_session_payloads where session_id = ?")
            .get("s-no-blobs"),
        );
        assert.equal(noPayload, undefined, "no payload row for null-blob session");

        // Storage API (getAgentSession) returns the blobs through the join.
        const row = storage.getAgentSession("s-with-blobs");
        assert.ok(row, "session row readable via getAgentSession");
        assert.ok(
          row?.context_snapshot_json?.includes("snap"),
          "getAgentSession surfaces context_snapshot_json via join",
        );
        assert.ok(
          row?.transcript_json?.includes("tx"),
          "getAgentSession surfaces transcript_json via join",
        );

        // A session with no payload row returns nulls for the blob fields (LEFT JOIN).
        const rowNoBlobData = storage.getAgentSession("s-no-blobs");
        assert.ok(rowNoBlobData, "s-no-blobs readable");
        assert.equal(rowNoBlobData?.context_snapshot_json, null);
        assert.equal(rowNoBlobData?.transcript_json, null);

        // The three new indexes were created.
        assert.ok(hasIndex(storage, "idx_agent_sessions_recent"), "idx_agent_sessions_recent created");
        assert.ok(
          hasIndex(storage, "idx_agent_sessions_sender_recent"),
          "idx_agent_sessions_sender_recent created",
        );
      } finally {
        await storage.waitForIdle();
        storage.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v10→v11: fresh DB has agent_session_payloads and no blob columns in agent_sessions", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Fresh DB built at v11: blob columns must be absent from agent_sessions.
    const asCols = columnNames(storage, "agent_sessions");
    assert.ok(!asCols.includes("context_snapshot_json"), "no context_snapshot_json on fresh DB");
    assert.ok(!asCols.includes("transcript_json"), "no transcript_json on fresh DB");

    // agent_session_payloads exists with the right columns.
    assert.ok(hasTable(storage, "agent_session_payloads"), "payload table present on fresh DB");
    const payloadCols = columnNames(storage, "agent_session_payloads");
    assert.ok(payloadCols.includes("session_id"), "session_id column present");
    assert.ok(payloadCols.includes("context_snapshot_json"), "context_snapshot_json in payloads");
    assert.ok(payloadCols.includes("transcript_json"), "transcript_json in payloads");

    // All four expected indexes are present.
    for (const idx of [
      "idx_agent_sessions_timeline",
      "idx_agent_sessions_status",
      "idx_agent_sessions_recent",
      "idx_agent_sessions_sender_recent",
    ]) {
      assert.ok(hasIndex(storage, idx), `index ${idx} present on fresh DB`);
    }
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("v10→v11: saveSnapshot + saveTranscript round-trip through agent_session_payloads", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertAgentSession({
      id: "s-roundtrip",
      timelineKey: "matrix:bot:room:!r",
      sessionType: "default",
      status: "created",
      createdAt: 1000,
      updatedAt: 1000,
    });

    await storage.saveAgentSessionSnapshot("s-roundtrip", {
      snapshotJson: '["snapshot"]',
      dumpPath: "/dumps/s-roundtrip.json",
      tokenEstimate: 42,
      updatedAt: 2000,
    });

    // Snapshot present; transcript still null.
    let row = storage.getAgentSession("s-roundtrip");
    assert.equal(row?.context_snapshot_json, '["snapshot"]');
    assert.equal(row?.transcript_json, null);
    assert.equal(row?.context_dump_path, "/dumps/s-roundtrip.json");
    assert.equal(row?.token_estimate, 42);

    await storage.saveAgentSessionTranscript("s-roundtrip", '["transcript"]', 3000);

    // Both present; snapshot unchanged.
    row = storage.getAgentSession("s-roundtrip");
    assert.equal(row?.context_snapshot_json, '["snapshot"]');
    assert.equal(row?.transcript_json, '["transcript"]');

    // Transcript update does not clobber snapshot.
    await storage.saveAgentSessionTranscript("s-roundtrip", '["tx2"]', 4000);
    row = storage.getAgentSession("s-roundtrip");
    assert.equal(row?.context_snapshot_json, '["snapshot"]');
    assert.equal(row?.transcript_json, '["tx2"]');

    // Snapshot update does not clobber transcript.
    await storage.saveAgentSessionSnapshot("s-roundtrip", {
      snapshotJson: '["snap2"]',
      dumpPath: null,
      tokenEstimate: null,
      updatedAt: 5000,
    });
    row = storage.getAgentSession("s-roundtrip");
    assert.equal(row?.context_snapshot_json, '["snap2"]');
    assert.equal(row?.transcript_json, '["tx2"]');
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("v10→v11: EXPLAIN QUERY PLAN shows index use for the four affected queries", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Helper: return the EXPLAIN QUERY PLAN detail strings for a SQL statement.
    const eqp = (sql: string, params: unknown[] = []): string[] =>
      storage.read((db) =>
        (
          db
            .prepare(`explain query plan ${sql}`)
            .all(...params) as Array<{ detail: string }>
        ).map((r) => r.detail),
      );

    // Seed a handful of sessions with large-ish blobs to exercise the plan.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await storage.insertAgentSession({
        id: `s-eqp-${i}`,
        timelineKey: i < 3 ? "matrix:bot:room:!r1" : `matrix:bot:room:!r1:thread:$t${i}`,
        sessionType: "default",
        status: "completed",
        triggerSenderId: `@user${i}:example.org`,
        triggerSenderDisplayName: `User ${i}`,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }
    await storage.waitForIdle();

    // 1. getUsageRecentSessions ORDER BY: must use idx_agent_sessions_recent.
    const recentPlan = eqp(
      `select id from agent_sessions s
       order by coalesce(s.completed_at, s.updated_at) desc
       limit 50`,
    );
    const recentUsesIndex = recentPlan.some((d) => d.includes("idx_agent_sessions_recent"));
    assert.ok(
      recentUsesIndex,
      `getUsageRecentSessions should use idx_agent_sessions_recent; plan: ${recentPlan.join(" | ")}`,
    );

    // 2. getAgentSessionsByTimeline UNION ALL: neither arm should SCAN the full table.
    // The ORDER BY must reference a column present in the SELECT list.
    const byTimelinePlan = eqp(
      `select id, created_at from agent_sessions where timeline_key = ?
       union all
       select id, created_at from agent_sessions where timeline_key >= ? and timeline_key < ?
       order by created_at desc limit 100`,
      ["matrix:bot:room:!r1", "matrix:bot:room:!r1:thread:", "matrix:bot:room:!r1:thread;"],
    );
    // Each arm should use idx_agent_sessions_timeline (exact or range seek).
    const byTimelineUsesIndex = byTimelinePlan.some((d) =>
      d.includes("idx_agent_sessions_timeline"),
    );
    assert.ok(
      byTimelineUsesIndex,
      `getAgentSessionsByTimeline should use idx_agent_sessions_timeline; plan: ${byTimelinePlan.join(" | ")}`,
    );
    const byTimelineNoFullScan = !byTimelinePlan.some(
      (d) => /SCAN agent_sessions(?! USING)/i.test(d),
    );
    assert.ok(
      byTimelineNoFullScan,
      `getAgentSessionsByTimeline must not full-scan agent_sessions; plan: ${byTimelinePlan.join(" | ")}`,
    );

    // 3. getAgentSessionTimelineFacets: inner arms should not full-scan.
    const facetPlan = eqp(
      `select distinct session_type from (
         select session_type from agent_sessions where timeline_key = ?
         union all
         select session_type from agent_sessions where timeline_key >= ? and timeline_key < ?
       ) order by session_type`,
      ["matrix:bot:room:!r1", "matrix:bot:room:!r1:thread:", "matrix:bot:room:!r1:thread;"],
    );
    const facetUsesIndex = facetPlan.some((d) => d.includes("idx_agent_sessions_timeline"));
    assert.ok(
      facetUsesIndex,
      `getAgentSessionTimelineFacets should use idx_agent_sessions_timeline; plan: ${facetPlan.join(" | ")}`,
    );

    // 4. getUserLabels fallback (window function on indexed partial): must not
    //    perform a full SCAN while the indexed columns are in the query.
    const labelPlan = eqp(
      `select trigger_sender_id, trigger_sender_display_name
       from (
         select trigger_sender_id, trigger_sender_display_name,
                row_number() over (
                  partition by trigger_sender_id
                  order by coalesce(completed_at, updated_at) desc
                ) as rn
         from agent_sessions
         where trigger_sender_id in (?, ?)
           and trigger_sender_display_name is not null
       ) where rn = 1`,
      ["@user0:example.org", "@user1:example.org"],
    );
    // The partial index idx_agent_sessions_sender_recent covers the WHERE predicate.
    const labelUsesIndex = labelPlan.some((d) =>
      d.includes("idx_agent_sessions_sender_recent"),
    );
    assert.ok(
      labelUsesIndex,
      `getUserLabels fallback should use idx_agent_sessions_sender_recent; plan: ${labelPlan.join(" | ")}`,
    );
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
