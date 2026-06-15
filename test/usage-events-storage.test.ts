import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Storage, LATEST_SCHEMA_VERSION, type AgentSessionInsert } from "../src/storage/index.js";
import type {
  UsageCostFilter,
  UsageEventInput,
  UsageEventRow,
} from "../src/storage/database.js";

// ===========================================================================
// Unified usage ledger: v24→v25 migration + backfill + ledger queries (spec
// USAGE-COST-LIMITS §3/§4/§6.1/§7.1; review issue #18). The migration creates
// `usage_events` and backfills history from three legacy lanes:
//   - tool rows: every `tool_invocations` row 1:1 (class='tool'), session
//     attribution joined from `agent_sessions` where present.
//   - agent_loop rows: one COARSE synthetic row per session WITH usage actuals.
//   - caption rows: every captioned `media_assets` row with a known cost.
// The backfill is idempotent (guarded on an empty `usage_events`) and
// best-effort (a partial/absent legacy source is skipped, not fatal — #3).
// ===========================================================================

const TK = "matrix:miku:room:!room";

/** A complete agent_sessions insert; usage is layered on separately. */
function session(overrides: Partial<AgentSessionInsert> = {}): AgentSessionInsert {
  return {
    id: "s-000000001",
    timelineKey: TK,
    sessionType: "default",
    status: "completed",
    modelId: "anthropic/claude",
    triggerEventId: "evt-1",
    triggerExternalId: "$server-1",
    triggerBody: "hi",
    triggerSenderId: "@alice:example.org",
    triggerSenderDisplayName: "Alice",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

/**
 * Seed a `timeline_events` parent row (media_assets.event_id is a NOT NULL FK
 * with `foreign_keys = ON`) so a captioned media asset can reference it.
 */
function seedTimelineEvent(storage: Storage, id: string): Promise<void> {
  return storage.readAndWrite((db) => {
    db.prepare(
      `insert into timeline_events
         (id, external_id, timeline_key, provider, role, sender_id, sender_display_name,
          body, timestamp, received_at, agent_session_id, event_json, created_at, updated_at)
       values (@id, @id, @tk, 'matrix', 'user', '@u:x', 'U', 'b', 1, 1, null, '{}', 1, 1)`,
    ).run({ id, tk: TK });
  });
}

/**
 * Seed a captioned media asset with full control over caption cost/usage and
 * `updated_at` (which the backfill copies into `ts`). `caption_cost = null`
 * means "uncosted" — the backfill must skip it.
 */
function seedMediaAsset(
  storage: Storage,
  row: {
    id: string;
    eventId: string;
    captionModel: string | null;
    captionCost: number | null;
    captionInput?: number | null;
    captionOutput?: number | null;
    captionStatus?: string;
    updatedAt: number;
  },
): Promise<void> {
  return storage.readAndWrite((db) => {
    db.prepare(
      `insert into media_assets
         (id, event_id, role, media_type, caption, caption_model, caption_status,
          caption_input_tokens, caption_output_tokens, caption_cache_read_tokens,
          caption_total_tokens, caption_cost, created_at, updated_at)
       values
         (@id, @eventId, 'user', 'image', 'a cat', @captionModel, @captionStatus,
          @captionInput, @captionOutput, null, null, @captionCost, @updatedAt, @updatedAt)`,
    ).run({
      id: row.id,
      eventId: row.eventId,
      captionModel: row.captionModel,
      captionStatus: row.captionStatus ?? "complete",
      captionInput: row.captionInput ?? null,
      captionOutput: row.captionOutput ?? null,
      captionCost: row.captionCost,
      updatedAt: row.updatedAt,
    });
  });
}

/**
 * Seed a `tool_invocations` row directly (the public insert stamps `created_at`
 * to now; here `ts` must be controllable, and `model_id` must be settable to
 * NULL to exercise the `coalesce(..., 'unknown')` path).
 */
function seedToolInvocation(
  storage: Storage,
  row: {
    id: string;
    sessionId: string | null;
    toolName: string;
    modelId: string | null;
    cost: number | null;
    input?: number | null;
    output?: number | null;
    createdAt: number;
  },
): Promise<void> {
  return storage.readAndWrite((db) => {
    db.prepare(
      `insert into tool_invocations
         (id, agent_session_id, tool_name, tool_call_id, model_id, provider,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          images, cost, ref, created_at)
       values
         (@id, @sessionId, @toolName, null, @modelId, 'gemini',
          @input, @output, null, null, null, @cost, null, @createdAt)`,
    ).run({
      id: row.id,
      sessionId: row.sessionId,
      toolName: row.toolName,
      modelId: row.modelId,
      input: row.input ?? null,
      output: row.output ?? null,
      cost: row.cost,
      createdAt: row.createdAt,
    });
  });
}

/** Rewind a built DB to v24 and drop usage_events; optionally keep the table. */
function rewindToV24(dbPath: string, opts: { dropTable: boolean }): void {
  const raw = new Database(dbPath);
  if (opts.dropTable) raw.exec("drop table usage_events;");
  raw.pragma("user_version = 24");
  raw.close();
}

function rowCount(storage: Storage, sql: string, ...params: unknown[]): number {
  return storage.read(
    (db) => (db.prepare(sql).get(...params) as { n: number }).n,
  );
}

/**
 * Build a current DB, seed the legacy lanes, rewind to v24, drop usage_events,
 * and reopen so the v24→v25 backfill runs. Returns the reopened Storage + path.
 */
async function buildAndMigrate(
  seed: (storage: Storage) => Promise<void>,
): Promise<{ storage: Storage; dbPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-usage-events-"));
  const dbPath = path.join(dir, "legacy.db");
  const built = await Storage.open({ databasePath: dbPath });
  await seed(built);
  await built.waitForIdle();
  built.close();

  rewindToV24(dbPath, { dropTable: true });

  const storage = await Storage.open({ databasePath: dbPath });
  return { storage, dbPath, dir };
}

/**
 * Seed a representative spread across all three lanes:
 *   - s-with-usage: completed session WITH usage actuals + a tool invocation.
 *   - s-no-usage: a session with NO usage update (usage_* NULL) → excluded from
 *     the agent_loop backfill, but its tool invocation IS backfilled.
 *   - a NULL-model tool invocation (model coalesces to 'unknown').
 *   - one captioned asset WITH cost, one uncosted (caption_cost NULL → excluded).
 */
async function seedRepresentative(storage: Storage): Promise<void> {
  // (1) A session with usage actuals → one agent_loop row. The agent_loop backfill
  // copies `coalesce(completed_at, updated_at)` into `ts`; `updateAgentSessionUsage`
  // stamps `updated_at = Date.now()`, so set an explicit `completed_at` afterwards
  // (via the status update, the only path that persists it) to pin a deterministic ts.
  await storage.insertAgentSession(session({ id: "s-with-usage", sessionType: "default" }));
  await storage.updateAgentSessionUsage("s-with-usage", {
    llmRequests: 4,
    inputTokens: 1_000,
    outputTokens: 300,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 100,
    cost: 0.05,
    contextTokens: 12_000,
  });
  await storage.updateAgentSessionStatus("s-with-usage", "completed", { completedAt: 5_000, updatedAt: 5_000 });

  // (2) A session with NO usage update → usage_* stay NULL → NOT backfilled to agent_loop.
  await storage.insertAgentSession(
    session({
      id: "s-no-usage",
      sessionType: "proactive",
      triggerSenderId: "@bob:example.org",
      updatedAt: 6_000,
    }),
  );

  // (3) Tool invocations: one attributed to s-with-usage (joins session_type/
  //     timeline_key/trigger_sender_id), one to s-no-usage, and one with a NULL
  //     model id (coalesces to 'unknown') attributed to s-no-usage.
  await seedToolInvocation(storage, {
    id: "ti-1",
    sessionId: "s-with-usage",
    toolName: "image_generate",
    modelId: "gemini-3-pro-image",
    cost: 0.08,
    input: 100,
    output: 1290,
    createdAt: 4_100,
  });
  await seedToolInvocation(storage, {
    id: "ti-2",
    sessionId: "s-no-usage",
    toolName: "x_search",
    modelId: null, // NULL model → 'unknown'
    cost: 0.01,
    createdAt: 6_100,
  });

  // (4) Captioned media: one with cost (backfilled), one uncosted (skipped).
  await seedTimelineEvent(storage, "evt-cap-1");
  await seedTimelineEvent(storage, "evt-cap-2");
  await seedMediaAsset(storage, {
    id: "ma-costed",
    eventId: "evt-cap-1",
    captionModel: "google/gemini-3.5-flash",
    captionCost: 0.0009,
    captionInput: 700,
    captionOutput: 200,
    updatedAt: 7_000,
  });
  await seedMediaAsset(storage, {
    id: "ma-uncosted",
    eventId: "evt-cap-2",
    captionModel: "google/gemini-3.5-flash",
    captionCost: null, // uncosted → excluded
    updatedAt: 7_100,
  });
}

// ---------------------------------------------------------------------------
// (a) version stamp + (b) per-class backfilled row counts
// ---------------------------------------------------------------------------

test("v24 -> v25 migration stamps LATEST and backfills the expected per-class counts (#18)", async () => {
  const { storage, dir } = await buildAndMigrate(seedRepresentative);
  try {
    // (a) version stamped forward to latest.
    const version = storage.read((db) => db.pragma("user_version", { simple: true }) as number);
    assert.equal(version, LATEST_SCHEMA_VERSION);

    // (b) per-class counts: 1 agent_loop (only the session WITH usage), 2 tool
    // (both invocations), 1 caption (only the costed asset).
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where class='agent_loop'`), 1);
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where class='tool'`), 2);
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where class='caption'`), 1);
    // Total = 1 + 2 + 1 (no embedding rows in the legacy lanes).
    assert.equal(rowCount(storage, `select count(*) as n from usage_events`), 4);
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where class='embedding'`), 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) attribution-join values + (d) usage-less / uncosted exclusion
// ---------------------------------------------------------------------------

test("backfill joins session attribution onto tool rows; caption rows carry null attribution (#18)", async () => {
  const { storage, dir } = await buildAndMigrate(seedRepresentative);
  try {
    const get = (id: string): UsageEventRow =>
      storage.read((db) => db.prepare(`select * from usage_events where id = ?`).get(id) as UsageEventRow);

    // (c) tool row ti-1 inherits the joined session's attribution + ts = ti.created_at.
    const tool1 = get("ti-1");
    assert.equal(tool1.class, "tool");
    assert.equal(tool1.agent_session_id, "s-with-usage");
    assert.equal(tool1.session_type, "default");
    assert.equal(tool1.timeline_key, TK);
    assert.equal(tool1.trigger_sender_id, "@alice:example.org");
    assert.equal(tool1.tool_name, "image_generate");
    assert.equal(tool1.model_id, "gemini-3-pro-image");
    assert.equal(tool1.cost_usd, 0.08);
    assert.equal(tool1.ts, 4_100);

    // tool row ti-2: NULL source model coalesces to 'unknown'; attribution from s-no-usage.
    const tool2 = get("ti-2");
    assert.equal(tool2.model_id, "unknown");
    assert.equal(tool2.session_type, "proactive");
    assert.equal(tool2.trigger_sender_id, "@bob:example.org");

    // The agent_loop synthetic row uses the `usage_bf_<sessionId>` key + carries
    // the session totals/attribution; ts = completed_at.
    const loop = get("usage_bf_s-with-usage");
    assert.equal(loop.class, "agent_loop");
    assert.equal(loop.agent_session_id, "s-with-usage");
    assert.equal(loop.session_type, "default");
    assert.equal(loop.timeline_key, TK);
    assert.equal(loop.trigger_sender_id, "@alice:example.org");
    assert.equal(loop.model_id, "anthropic/claude");
    assert.equal(loop.input_tokens, 1_000);
    assert.equal(loop.output_tokens, 300);
    assert.equal(loop.cost_usd, 0.05);
    assert.equal(loop.tool_name, null);
    assert.equal(loop.ts, 5_000); // completed_at

    // (c) caption row carries NULL attribution (background work — no session).
    const caption = get("usage_capbf_ma-costed");
    assert.equal(caption.class, "caption");
    assert.equal(caption.agent_session_id, null);
    assert.equal(caption.session_type, null);
    assert.equal(caption.timeline_key, null);
    assert.equal(caption.trigger_sender_id, null);
    assert.equal(caption.model_id, "google/gemini-3.5-flash");
    assert.equal(caption.input_tokens, 700);
    assert.equal(caption.cost_usd, 0.0009);
    assert.equal(caption.ts, 7_000);

    // (d) the usage-less session is NOT in the agent_loop lane.
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where id = 'usage_bf_s-no-usage'`), 0);
    // (d) the uncosted caption asset is NOT backfilled.
    assert.equal(rowCount(storage, `select count(*) as n from usage_events where id = 'usage_capbf_ma-uncosted'`), 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) idempotency — re-running the migration step does NOT double-insert
// ---------------------------------------------------------------------------

test("backfill is idempotent: re-running the v25 step without dropping the table does not double-insert (#18)", async () => {
  const { storage, dbPath, dir } = await buildAndMigrate(seedRepresentative);
  try {
    const afterFirst = rowCount(storage, `select count(*) as n from usage_events`);
    assert.equal(afterFirst, 4, "first migration backfilled four rows");
    await storage.waitForIdle();
    storage.close();

    // Rewind the version to 24 again but LEAVE the populated usage_events table in
    // place. Reopening re-runs the v25 step. Idempotency is doubly guarded: the
    // `if (existing) return` short-circuit skips the backfill when the ledger is
    // non-empty, and even without it every backfilled row carries a DETERMINISTIC
    // PK (the source `ti.id`, or `usage_bf_<sessionId>` / `usage_capbf_<assetId>`),
    // so a re-insert collides on UNIQUE and the whole statement is swallowed. Either
    // way the ledger must NOT grow and NO row may be duplicated.
    rewindToV24(dbPath, { dropTable: false });
    const reopened = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(reopened.read((db) => db.pragma("user_version", { simple: true }) as number), LATEST_SCHEMA_VERSION);
      assert.equal(
        rowCount(reopened, `select count(*) as n from usage_events`),
        4,
        "re-running the backfill on a non-empty ledger must not double-insert",
      );
      // No duplicate PKs slipped in (count(distinct id) == count(*)).
      assert.equal(rowCount(reopened, `select count(distinct id) as n from usage_events`), 4);
      // Per-class shape is unchanged after the re-run.
      assert.equal(rowCount(reopened, `select count(*) as n from usage_events where class='agent_loop'`), 1);
      assert.equal(rowCount(reopened, `select count(*) as n from usage_events where class='tool'`), 2);
      assert.equal(rowCount(reopened, `select count(*) as n from usage_events where class='caption'`), 1);
    } finally {
      await reopened.waitForIdle();
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Degraded-schema case (#3 logging path): a partial/absent legacy source must
// not crash the v24→v25 reopen; the backfill skips and the ledger ends empty.
// ---------------------------------------------------------------------------

test("degraded legacy schema: a missing-column source is skipped, reopen survives, ledger empty (#3/#18)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-usage-degraded-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    // Build a current DB and seed a session WITH usage (would normally backfill an
    // agent_loop row), then DROP a column the agent_loop SELECT reads
    // (trigger_sender_id). The pragma/hasTable guards still see the table, so the
    // backfill is attempted and the `insert … select` raises "no such column" —
    // exercising the swallow-and-log path. SQLite cannot DROP a column on old
    // builds, so REBUILD agent_sessions without that column instead.
    const built = await Storage.open({ databasePath: dbPath });
    await built.insertAgentSession(session({ id: "s-deg-1" }));
    await built.updateAgentSessionUsage("s-deg-1", {
      llmRequests: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
      contextTokens: 100,
    });
    await built.waitForIdle();
    built.close();

    // Rewind + drop usage_events, AND mangle agent_sessions so the agent_loop
    // backfill SELECT references a now-missing column.
    const raw = new Database(dbPath);
    raw.exec("drop table usage_events;");
    // Remove the trigger_sender_id column the backfill SELECT reads. (Modern SQLite
    // supports DROP COLUMN; bundled better-sqlite3 is new enough.)
    raw.exec("alter table agent_sessions drop column trigger_sender_id;");
    raw.pragma("user_version = 24");
    raw.close();

    // Reopen: the v25 step creates usage_events, attempts the backfill, and both the
    // tool lane (which JOINs agent_sessions to read s.trigger_sender_id) and the
    // agent_loop lane raise "no such column: s.trigger_sender_id" — each must be
    // caught (logged with the `usage_backfill_skipped` tag + lane, swallowed) so the
    // migration completes and startup survives.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(
        storage.read((db) => db.pragma("user_version", { simple: true }) as number),
        LATEST_SCHEMA_VERSION,
        "reopen completes despite the degraded source",
      );
      // The agent_loop lane was skipped; with no other costed legacy rows the
      // ledger ends empty (partial backfill, not a crash). The table exists and
      // accepts fresh writes.
      assert.equal(rowCount(storage, `select count(*) as n from usage_events`), 0);
      await storage.insertUsageEvent({ class: "agent_loop", modelId: "m1", costUsd: 0.02 });
      await storage.waitForIdle();
      assert.equal(rowCount(storage, `select count(*) as n from usage_events`), 1, "new rows accrue post-upgrade");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sumUsageCost(filter): each selector dimension + window bounds.
// ---------------------------------------------------------------------------

/** Open a fresh in-memory Storage and seed a controlled ledger via insertUsageEvent. */
async function withLedger(
  rows: UsageEventInput[],
  run: (storage: Storage) => Promise<void>,
): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    for (const r of rows) await storage.insertUsageEvent(r);
    await storage.waitForIdle();
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

const sum = (storage: Storage, filter: UsageCostFilter): number => storage.sumUsageCost(filter);

test("sumUsageCost: filters by each selector dimension and ANDs across dimensions (#18)", async () => {
  await withLedger(
    [
      { ts: 1_000, class: "agent_loop", sessionType: "default", modelId: "opus", costUsd: 1 },
      { ts: 2_000, class: "agent_loop", sessionType: "proactive", modelId: "opus", costUsd: 2 },
      { ts: 3_000, class: "tool", toolName: "image_generate", sessionType: "default", modelId: "gemini", costUsd: 4 },
      { ts: 4_000, class: "caption", modelId: "flash", costUsd: 8 },
    ],
    async (storage) => {
      // No dimension filter (only `since`): sum of everything.
      assert.equal(sum(storage, { since: 0 }), 15);
      // classes
      assert.equal(sum(storage, { since: 0, classes: ["agent_loop"] }), 3);
      assert.equal(sum(storage, { since: 0, classes: ["tool", "caption"] }), 12);
      // session_types
      assert.equal(sum(storage, { since: 0, sessionTypes: ["default"] }), 5); // 1 + 4
      assert.equal(sum(storage, { since: 0, sessionTypes: ["proactive"] }), 2);
      // tools
      assert.equal(sum(storage, { since: 0, tools: ["image_generate"] }), 4);
      assert.equal(sum(storage, { since: 0, tools: ["nonexistent"] }), 0);
      // models
      assert.equal(sum(storage, { since: 0, models: ["opus"] }), 3);
      assert.equal(sum(storage, { since: 0, models: ["flash"] }), 8);
      // AND across dimensions: agent_loop AND model=opus AND session=default → only the $1 row.
      assert.equal(sum(storage, { since: 0, classes: ["agent_loop"], models: ["opus"], sessionTypes: ["default"] }), 1);
    },
  );
});

test("sumUsageCost: window bounds are half-open [since, until) (#18)", async () => {
  await withLedger(
    [
      { ts: 1_000, class: "agent_loop", modelId: "m", costUsd: 1 },
      { ts: 2_000, class: "agent_loop", modelId: "m", costUsd: 2 },
      { ts: 3_000, class: "agent_loop", modelId: "m", costUsd: 4 },
    ],
    async (storage) => {
      // since is inclusive.
      assert.equal(sum(storage, { since: 2_000 }), 6); // ts 2000 + 3000
      assert.equal(sum(storage, { since: 2_001 }), 4); // only ts 3000
      // until is exclusive.
      assert.equal(sum(storage, { since: 0, until: 3_000 }), 3); // ts 1000 + 2000 (3000 excluded)
      assert.equal(sum(storage, { since: 2_000, until: 3_000 }), 2); // only ts 2000
      // Window past all rows → 0.
      assert.equal(sum(storage, { since: 9_000 }), 0);
    },
  );
});

// ---------------------------------------------------------------------------
// minUsageTs(filter): earliest contributing ts; null when none.
// ---------------------------------------------------------------------------

test("minUsageTs: earliest matching ts per selector; null when none match (#18)", async () => {
  await withLedger(
    [
      { ts: 5_000, class: "tool", toolName: "x_search", modelId: "xs", costUsd: 1 },
      { ts: 3_000, class: "agent_loop", sessionType: "default", modelId: "opus", costUsd: 1 },
      { ts: 7_000, class: "agent_loop", sessionType: "proactive", modelId: "opus", costUsd: 1 },
    ],
    async (storage) => {
      // Earliest across everything.
      assert.equal(storage.minUsageTs({ since: 0 }), 3_000);
      // Scoped to a class.
      assert.equal(storage.minUsageTs({ since: 0, classes: ["tool"] }), 5_000);
      // Scoped to a session type.
      assert.equal(storage.minUsageTs({ since: 0, sessionTypes: ["proactive"] }), 7_000);
      // Window excludes the earliest → next contributing ts.
      assert.equal(storage.minUsageTs({ since: 4_000 }), 5_000);
      // No match → null (not 0).
      assert.equal(storage.minUsageTs({ since: 0, tools: ["nope"] }), null);
      assert.equal(storage.minUsageTs({ since: 99_000 }), null);
    },
  );
});

// ---------------------------------------------------------------------------
// Console aggregations against a known fixture: getUsageSummary /
// getUsageTimeseries / getUsageRecentSessions / getUsageRecentToolCalls.
// ---------------------------------------------------------------------------

test("getUsageSummary: groups by class and by model with totals (#18)", async () => {
  await withLedger(
    [
      { ts: 1_000, class: "agent_loop", modelId: "opus", costUsd: 1 },
      { ts: 2_000, class: "agent_loop", modelId: "opus", costUsd: 2 },
      { ts: 3_000, class: "tool", toolName: "image_generate", modelId: "gemini", costUsd: 4 },
      { ts: 4_000, class: "caption", modelId: "flash", costUsd: 0 }, // zero-cost row still counted in `events`
    ],
    async (storage) => {
      const summary = storage.getUsageSummary(0);
      assert.equal(summary.since, 0);
      assert.ok(Math.abs(summary.total - 7) < 1e-9);
      const byClass = new Map(summary.byClass.map((r) => [r.class, r]));
      assert.equal(byClass.get("agent_loop")?.cost, 3);
      assert.equal(byClass.get("agent_loop")?.events, 2);
      assert.equal(byClass.get("tool")?.cost, 4);
      assert.equal(byClass.get("caption")?.cost, 0);
      assert.equal(byClass.get("caption")?.events, 1, "a zero-cost event still counts toward the event tally");
      const byModel = new Map(summary.byModel.map((r) => [r.model, r]));
      assert.equal(byModel.get("opus")?.cost, 3);
      assert.equal(byModel.get("gemini")?.cost, 4);
      // Ordered cost-desc: the priciest class leads.
      assert.equal(summary.byClass[0]?.class, "tool");
    },
  );
});

test("getUsageTimeseries: groups (bucket, grp) and sums cost, ascending bucket, by class or model (#18)", async () => {
  await withLedger(
    [
      // Two events sharing the SAME ts (same bucket key) + same class → collapse & sum.
      { ts: 3_600_000, class: "agent_loop", modelId: "opus", costUsd: 1 },
      { ts: 3_600_000, class: "agent_loop", modelId: "opus", costUsd: 2 },
      // A later event in a different class.
      { ts: 7_200_000, class: "tool", toolName: "x_search", modelId: "xs", costUsd: 4 },
    ],
    async (storage) => {
      const byClass = storage.getUsageTimeseries(0, 3_600_000, "class");
      // The two same-bucket agent_loop rows fold into one summed (bucket, grp) point.
      const loop = byClass.filter((r) => r.grp === "agent_loop");
      assert.equal(loop.length, 1, "same bucket + same group collapses to one row");
      assert.equal(loop[0]?.cost, 3);
      assert.equal(byClass.find((r) => r.grp === "tool")?.cost, 4);
      // Ascending bucket order (the earlier agent_loop bucket precedes the tool bucket).
      assert.deepEqual(
        byClass.map((r) => r.bucket),
        [...byClass.map((r) => r.bucket)].sort((a, b) => a - b),
      );
      assert.ok(byClass[0]!.bucket <= byClass[byClass.length - 1]!.bucket);
      // Group-by model splits the same rows by model id instead.
      const byModel = storage.getUsageTimeseries(0, 3_600_000, "model");
      assert.equal(byModel.find((r) => r.grp === "opus")?.cost, 3);
      assert.equal(byModel.find((r) => r.grp === "xs")?.cost, 4);
    },
  );
});

test("getUsageTimeseries: events at DISTINCT ts within one bucket window collapse to a single bucket (#22)", async () => {
  await withLedger(
    [
      // Three agent_loop events with DISTINCT timestamps, all inside the SAME hourly
      // bucket [3_600_000, 7_200_000). They must fold into one (bucket, grp) point at
      // the bucket start (3_600_000). Pre-#22-fix the bound-parameter division was
      // floating-point, so `(ts/?)*?` returned each ts verbatim and produced three
      // separate columns — one per event — instead of one hourly bucket.
      { ts: 3_600_000, class: "agent_loop", modelId: "opus", costUsd: 1 },
      { ts: 3_605_000, class: "agent_loop", modelId: "opus", costUsd: 2 },
      { ts: 7_199_999, class: "agent_loop", modelId: "opus", costUsd: 4 }, // last ms of the hour
      // A fourth event one ms into the NEXT hourly bucket — must stay separate.
      { ts: 7_200_000, class: "agent_loop", modelId: "opus", costUsd: 8 },
    ],
    async (storage) => {
      const rows = storage.getUsageTimeseries(0, 3_600_000, "class");
      assert.equal(rows.length, 2, "two hourly buckets, not one column per distinct ts");
      // First bucket floors to 3_600_000 and sums the three same-hour events (1+2+4).
      assert.equal(rows[0]?.bucket, 3_600_000, "bucket floored to the hour start");
      assert.ok(Math.abs((rows[0]?.cost ?? 0) - 7) < 1e-9, "1+2+4 collapse into the 3.6e6 bucket");
      // The boundary event opens the next hourly bucket.
      assert.equal(rows[1]?.bucket, 7_200_000);
      assert.equal(rows[1]?.cost, 8);
    },
  );
});

test("getUsageRecentToolCalls: returns tool/caption/embedding rows newest-first, excludes agent_loop (#18)", async () => {
  await withLedger(
    [
      { ts: 1_000, class: "agent_loop", modelId: "opus", costUsd: 1 }, // excluded
      { ts: 2_000, class: "tool", toolName: "image_generate", modelId: "gemini", costUsd: 4 },
      { ts: 3_000, class: "caption", modelId: "flash", costUsd: 0.001 },
      { ts: 4_000, class: "embedding", modelId: "emb", costUsd: 0.0001 },
    ],
    async (storage) => {
      const rows = storage.getUsageRecentToolCalls(50);
      // agent_loop is never in this view.
      assert.deepEqual(
        rows.map((r) => r.class),
        ["embedding", "caption", "tool"],
        "newest-first, agent_loop excluded",
      );
      // limit is honored.
      assert.equal(storage.getUsageRecentToolCalls(1).length, 1);
      assert.equal(storage.getUsageRecentToolCalls(1)[0]?.class, "embedding");
    },
  );
});

// getUsageRecentSessions joins agent_sessions with the per-session tool rollup
// (the #12 single-pass LEFT JOIN). It reads `agent_sessions`, so it needs real
// sessions + ledger rows, not a bare ledger.
test("getUsageRecentSessions: tool rollup join — toolCost/toolCalls, no-tool session is 0/0, caption not counted (#12/#18)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Session A: has usage actuals + TWO tool invocations (rollup 0.08 + 0.02, 2 calls)
    // AND a caption-class ledger row attributed to it (must NOT be counted as tool).
    await storage.insertAgentSession(session({ id: "s-A" }));
    await storage.updateAgentSessionUsage("s-A", {
      llmRequests: 3,
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.238,
      contextTokens: 5_000,
    });
    // `completed_at` (the recent-sessions ordering key) is persisted via the status
    // update, not the insert — set it after the usage write (which stamps updated_at).
    await storage.updateAgentSessionStatus("s-A", "completed", { completedAt: 9_000, updatedAt: 9_000 });
    // Session B: a session with NO tool spend → toolCost/toolCalls must be 0/0.
    await storage.insertAgentSession(session({ id: "s-B", sessionType: "summarize" }));
    await storage.updateAgentSessionStatus("s-B", "completed", { completedAt: 8_000, updatedAt: 8_000 });

    // Ledger: two tool rows for s-A, a caption row for s-A (a co-attributed
    // background event that the rollup must ignore because class != 'tool').
    await storage.insertUsageEvent({ ts: 9_100, class: "tool", toolName: "image_generate", agentSessionId: "s-A", modelId: "gemini", costUsd: 0.08 });
    await storage.insertUsageEvent({ ts: 9_200, class: "tool", toolName: "x_search", agentSessionId: "s-A", modelId: "xs", costUsd: 0.02 });
    await storage.insertUsageEvent({ ts: 9_300, class: "caption", agentSessionId: "s-A", modelId: "flash", costUsd: 0.5 });
    await storage.waitForIdle();

    const sessions = storage.getUsageRecentSessions(50);
    const byId = new Map(sessions.map((r) => [r.sessionId, r]));

    const a = byId.get("s-A");
    assert.ok(a, "session A present");
    assert.equal(a.agentCost, 0.238, "agent-loop cost from the session aggregate");
    assert.equal(a.requests, 3);
    assert.ok(Math.abs(a.toolCost - 0.1) < 1e-9, "tool rollup = 0.08 + 0.02 (caption's 0.5 excluded)");
    assert.equal(a.toolCalls, 2, "two tool rows; the caption row is NOT counted as a tool call");

    const b = byId.get("s-B");
    assert.ok(b, "session B present");
    assert.equal(b.toolCost, 0, "a session with no tool spend coalesces to 0");
    assert.equal(b.toolCalls, 0);

    // Ordered by completed_at desc: A (9000) before B (8000).
    assert.deepEqual(
      sessions.map((r) => r.sessionId),
      ["s-A", "s-B"],
    );
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
