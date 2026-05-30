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
    assert.equal(replaced?.body, "now decrypted");
    assert.equal(replaced?.undecryptable, undefined);
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
    assert.equal(result?.body, "already plain", "non-UTD rows are left untouched");
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
