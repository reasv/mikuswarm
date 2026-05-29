import assert from "node:assert/strict";
import test from "node:test";
import { performInitialBackfill, type BackfillReadClient } from "../src/backfill/index.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type {
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
  };
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
    assert.deepEqual(result, { fetched: 0, stored: 0, reachedCount: false, reachedWindow: false, exhausted: false, timedOut: false });
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

test("stops once a page crosses the window floor", async () => {
  await withStores(async (store, storage) => {
    // Seed the timeline so oldestStored = 1_000_000; windowMs = 5000 → floor = 995_000.
    await storage.appendTimelineEvent(seedEvent("seed", 1_000_000), "pending");
    const client = new ScriptedClient([
      page([summary({ eventId: "$a", timestamp: 999_000 }), summary({ eventId: "$b", timestamp: 998_000 })], "tok1"),
      page([summary({ eventId: "$c", timestamp: 996_000 }), summary({ eventId: "$d", timestamp: 994_000 })], "tok2"),
      page([summary({ eventId: "$e", timestamp: 990_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, windowMs: 5000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, true);
    assert.equal(result.stored, 4, "the crossing page is stored in full before stopping");
    assert.equal(client.calls.length, 2, "should not fetch past the window-crossing page");
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
