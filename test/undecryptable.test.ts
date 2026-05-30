import assert from "node:assert/strict";
import test from "node:test";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import {
  RedecryptionSweeper,
  decryptedCanonical,
  roomIdFromTimelineKey,
} from "../src/redecryption/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { MatrixMessageSummary } from "../src/matrix/native-types.js";

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;

function utdEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$utd`,
    externalId: "$utd",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    undecryptable: { sessionId: "session-abc" },
    ...overrides,
  };
}

// ── Rendering: human-client-style placeholder, no body leak ────────────────

test("renderCompactMessage shows a lock placeholder for UTD with sender + time, no body", () => {
  // A malicious/accidental body must never reach the model; the renderer keys
  // off `undecryptable`, not the body.
  const event = utdEvent({ body: "LEAKED SECRET PLAINTEXT" });
  const out = renderCompactMessage(event);
  assert.match(out, /unable to decrypt/);
  assert.match(out, /🔒/);
  assert.match(out, /Alice \(@alice:example\.org\)/, "sender is visible");
  assert.match(out, /2023-11-14/, "timestamp is visible");
  assert.ok(!out.includes("LEAKED SECRET PLAINTEXT"), "body must not leak");
});

test("renderRichMessage shows a lock placeholder for UTD inside the message envelope, no body", () => {
  const event = utdEvent({ body: "LEAKED SECRET PLAINTEXT" });
  const out = renderRichMessage(event);
  assert.match(out, /<message /, "keeps the rich envelope");
  assert.match(out, /sender="@alice:example\.org"/);
  assert.match(out, /unable to decrypt/);
  assert.ok(!out.includes("LEAKED SECRET PLAINTEXT"), "body must not leak");
});

test("normal (non-UTD) messages render unchanged", () => {
  const event = utdEvent({ undecryptable: undefined, body: "hello world" });
  assert.match(renderCompactMessage(event), /hello world/);
  assert.match(renderRichMessage(event), /hello world/);
});

// ── Storage: replaceUndecrypted flips body/status, matched by id ───────────

async function withStores(run: (store: TimelineStore, storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(new TimelineStore(storage), storage);
  } finally {
    storage.close();
  }
}

function status(storage: Storage, id: string): string {
  return storage.read(
    (db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get(id) as { enrichment_status: string })
        .enrichment_status,
  );
}

test("replaceUndecrypted flips body/event_json and sets enrichment_status=pending, matched by id", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");
    assert.equal(status(storage, event.id), "skipped");

    const replaced = await store.replaceUndecrypted(event.id, (existing) => ({
      ...existing,
      body: "now decrypted",
      undecryptable: undefined,
    }));

    assert.ok(replaced);
    assert.equal(replaced?.replaced, true, "a real write is reported");
    assert.equal(replaced?.event.body, "now decrypted");
    assert.equal(replaced?.event.undecryptable, undefined);
    assert.equal(status(storage, event.id), "pending", "decrypted content must re-enrich");

    const reloaded = store.getById(event.id);
    assert.equal(reloaded?.body, "now decrypted");
    assert.equal(reloaded?.undecryptable, undefined, "the persisted row clears the flag");
  });
});

test("getUndecrypted returns only UTD rows (generated column index)", async () => {
  await withStores(async (store) => {
    await store.appendIfMissing(utdEvent({ id: `matrix:${ACCOUNT}:$u1`, externalId: "$u1", timestamp: 1000 }), "skipped");
    await store.appendIfMissing(
      utdEvent({ id: `matrix:${ACCOUNT}:$plain`, externalId: "$plain", body: "hi", undecryptable: undefined, timestamp: 2000 }),
      "pending",
    );
    const utd = store.getUndecrypted(50);
    assert.equal(utd.length, 1);
    assert.equal(utd[0]!.externalId, "$u1");
  });
});

test("replaceUndecrypted is a no-op once the row is no longer UTD", async () => {
  await withStores(async (store) => {
    const event = utdEvent({ undecryptable: undefined, body: "already plain" });
    await store.appendIfMissing(event, "pending");
    const result = await store.replaceUndecrypted(event.id, (e) => ({ ...e, body: "should not apply" }));
    assert.equal(result?.replaced, false, "no-op is reported as not replaced");
    assert.equal(result?.event.body, "already plain", "non-UTD rows are left untouched");
  });
});

// ── roomId extraction (Matrix ids contain colons) ──────────────────────────

test("roomIdFromTimelineKey handles room, dm, and thread keys", () => {
  assert.equal(roomIdFromTimelineKey(`matrix:${ACCOUNT}:room:${ROOM}`), ROOM);
  assert.equal(roomIdFromTimelineKey(`matrix:${ACCOUNT}:dm:${ROOM}`), ROOM);
  assert.equal(roomIdFromTimelineKey(`matrix:${ACCOUNT}:room:${ROOM}:thread:$root:example.org`), ROOM);
  assert.equal(roomIdFromTimelineKey("not-a-matrix-key"), undefined);
});

test("decryptedCanonical clears the flag and populates body + attachments", () => {
  const existing = utdEvent();
  const summary: MatrixMessageSummary = {
    eventId: "$utd",
    sender: "@alice:example.org",
    body: "decrypted text",
    timestamp: new Date(existing.timestamp).toISOString(),
    media: [{ index: 0, kind: "image", filename: "cat.png", contentType: "image/png", sizeBytes: 12 }],
  };
  const next = decryptedCanonical(existing, summary);
  assert.equal(next.undecryptable, undefined);
  assert.equal(next.body, "decrypted text");
  assert.equal(next.attachments?.length, 1);
  assert.equal(next.attachments?.[0]!.filename, "cat.png");
  assert.equal(next.id, existing.id, "identity is preserved");
});

// ── #3: re-decrypted reply linkage + thread re-homing ─────────────────────

test("decryptedCanonical records a bare in-reply-to as replyTo", () => {
  const existing = utdEvent();
  const summary: MatrixMessageSummary = {
    eventId: "$utd",
    sender: "@alice:example.org",
    body: "decrypted reply",
    timestamp: new Date(existing.timestamp).toISOString(),
    relatesTo: { eventId: "$parent:example.org" }, // no relType → bare in-reply-to
  };
  const next = decryptedCanonical(existing, summary);
  assert.deepEqual(next.replyTo, { externalId: "$parent:example.org" });
  assert.equal(next.threadId, undefined, "a reply is not a thread message");
  assert.equal(next.timelineKey, existing.timelineKey, "reply stays on the room timeline");
});

test("decryptedCanonical re-homes an m.thread message to the thread timeline", () => {
  const existing = utdEvent();
  const summary: MatrixMessageSummary = {
    eventId: "$utd",
    sender: "@alice:example.org",
    body: "decrypted thread message",
    timestamp: new Date(existing.timestamp).toISOString(),
    relatesTo: { relType: "m.thread", eventId: "$root:example.org" },
  };
  const next = decryptedCanonical(existing, summary);
  assert.equal(next.threadId, "$root:example.org");
  assert.equal(next.timelineKey, `${ROOM_TK}:thread:$root:example.org`);
  assert.equal(next.id, existing.id, "dedup id is unchanged — only placement moves");
});

test("decryptedCanonical ignores an m.replace (edit) relation", () => {
  const existing = utdEvent();
  const summary: MatrixMessageSummary = {
    eventId: "$utd",
    sender: "@alice:example.org",
    body: "decrypted edit body",
    timestamp: new Date(existing.timestamp).toISOString(),
    relatesTo: { relType: "m.replace", eventId: "$original:example.org" },
  };
  const next = decryptedCanonical(existing, summary);
  assert.equal(next.replyTo, undefined, "an edit must not masquerade as a reply");
  assert.equal(next.threadId, undefined);
  assert.equal(next.timelineKey, existing.timelineKey);
});

test("replaceUndecrypted re-homes the stored row to the thread timeline_key", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    const result = await store.replaceUndecrypted(event.id, (existing) =>
      decryptedCanonical(existing, {
        eventId: "$utd",
        sender: "@alice:example.org",
        body: "thread msg",
        timestamp: new Date(existing.timestamp).toISOString(),
        relatesTo: { relType: "m.thread", eventId: "$root:example.org" },
      }),
    );

    assert.equal(result?.replaced, true);
    const threadKey = `${ROOM_TK}:thread:$root:example.org`;
    assert.equal(result?.event.timelineKey, threadKey);

    // The persisted row's timeline_key column is re-homed, matched by id.
    const persistedKey = storage.read(
      (db) =>
        (db.prepare("select timeline_key from timeline_events where id = ?").get(event.id) as {
          timeline_key: string;
        }).timeline_key,
    );
    assert.equal(persistedKey, threadKey, "the row moves to the thread timeline");

    const reloaded = store.getById(event.id);
    assert.equal(reloaded?.timelineKey, threadKey);
    assert.equal(reloaded?.threadId, "$root:example.org");
    assert.equal(reloaded?.undecryptable, undefined);
  });
});

// ── #7: no-op race must not re-arm enrichment or log a replacement ─────────

test("sweeper does not re-arm enrichment or captions when the replace is a no-op", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    // Simulate the backfill race: the row is still UTD when the sweeper reads it
    // via getUndecrypted, but a concurrent path decrypts it before the sweeper's
    // own replaceUndecrypted write lands. Wrap the store so its replaceUndecrypted
    // wins the race (decrypts the row) right before the sweeper's call no-ops.
    const racingStore = {
      getUndecrypted: (limit?: number) => store.getUndecrypted(limit),
      replaceUndecrypted: async (
        id: string,
        updater: (e: CanonicalChatEvent) => CanonicalChatEvent,
      ) => {
        // Win the race: another writer already decrypted the row.
        await store.replaceUndecrypted(id, (existing) => ({
          ...existing,
          body: "decrypted by the racing writer",
          undecryptable: undefined,
        }));
        // Now the sweeper's own call must observe a non-UTD row and no-op.
        return store.replaceUndecrypted(id, updater);
      },
    } as unknown as TimelineStore;

    const sweeper = new RedecryptionSweeper({
      store: racingStore,
      retry: async () => ({
        eventId: "$utd",
        sender: "@alice:example.org",
        body: "decrypted now",
        timestamp: new Date(event.timestamp).toISOString(),
      }),
      notifyEnrichment: () => assert.fail("must not re-arm enrichment on a no-op replace"),
      notifyCaptions: () => assert.fail("must not nudge captions on a no-op replace"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // The row settled to the racing writer's content; the sweeper added nothing.
    const reloaded = store.getById(event.id);
    assert.equal(reloaded?.body, "decrypted by the racing writer");
    assert.equal(reloaded?.undecryptable, undefined);
    assert.equal(status(storage, event.id), "pending");
  });
});

// ── Sweeper: UTD row → retry returns decrypted → replaced, status pending ──

test("sweeper replaces a UTD row when retry returns a decrypted summary and re-arms enrichment", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    const enriched: string[] = [];
    let captionNudges = 0;

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async ({ roomId, eventId }) => {
        assert.equal(roomId, ROOM, "roomId is parsed from the timeline key");
        assert.equal(eventId, "$utd");
        // Keys have arrived: return a normal (non-UTD) summary with media.
        return {
          eventId: "$utd",
          sender: "@alice:example.org",
          body: "decrypted now",
          timestamp: new Date(event.timestamp).toISOString(),
          media: [{ index: 0, kind: "image", filename: "cat.png", contentType: "image/png", sizeBytes: 1 }],
        };
      },
      notifyEnrichment: (id) => enriched.push(id),
      notifyCaptions: () => {
        captionNudges++;
      },
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    const reloaded = store.getById(event.id);
    assert.equal(reloaded?.body, "decrypted now");
    assert.equal(reloaded?.undecryptable, undefined);
    assert.equal(status(storage, event.id), "pending");
    assert.deepEqual(enriched, [event.id], "enrichment re-armed for the decrypted event");
    assert.equal(captionNudges, 1, "captions nudged because the decrypted event has media");
    assert.equal(store.getUndecrypted(50).length, 0, "no UTD rows remain");
  });
});

test("sweeper leaves a still-UTD row untouched and backs off", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    let calls = 0;
    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => {
        calls++;
        // Still undecryptable: keys have not arrived.
        return { eventId: "$utd", sender: "@alice:example.org", body: "", timestamp: new Date(event.timestamp).toISOString(), undecryptable: true };
      },
      notifyEnrichment: () => assert.fail("must not enrich a still-UTD event"),
      notifyCaptions: () => assert.fail("must not nudge captions"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    assert.equal(calls, 1);
    assert.equal(status(storage, event.id), "skipped", "still-UTD row keeps its placeholder status");
    assert.equal(store.getById(event.id)?.undecryptable != null, true, "still flagged UTD");

    // Immediately ticking again must back off (no second probe within the window).
    await sweeper.tick();
    assert.equal(calls, 1, "backoff prevents hammering on the next immediate tick");
  });
});
