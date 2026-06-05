import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Storage, LATEST_SCHEMA_VERSION } from "../src/storage/index.js";
import type { ReactionUpsert } from "../src/storage/index.js";

const TK = "matrix:test:room:!room";

function reaction(overrides: Partial<ReactionUpsert> & { reactionEventId: string }): ReactionUpsert {
  return {
    timelineKey: TK,
    targetEventId: "$msg1",
    senderId: "@alice:test",
    senderDisplay: "Alice",
    kind: "unicode",
    display: "👍",
    shortcode: null,
    normalizedKey: "👍",
    reactedAt: 1000,
    observedAt: 1001,
    ...overrides,
  };
}

async function withStorage(run: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-reactions-db-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("aggregate dedups by distinct sender and orders by count desc, display asc", async () => {
  await withStorage(async (storage) => {
    // Two senders thumbs-up the same target; one of them sends it twice (distinct
    // reaction event ids) — must still count once. A third reacts with a different key.
    await storage.upsertReaction(reaction({ reactionEventId: "$r1", senderId: "@alice:test" }));
    await storage.upsertReaction(reaction({ reactionEventId: "$r2", senderId: "@bob:test" }));
    await storage.upsertReaction(reaction({ reactionEventId: "$r3", senderId: "@bob:test" })); // dup sender+key
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r4", senderId: "@cy:test", display: "😮", normalizedKey: "😮" }),
    );

    const agg = storage.getReactionAggregates(TK, ["$msg1"]);
    const rows = agg.get("$msg1");
    assert.ok(rows, "msg1 should have aggregates");
    assert.equal(rows.length, 2);
    // 👍 has 2 distinct senders (alice, bob), 😮 has 1 — count desc.
    assert.deepEqual(
      rows.map((r) => [r.display, r.count]),
      [
        ["👍", 2],
        ["😮", 1],
      ],
    );
  });
});

test("upsert is idempotent on duplicate delivery of the same reaction event id", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(reaction({ reactionEventId: "$r1" }));
    // Re-deliver with a different (stale) display — must be ignored, not overwrite.
    await storage.upsertReaction(reaction({ reactionEventId: "$r1", display: "CHANGED" }));
    const rows = storage.getReactionAggregates(TK, ["$msg1"]).get("$msg1");
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0].count, 1);
    assert.equal(rows?.[0].display, "👍");
  });
});

test("tombstone removes a reaction from both views; redaction is idempotent", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(reaction({ reactionEventId: "$r1", senderId: "@alice:test" }));
    await storage.upsertReaction(reaction({ reactionEventId: "$r2", senderId: "@bob:test" }));

    const changed = await storage.tombstoneReaction("$r1", 5000);
    assert.equal(changed, 1);

    // A second redaction of the same id is a no-op (already tombstoned).
    assert.equal(await storage.tombstoneReaction("$r1", 6000), 0);
    // Redacting an unknown id (e.g. a message redaction) is a no-op.
    assert.equal(await storage.tombstoneReaction("$nonexistent", 6000), 0);

    const rows = storage.getReactionAggregates(TK, ["$msg1"]).get("$msg1");
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0].count, 1); // only bob remains
    const discrete = storage.getDiscreteReactions(TK, ["$msg1"]);
    assert.deepEqual(
      discrete.map((d) => d.reactionEventId),
      ["$r2"],
    );
  });
});

test("discrete reactions are returned oldest-first and scoped to the target set", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r2", senderId: "@bob:test", reactedAt: 2000 }),
    );
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r1", senderId: "@alice:test", reactedAt: 1000 }),
    );
    // A reaction on a different target must not leak into the msg1 query.
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r3", targetEventId: "$msg2", senderId: "@cy:test" }),
    );

    const discrete = storage.getDiscreteReactions(TK, ["$msg1"]);
    assert.deepEqual(
      discrete.map((d) => [d.reactionEventId, d.reactedAt]),
      [
        ["$r1", 1000],
        ["$r2", 2000],
      ],
    );
  });
});

test("empty target list short-circuits to empty results", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(reaction({ reactionEventId: "$r1" }));
    assert.equal(storage.getReactionAggregates(TK, []).size, 0);
    assert.deepEqual(storage.getDiscreteReactions(TK, []), []);
  });
});

test("v13 -> v14 migration creates the reactions table on an existing DB", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-reactions-migrate-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    // Build a current DB, then simulate a pre-reactions v13 database by dropping
    // the table and rewinding user_version so reopening must re-run the step.
    const built = await Storage.open({ databasePath: dbPath });
    await built.waitForIdle();
    built.close();

    const raw = new Database(dbPath);
    raw.exec("drop table reactions;");
    raw.pragma("user_version = 13");
    raw.close();

    // Reopen through Storage: runMigrations applies the v13 -> v14 step.
    const migrated = await Storage.open({ databasePath: dbPath });
    try {
      await migrated.upsertReaction(reaction({ reactionEventId: "$r1" }));
      const rows = migrated.getReactionAggregates(TK, ["$msg1"]).get("$msg1");
      assert.equal(rows?.length, 1, "reactions table should exist and accept writes after migration");
    } finally {
      await migrated.waitForIdle();
      migrated.close();
    }

    // Version was stamped forward to latest.
    const check = new Database(dbPath);
    assert.equal(check.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
    check.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom reactions carry shortcode through the aggregate", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(
      reaction({
        reactionEventId: "$r1",
        kind: "custom",
        display: ":blobwave:",
        shortcode: ":blobwave:",
        normalizedKey: "mxc://example/blobwave",
      }),
    );
    const rows = storage.getReactionAggregates(TK, ["$msg1"]).get("$msg1");
    assert.equal(rows?.[0].kind, "custom");
    assert.equal(rows?.[0].display, ":blobwave:");
    assert.equal(rows?.[0].shortcode, ":blobwave:");
    assert.equal(rows?.[0].normalizedKey, "mxc://example/blobwave");
  });
});
