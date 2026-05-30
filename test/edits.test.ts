import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMatrixInboundEvent } from "../src/matrix/inbound.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore, applyEditToCanonical, editStatus } from "../src/timeline/index.js";
import { RedecryptionSweeper } from "../src/redecryption/index.js";
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
      (t) => applyEditToCanonical(t, { body: "see http://example.org", attachments: [] }),
      editStatus,
    );
    assert.ok(result.applied);
    assert.equal(result.applied && result.status, "pending", "a URL re-arms enrichment");
    assert.equal(status(storage, `matrix:${ACCOUNT}:$orig`), "pending");
  });
});

// ── (b) an edit to a missing target is skipped (no standalone row) ──────────

test("applyEditToTarget skips when the target is not stored (no standalone row)", async () => {
  await withStores(async (store, storage) => {
    const result = await store.applyEdit(
      "matrix",
      "$never-seen",
      (t) => applyEditToCanonical(t, { body: "edited", attachments: [] }),
      editStatus,
    );
    assert.equal(result.applied, false, "a missing target is reported, not inserted");
    assert.equal(rowCount(storage, ROOM_TK), 0, "the edit is never stored as a standalone message");
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
    const result = await store.applyEdit(
      "matrix",
      "$orig",
      (t) =>
        applyEditToCanonical(t, {
          body: "now with an image",
          attachments: [
            { id: "$orig:media:0", mediaType: "image", filename: "cat.png" },
          ],
        }),
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
