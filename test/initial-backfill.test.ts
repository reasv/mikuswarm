import assert from "node:assert/strict";
import test from "node:test";
import { performInitialBackfill, type BackfillReadClient } from "../src/backfill/index.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { normalizeMatrixInboundEvent } from "../src/matrix/inbound.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type {
  MatrixInboundEvent,
  MatrixInboundMedia,
  MatrixMessageSummary,
  MatrixReadMessagesRequest,
  MatrixReadMessagesResult,
} from "../src/matrix/native-types.js";

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;
const SELF = "@miku:example.org";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function summary(overrides: Partial<MatrixMessageSummary> & { eventId: string; timestamp: number }): MatrixMessageSummary {
  return {
    eventId: overrides.eventId,
    sender: overrides.sender ?? "@alice:example.org",
    senderName: overrides.senderName,
    body: overrides.body ?? "hello",
    msgtype: overrides.msgtype ?? "m.text",
    timestamp: iso(overrides.timestamp),
    relatesTo: overrides.relatesTo,
    media: overrides.media,
    undecryptable: overrides.undecryptable,
    sessionId: overrides.sessionId,
    utdReason: overrides.utdReason,
  };
}

/** A UTD summary as the native layer surfaces it: empty body, undecryptable flag. */
function utdSummary(eventId: string, timestamp: number): MatrixMessageSummary {
  return summary({
    eventId,
    timestamp,
    body: "",
    undecryptable: true,
    sessionId: "s",
    utdReason: "missing_megolm_session",
  });
}

/** A scripted client that returns canned pages and records the `before` token of each call. */
class ScriptedClient implements BackfillReadClient {
  readonly calls: Array<string | undefined> = [];
  constructor(private readonly pages: MatrixReadMessagesResult[]) {}
  async readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult> {
    this.calls.push(request.before);
    return this.pages[this.calls.length - 1] ?? { messages: [], nextBatch: null, prevBatch: null };
  }
}

function page(messages: MatrixMessageSummary[], nextBatch: string | null): MatrixReadMessagesResult {
  return { messages, nextBatch, prevBatch: null };
}

async function withStores(run: (store: TimelineStore, storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(new TimelineStore(storage), storage);
  } finally {
    storage.close();
  }
}

const BASE = {
  roomId: ROOM,
  accountId: ACCOUNT,
  selfUserId: SELF,
  windowMs: Number.MAX_SAFE_INTEGER, // unbounded window so count/exhaustion dominate unless overridden
  timeoutMs: 10_000,
};

test("maxMessages = 0 performs no fetch", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([page([summary({ eventId: "$a", timestamp: 1000 })], null)]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 0 });
    assert.equal(client.calls.length, 0, "client should not be called");
    assert.deepEqual(result, { fetched: 0, stored: 0, reachedCount: false, reachedWindow: false, exhausted: false, timedOut: false, errored: false, haltedOnUtd: false });
  });
});

test("stores messages with canonical IDs and stops on exhaustion (no nextBatch)", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 3000 }), summary({ eventId: "$b", timestamp: 2000 })], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 2);
    assert.equal(result.exhausted, true);
    assert.equal(result.reachedCount, false);
    // Canonical ID scheme matches normalizeMatrixInboundEvent so live/backfill dedup.
    const stored = store.getById(`matrix:${ACCOUNT}:$a`);
    assert.ok(stored, "event should be stored under matrix:<account>:<eventId>");
    assert.equal(stored?.externalId, "$a");
    assert.equal(stored?.timelineKey, ROOM_TK);
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get(`matrix:${ACCOUNT}:$a`) as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "pending", "backfilled events are stored pending so they enrich");
  });
});

test("stops after maxMessages newly-stored and threads the backward pagination token", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 5000 }), summary({ eventId: "$b", timestamp: 4000 })], "tok1"),
      page([summary({ eventId: "$c", timestamp: 3000 }), summary({ eventId: "$d", timestamp: 2000 })], "tok2"),
      page([summary({ eventId: "$e", timestamp: 1000 })], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 3 });
    assert.equal(result.stored, 3);
    assert.equal(result.reachedCount, true);
    assert.equal(result.fetched, 3, "should stop mid-page once the count is reached");
    // First call has no token; second uses the first page's nextBatch.
    assert.deepEqual(client.calls, [undefined, "tok1"]);
    assert.equal(store.getById(`matrix:${ACCOUNT}:$e`), undefined, "third page should never be fetched");
  });
});

test("stops once a page crosses the window floor (anchored to activation time)", async () => {
  await withStores(async (store, storage) => {
    // anchorTimestamp = 1_000_000; windowMs = 5000 → floor = 995_000.
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 999_000 }), summary({ eventId: "$b", timestamp: 998_000 })], "tok1"),
      page([summary({ eventId: "$c", timestamp: 996_000 }), summary({ eventId: "$d", timestamp: 994_000 })], "tok2"),
      page([summary({ eventId: "$e", timestamp: 990_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, true);
    assert.equal(result.stored, 4, "the crossing page is stored in full before stopping");
    assert.equal(client.calls.length, 2, "should not fetch past the window-crossing page");
  });
});

test("window is anchored to activation time, not the oldest stored event", async () => {
  await withStores(async (store, storage) => {
    // A busy channel with months of pre-activation inactive history: the oldest
    // stored event is far in the past. Under the OLD behavior (floor = oldest -
    // windowMs) the window cap would never bite and all pages would be fetched.
    // The new anchor pins the floor to the activation moment.
    await storage.appendTimelineEvent(seedEvent("oldseed", 1_000), "inactive");
    // anchorTimestamp = 1_000_000; windowMs = 5000 → floor = 995_000.
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 999_000 }), summary({ eventId: "$b", timestamp: 998_000 })], "tok1"),
      page([summary({ eventId: "$c", timestamp: 994_000 }), summary({ eventId: "$d", timestamp: 993_000 })], "tok2"),
      page([summary({ eventId: "$e", timestamp: 990_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, true, "the window cap must bite despite old inactive history");
    assert.equal(result.stored, 4, "crossing page stored in full; later pages not fetched");
    assert.equal(client.calls.length, 2, "should stop at the window-crossing page, not paginate to exhaustion");
  });
});

test("does not count duplicates (already-stored events) toward the limit", async () => {
  await withStores(async (store, storage) => {
    // Pre-store $a as if it were the trigger event already routed.
    await store.appendIfMissing(
      { ...seedEvent("ignored", 5000), id: `matrix:${ACCOUNT}:$a`, externalId: "$a" },
      "pending",
    );
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 5000 }), summary({ eventId: "$b", timestamp: 4000 })], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.fetched, 2);
    assert.equal(result.stored, 1, "only the new $b counts; $a is a duplicate");
  });
});

test("room timeline excludes thread messages and edits; sets role and replyTo", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([
        summary({ eventId: "$plain", timestamp: 5000, sender: "@alice:example.org" }),
        summary({ eventId: "$self", timestamp: 4900, sender: SELF }),
        summary({ eventId: "$reply", timestamp: 4800, relatesTo: { eventId: "$plain" } }),
        summary({ eventId: "$thread", timestamp: 4700, relatesTo: { relType: "m.thread", eventId: "$root" } }),
        summary({ eventId: "$edit", timestamp: 4600, relatesTo: { relType: "m.replace", eventId: "$plain" } }),
      ], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.fetched, 5);
    assert.equal(result.stored, 3, "plain + self + reply; thread and edit excluded");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$thread`), undefined, "thread message excluded from room timeline");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "m.replace edit skipped");

    const self = store.getById(`matrix:${ACCOUNT}:$self`);
    assert.equal(self?.role, "assistant");
    assert.equal(self?.sender.isSelf, true);

    const reply = store.getById(`matrix:${ACCOUNT}:$reply`);
    assert.equal(reply?.replyTo?.externalId, "$plain", "bare in-reply-to becomes replyTo");
    assert.equal(reply?.role, "user");
  });
});

test("thread timeline keeps only that thread's messages", async () => {
  await withStores(async (store, storage) => {
    const threadTk = `matrix:${ACCOUNT}:room:${ROOM}:thread:$root`;
    const client = new ScriptedClient([
      page([
        summary({ eventId: "$plain", timestamp: 5000 }),
        summary({ eventId: "$mine", timestamp: 4900, relatesTo: { relType: "m.thread", eventId: "$root" } }),
        summary({ eventId: "$other", timestamp: 4800, relatesTo: { relType: "m.thread", eventId: "$otherRoot" } }),
      ], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: threadTk, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 1, "only the message in this thread");
    const mine = store.getById(`matrix:${ACCOUNT}:$mine`);
    assert.equal(mine?.timelineKey, threadTk);
    assert.equal(mine?.threadId, "$root");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$plain`), undefined, "non-thread message excluded from thread timeline");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$other`), undefined, "other thread excluded");
  });
});

test("times out when reads hang, holding no longer than timeoutMs", async () => {
  await withStores(async (store, storage) => {
    const hangingClient: BackfillReadClient = {
      readMessages: () => new Promise<MatrixReadMessagesResult>(() => {}),
    };
    const start = Date.now();
    const result = await performInitialBackfill({
      client: hangingClient, store, storage, timelineKey: ROOM_TK, ...BASE, timeoutMs: 60, maxMessages: 100,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    assert.equal(result.stored, 0);
    assert.ok(elapsed < 2000, `should give up promptly (elapsed ${elapsed}ms)`);
  });
});

test("terminates instead of spinning when the pagination token does not advance", async () => {
  await withStores(async (store, storage) => {
    // Pre-store $a so the page is all-duplicate (stored does not advance), and
    // have the homeserver return the SAME token it was just given. Without the
    // spin guard this loops until the timeout; with it, it treats history as
    // exhausted after a single non-advancing page.
    await store.appendIfMissing(
      { ...seedEvent("ignored", 5000), id: `matrix:${ACCOUNT}:$a`, externalId: "$a" },
      "pending",
    );
    const client = new ScriptedClient([
      // First page advances the token normally (undefined → "stuck").
      page([summary({ eventId: "$a", timestamp: 5000 })], "stuck"),
      // Second page returns the same token it was handed: non-advancing.
      page([summary({ eventId: "$a", timestamp: 5000 })], "stuck"),
      // Would loop forever if reached.
      page([summary({ eventId: "$a", timestamp: 5000 })], "stuck"),
    ]);
    const start = Date.now();
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, timeoutMs: 5000, maxMessages: 100,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.exhausted, true, "non-advancing token should terminate as exhausted");
    assert.equal(result.timedOut, false, "must not fall through to the timeout");
    assert.ok(elapsed < 2000, `should stop promptly, not burn the timeout (elapsed ${elapsed}ms)`);
    // First call (undefined) then second call ("stuck"); the loop breaks before a third.
    assert.deepEqual(client.calls, [undefined, "stuck"]);
  });
});

test("keeps paginating when a page is fully deduped but the token advances", async () => {
  await withStores(async (store, storage) => {
    // $a is already stored (duplicate, stored does not advance), but the token
    // advances each page — the spin guard must NOT trip here.
    await store.appendIfMissing(
      { ...seedEvent("ignored", 5000), id: `matrix:${ACCOUNT}:$a`, externalId: "$a" },
      "pending",
    );
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 5000 })], "tok1"),
      page([summary({ eventId: "$b", timestamp: 4000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100,
    });
    assert.equal(result.stored, 1, "the new $b is stored after paging past the deduped page");
    assert.equal(result.exhausted, true);
    assert.deepEqual(client.calls, [undefined, "tok1"], "advancing token keeps pagination going");
  });
});

test("sets the errored flag on a read failure mid-pagination", async () => {
  await withStores(async (store, storage) => {
    let call = 0;
    const failingClient: BackfillReadClient = {
      readMessages: async (request: MatrixReadMessagesRequest) => {
        call++;
        if (call === 1) {
          return page([summary({ eventId: "$a", timestamp: 5000 })], "tok1");
        }
        throw new Error("network down");
      },
    };
    const result = await performInitialBackfill({
      client: failingClient, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100,
    });
    assert.equal(result.errored, true, "a non-timeout read failure must set errored");
    assert.equal(result.error, "network down");
    assert.equal(result.timedOut, false, "errored is distinct from a timeout");
    assert.equal(result.exhausted, false, "errored is distinct from a clean exhaustion");
    assert.equal(result.stored, 1, "the partial page fetched before the failure is kept");
  });
});

test("backfilled media is stored as attachments with the live shape", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page(
        [
          summary({
            eventId: "$img",
            timestamp: 5000,
            msgtype: "m.image",
            body: "cat.png",
            media: [
              { index: 0, kind: "image", body: "cat.png", filename: "cat.png", contentType: "image/png", sizeBytes: 1234 },
            ],
          }),
        ],
        null,
      ),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 1);
    const stored = store.getById(`matrix:${ACCOUNT}:$img`);
    assert.ok(stored, "image event should be stored");
    assert.deepEqual(stored?.attachments, [
      {
        id: "$img:media:0",
        filename: "cat.png",
        mimeType: "image/png",
        mediaType: "image",
        sizeBytes: 1234,
        processing: { downloaded: false, captioned: false },
      },
    ]);
  });
});

// The strongest parity guard: for equivalent native media input, the backfill
// converter and the live normalizer must produce byte-for-byte identical
// `attachments`. Both routes go through the shared `mediaToAttachment` helper.
test("backfill and live produce identical attachments for equivalent media", async () => {
  const media: MatrixInboundMedia[] = [
    { index: 0, kind: "image", body: "cat.png", filename: "cat.png", contentType: "image/png", sizeBytes: 1234 },
  ];
  const eventId = "$shared";

  // Live path attachments.
  const liveEvent: MatrixInboundEvent = {
    roomId: ROOM,
    eventId,
    senderId: "@alice:example.org",
    chatType: "channel",
    body: "cat.png",
    msgtype: "m.image",
    timestamp: iso(5000),
    media,
  };
  const live = normalizeMatrixInboundEvent(liveEvent, { accountId: ACCOUNT, selfUserId: SELF });

  // Backfill path attachments (run through the full converter via the store).
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ eventId, timestamp: 5000, msgtype: "m.image", body: "cat.png", media })], null),
    ]);
    await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    const stored = store.getById(`matrix:${ACCOUNT}:${eventId}`);
    assert.deepEqual(stored?.attachments, live.event.attachments);
  });
});

// ── Undecryptable (UTD) handling (issue #11) ───────────────────────────────

test("UTD summaries are stored as placeholders with the undecryptable flag and skipped status", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([utdSummary("$utd", 5000), summary({ eventId: "$ok", timestamp: 4000 })], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 2, "both the UTD placeholder and the normal message are stored");
    const utd = store.getById(`matrix:${ACCOUNT}:$utd`);
    assert.ok(utd, "UTD event is stored, not dropped");
    assert.deepEqual(utd?.undecryptable, { sessionId: "s", reason: "missing_megolm_session" });
    assert.equal(utd?.body, "", "no plaintext leaks into the stored body");
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get(`matrix:${ACCOUNT}:$utd`) as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "skipped", "a UTD placeholder has nothing to enrich");
  });
});

test("halts paging after a long run of consecutive UTD events", async () => {
  await withStores(async (store, storage) => {
    // 55 consecutive UTD events across pages; threshold is 50.
    const first = Array.from({ length: 30 }, (_, i) => utdSummary(`$u${i}`, 100_000 - i));
    const second = Array.from({ length: 30 }, (_, i) => utdSummary(`$u${30 + i}`, 70_000 - i));
    const client = new ScriptedClient([
      page(first, "tok1"),
      page(second, "tok2"),
      page([summary({ eventId: "$never", timestamp: 1000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 1000, utdHaltThreshold: 50,
    });
    assert.equal(result.haltedOnUtd, true, "should halt on the consecutive-UTD guard");
    assert.equal(result.reachedCount, false);
    assert.equal(result.exhausted, false);
    // 30 in page 1, then 20 more in page 2 reaches 50 and breaks mid-page.
    assert.equal(result.stored, 50, "stops exactly when the threshold is hit");
    assert.equal(client.calls.length, 2, "the third page is never fetched");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$never`), undefined);
  });
});

test("a non-UTD event resets the consecutive-UTD counter", async () => {
  await withStores(async (store, storage) => {
    // 40 UTD, then one real message (resets), then 40 more UTD: never reaches 50
    // consecutive, so the run is NOT halted and pages to exhaustion.
    const utdsA = Array.from({ length: 40 }, (_, i) => utdSummary(`$a${i}`, 200_000 - i));
    const utdsB = Array.from({ length: 40 }, (_, i) => utdSummary(`$b${i}`, 150_000 - i));
    const client = new ScriptedClient([
      page([...utdsA, summary({ eventId: "$real", timestamp: 160_000 }), ...utdsB], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 1000, utdHaltThreshold: 50,
    });
    assert.equal(result.haltedOnUtd, false, "the interrupting real message resets the run below threshold");
    assert.equal(result.exhausted, true);
    assert.equal(result.stored, 81, "all 80 UTD + 1 real stored");
    assert.ok(store.getById(`matrix:${ACCOUNT}:$real`), "the interrupting message is stored");
  });
});

function seedEvent(id: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org" },
    body: "seed",
    timestamp,
    receivedAt: timestamp,
  };
}
