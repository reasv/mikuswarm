import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";

// v3 → v4 migration (spec MULTI-SHARED-POOL §6): add the usage_event_partitions
// overflow-membership child table. Purely ADDITIVE — no back-fill. A pool's pre-v4
// spend lives on the usage_events.budget_partition scalar and is found unchanged by
// the reseed's scalar half, so nothing needs migrating; only the empty child table
// (for future overflow memberships) is created.

const hasTable = (storage: Storage, name: string): boolean =>
  storage.read(
    (db) =>
      db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
        .get(name) !== undefined,
  );

test("v3→v4 recreates the overflow child table and preserves pre-v4 pooled spend", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-multi-pool-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      // A pre-v4 pooled event: a single shared pool on the scalar column (the only
      // form that existed before this feature — no child rows).
      await storage.insertUsageEvent({
        ts: 1_000,
        class: "agent_loop",
        modelId: "opus",
        budgetPartition: "fleet",
        costUsd: 4,
      });
      await storage.waitForIdle();
      // Simulate a v3 database: drop the child table and re-stamp the version so the
      // next open runs the v3→v4 step.
      await storage.write((db) => {
        db.exec("drop table if exists usage_event_partitions");
        db.pragma("user_version = 3");
      });
      await storage.waitForIdle();
      assert.equal(hasTable(storage, "usage_event_partitions"), false, "child table dropped for the v3 sim");
      storage.close();
    }

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 5, "migration stamps the latest version (v5 with user_identities tables)");
      assert.ok(hasTable(storage, "usage_event_partitions"), "the child table is (re)created");

      // The pre-v4 scalar pooled row is still summed by the pool reseed (scalar half of
      // the union) — no back-fill required.
      assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["fleet"] }), 4);

      // A NEW multi-pool event now spills its overflow membership to the child table;
      // the pool reseed unions old scalar + new scalar + new child correctly.
      await storage.insertUsageEvent({
        ts: 2_000,
        class: "agent_loop",
        modelId: "opus",
        budgetPartitions: ["fleet", "space:!x:hs"],
        costUsd: 6,
      });
      await storage.waitForIdle();
      // fleet = pre-v4 scalar($4) + new scalar($6) = $10.
      assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["fleet"] }), 10);
      // space:!x:hs = the new event's overflow child row ($6).
      assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["space:!x:hs"] }), 6);
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
