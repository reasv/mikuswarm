import assert from "node:assert/strict";
import test from "node:test";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { Storage, MAX_REDECRYPT_ATTEMPTS } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import {
  RedecryptionSweeper,
  decryptedCanonical,
  postDecryptStatus,
  resolveMultiAccountRetry,
  roomIdFromTimelineKey,
} from "../src/redecryption/index.js";
import type { CanonicalChatEvent, TimelineState } from "../src/types.js";
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

test("replaceUndecrypted flips body/event_json and sets the computed status, matched by id", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");
    assert.equal(status(storage, event.id), "skipped");
    // Active timeline + media content → needsEnrichment → 'pending'.
    await storage.setTimelineState(event.timelineKey, "active");

    const replaced = await store.replaceUndecrypted(
      event.id,
      (existing) => ({
        ...existing,
        body: "now decrypted",
        attachments: [{ kind: "image", filename: "x.png" } as never],
        undecryptable: undefined,
      }),
      postDecryptStatus,
    );

    assert.ok(replaced);
    assert.equal(replaced?.replaced, true, "a real write is reported");
    assert.equal(replaced?.event.body, "now decrypted");
    assert.equal(replaced?.event.undecryptable, undefined);
    assert.equal(replaced?.status, "pending", "the chosen status is returned");
    assert.equal(status(storage, event.id), "pending", "media content must re-enrich");

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
    assert.equal(utd[0]!.event.externalId, "$u1");
    assert.equal(utd[0]!.attempts, 0, "a never-probed row reports 0 attempts");
  });
});

test("replaceUndecrypted is a no-op once the row is no longer UTD", async () => {
  await withStores(async (store) => {
    const event = utdEvent({ undecryptable: undefined, body: "already plain" });
    await store.appendIfMissing(event, "pending");
    const result = await store.replaceUndecrypted(
      event.id,
      (e) => ({ ...e, body: "should not apply" }),
      postDecryptStatus,
    );
    assert.equal(result?.replaced, false, "no-op is reported as not replaced");
    assert.equal(result?.event.body, "already plain", "non-UTD rows are left untouched");
    assert.equal(result?.status, "pending", "the existing stored status is reported on a no-op");
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

    const result = await store.replaceUndecrypted(
      event.id,
      (existing) =>
        decryptedCanonical(existing, {
          eventId: "$utd",
          sender: "@alice:example.org",
          body: "thread msg",
          timestamp: new Date(existing.timestamp).toISOString(),
          relatesTo: { relType: "m.thread", eventId: "$root:example.org" },
        }),
      postDecryptStatus,
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
    await storage.setTimelineState(event.timelineKey, "active");

    // Simulate the backfill race: the row is still UTD when the sweeper reads it
    // via getUndecrypted, but a concurrent path decrypts it before the sweeper's
    // own replaceUndecrypted write lands. Wrap the store so its replaceUndecrypted
    // wins the race (decrypts the row) right before the sweeper's call no-ops.
    const racingStore = {
      getUndecrypted: (limit?: number) => store.getUndecrypted(limit),
      replaceUndecrypted: async (
        id: string,
        updater: (e: CanonicalChatEvent) => CanonicalChatEvent,
        computeStatus: (u: CanonicalChatEvent, s: TimelineState) => string,
      ) => {
        // Win the race: another writer already decrypted the row.
        await store.replaceUndecrypted(
          id,
          (existing) => ({
            ...existing,
            body: "decrypted by the racing writer",
            undecryptable: undefined,
          }),
          postDecryptStatus,
        );
        // Now the sweeper's own call must observe a non-UTD row and no-op.
        return store.replaceUndecrypted(id, updater, computeStatus);
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
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("must not re-arm enrichment on a no-op replace"),
      notifyCaptions: () => assert.fail("must not nudge captions on a no-op replace"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();

    // The row settled to the racing writer's content; the sweeper added nothing.
    // Plain text on an active timeline is 'skipped' (needsEnrichment false).
    const reloaded = store.getById(event.id);
    assert.equal(reloaded?.body, "decrypted by the racing writer");
    assert.equal(reloaded?.undecryptable, undefined);
    assert.equal(status(storage, event.id), "skipped");
  });
});

// ── Sweeper: UTD row → retry returns decrypted → replaced, status pending ──

test("sweeper replaces a UTD row when retry returns a decrypted summary and re-arms enrichment", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");
    // Active timeline so the decrypted media event enriches/captions (issue #6).
    await storage.setTimelineState(event.timelineKey, "active");

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
      notifyChatIndex: () => {},
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
      notifyChatIndex: () => {},
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

// ── #3: multi-account retry prefers a decrypting account ───────────────────

function decryptedSummary(body = "decrypted"): MatrixMessageSummary {
  return { eventId: "$e", sender: "@a:x", body, timestamp: new Date(0).toISOString() };
}
function utdSummaryFixture(): MatrixMessageSummary {
  return { eventId: "$e", sender: "@a:x", body: "", timestamp: new Date(0).toISOString(), undecryptable: true };
}

test("#3 second account decrypts when the first returns a still-UTD summary", async () => {
  const tried: string[] = [];
  const result = await resolveMultiAccountRetry(["a", "b"], async (id) => {
    tried.push(id);
    return id === "a" ? utdSummaryFixture() : decryptedSummary("from b");
  });
  assert.equal(result?.undecryptable, undefined, "a decrypted summary is preferred");
  assert.equal(result?.body, "from b");
  assert.deepEqual(tried, ["a", "b"], "both accounts are tried when the first can't decrypt");
});

test("#3 falls back to a still-UTD summary only when no account decrypts", async () => {
  const result = await resolveMultiAccountRetry(["a", "b"], async () => utdSummaryFixture());
  assert.equal(result?.undecryptable, true, "still-UTD is returned so the sweeper backs off");
});

test("#3 a decrypting account short-circuits and is preferred over a later null", async () => {
  const tried: string[] = [];
  const result = await resolveMultiAccountRetry(["a", "b"], async (id) => {
    tried.push(id);
    return decryptedSummary("from a");
  });
  assert.equal(result?.body, "from a");
  assert.deepEqual(tried, ["a"], "a decrypted result short-circuits the remaining accounts");
});

test("#3 rethrows when every account throws (must not collapse to null)", async () => {
  await assert.rejects(
    () => resolveMultiAccountRetry(["a", "b"], async () => { throw new Error("unknown room"); }),
    /unknown room/,
    "all-throw is a transient failure, not a decrypted-non-message",
  );
});

test("#3 a fetched null (non-message) wins over an account that threw", async () => {
  const result = await resolveMultiAccountRetry(["a", "b"], async (id) => {
    if (id === "a") throw new Error("unknown room");
    return null; // account b fetched & decrypted a non-message
  });
  assert.equal(result, null, "a real null return is authoritative over a throw");
});

test("#3 single account is behaviorally identical (returns its outcome)", async () => {
  assert.equal((await resolveMultiAccountRetry(["only"], async () => decryptedSummary("solo")))?.body, "solo");
  assert.equal(await resolveMultiAccountRetry(["only"], async () => null), null);
  await assert.rejects(() => resolveMultiAccountRetry(["only"], async () => { throw new Error("boom"); }), /boom/);
});

// ── #1: dead rows must not starve newer decryptable rows ───────────────────

test("#1 a wall of dead old UTD rows does not starve a newer decryptable row", async () => {
  await withStores(async (store, storage) => {
    // The give-up ceiling, plus a small batch, so the OLD dead rows would fill the
    // oldest-first window under the pre-fix query (`order by timestamp asc`).
    const DEAD = 8;
    for (let i = 0; i < DEAD; i++) {
      await store.appendIfMissing(
        utdEvent({ id: `matrix:miku:$dead${i}`, externalId: `$dead${i}`, timestamp: 1000 + i }),
        "skipped",
      );
      // Stamp each dead row to the ceiling so it's exhausted (keys will never come).
      await storage.read(() => {}); // no-op to keep types happy
      for (let n = 0; n < MAX_REDECRYPT_ATTEMPTS; n++) {
        await store.recordRedecryptFailure(`matrix:miku:$dead${i}`);
      }
    }
    // A NEWER decryptable row (larger timestamp → sorts last in oldest-first order).
    const live = utdEvent({ id: "matrix:miku:$live", externalId: "$live", timestamp: 9_999_999 });
    await store.appendIfMissing(live, "skipped");
    await storage.setTimelineState(live.timelineKey, "active");

    // Exhausted rows are excluded from the candidate set entirely.
    const rotation = store.getUndecrypted(100);
    assert.equal(rotation.length, 1, "only the live row remains in rotation");
    assert.equal(rotation[0]!.event.externalId, "$live");

    let probed: string[] = [];
    const sweeper = new RedecryptionSweeper({
      store,
      retry: async ({ eventId }) => {
        probed.push(eventId);
        return {
          eventId,
          sender: "@alice:example.org",
          body: "finally decrypted",
          timestamp: new Date(live.timestamp).toISOString(),
        };
      },
      notifyChatIndex: () => {},
      notifyEnrichment: () => {},
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 2, // small batch: dead rows would consume it under the old query
      isDraining: () => false,
    });

    await sweeper.tick();

    // Under the OLD behavior the 8 dead oldest rows would fill the window and the
    // live row would never be probed. Now it is reached and decrypted.
    assert.deepEqual(probed, ["$live"], "the newer decryptable row is probed, not starved");
    assert.equal(store.getById(live.id)?.body, "finally decrypted");
    assert.equal(store.getById(live.id)?.undecryptable, undefined);
  });
});

test("#1 a failed probe persists an attempt and a row at the ceiling retires", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    const sweeper = new RedecryptionSweeper({
      store,
      // Throws every time → transient failure → backoff + persisted attempt.
      retry: async () => {
        throw new Error("unknown room");
      },
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("no enrichment on a failed probe"),
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    const attempts = storage.read(
      (db) =>
        (db.prepare("select redecrypt_attempts from timeline_events where id = ?").get(event.id) as {
          redecrypt_attempts: number;
        }).redecrypt_attempts,
    );
    assert.equal(attempts, 1, "a failed probe persists one attempt");

    // Drive the row to the ceiling and confirm it drops out of rotation.
    for (let n = attempts; n < MAX_REDECRYPT_ATTEMPTS; n++) {
      await store.recordRedecryptFailure(event.id);
    }
    assert.equal(store.getUndecrypted(50).length, 0, "a row at the ceiling leaves the candidate set");
  });
});

test("#1 a UTD row with no resolvable room/event id is retired in the DB", async () => {
  await withStores(async (store) => {
    // A timeline key that roomIdFromTimelineKey can't parse → no room id.
    const event = utdEvent({ id: "matrix:miku:$noroom", externalId: undefined, timelineKey: "garbage-key" });
    await store.appendIfMissing(event, "skipped");

    const sweeper = new RedecryptionSweeper({
      store,
      retry: async () => assert.fail("must not attempt a re-fetch without a room id"),
      notifyChatIndex: () => {},
      notifyEnrichment: () => {},
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    // The row is retired (stamped to the sentinel) so it never returns to rotation,
    // even across a fresh sweeper with an empty in-memory backoff map.
    assert.equal(store.getUndecrypted(50).length, 0, "the unfetchable row is retired in the DB");
    assert.equal(store.getById(event.id)?.undecryptable != null, true, "row content is preserved (still UTD)");
  });
});

// ── #5 / #6: post-decrypt status mirrors live parity + inactive gating ──────

test("#5 active-timeline plain-text redecrypt stores 'skipped' and does not nudge enrichment", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");
    await storage.setTimelineState(event.timelineKey, "active");

    let enrichNudged = false;
    let captionNudged = false;
    const sweeper = new RedecryptionSweeper({
      store,
      // Plain text: no media, no replyTo, no URL → needsEnrichment false.
      retry: async ({ eventId }) => ({
        eventId,
        sender: "@alice:example.org",
        body: "just plain text",
        timestamp: new Date(event.timestamp).toISOString(),
      }),
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
    assert.equal(status(storage, event.id), "skipped", "plain text on an active timeline is 'skipped', not 'pending'");
    assert.equal(enrichNudged, false, "enrichment is not nudged for a 'skipped' event");
    assert.equal(captionNudged, false, "no captions without attachments");
    assert.equal(store.getById(event.id)?.body, "just plain text");
  });
});

test("#6 inactive-timeline redecrypt stores 'inactive' and nudges neither pool", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    // No setTimelineState call → the timeline is inactive (no compaction-state row).
    await store.appendIfMissing(event, "skipped");

    const sweeper = new RedecryptionSweeper({
      store,
      // Decrypts to MEDIA — which on an active timeline would caption — but the
      // timeline is inactive, so nothing must be nudged.
      retry: async ({ eventId }) => ({
        eventId,
        sender: "@alice:example.org",
        body: "decrypted in an inactive room",
        timestamp: new Date(event.timestamp).toISOString(),
        media: [{ index: 0, kind: "image", filename: "cat.png", contentType: "image/png", sizeBytes: 1 }],
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("must not nudge enrichment for an inactive timeline (spec §3)"),
      notifyCaptions: () => assert.fail("must not nudge captions for an inactive timeline (spec §3)"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    // Decryption STILL happened (content replaced, flag cleared) but enrichment is
    // deferred to activation via the 'inactive' status.
    assert.equal(status(storage, event.id), "inactive", "inactive-timeline redecrypt stores 'inactive'");
    assert.equal(store.getById(event.id)?.body, "decrypted in an inactive room");
    assert.equal(store.getById(event.id)?.undecryptable, undefined, "the row is still decrypted");
    assert.equal(store.getById(event.id)?.attachments?.length, 1, "media is populated for later activation");
  });
});

test("postDecryptStatus mirrors the live append path", () => {
  const plain = utdEvent({ body: "hi", undecryptable: undefined });
  const media = utdEvent({ undecryptable: undefined, attachments: [{ kind: "image", filename: "x" } as never] });
  const inactiveStates: TimelineState[] = ["inactive"];
  for (const s of inactiveStates) {
    assert.equal(postDecryptStatus(plain, s), "inactive");
    assert.equal(postDecryptStatus(media, s), "inactive");
  }
  for (const s of ["active", "activating", "backfilling"] as TimelineState[]) {
    assert.equal(postDecryptStatus(plain, s), "skipped", "plain text → skipped");
    assert.equal(postDecryptStatus(media, s), "pending", "media → pending");
  }
});

// ── #9: a UTD that decrypts to a non-message retires the row ────────────────

test("#9 retry returning null (decrypted non-message) deletes the placeholder row", async () => {
  await withStores(async (store, storage) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");
    await storage.setTimelineState(event.timelineKey, "active");

    let calls = 0;
    const sweeper = new RedecryptionSweeper({
      store,
      // null (Ok(None)) = fetched & decrypted, but a sticker/poll/reaction.
      retry: async () => {
        calls++;
        return null;
      },
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("a non-message must not enrich"),
      notifyCaptions: () => assert.fail("a non-message must not caption"),
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    assert.equal(calls, 1, "the row was probed once");
    // Under the OLD behavior the row stayed UTD and was probed forever; now it is
    // deleted (live parity: the live path never stores a non-message).
    assert.equal(store.getById(event.id), undefined, "the placeholder is removed");
    assert.equal(store.getUndecrypted(50).length, 0, "no UTD rows remain in rotation");
  });
});

test("#9 a still-UTD summary (undecryptable=true) is distinct from a null return", async () => {
  await withStores(async (store) => {
    const event = utdEvent();
    await store.appendIfMissing(event, "skipped");

    const sweeper = new RedecryptionSweeper({
      store,
      // undecryptable === true → still UTD → keep backing off (do NOT delete).
      retry: async ({ eventId }) => ({
        eventId,
        sender: "@alice:example.org",
        body: "",
        timestamp: new Date(event.timestamp).toISOString(),
        undecryptable: true,
      }),
      notifyChatIndex: () => {},
      notifyEnrichment: () => assert.fail("still-UTD must not enrich"),
      notifyCaptions: () => {},
      intervalMs: 1000,
      batchSize: 10,
      isDraining: () => false,
    });

    await sweeper.tick();
    assert.equal(store.getById(event.id)?.undecryptable != null, true, "still-UTD row is kept, not deleted");
    assert.equal(store.getUndecrypted(50).length, 1, "the row stays in rotation under backoff");
  });
});
