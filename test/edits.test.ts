import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMatrixInboundEvent } from "../src/matrix/inbound.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore, applyEditToCanonical, editStatus } from "../src/timeline/index.js";
import { RedecryptionSweeper, resolveMultiAccountRetry } from "../src/redecryption/index.js";
import type { MatrixInboundEvent, MatrixMessageSummary } from "../src/matrix/native-types.js";
import type { CanonicalChatEvent } from "../src/types.js";

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;
const CONTEXT = { accountId: ACCOUNT, selfUserId: "@miku:example.org" };

async function withStores(
  run: (store: TimelineStore, storage: Storage) => Promise<void>,
): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(new TimelineStore(storage), storage);
  } finally {
    storage.close();
  }
}

function status(storage: Storage, id: string): string | undefined {
  return storage.read(
    (db) =>
      (
        db.prepare("select enrichment_status from timeline_events where id = ?").get(id) as
          | { enrichment_status: string }
          | undefined
      )?.enrichment_status,
  );
}

function rowCount(storage: Storage, timelineKey: string): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare("select count(*) as n from timeline_events where timeline_key = ?")
          .get(timelineKey) as { n: number }
      ).n,
  );
}

function pendingEditCount(storage: Storage, timelineKey: string): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare("select count(*) as n from pending_edits where timeline_key = ?")
          .get(timelineKey) as { n: number }
      ).n,
  );
}

function targetEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$orig`,
    externalId: "$orig",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "original text",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ── Normalization: an m.replace is surfaced as an edit, not a trigger ───────

test("normalizeMatrixInboundEvent surfaces an m.replace as an edit using the new content", () => {
  // The Rust layer puts the post-edit message on body/media (from m.new_content)
  // and signals the edit via relatesTo. The normalizer must mark it as an edit
  // targeting the original event id and never attach a trigger.
  const native: MatrixInboundEvent = {
    roomId: ROOM,
    eventId: "$edit",
    senderId: "@alice:example.org",
    chatType: "channel",
    body: "edited text", // already m.new_content, not the "* fallback"
    msgtype: "m.text",
    relatesTo: { relType: "m.replace", eventId: "$orig" },
    mentions: { userIds: ["@miku:example.org"] }, // even a mention must not trigger
    timestamp: new Date(1_000).toISOString(),
    media: [],
  };

  const inbound = normalizeMatrixInboundEvent(native, CONTEXT);
  assert.deepEqual(inbound.edit, { targetExternalId: "$orig" });
  assert.equal(inbound.event.body, "edited text");
  assert.equal(inbound.trigger, undefined, "an edit must never trigger a session");
  assert.equal(inbound.event.trigger, undefined);
});

// ── (a) a live edit updates the target in place, no standalone row ──────────

test("applyEditToTarget updates the target body in place and creates no standalone row", async () => {
  await withStores(async (store, storage) => {
    const target = targetEvent();
    await store.append(target, "skipped");
    await storage.setTimelineState(ROOM_TK, "active");
    assert.equal(rowCount(storage, ROOM_TK), 1);

    const result = await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      { body: "edited text", attachments: [] },
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, { body: "edited text", attachments: [] }),
      editStatus,
    );

    assert.ok(result.applied);
    assert.equal(result.applied && result.event.body, "edited text");
    assert.equal(result.applied && result.status, "skipped", "plain text on active → skipped");
    assert.equal(rowCount(storage, ROOM_TK), 1, "no standalone row is inserted");

    const reloaded = store.getById(target.id);
    assert.equal(reloaded?.body, "edited text", "the target body is updated in place");
    assert.equal(reloaded?.id, target.id, "identity is preserved");
    assert.equal(reloaded?.timestamp, target.timestamp, "timestamps are preserved");
    assert.equal(reloaded?.sender.id, target.sender.id, "sender is preserved");
  });
});

test("applyEditToTarget re-arms enrichment when the edit introduces a URL", async () => {
  await withStores(async (store, storage) => {
    await store.append(targetEvent(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    // The edited body now contains a link → needsEnrichment → 'pending'.
    const result = await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      { body: "see http://example.org", attachments: [] },
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, { body: "see http://example.org", attachments: [] }),
      editStatus,
    );
    assert.ok(result.applied);
    assert.equal(result.applied && result.status, "pending", "a URL re-arms enrichment");
    assert.equal(status(storage, `matrix:${ACCOUNT}:$orig`), "pending");
  });
});

// ── (b) an edit to a missing target is skipped (no standalone row) ──────────

test("applyEditToTarget parks a pending edit when the target is not stored (no standalone row)", async () => {
  await withStores(async (store, storage) => {
    const result = await store.applyEdit(
      "matrix",
      "$never-seen",
      ROOM_TK,
      { body: "edited", attachments: [] },
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, { body: "edited", attachments: [] }),
      editStatus,
    );
    assert.equal(result.applied, false, "a missing target is reported, not inserted");
    assert.equal(rowCount(storage, ROOM_TK), 0, "the edit is never stored as a standalone message");
    // The edit is parked for replay (issue #12), not dropped.
    assert.equal(pendingEditCount(storage, ROOM_TK), 1, "the edit is parked in pending_edits");
  });
});

// ── (c) an edit on an inactive timeline does not nudge enrichment/captions ──

test("applyEditToTarget on an inactive timeline stores 'inactive' (no pool nudge)", async () => {
  await withStores(async (store, storage) => {
    // Target stored cheaply on an inactive timeline (no compaction-state row).
    await store.append(targetEvent(), "inactive");

    // The edit introduces MEDIA — which on an active timeline would caption — but
    // the timeline is inactive, so the status must stay 'inactive' so the caller
    // nudges neither pool (activation's bulk-flip picks it up later).
    const editReplacement = {
      body: "now with an image",
      attachments: [
        { id: "$orig:media:0", mediaType: "image" as const, filename: "cat.png" },
      ],
    };
    const result = await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      editReplacement,
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, editReplacement),
      editStatus,
    );

    assert.ok(result.applied);
    assert.equal(result.applied && result.status, "inactive", "inactive timeline stays inactive");
    assert.equal(status(storage, `matrix:${ACCOUNT}:$orig`), "inactive");
    const reloaded = store.getById(`matrix:${ACCOUNT}:$orig`);
    assert.equal(reloaded?.body, "now with an image", "content is still applied for later activation");
    assert.equal(reloaded?.attachments?.length, 1);
  });
});

// ── (d) a redecrypted m.replace applies to the target, not a standalone row ─

function utdEditPlaceholder(): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$edit`,
    externalId: "$edit",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org" },
    body: "",
    timestamp: 1_700_000_001_000,
    receivedAt: 1_700_000_001_000,
    undecryptable: { sessionId: "session-edit" },
  };
}

test("sweeper applies a decrypted m.replace to the target and deletes the placeholder", async () => {
  await withStores(async (store, storage) => {
    // The original message exists (decrypted), plus a UTD placeholder that turns
    // out to be an edit of it once its megolm key arrives.
    await store.append(targetEvent(), "skipped");
    await store.appendIfMissing(utdEditPlaceholder(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");
    assert.equal(rowCount(storage, ROOM_TK), 2);

    let enrichNudged = false;
    let captionNudged = false;
    const sweeper = new RedecryptionSweeper({
      store,
      retry: async ({ eventId }) => {
        assert.equal(eventId, "$edit");
        const summary: MatrixMessageSummary = {
          eventId: "$edit",
          sender: "@alice:example.org",
          body: "decrypted edit body",
          timestamp: new Date(1_700_000_001_000).toISOString(),
          relatesTo: { relType: "m.replace", eventId: "$orig" },
        };
        return summary;
      },
      notifyChatIndex: () => {},
      notifyEnrichment: () => {
        enrichNudged = true;
      },
      notifyCaptions: () => {
        captionNudged = true;
      },
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // The target was edited in place; the placeholder row was deleted (live
    // parity: an edit is never a standalone message).
    assert.equal(store.getById(`matrix:${ACCOUNT}:$orig`)?.body, "decrypted edit body");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "the placeholder is removed");
    assert.equal(rowCount(storage, ROOM_TK), 1, "no standalone edit row remains");
    assert.equal(store.getUndecrypted(50).length, 0, "no UTD rows remain in rotation");
    // Plain-text edit on an active timeline → 'skipped' → no pool nudges.
    assert.equal(enrichNudged, false);
    assert.equal(captionNudged, false);
  });
});

test("sweeper deletes the placeholder even when the edit's target is missing", async () => {
  await withStores(async (store, storage) => {
    // Only the UTD edit placeholder exists; the original was never stored.
    await store.appendIfMissing(utdEditPlaceholder(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => ({
        eventId: "$edit",
        sender: "@alice:example.org",
        body: "decrypted edit body",
        timestamp: new Date(1_700_000_001_000).toISOString(),
        relatesTo: { relType: "m.replace", eventId: "$missing" },
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("a missing-target edit must not enrich"),
      notifyCaptions: () => assert.fail("a missing-target edit must not caption"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // The edit fallback is not a standalone message, so the placeholder is retired
    // even though the target wasn't found.
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "the placeholder is removed");
    assert.equal(rowCount(storage, ROOM_TK), 0, "no standalone edit row remains");
    assert.equal(store.getUndecrypted(50).length, 0);
  });
});

// ── (#3) edit application is account-scoped in a multi-account shared room ────

const ACCOUNT_B = "miku2";
const ROOM_TK_B = `matrix:${ACCOUNT_B}:room:${ROOM}`;

test("applyEdit edits only the timeline_key-scoped row when two accounts share a room (#3)", async () => {
  await withStores(async (store, storage) => {
    // Two bot accounts in the same Matrix room each store the SAME event ($orig):
    // rows differ only by canonical id / timeline_key (matrix:<account>:...).
    await store.append(
      targetEvent({ id: `matrix:${ACCOUNT}:$orig`, timelineKey: ROOM_TK }),
      "skipped",
    );
    await store.append(
      targetEvent({ id: `matrix:${ACCOUNT_B}:$orig`, timelineKey: ROOM_TK_B }),
      "skipped",
    );
    await storage.setTimelineState(ROOM_TK, "active");
    await storage.setTimelineState(ROOM_TK_B, "active");

    // An edit on account B's timeline must update account B's row only.
    const replacement = { body: "edited via B", attachments: [] };
    const result = await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK_B,
      replacement,
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, replacement),
      editStatus,
    );

    assert.ok(result.applied);
    assert.equal(result.applied && result.event.timelineKey, ROOM_TK_B, "the scoped row is edited");
    assert.equal(
      store.getById(`matrix:${ACCOUNT_B}:$orig`)?.body,
      "edited via B",
      "account B's row is updated",
    );
    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "original text",
      "account A's row is untouched",
    );
  });
});

test("getByExternalId is scoped by timeline_key (#3)", async () => {
  await withStores(async (store) => {
    await store.append(
      targetEvent({ id: `matrix:${ACCOUNT}:$orig`, timelineKey: ROOM_TK, body: "A body" }),
      "skipped",
    );
    await store.append(
      targetEvent({ id: `matrix:${ACCOUNT_B}:$orig`, timelineKey: ROOM_TK_B, body: "B body" }),
      "skipped",
    );

    assert.equal(store.getByExternalId("matrix", "$orig", ROOM_TK)?.body, "A body");
    assert.equal(store.getByExternalId("matrix", "$orig", ROOM_TK_B)?.body, "B body");
  });
});

// ── (#12) edit-before-target is parked and replayed when the target lands ────

test("an edit parked before its target is replayed on append, on the live path (#12)", async () => {
  await withStores(async (store, storage) => {
    await storage.setTimelineState(ROOM_TK, "active");

    // Edit arrives FIRST — the target $orig is not stored yet. It is parked.
    const replacement = { body: "edited body", attachments: [] };
    const result = await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      replacement,
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, replacement),
      editStatus,
    );
    assert.equal(result.applied, false, "no target yet → not applied");
    assert.equal(pendingEditCount(storage, ROOM_TK), 1, "the edit is parked");
    assert.equal(rowCount(storage, ROOM_TK), 0, "no standalone row");

    // Now the target lands via the normal append path (router/backfill use
    // appendIfMissing). The pending edit must be replayed in place.
    const { event: stored } = await store.appendIfMissing(targetEvent(), "skipped");
    assert.equal(stored.body, "edited body", "appendIfMissing returns the edited event");
    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "edited body",
      "the stored target renders the edited body, not the pre-edit body",
    );
    assert.equal(pendingEditCount(storage, ROOM_TK), 0, "the pending edit is cleared after replay");
    // Plain text on an active timeline → 'skipped'.
    assert.equal(status(storage, `matrix:${ACCOUNT}:$orig`), "skipped");
  });
});

test("a replayed pending edit honors inactive-timeline gating (#12)", async () => {
  await withStores(async (store, storage) => {
    // No compaction-state row → timeline is inactive. The edit introduces media,
    // which on an active timeline would caption; on an inactive one the replay must
    // store 'inactive' so activation's bulk-flip picks it up later.
    const replacement = {
      body: "now with an image",
      attachments: [{ id: "$orig:media:0", mediaType: "image" as const, filename: "cat.png" }],
    };
    await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      replacement,
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, replacement),
      editStatus,
    );

    await store.appendIfMissing(targetEvent(), "inactive");

    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "now with an image",
      "the edit is still applied for later activation",
    );
    assert.equal(
      status(storage, `matrix:${ACCOUNT}:$orig`),
      "inactive",
      "inactive timeline keeps the replayed edit 'inactive' (no pool nudge)",
    );
  });
});

test("pending edits are latest-wins by edit timestamp (#12)", async () => {
  await withStores(async (store, storage) => {
    await storage.setTimelineState(ROOM_TK, "active");

    const parkEdit = (body: string, ts: number) =>
      store.applyEdit(
        "matrix",
        "$orig",
        ROOM_TK,
        { body, attachments: [] },
        ts,
        (t) => applyEditToCanonical(t, { body, attachments: [] }),
        editStatus,
      );

    // Three edits land out of order before the target. The newest by edit
    // timestamp must win regardless of arrival order.
    await parkEdit("older edit", 1_700_000_002_000);
    await parkEdit("NEWEST edit", 1_700_000_009_000);
    await parkEdit("middle edit (stale)", 1_700_000_005_000);
    assert.equal(pendingEditCount(storage, ROOM_TK), 1, "only one pending edit per target");

    await store.appendIfMissing(targetEvent(), "skipped");
    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "NEWEST edit",
      "the newest edit by timestamp wins",
    );
  });
});

test("a pending edit is scoped by timeline_key so it doesn't bleed across accounts (#12/#3)", async () => {
  await withStores(async (store, storage) => {
    await storage.setTimelineState(ROOM_TK, "active");
    await storage.setTimelineState(ROOM_TK_B, "active");

    // Park an edit on account A's timeline only.
    const replacement = { body: "A-only edit", attachments: [] };
    await store.applyEdit(
      "matrix",
      "$orig",
      ROOM_TK,
      replacement,
      1_700_000_002_000,
      (t) => applyEditToCanonical(t, replacement),
      editStatus,
    );

    // Account B's row for the same external id lands — it must NOT pick up A's edit.
    await store.appendIfMissing(
      targetEvent({ id: `matrix:${ACCOUNT_B}:$orig`, timelineKey: ROOM_TK_B }),
      "skipped",
    );
    assert.equal(
      store.getById(`matrix:${ACCOUNT_B}:$orig`)?.body,
      "original text",
      "account B's row is unaffected by account A's pending edit",
    );
    assert.equal(pendingEditCount(storage, ROOM_TK), 1, "A's pending edit is still parked");

    // Account A's row landing replays A's edit.
    await store.appendIfMissing(targetEvent(), "skipped");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$orig`)?.body, "A-only edit");
    assert.equal(pendingEditCount(storage, ROOM_TK), 0);
  });
});

// ── (#12) the redecryption path also parks + replays ─────────────────────────

test("a decrypted m.replace whose target is missing is parked, then replayed on append (#12)", async () => {
  await withStores(async (store, storage) => {
    // Only the UTD edit placeholder exists; the target $orig is not stored yet.
    await store.appendIfMissing(utdEditPlaceholder(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => ({
        eventId: "$edit",
        sender: "@alice:example.org",
        body: "decrypted edit body",
        timestamp: new Date(1_700_000_001_000).toISOString(),
        relatesTo: { relType: "m.replace", eventId: "$orig" },
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => {},
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // Placeholder retired; the edit is parked (not dropped) because the target
    // hasn't landed yet.
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "the placeholder is removed");
    assert.equal(pendingEditCount(storage, ROOM_TK), 1, "the decrypted edit is parked for replay");

    // The target finally lands → the parked edit is replayed in place.
    await store.appendIfMissing(targetEvent(), "skipped");
    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "decrypted edit body",
      "the target renders the decrypted edit body once it lands",
    );
    assert.equal(pendingEditCount(storage, ROOM_TK), 0, "the pending edit is cleared after replay");
  });
});

// ── (#3/#12) latest-by-origin_server_ts wins on the applied (target-present) path ─

test("two out-of-order edits on a stored target: the origin_server_ts-newer one wins (#3/#12)", async () => {
  await withStores(async (store, storage) => {
    await store.append(targetEvent(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    const applyEdit = (body: string, ts: number) =>
      store.applyEdit(
        "matrix",
        "$orig",
        ROOM_TK,
        { body, attachments: [] },
        ts,
        (t) => applyEditToCanonical(t, { body, attachments: [] }),
        editStatus,
      );

    // The NEWER edit (by origin_server_ts) arrives first; the OLDER edit arrives
    // afterward (out-of-order delivery — e.g. a re-decrypted older edit crossing
    // the live/redecryption boundary). The newer body must survive: the stale
    // older edit is a no-op. Pre-#3 (last-arrival-wins) this asserted "old body".
    const newer = await applyEdit("NEWER edit", 1_700_000_009_000);
    assert.ok(newer.applied);
    assert.equal(newer.applied && newer.event.body, "NEWER edit");

    const older = await applyEdit("older edit (stale, arrives late)", 1_700_000_002_000);
    assert.ok(older.applied, "the placeholder/caller still sees applied=true");
    assert.equal(
      older.applied && older.event.body,
      "NEWER edit",
      "the stale edit returns the already-stored newer event, unchanged",
    );

    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "NEWER edit",
      "the newer-by-origin_server_ts edit wins regardless of arrival order",
    );
  });
});

test("a newer edit still applies over an older one on the applied path (#3)", async () => {
  await withStores(async (store, storage) => {
    await store.append(targetEvent(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    const applyEdit = (body: string, ts: number) =>
      store.applyEdit(
        "matrix",
        "$orig",
        ROOM_TK,
        { body, attachments: [] },
        ts,
        (t) => applyEditToCanonical(t, { body, attachments: [] }),
        editStatus,
      );

    // In-order: older then newer — the newer wins (the guard is `<`, so an equal
    // or newer timestamp applies).
    await applyEdit("first edit", 1_700_000_002_000);
    await applyEdit("second edit", 1_700_000_005_000);
    assert.equal(store.getById(`matrix:${ACCOUNT}:$orig`)?.body, "second edit");

    // An equal-timestamp re-application is still applied (benign), mirroring the
    // pending_edits `>=` guard.
    await applyEdit("re-applied at same ts", 1_700_000_005_000);
    assert.equal(store.getById(`matrix:${ACCOUNT}:$orig`)?.body, "re-applied at same ts");
  });
});

// ── (#4) a re-decrypted edit targeting a THREAD message reaches the thread row ──

const THREAD_ROOT = "$threadroot";
const THREAD_TK = `${ROOM_TK}:thread:${THREAD_ROOT}`;

test("sweeper resolves a thread-keyed target for a re-decrypted edit (#4)", async () => {
  await withStores(async (store, storage) => {
    // The target original is a DECRYPTED THREAD message: it lives on the thread
    // timeline key, not the room key.
    await store.append(
      targetEvent({
        id: `matrix:${ACCOUNT}:$orig`,
        timelineKey: THREAD_TK,
        threadId: THREAD_ROOT,
        body: "original thread text",
      }),
      "skipped",
    );
    // The UTD edit placeholder landed on the ROOM key (its thread relation was
    // megolm-encrypted at store time).
    await store.appendIfMissing(utdEditPlaceholder(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");
    await storage.setTimelineState(THREAD_TK, "active");

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => ({
        eventId: "$edit",
        sender: "@alice:example.org",
        body: "decrypted thread edit body",
        timestamp: new Date(1_700_000_001_000).toISOString(),
        relatesTo: { relType: "m.replace", eventId: "$orig" },
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => {},
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // The edit reached the thread-keyed target (pre-#4 it parked under the room
    // key and was permanently lost).
    assert.equal(
      store.getById(`matrix:${ACCOUNT}:$orig`)?.body,
      "decrypted thread edit body",
      "the thread target renders the decrypted edit body",
    );
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "the placeholder is removed");
    // Nothing parked under either key.
    assert.equal(pendingEditCount(storage, ROOM_TK), 0, "no edit parked under the room key");
    assert.equal(pendingEditCount(storage, THREAD_TK), 0, "no edit parked under the thread key");
  });
});

test("sweeper still edits a room-keyed target and parks correctly when missing (#4 regression)", async () => {
  await withStores(async (store, storage) => {
    // Common case: the target is a plain ROOM message — resolution returns the
    // room key and the edit applies there.
    await store.append(targetEvent(), "skipped");
    await store.appendIfMissing(utdEditPlaceholder(), "skipped");
    await storage.setTimelineState(ROOM_TK, "active");

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => ({
        eventId: "$edit",
        sender: "@alice:example.org",
        body: "decrypted room edit body",
        timestamp: new Date(1_700_000_001_000).toISOString(),
        relatesTo: { relType: "m.replace", eventId: "$orig" },
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => {},
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    assert.equal(store.getById(`matrix:${ACCOUNT}:$orig`)?.body, "decrypted room edit body");
    assert.equal(pendingEditCount(storage, ROOM_TK), 0);
  });
});

// ── (#6) resolveMultiAccountRetry keeps the row alive on the defensive fallback ─

test("resolveMultiAccountRetry rethrows when every account throws (transient → keep alive) (#6)", async () => {
  const boom = new Error("room unknown to account");
  await assert.rejects(
    () =>
      resolveMultiAccountRetry(["a", "b"], async () => {
        throw boom;
      }),
    boom,
    "all-threw must rethrow (transient), never collapse to null (the retire signal)",
  );
});

test("resolveMultiAccountRetry returns null only for a genuine non-message (#6)", async () => {
  // A null fetch is the ONLY path that yields null (retire as non-message).
  const out = await resolveMultiAccountRetry(["a"], async () => null);
  assert.equal(out, null);
});

test("resolveMultiAccountRetry surfaces a still-UTD summary (keep backing off) (#6)", async () => {
  const utd: MatrixMessageSummary = {
    eventId: "$x",
    sender: "@a:e.org",
    body: "",
    timestamp: new Date(0).toISOString(),
    undecryptable: true,
  };
  const out = await resolveMultiAccountRetry(["a"], async () => utd);
  assert.equal(out, utd, "a UTD summary is returned so the sweeper keeps retrying");
});

test("resolveMultiAccountRetry does not return null when an account fetched a classifiable result (#6)", async () => {
  // The decrypted-message branch short-circuits — proving a fetched, classifiable
  // result NEVER falls through to the defensive (now-throwing) post-loop branch.
  // The post-loop `anyFetched` branch is unreachable under the contract; the
  // source change makes it THROW (keep-alive) instead of returning null, so a
  // future contract break can't silently retire/delete the placeholder.
  const decrypted: MatrixMessageSummary = {
    eventId: "$x",
    sender: "@a:e.org",
    body: "hi",
    timestamp: new Date(0).toISOString(),
  };
  const out = await resolveMultiAccountRetry(["a", "b"], async (id) => {
    if (id === "a") return decrypted; // best outcome short-circuits
    throw new Error("should not be asked");
  });
  assert.equal(out, decrypted);
});
