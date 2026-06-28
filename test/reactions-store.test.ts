import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
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

    const agg = storage.getReactionAggregates(["$msg1"]);
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

test("aggregate ordering is byte-for-byte deterministic on a (count, display) tie", async () => {
  // Two distinct normalized_key groups with equal count (1) AND equal display
  // ("👍" — different keys, same glyph): without a final normalized_key tiebreaker
  // their relative order is SQLite-undefined. The order must be stable and identical
  // every time (§9 byte-for-byte invariant).
  await withStorage(async (storage) => {
    await storage.upsertReaction(
      reaction({ reactionEventId: "$rA", senderId: "@a:test", display: "👍", normalizedKey: "kZ" }),
    );
    await storage.upsertReaction(
      reaction({ reactionEventId: "$rB", senderId: "@b:test", display: "👍", normalizedKey: "kA" }),
    );

    const first = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    const second = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    assert.deepEqual(first, second, "repeated calls must yield identical ordering");
    // normalized_key asc is the final tiebreaker → kA before kZ.
    assert.deepEqual(
      first?.map((r) => r.normalizedKey),
      ["kA", "kZ"],
    );
  });
});

test("aggregate picks a stable representative across a variation-selector split", async () => {
  // Two rows share a normalized_key (variation-selector-stripped) but their `display`
  // glyph differs ("❤️" with VS16 vs bare "❤"). The grouped `display` must be a
  // deterministic representative (min(display)), not an arbitrary row's value.
  await withStorage(async (storage) => {
    const withVs = "❤️"; // ❤️
    const bare = "❤"; // ❤
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r1", senderId: "@a:test", display: withVs, normalizedKey: "❤" }),
    );
    await storage.upsertReaction(
      reaction({ reactionEventId: "$r2", senderId: "@b:test", display: bare, normalizedKey: "❤" }),
    );

    const first = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    const second = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    assert.equal(first?.length, 1, "both rows fold into one normalized_key group");
    assert.deepEqual(first, second, "the chosen glyph must be deterministic");
    // min() of the two glyphs: bare "❤" (U+2764) sorts before "❤️" (U+2764 U+FE0F).
    assert.equal(first?.[0].display, bare);
    assert.equal(first?.[0].count, 2);
  });
});

test("upsert is idempotent on duplicate delivery of the same reaction event id", async () => {
  await withStorage(async (storage) => {
    await storage.upsertReaction(reaction({ reactionEventId: "$r1" }));
    // Re-deliver with a different (stale) display — must be ignored, not overwrite.
    await storage.upsertReaction(reaction({ reactionEventId: "$r1", display: "CHANGED" }));
    const rows = storage.getReactionAggregates(["$msg1"]).get("$msg1");
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

    const rows = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0].count, 1); // only bob remains
    const discrete = storage.getDiscreteReactions(["$msg1"]);
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

    const discrete = storage.getDiscreteReactions(["$msg1"]);
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
    assert.equal(storage.getReactionAggregates([]).size, 0);
    assert.deepEqual(storage.getDiscreteReactions([]), []);
  });
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
    const rows = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    assert.equal(rows?.[0].kind, "custom");
    assert.equal(rows?.[0].display, ":blobwave:");
    assert.equal(rows?.[0].shortcode, ":blobwave:");
    assert.equal(rows?.[0].normalizedKey, "mxc://example/blobwave");
  });
});
