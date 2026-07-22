import assert from "node:assert/strict";
import test from "node:test";
import { Storage, type AgentSessionInsert } from "../src/storage/index.js";
import type { UsageCostFilter, UsageEventInput } from "../src/storage/database.js";

// ===========================================================================
// Unified usage ledger query surface (spec USAGE-COST-LIMITS §4/§6.1/§7.1):
// sumUsageCost selectors + window bounds, insertUsageEvent room derivation, and
// the getUsage* aggregation/leaderboard queries, all over a freshly-built
// `usage_events` table seeded via insertUsageEvent.
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

// ---------------------------------------------------------------------------
// requestedModelIds null-fallback (spec PER-USER-LIMITS §7/§8.3): a sub-cap seed
// matches `requested_model_id` directly AND folds in legacy `class='agent_loop'`
// rows whose requested id is null via `logical_model_id` — but NOT null-requested
// `class='tool'` rows (issue #14: tool spend never seeds a model-scoped sub-cap).
// ---------------------------------------------------------------------------

test("sumUsageCost requestedModelIds: agent-loop-gated null-fallback excludes tool rows, no double-count (#14)", async () => {
  await withLedger(
    [
      // (a) Legacy agent-loop row: requested_model_id NULL, logical_model_id matches
      //     the sub-cap scope → counted via the null-fallback (class='agent_loop').
      { ts: 1_000, class: "agent_loop", modelId: "opus-up", logicalModelId: "opus-premium", costUsd: 1 },
      // (b) Non-legacy agent-loop row under active fallback: requested_model_id matches
      //     the scope, logical_model_id is the served BACKUP → counted ONCE by the
      //     requested branch (no double-count even though logical_model_id differs).
      { ts: 2_000, class: "agent_loop", modelId: "glm-up", logicalModelId: "glm-backup", requestedModelId: "opus-premium", costUsd: 2 },
      // (c) Non-legacy agent-loop row whose logical_model_id == the scope but whose
      //     requested_model_id is a DIFFERENT model → excluded (requested != scope, and
      //     the null-fallback does not apply because requested is non-null).
      { ts: 3_000, class: "agent_loop", modelId: "other-up", logicalModelId: "opus-premium", requestedModelId: "other-model", costUsd: 4 },
      // (d) Tool row, requested_model_id NULL, logical_model_id == the scope (e.g.
      //     x_search→Grok sharing a model name with the sub-cap) → EXCLUDED after #14:
      //     the null-fallback is gated to class='agent_loop'.
      { ts: 4_000, class: "tool", toolName: "x_search", modelId: "opus-up", logicalModelId: "opus-premium", costUsd: 8 },
    ],
    async (storage) => {
      // The opus-premium sub-cap seed: (a) legacy fallback $1 + (b) requested $2 = $3.
      // (c) other-model and (d) tool spend are both excluded.
      assert.equal(sum(storage, { since: 0, requestedModelIds: ["opus-premium"] }), 3);
      // The "other-model" sub-cap counts only (c)'s requested match — the legacy null
      // row (a) does NOT leak in (its logical is opus-premium, not other-model).
      assert.equal(sum(storage, { since: 0, requestedModelIds: ["other-model"] }), 4);
      // Row (b) is counted once, not twice: its served logical_model_id ("glm-backup")
      // does NOT separately seed a glm-backup sub-cap via the (agent-loop) null-fallback,
      // because its requested_model_id is non-null.
      assert.equal(sum(storage, { since: 0, requestedModelIds: ["glm-backup"] }), 0);
      // The tool row (d) IS still counted by the model-agnostic seeds (total / pool):
      // it draws down a fungible total (no requestedModelIds filter) as normal.
      assert.equal(sum(storage, { since: 0 }), 15); // 1 + 2 + 4 + 8
    },
  );
});

// ---------------------------------------------------------------------------
// partitionKeys (spec PER-USER-LIMITS §3.5/§8.3): a shared-pool meter reseeds off
// the denormalized `budget_partition` column. A tool-lane row MUST carry the pool
// key so the reseed includes its spend (issue #2 — the recorder backfills it).
// ---------------------------------------------------------------------------

test("sumUsageCost partitionKeys: a pooled tool row's budget_partition is included in the pool reseed (#2)", async () => {
  await withLedger(
    [
      // Agent-loop spend in the "staff" pool.
      { ts: 1_000, class: "agent_loop", modelId: "opus", budgetPartition: "staff", costUsd: 3 },
      // Tool spend in the SAME pool — stamped with budget_partition by the recorder
      // backfill (#2). Pre-fix this would persist NULL and DROP OUT of the reseed.
      { ts: 2_000, class: "tool", toolName: "x_search", modelId: "grok", budgetPartition: "staff", costUsd: 5 },
      // Unpooled spend (no budget_partition) — must NOT seed the staff pool.
      { ts: 3_000, class: "tool", toolName: "find_source", modelId: "sauce", costUsd: 7 },
      // A different pool — isolated.
      { ts: 4_000, class: "agent_loop", modelId: "opus", budgetPartition: "public", costUsd: 11 },
    ],
    async (storage) => {
      // The staff pool reseed sums BOTH the agent-loop ($3) and the tool ($5) row.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["staff"] }), 8);
      // The unpooled tool row ($7) is excluded from every pool.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["public"] }), 11);
      // Combined with a sub-cap's requestedModelIds, the pool key still scopes the seed
      // (the tool row has no requested model, so it never seeds a model-scoped pool
      // sub-cap — only the model-agnostic pool total above includes it).
      assert.equal(
        sum(storage, { since: 0, partitionKeys: ["staff"], requestedModelIds: ["grok"] }),
        0,
        "the pooled tool row does not seed a grok-scoped pool sub-cap (#14)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Overflow shared-pool memberships (spec MULTI-SHARED-POOL §4): an event joining
// 2+ distinct pools stores its FIRST key on the budget_partition scalar and spills
// the rest to usage_event_partitions. A pool reseed UNIONs the scalar + child halves,
// so a key's spend is complete no matter which storage each contributing event used —
// with no double-count (a given (event, key) pair lives in exactly one half).
// ---------------------------------------------------------------------------

test("sumUsageCost partitionKeys: overflow memberships union scalar + child, no double-count (MULTI-SHARED-POOL)", async () => {
  await withLedger(
    [
      // Two pools: first ("space:!abc") on the scalar, second ("fleet") spills to child.
      { ts: 1_000, class: "agent_loop", modelId: "opus", budgetPartitions: ["space:!abc", "fleet"], costUsd: 3 },
      // Single pool via the legacy scalar form — "fleet" on the scalar column.
      { ts: 2_000, class: "agent_loop", modelId: "opus", budgetPartition: "fleet", costUsd: 5 },
      // Two pools, order reversed: "fleet" scalar, "space:!xyz" spills to child.
      { ts: 3_000, class: "agent_loop", modelId: "opus", budgetPartitions: ["fleet", "space:!xyz"], costUsd: 7 },
    ],
    async (storage) => {
      // "fleet" spend = child(3, from row1) + scalar(5, row2) + scalar(7, row3) = 15.
      // Each row contributes to fleet via EXACTLY one half (child for row1, scalar for
      // rows 2/3) → union all, no double-count.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["fleet"] }), 15);
      // "space:!abc" only exists as row1's scalar (its first pool).
      assert.equal(sum(storage, { since: 0, partitionKeys: ["space:!abc"] }), 3);
      // "space:!xyz" only exists as row3's overflow child.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["space:!xyz"] }), 7);
      // A key present in neither half.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["nope"] }), 0);
    },
  );
});

test("sumUsageCost partitionKeys: a model-scoped pool sub-cap filters the child half too (MULTI-SHARED-POOL/#14)", async () => {
  await withLedger(
    [
      // Agent-loop event: "fleet" scalar + "solpool" overflow child, requested = sol.
      { ts: 1_000, class: "agent_loop", modelId: "sol-up", logicalModelId: "sol", requestedModelId: "sol", budgetPartitions: ["fleet", "solpool"], costUsd: 2 },
      // Tool event in the same two pools, no requested model (tool lane). The overflow
      // child row carries requested_model_id NULL → excluded from a model-scoped sub-cap.
      { ts: 2_000, class: "tool", toolName: "x_search", modelId: "grok", budgetPartitions: ["fleet", "solpool"], costUsd: 4 },
    ],
    async (storage) => {
      // The pooled sub-cap (solpool ∩ requested=sol): only the agent-loop $2 (the tool
      // child row is null-requested → dropped by the child half's requested filter).
      assert.equal(sum(storage, { since: 0, partitionKeys: ["solpool"], requestedModelIds: ["sol"] }), 2);
      // The model-agnostic solpool total counts BOTH memberships ($2 + $4) via the child
      // half (both rows spilled solpool to the child).
      assert.equal(sum(storage, { since: 0, partitionKeys: ["solpool"] }), 6);
      // A different requested model matches neither.
      assert.equal(sum(storage, { since: 0, partitionKeys: ["solpool"], requestedModelIds: ["glm"] }), 0);
      // minUsageTs also unions: oldest solpool contributor is the $2 agent-loop row.
      assert.equal(storage.minUsageTs({ since: 0, partitionKeys: ["solpool"] }), 1_000);
    },
  );
});

// ---------------------------------------------------------------------------
// New per-user filter dimensions (spec PER-USER-LIMITS §8.3): triggerSenderIds /
// roomIds / spaceIds each select the right rows and AND together with each other
// (and with the model-agnostic dimensions). The `requestedModelIds` null-fallback
// and `partitionKeys` reseed are covered above (#14/#2); this fills the remaining
// per-user seed dimensions and a representative AND-combination (issue #15).
// ---------------------------------------------------------------------------

test("sumUsageCost: triggerSenderIds / roomIds / spaceIds select the right rows and AND together (#15)", async () => {
  await withLedger(
    [
      // Alice in room !r1 (space !sX): two agent-loop rows.
      { ts: 1_000, class: "agent_loop", triggerSenderId: "@alice:hs", timelineKey: "matrix:miku:room:!r1:hs", spaceId: "!sX:hs", modelId: "opus", costUsd: 1 },
      { ts: 1_100, class: "agent_loop", triggerSenderId: "@alice:hs", timelineKey: "matrix:miku:room:!r1:hs", spaceId: "!sX:hs", modelId: "opus", costUsd: 2 },
      // Alice in a DIFFERENT room !r2 (space !sY).
      { ts: 2_000, class: "agent_loop", triggerSenderId: "@alice:hs", timelineKey: "matrix:miku:room:!r2:hs", spaceId: "!sY:hs", modelId: "opus", costUsd: 4 },
      // Bob in room !r1 (space !sX).
      { ts: 3_000, class: "agent_loop", triggerSenderId: "@bob:hs", timelineKey: "matrix:miku:room:!r1:hs", spaceId: "!sX:hs", modelId: "opus", costUsd: 8 },
    ],
    async (storage) => {
      // triggerSenderIds (the per-user {user_id} seed): Alice = 1+2+4 = 7; Bob = 8.
      assert.equal(sum(storage, { since: 0, triggerSenderIds: ["@alice:hs"] }), 7);
      assert.equal(sum(storage, { since: 0, triggerSenderIds: ["@bob:hs"] }), 8);
      // OR-within-list across senders.
      assert.equal(sum(storage, { since: 0, triggerSenderIds: ["@alice:hs", "@bob:hs"] }), 15);

      // roomIds (the room-scoped seed, matched on the DERIVED bare room id): !r1 holds
      // Alice's two ($3) + Bob's ($8) = $11; !r2 holds Alice's $4.
      assert.equal(sum(storage, { since: 0, roomIds: ["!r1:hs"] }), 11);
      assert.equal(sum(storage, { since: 0, roomIds: ["!r2:hs"] }), 4);

      // spaceIds (the canonical-parent-space seed): !sX holds !r1's three rows ($11);
      // !sY holds the lone !r2 row ($4).
      assert.equal(sum(storage, { since: 0, spaceIds: ["!sX:hs"] }), 11);
      assert.equal(sum(storage, { since: 0, spaceIds: ["!sY:hs"] }), 4);

      // AND across dimensions: a room/space-NARROWED per-user seed (sender + room +
      // space) selects only Alice's spend inside !r1/!sX — her $4 in !r2 drops out and
      // Bob's $8 in !r1 drops out. The result ($3) is strictly less than any single
      // dimension, proving the dimensions intersect rather than union.
      assert.equal(
        sum(storage, { since: 0, triggerSenderIds: ["@alice:hs"], roomIds: ["!r1:hs"], spaceIds: ["!sX:hs"] }),
        3,
      );
      // A combo with no overlapping row → 0 (Bob never spent in !r2).
      assert.equal(sum(storage, { since: 0, triggerSenderIds: ["@bob:hs"], roomIds: ["!r2:hs"] }), 0);
    },
  );
});

// ---------------------------------------------------------------------------
// `room_id` derivation AT INSERT (spec PER-USER-LIMITS §8.3 / §16 Q2): the real
// insert path must denormalize the bare room id from each `timeline_key` shape so
// the `room:{room_id}` partition + room-scoped seed agree with the engine's ctx.
// Exercises the persisted column via insertUsageEvent (not a pre-stamped value).
// ---------------------------------------------------------------------------

test("insertUsageEvent: room_id is DERIVED from timeline_key at insert across room/dm/thread/malformed (#15)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // `insertUsageEvent` mints its own id, so each row is pinned by a unique `ts`
    // (used here purely as a selector — windows are wide-open in the reads below).
    await storage.insertUsageEvent({ ts: 1_000, class: "agent_loop", modelId: "m", costUsd: 1, timelineKey: "matrix:miku:room:!abc:hs.org" });
    await storage.insertUsageEvent({ ts: 2_000, class: "agent_loop", modelId: "m", costUsd: 1, timelineKey: "matrix:miku:dm:!dmroom:hs.org" });
    await storage.insertUsageEvent({ ts: 3_000, class: "agent_loop", modelId: "m", costUsd: 1, timelineKey: "matrix:miku:room:!abc:hs.org:thread:$root" });
    await storage.insertUsageEvent({ ts: 4_000, class: "agent_loop", modelId: "m", costUsd: 1, timelineKey: "not-a-timeline-key" });
    await storage.insertUsageEvent({ ts: 5_000, class: "agent_loop", modelId: "m", costUsd: 1 }); // no timeline_key at all
    await storage.waitForIdle();

    const roomIdAt = (ts: number): string | null =>
      storage.read((db) => (db.prepare(`select room_id from usage_events where ts = ?`).get(ts) as { room_id: string | null }).room_id);

    assert.equal(roomIdAt(1_000), "!abc:hs.org", "bare room id for a room key");
    assert.equal(roomIdAt(2_000), "!dmroom:hs.org", "bare room id for a dm key");
    assert.equal(roomIdAt(3_000), "!abc:hs.org", "thread suffix stripped → same bare room id");
    assert.equal(roomIdAt(4_000), null, "malformed key → null room_id");
    assert.equal(roomIdAt(5_000), null, "absent timeline_key → null room_id");

    // The derived room_id is what the roomIds seed filter matches on — a room and its
    // thread sub-key collapse to one bare-room meter (the load-bearing property).
    assert.equal(sum(storage, { since: 0, roomIds: ["!abc:hs.org"] }), 2, "room + thread rows share one bare-room meter");
    assert.equal(sum(storage, { since: 0, roomIds: ["!dmroom:hs.org"] }), 1);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
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
      const summary = storage.getUsageSummary(0, 10_000);
      assert.equal(summary.since, 0);
      assert.equal(summary.now, 10_000, "echoes the `now` it was computed against");
      assert.equal(summary.firstTs, 1_000, "firstTs is the earliest event ts within the window");
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
      // A window that starts after every event has no data start to anchor averages to.
      assert.equal(storage.getUsageSummary(5_000, 10_000).firstTs, null);
    },
  );
});

test("getUsageSummary/getUsageTimeseries: by-model groups on the upstream model_id, not the logical/virtual block name", async () => {
  // The cost page reports real-model spend. A virtual block ("default") and a
  // legacy row that carried the bare wire id in logical_model_id both resolve to
  // the SAME upstream model and must collapse into one bucket — not split by
  // whether the row predates the logical-id column.
  await withLedger(
    [
      // Virtual model "default" routing to the real GLM-5.2 upstream.
      { ts: 1_000, class: "agent_loop", modelId: "glm-5.2", logicalModelId: "default", costUsd: 3 },
      // Legacy/other-lane row: logical defaults to the same wire id.
      { ts: 2_000, class: "agent_loop", modelId: "glm-5.2", logicalModelId: "glm-5.2", costUsd: 5 },
      // A genuinely different upstream stays its own bucket.
      { ts: 3_000, class: "tool", toolName: "x_search", modelId: "grok", logicalModelId: "grok", costUsd: 2 },
    ],
    async (storage) => {
      const byModel = new Map(storage.getUsageSummary(0, 10_000).byModel.map((r) => [r.model, r]));
      assert.equal(byModel.get("glm-5.2")?.cost, 8, "virtual + legacy rows merge on the real wire id");
      assert.equal(byModel.get("glm-5.2")?.events, 2);
      assert.equal(byModel.get("grok")?.cost, 2);
      assert.equal(byModel.has("default"), false, "the virtual block name never appears as its own bucket");

      const series = storage.getUsageTimeseries(0, 3_600_000, "model");
      assert.equal(
        series.filter((r) => r.grp === "glm-5.2").reduce((s, r) => s + r.cost, 0),
        8,
        "timeseries also groups by the real wire id",
      );
      assert.equal(series.some((r) => r.grp === "default"), false);
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

// ---------------------------------------------------------------------------
// getUsageLeaderboard: per-actor spend ranking (§7.1 leaderboard tab). Humans are
// attributed by trigger_sender_id (system session types excluded), ranked 1..N,
// zero-spend dropped; null-sender background spend is excluded but still counted in
// grandTotal. Display name resolves to the most-recent NON-null agent_sessions name.
// `userStats` carries mean/median over the non-zero humans. System actors are covered
// in the next test. Each carded actor carries its per-bucket series.
// ---------------------------------------------------------------------------

test("getUsageLeaderboard: ranks by spend, resolves latest name, excludes null-sender, buckets series", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Sessions exist ONLY to resolve display names. Alice has three: the most-recent
    // carries a NULL name (must be skipped by the `is not null` filter), so the latest
    // NON-null name ("Alice Cooper", updated 9000) wins over the older "Alice" (5000).
    // Bob has one. Carol has NONE → her display name resolves to null.
    await storage.insertAgentSession(
      session({ id: "s-alice-old", triggerExternalId: "$a-old", triggerSenderId: "@alice:x", triggerSenderDisplayName: "Alice", updatedAt: 5_000 }),
    );
    await storage.insertAgentSession(
      session({ id: "s-alice-new", triggerExternalId: "$a-new", triggerSenderId: "@alice:x", triggerSenderDisplayName: "Alice Cooper", updatedAt: 9_000 }),
    );
    await storage.insertAgentSession(
      session({ id: "s-alice-null", triggerExternalId: "$a-null", triggerSenderId: "@alice:x", triggerSenderDisplayName: null, updatedAt: 9_999 }),
    );
    await storage.insertAgentSession(
      session({ id: "s-bob", triggerExternalId: "$b", triggerSenderId: "@bob:x", triggerSenderDisplayName: "Bob", updatedAt: 6_000 }),
    );

    // Ledger. bucketMs = 1000 below, so `ts/1000` floors to the bucket start.
    // Alice: 3 events across TWO sessions (distinct-session count = 2), total 6;
    //   bucket 1000 → 3, bucket 2000 → 2 + 1 = 3.
    await storage.insertUsageEvent({ ts: 1_000, class: "agent_loop", agentSessionId: "s-alice-new", triggerSenderId: "@alice:x", modelId: "opus", costUsd: 3 });
    await storage.insertUsageEvent({ ts: 2_000, class: "tool", toolName: "x_search", agentSessionId: "s-alice-old", triggerSenderId: "@alice:x", modelId: "xs", costUsd: 2 });
    await storage.insertUsageEvent({ ts: 2_000, class: "agent_loop", agentSessionId: "s-alice-new", triggerSenderId: "@alice:x", modelId: "opus", costUsd: 1 });
    // Bob: 1 event, total 4; bucket 3000 → 4.
    await storage.insertUsageEvent({ ts: 3_000, class: "agent_loop", agentSessionId: "s-bob", triggerSenderId: "@bob:x", modelId: "opus", costUsd: 4 });
    // Carol: 1 event, total 0.1, but NO agent_sessions row → displayName null.
    await storage.insertUsageEvent({ ts: 500, class: "agent_loop", agentSessionId: "s-carol", triggerSenderId: "@carol:x", modelId: "opus", costUsd: 0.1 });
    // Null-sender background spend: excluded from users, counted in grandTotal.
    await storage.insertUsageEvent({ ts: 1_500, class: "caption", modelId: "flash", costUsd: 0.5 });
    await storage.insertUsageEvent({ ts: 1_600, class: "embedding", modelId: "emb", costUsd: 0.25 });
    await storage.waitForIdle();

    const lb = storage.getUsageLeaderboard(0, 10_000, 1_000, 10);

    // Envelope: echoes now/bucketMs; grandTotal counts EVERY event (incl. null-sender).
    assert.equal(lb.now, 10_000);
    assert.equal(lb.bucketMs, 1_000);
    assert.ok(Math.abs(lb.grandTotal - 10.85) < 1e-9, "grandTotal = 6 + 4 + 0.1 + 0.5 + 0.25");

    // Three attributable users, ranked by spend desc; null-sender rows are NOT users.
    assert.deepEqual(
      lb.users.map((u) => u.senderId),
      ["@alice:x", "@bob:x", "@carol:x"],
    );

    const [alice, bob, carol] = lb.users;
    // Alice: latest NON-null name wins; totals/counts; distinct-session count = 2.
    assert.equal(alice!.displayName, "Alice Cooper");
    assert.ok(Math.abs(alice!.total - 6) < 1e-9);
    assert.equal(alice!.events, 3);
    assert.equal(alice!.sessions, 2, "distinct agent_session_id across her ledger rows");
    assert.equal(alice!.firstTs, 1_000);
    assert.equal(alice!.lastTs, 2_000);
    // Per-bucket series (ascending); the two ts=2000 rows fold: 1000→3, 2000→(2+1)=3.
    assert.deepEqual(alice!.series, [
      { bucket: 1_000, cost: 3 },
      { bucket: 2_000, cost: 3 },
    ]);

    // Bob: single session/event.
    assert.equal(bob!.displayName, "Bob");
    assert.equal(bob!.total, 4);
    assert.equal(bob!.events, 1);
    assert.equal(bob!.sessions, 1);
    assert.deepEqual(bob!.series, [{ bucket: 3_000, cost: 4 }]);

    // Carol: a spender with no session row resolves to a null display name.
    assert.equal(carol!.displayName, null);
    assert.ok(Math.abs(carol!.total - 0.1) < 1e-9);

    // Every user is kind:'user' with a contiguous 1..N rank.
    assert.deepEqual(lb.users.map((u) => u.kind), ["user", "user", "user"]);
    assert.deepEqual(lb.users.map((u) => u.rank), [1, 2, 3]);

    // No system session types here → no system actors.
    assert.deepEqual(lb.systemActors, []);

    // Reference stats over the (non-zero) human users: mean and median of [6, 4, 0.1].
    assert.equal(lb.userStats.count, 3);
    assert.ok(Math.abs(lb.userStats.average - 10.1 / 3) < 1e-9);
    assert.equal(lb.userStats.median, 4, "median of sorted [6, 4, 0.1]");

    // limit is honored: top-1 is the highest spender only, grandTotal unaffected.
    const top1 = storage.getUsageLeaderboard(0, 10_000, 1_000, 1);
    assert.equal(top1.users.length, 1);
    assert.equal(top1.users[0]?.senderId, "@alice:x");
    assert.ok(Math.abs(top1.grandTotal - 10.85) < 1e-9, "grandTotal is independent of the limit");

    // A window starting after every event → no users, grandTotal 0.
    const empty = storage.getUsageLeaderboard(50_000, 60_000, 1_000, 10);
    assert.equal(empty.users.length, 0);
    assert.equal(empty.grandTotal, 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

// getUsageLeaderboard: non-human/self workloads are attributed by session_type and
// returned SEPARATELY from the human ranking. summarize+condense collapse to one
// "Summarization" actor; diary → "Diary"; proactive → "Proactive". Each carries a
// comparisonRank (where it would sit among users) and is excluded from `users` even
// when (as for proactive) it has a non-null sender.
// ---------------------------------------------------------------------------

test("getUsageLeaderboard: system actors split by session_type, comparisonRank, excluded from users", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Humans: Alice 10, Bob 4.
    await storage.insertUsageEvent({ ts: 1_000, class: "agent_loop", sessionType: "default", agentSessionId: "s-alice", triggerSenderId: "@alice:x", modelId: "opus", costUsd: 10 });
    await storage.insertUsageEvent({ ts: 1_000, class: "agent_loop", sessionType: "default", agentSessionId: "s-bob", triggerSenderId: "@bob:x", modelId: "opus", costUsd: 4 });

    // System workloads. summarize(5) + condense(1) → Summarization 6; diary 3;
    // proactive 8 carries the bot's OWN sender (non-null) yet must not be a user.
    await storage.insertUsageEvent({ ts: 2_000, class: "agent_loop", sessionType: "summarize", agentSessionId: "s-sum", triggerSenderId: "system", modelId: "opus", costUsd: 5 });
    await storage.insertUsageEvent({ ts: 2_000, class: "agent_loop", sessionType: "condense", agentSessionId: "s-con", triggerSenderId: "system", modelId: "opus", costUsd: 1 });
    await storage.insertUsageEvent({ ts: 3_000, class: "agent_loop", sessionType: "diary", agentSessionId: "s-diary", triggerSenderId: "system", modelId: "opus", costUsd: 3 });
    await storage.insertUsageEvent({ ts: 3_000, class: "agent_loop", sessionType: "proactive", agentSessionId: "s-pro", triggerSenderId: "@miku:x", modelId: "opus", costUsd: 8 });
    // A diary tool row with a NULL sender — still attributed to Diary by its type.
    await storage.insertUsageEvent({ ts: 3_500, class: "tool", toolName: "find_source", sessionType: "diary", agentSessionId: "s-diary", modelId: "sauce", costUsd: 1 });
    await storage.waitForIdle();

    const lb = storage.getUsageLeaderboard(0, 10_000, 1_000, 10);

    // Users: only the two humans; the bot's @miku sender does NOT leak in via proactive.
    assert.deepEqual(lb.users.map((u) => u.senderId), ["@alice:x", "@bob:x"]);
    assert.deepEqual(lb.users.map((u) => u.rank), [1, 2]);

    // System actors, by spend desc: Proactive 8, Summarization 6, Diary (3 + 1 tool) 4.
    assert.deepEqual(lb.systemActors.map((a) => a.senderId), ["Proactive", "Summarization", "Diary"]);
    assert.deepEqual(lb.systemActors.map((a) => a.displayName), ["Proactive", "Summarization", "Diary"]);
    assert.deepEqual(lb.systemActors.map((a) => a.kind), ["system", "system", "system"]);
    assert.deepEqual(lb.systemActors.map((a) => a.total), [8, 6, 4]);
    // comparisonRank = 1 + (#users outspending it): Proactive 8 → only Alice(10) → 2;
    // Summarization 6 → Alice → 2; Diary 4 → Alice → 2 (Bob is 4, not strictly >4).
    assert.deepEqual(lb.systemActors.map((a) => a.comparisonRank), [2, 2, 2]);

    // System actors carry a per-bucket series too (for their cards).
    const summ = lb.systemActors.find((a) => a.senderId === "Summarization")!;
    assert.deepEqual(summ.series, [{ bucket: 2_000, cost: 6 }]);

    // userStats over the humans [10, 4]: mean 7, median 7.
    assert.equal(lb.userStats.count, 2);
    assert.equal(lb.userStats.average, 7);
    assert.equal(lb.userStats.median, 7);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
