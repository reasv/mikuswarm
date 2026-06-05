import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
// Import the ingest module directly (not via the matrix barrel) to avoid pulling
// in the native binding, which isn't built in the unit-test environment.
import { ingestReactionEvent } from "../src/matrix/reaction-ingest.js";
import type { MatrixReactionStreamEvent } from "../src/matrix/native-types.js";

const ACCOUNT = "default";
const ROOM = "!room:test";

function addEvent(over: Partial<MatrixReactionStreamEvent> & { reactionEventId: string }): MatrixReactionStreamEvent {
  return {
    action: "add",
    roomId: ROOM,
    targetEventId: "$msg1",
    senderId: "@alice:test",
    senderDisplay: "Alice",
    reactedAtMs: 1000,
    kind: "unicode",
    display: "👍",
    normalizedKey: "👍",
    ...over,
  };
}

async function withStorage(run: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-reaction-ingest-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("add ingests a reaction that surfaces in the aggregate", async () => {
  await withStorage(async (storage) => {
    const outcome = await ingestReactionEvent(storage, ACCOUNT, addEvent({ reactionEventId: "$r1" }), 2000);
    assert.deepEqual(outcome, { action: "upserted" });
    const rows = storage.getReactionAggregates(["$msg1"]).get("$msg1");
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0].display, "👍");
    assert.equal(rows?.[0].count, 1);
  });
});

test("remove tombstones a known reaction and is a no-op for unknown ids", async () => {
  await withStorage(async (storage) => {
    await ingestReactionEvent(storage, ACCOUNT, addEvent({ reactionEventId: "$r1" }), 2000);

    const removed = await ingestReactionEvent(
      storage,
      ACCOUNT,
      { action: "remove", reactionEventId: "$r1", roomId: ROOM, senderId: "@alice:test", reactedAtMs: 3000 },
      3000,
    );
    assert.deepEqual(removed, { action: "tombstoned", changed: 1 });
    assert.equal(storage.getReactionAggregates(["$msg1"]).size, 0);

    // A redaction of a non-reaction event (the native side forwards every
    // redaction) tombstones nothing — the intended stateless no-op.
    const noop = await ingestReactionEvent(
      storage,
      ACCOUNT,
      { action: "remove", reactionEventId: "$some-message", roomId: ROOM, senderId: "@x:test", reactedAtMs: 4000 },
      4000,
    );
    assert.deepEqual(noop, { action: "tombstoned", changed: 0 });
  });
});

test("a malformed add (missing resolver fields) is skipped, not stored", async () => {
  await withStorage(async (storage) => {
    const outcome = await ingestReactionEvent(
      storage,
      ACCOUNT,
      // Drop the resolver-derived fields a real add always carries.
      { action: "add", reactionEventId: "$r1", roomId: ROOM, targetEventId: undefined, senderId: "@a:test", reactedAtMs: 1000 },
      2000,
    );
    assert.deepEqual(outcome, { action: "skipped", reason: "incomplete_add" });
    assert.equal(storage.getReactionAggregates(["$msg1"]).size, 0);
  });
});

test("ingest matches by target_event_id regardless of the room-derived timeline key", async () => {
  await withStorage(async (storage) => {
    // The target message actually lives in a DM/thread timeline, but ingest only
    // knows the room id. Matching is by target_event_id, so the aggregate is still
    // found when the renderer queries by the message's external id.
    await ingestReactionEvent(storage, ACCOUNT, addEvent({ reactionEventId: "$r1", targetEventId: "$dmMsg" }), 2000);
    const rows = storage.getReactionAggregates(["$dmMsg"]).get("$dmMsg");
    assert.equal(rows?.length, 1);
  });
});

test("observedAt is used as the tombstone timestamp", async () => {
  await withStorage(async (storage) => {
    await ingestReactionEvent(storage, ACCOUNT, addEvent({ reactionEventId: "$r1" }), 2000);
    const removed = await ingestReactionEvent(
      storage,
      ACCOUNT,
      { action: "remove", reactionEventId: "$r1", roomId: ROOM, senderId: "@alice:test", reactedAtMs: 9999 },
      7777,
    );
    // tombstoneReaction returns 1 change; the row is now excluded from views.
    assert.deepEqual(removed, { action: "tombstoned", changed: 1 });
    assert.deepEqual(storage.getDiscreteReactions(["$msg1"]), []);
  });
});
