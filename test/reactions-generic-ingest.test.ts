/**
 * Generic reaction ingest (Phase 6) — tests for the provider-agnostic ingest
 * path in src/timeline/reaction-ingest.ts and the bulk tombstone operations
 * added to storage in src/storage/database.ts.
 *
 * Matrix correctness is verified by running the same inputs through
 * adaptMatrixReactionEvent + ingestGenericReactionEvent and asserting
 * identical DB writes to the pre-Phase-6 Matrix-specific path.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { ingestReactionEvent as ingestGenericReactionEvent } from "../src/timeline/reaction-ingest.js";
import { adaptMatrixReactionEvent, ingestReactionEvent as ingestMatrixReactionEvent } from "../src/matrix/reaction-ingest.js";
import type { MatrixReactionStreamEvent } from "../src/matrix/native-types.js";
import type { ChatProviderHost, ReactionStreamEvent } from "../src/types.js";

const ACCOUNT = "default";
const ROOM = "!room:test";
const TK = `matrix:${ACCOUNT}:room:${ROOM}`;

// ── fixtures ─────────────────────────────────────────────────────────────────

function matrixAdd(
  over: Partial<MatrixReactionStreamEvent> & { reactionEventId: string },
): MatrixReactionStreamEvent {
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

function genericAdd(
  over: Partial<ReactionStreamEvent> & { reactionEventId: string },
): ReactionStreamEvent {
  return {
    action: "add",
    timelineKey: "discord:guild123:channel:456",
    targetEventId: "msg-abc",
    senderId: "discord-user-1",
    senderDisplay: "DiscordUser",
    reactedAtMs: 2000,
    kind: "unicode",
    display: "🎉",
    normalizedKey: "🎉",
    ...over,
  };
}

async function withStorage(run: (s: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-generic-ingest-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Matrix byte-identical correctness ────────────────────────────────────────

test("generic path via Matrix adapter produces byte-identical rows to the matrix-specific ingest", async () => {
  const event = matrixAdd({ reactionEventId: "$r1" });

  // Matrix-specific path (writes using matrix:account:room:roomId key).
  let via_matrix: import("../src/storage/index.js").DiscreteReactionRow[];
  await withStorage(async (storage) => {
    await ingestMatrixReactionEvent(storage, ACCOUNT, event, 9000);
    via_matrix = storage.getDiscreteReactions(["$msg1"]);
    assert.equal(via_matrix.length, 1, "matrix path should produce 1 row");
  });

  // Generic adapter path in a fresh DB.
  let via_generic: import("../src/storage/index.js").DiscreteReactionRow[];
  await withStorage(async (storage) => {
    const adapted = adaptMatrixReactionEvent(ACCOUNT, event);
    await ingestGenericReactionEvent(storage, adapted, 9000);
    via_generic = storage.getDiscreteReactions(["$msg1"]);
    assert.equal(via_generic.length, 1, "generic adapter path should produce 1 row");
  });

  const mx = via_matrix![0]!;
  const gn = via_generic![0]!;
  assert.equal(gn.reactionEventId, mx.reactionEventId);
  assert.equal(gn.timelineKey, mx.timelineKey, "timelineKey is identical");
  assert.equal(gn.targetEventId, mx.targetEventId);
  assert.equal(gn.senderId, mx.senderId);
  assert.equal(gn.senderDisplay, mx.senderDisplay);
  assert.equal(gn.kind, mx.kind);
  assert.equal(gn.display, mx.display);
  assert.equal(gn.normalizedKey, mx.normalizedKey);
});

test("adaptMatrixReactionEvent builds the correct matrix: timelineKey", () => {
  const event = matrixAdd({ reactionEventId: "$r1" });
  const adapted = adaptMatrixReactionEvent("acc1", event);
  assert.equal(adapted.timelineKey, "matrix:acc1:room:!room:test");
});

// ── Generic add / remove ──────────────────────────────────────────────────────

test("generic add ingests a Discord-shaped reaction that surfaces in the aggregate", async () => {
  await withStorage(async (storage) => {
    const outcome = await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "discord:msg-abc:🎉:discord-user-1" }),
      3000,
    );
    assert.deepEqual(outcome, { action: "upserted" });
    const agg = storage.getReactionAggregates(["msg-abc"]).get("msg-abc");
    assert.equal(agg?.length, 1);
    assert.equal(agg?.[0].display, "🎉");
  });
});

test("generic remove tombstones a previously added reaction", async () => {
  await withStorage(async (storage) => {
    const pk = "discord:msg-abc:🎉:discord-user-1";
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: pk, targetEventId: "msg-abc" }),
      3000,
    );
    const removed = await ingestGenericReactionEvent(
      storage,
      {
        action: "remove",
        reactionEventId: pk,
        timelineKey: "discord:guild123:channel:456",
        senderId: "discord-user-1",
        reactedAtMs: 4000,
      },
      4000,
    );
    assert.deepEqual(removed, { action: "tombstoned", changed: 1 });
    assert.equal(storage.getReactionAggregates(["msg-abc"]).size, 0);
  });
});

test("generic add with missing required fields is skipped, not stored", async () => {
  await withStorage(async (storage) => {
    const outcome = await ingestGenericReactionEvent(
      storage,
      {
        action: "add",
        reactionEventId: "discord:msg-abc:🎉:u1",
        timelineKey: "discord:guild123:channel:456",
        senderId: "u1",
        reactedAtMs: 1000,
        // targetEventId, kind, display, normalizedKey all absent → incomplete
      },
      2000,
    );
    assert.deepEqual(outcome, { action: "skipped", reason: "incomplete_add" });
    assert.equal(storage.getReactionAggregates(["msg-abc"]).size, 0);
  });
});

// ── Bulk tombstone operations ─────────────────────────────────────────────────

test("tombstoneReactionsByTargetEvent removes all live reactions on a target", async () => {
  await withStorage(async (storage) => {
    // Add two different emoji reactions on the same message.
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-abc", display: "🎉", normalizedKey: "🎉" }),
      1000,
    );
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-2", targetEventId: "msg-abc", senderId: "u2", display: "👍", normalizedKey: "👍" }),
      1001,
    );

    const changed = await storage.tombstoneReactionsByTargetEvent("msg-abc", 5000);
    assert.equal(changed, 2);
    assert.equal(storage.getReactionAggregates(["msg-abc"]).size, 0, "all reactions cleared");
  });
});

test("tombstoneReactionsByTargetEvent is idempotent (second call returns 0)", async () => {
  await withStorage(async (storage) => {
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-abc" }),
      1000,
    );
    await storage.tombstoneReactionsByTargetEvent("msg-abc", 5000);
    const second = await storage.tombstoneReactionsByTargetEvent("msg-abc", 6000);
    assert.equal(second, 0, "idempotent — already tombstoned");
  });
});

test("tombstoneReactionsByTargetAndKey removes only the matching emoji", async () => {
  await withStorage(async (storage) => {
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-abc", display: "🎉", normalizedKey: "🎉" }),
      1000,
    );
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-2", targetEventId: "msg-abc", senderId: "u2", display: "👍", normalizedKey: "👍" }),
      1001,
    );

    const changed = await storage.tombstoneReactionsByTargetAndKey("msg-abc", "🎉", 5000);
    assert.equal(changed, 1);

    const remaining = storage.getReactionAggregates(["msg-abc"]).get("msg-abc");
    assert.equal(remaining?.length, 1);
    assert.equal(remaining?.[0].normalizedKey, "👍", "the 👍 reaction survives");
  });
});

test("tombstoneReactionsByTargetAndKey is idempotent (second call returns 0)", async () => {
  await withStorage(async (storage) => {
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-abc", display: "🎉", normalizedKey: "🎉" }),
      1000,
    );
    await storage.tombstoneReactionsByTargetAndKey("msg-abc", "🎉", 5000);
    const second = await storage.tombstoneReactionsByTargetAndKey("msg-abc", "🎉", 6000);
    assert.equal(second, 0);
  });
});

// ── timelineKey is persisted and surfaced in DiscreteReactionRow ──────────────

test("getDiscreteReactions surfaces the timelineKey column", async () => {
  await withStorage(async (storage) => {
    const discordTK = "discord:guild123:channel:456";
    await ingestGenericReactionEvent(
      storage,
      {
        action: "add",
        reactionEventId: "pk-3",
        timelineKey: discordTK,
        targetEventId: "msg-xyz",
        senderId: "u3",
        reactedAtMs: 1000,
        kind: "unicode",
        display: "🔥",
        normalizedKey: "🔥",
      },
      2000,
    );
    const rows = storage.getDiscreteReactions(["msg-xyz"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.timelineKey, discordTK);
  });
});

// ── onBulkReactionClear host callback dispatch ────────────────────────────────
//
// These tests verify that the ChatProviderHost.onBulkReactionClear callback
// correctly dispatches to tombstoneReactionsByTargetEvent (no normalizedKey)
// or tombstoneReactionsByTargetAndKey (normalizedKey present), mirroring the
// wiring in app.ts genericHost and buildMatrixHost.

function makeBulkClearHost(storage: Storage): ChatProviderHost {
  return {
    onEvent: () => {},
    onError: () => {},
    onReaction: () => {},
    onBulkReactionClear: (args, _ctx) => {
      const now = Date.now();
      if (args.normalizedKey !== undefined) {
        void storage.tombstoneReactionsByTargetAndKey(args.targetEventId, args.normalizedKey, now);
      } else {
        void storage.tombstoneReactionsByTargetEvent(args.targetEventId, now);
      }
    },
  };
}

test("onBulkReactionClear without normalizedKey tombstones all reactions on the target", async () => {
  await withStorage(async (storage) => {
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-bulk", display: "🎉", normalizedKey: "🎉" }),
      1000,
    );
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-2", targetEventId: "msg-bulk", senderId: "u2", display: "👍", normalizedKey: "👍" }),
      1001,
    );
    assert.equal(storage.getReactionAggregates(["msg-bulk"]).get("msg-bulk")?.length, 2, "two reactions before clear");

    const host = makeBulkClearHost(storage);
    host.onBulkReactionClear!({ targetEventId: "msg-bulk" }, { accountId: "main" });
    await storage.waitForIdle();

    assert.equal(storage.getReactionAggregates(["msg-bulk"]).size, 0, "all reactions cleared after bulk-clear");
  });
});

test("onBulkReactionClear with normalizedKey tombstones only that emoji", async () => {
  await withStorage(async (storage) => {
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-1", targetEventId: "msg-bulk", display: "🎉", normalizedKey: "🎉" }),
      1000,
    );
    await ingestGenericReactionEvent(
      storage,
      genericAdd({ reactionEventId: "pk-2", targetEventId: "msg-bulk", senderId: "u2", display: "👍", normalizedKey: "👍" }),
      1001,
    );

    const host = makeBulkClearHost(storage);
    host.onBulkReactionClear!({ targetEventId: "msg-bulk", normalizedKey: "🎉" }, { accountId: "main" });
    await storage.waitForIdle();

    const remaining = storage.getReactionAggregates(["msg-bulk"]).get("msg-bulk");
    assert.equal(remaining?.length, 1, "only one emoji survives");
    assert.equal(remaining?.[0]!.normalizedKey, "👍", "the 👍 reaction survives; 🎉 was cleared");
  });
});
