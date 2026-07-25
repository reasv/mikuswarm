import assert from "node:assert/strict";
import test from "node:test";
import { performInitialBackfill, type BackfillReadClient } from "../src/backfill/index.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { normalizeMatrixInboundEvent, mediaToAttachment } from "../src/matrix/inbound.js";
import type { CanonicalChatEvent, HistoryPageRequest, HistoryPageResult, HistorySummary } from "../src/types.js";
import type {
  MatrixInboundEvent,
  MatrixInboundMedia,
} from "../src/matrix/native-types.js";

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;
const SELF = "@miku:example.org";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function summary(overrides: {
  externalId: string;
  timestamp: number;
  sender?: string;
  senderName?: string;
  body?: string;
  msgtype?: string;
  /** Plain bare-reply (no relType). Mutually exclusive with thread/edit fields. */
  replyToExternalId?: string;
  /** Set when this message replaces another (m.replace rel). */
  edited?: boolean;
  editTargetExternalId?: string;
  /** Set when this message belongs to a thread (m.thread rel). */
  threadRootExternalId?: string;
  media?: MatrixInboundMedia[];
  undecryptable?: boolean;
  sessionId?: string;
  utdReason?: string;
}): HistorySummary {
  return {
    externalId: overrides.externalId,
    sender: { id: overrides.sender ?? "@alice:example.org", displayName: overrides.senderName },
    timestamp: overrides.timestamp,
    body: overrides.body ?? "hello",
    attachments: overrides.media
      ? overrides.media.map((m) => mediaToAttachment(overrides.externalId, m))
      : undefined,
    replyToExternalId: overrides.replyToExternalId,
    edited: overrides.edited,
    editTargetExternalId: overrides.editTargetExternalId,
    threadRootExternalId: overrides.threadRootExternalId,
    undecryptable: overrides.undecryptable ? true : undefined,
    sessionId: overrides.sessionId,
    utdReason: overrides.utdReason,
  };
}

/** A UTD summary as the native layer surfaces it: empty body, undecryptable flag. */
function utdSummary(externalId: string, timestamp: number): HistorySummary {
  return summary({
    externalId,
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
  readonly limits: Array<number | undefined> = [];
  constructor(private readonly pages: HistoryPageResult[]) {}
  async readMessages(request: HistoryPageRequest): Promise<HistoryPageResult> {
    this.calls.push(request.before);
    this.limits.push(request.limit);
    return this.pages[this.calls.length - 1] ?? { messages: [], nextCursor: undefined };
  }
}

function page(messages: HistorySummary[], nextCursor: string | null): HistoryPageResult {
  return { messages, nextCursor: nextCursor ?? undefined };
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
    const client = new ScriptedClient([page([summary({ externalId: "$a", timestamp: 1000 })], null)]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 0 });
    assert.equal(client.calls.length, 0, "client should not be called");
    assert.deepEqual(result, { fetched: 0, stored: 0, reachedCount: false, reachedWindow: false, exhausted: false, timedOut: false, errored: false, haltedOnUtd: false });
  });
});

test("stores messages with canonical IDs and stops on exhaustion (no nextBatch)", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ externalId: "$a", timestamp: 3000 }), summary({ externalId: "$b", timestamp: 2000 })], null),
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
    // #4: backfilled non-UTD events are stored 'inactive' (NOT 'pending') so a
    // failed activation leaves no enrichable rows under an inactive timeline; the
    // post-readiness activateTimelineEvents bulk-flip activates them on success.
    assert.equal(status, "inactive", "backfilled events are stored inactive, flipped to pending by the activation bulk-flip");
  });
});

test("#4: a successful activation bulk-flips backfilled 'inactive' events to 'pending'", async () => {
  // Backfill stores non-UTD events 'inactive'. The activation bulk-flip
  // (activateTimelineEvents: 'inactive'→'pending') runs only after readiness
  // succeeds, promoting the backfilled rows. (The failed-activation invariant —
  // rows stay 'inactive' when readiness throws before the flip — is covered in
  // test/activation-flow.test.ts "#4: a backfilled 'inactive' event stays
  // 'inactive' (NOT pending) when activation fails after the fetch phase".)
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ externalId: "$a", timestamp: 3000 }), summary({ externalId: "$b", timestamp: 2000 })], null),
    ]);
    await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });

    const statusesAfterBackfill = storage.read((db) =>
      Object.fromEntries(
        (db.prepare("select id, enrichment_status from timeline_events").all() as Array<{ id: string; enrichment_status: string }>)
          .map((r) => [r.id, r.enrichment_status]),
      ),
    );
    assert.equal(statusesAfterBackfill[`matrix:${ACCOUNT}:$a`], "inactive");
    assert.equal(statusesAfterBackfill[`matrix:${ACCOUNT}:$b`], "inactive");

    // SUCCESSFUL activation: the bulk-flip promotes them to 'pending'.
    const flipped = await storage.activateTimelineEvents(ROOM_TK);
    assert.equal(flipped, 2, "both backfilled rows are flipped by the bulk activation");
    const statusesAfterFlip = storage.read((db) =>
      Object.fromEntries(
        (db.prepare("select id, enrichment_status from timeline_events").all() as Array<{ id: string; enrichment_status: string }>)
          .map((r) => [r.id, r.enrichment_status]),
      ),
    );
    assert.equal(statusesAfterFlip[`matrix:${ACCOUNT}:$a`], "pending");
    assert.equal(statusesAfterFlip[`matrix:${ACCOUNT}:$b`], "pending");
  });
});

test("pageSize is passed through (clamped 1–1000) as the readMessages limit; defaults to 100", async () => {
  await withStores(async (store, storage) => {
    // Explicit pageSize flows through verbatim.
    const c1 = new ScriptedClient([page([summary({ externalId: "$a", timestamp: 1000 })], null)]);
    await performInitialBackfill({ client: c1, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100, pageSize: 250 });
    assert.equal(c1.limits[0], 250, "explicit pageSize should be used as the read limit");

    // Omitted pageSize defaults to 100.
    const c2 = new ScriptedClient([page([summary({ externalId: "$b", timestamp: 1000 })], null)]);
    await performInitialBackfill({ client: c2, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(c2.limits[0], 100, "omitted pageSize should default to 100");

    // Out-of-range pageSize is clamped to the 1–1000 bounds.
    const c3 = new ScriptedClient([page([summary({ externalId: "$c", timestamp: 1000 })], null)]);
    await performInitialBackfill({ client: c3, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100, pageSize: 9999 });
    assert.equal(c3.limits[0], 1000, "pageSize should be clamped to the 1000 ceiling");
  });
});

test("stops after maxMessages newly-stored and threads the backward pagination token", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([summary({ externalId: "$a", timestamp: 5000 }), summary({ externalId: "$b", timestamp: 4000 })], "tok1"),
      page([summary({ externalId: "$c", timestamp: 3000 }), summary({ externalId: "$d", timestamp: 2000 })], "tok2"),
      page([summary({ externalId: "$e", timestamp: 1000 })], null),
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

test("stops at the first kept message older than the window floor, without storing it", async () => {
  await withStores(async (store, storage) => {
    // anchorTimestamp = 1_000_000; windowMs = 5000 → floor = 995_000.
    const client = new ScriptedClient([
      page([summary({ externalId: "$a", timestamp: 999_000 }), summary({ externalId: "$b", timestamp: 998_000 })], "tok1"),
      page([summary({ externalId: "$c", timestamp: 996_000 }), summary({ externalId: "$d", timestamp: 994_000 })], "tok2"),
      page([summary({ externalId: "$e", timestamp: 990_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, true);
    assert.equal(result.stored, 3, "the floor-crossing message and everything after it are not stored");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$d`), undefined, "the floor-crossing message must not be persisted");
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
      page([summary({ externalId: "$a", timestamp: 999_000 }), summary({ externalId: "$b", timestamp: 998_000 })], "tok1"),
      page([summary({ externalId: "$c", timestamp: 994_000 }), summary({ externalId: "$d", timestamp: 993_000 })], "tok2"),
      page([summary({ externalId: "$e", timestamp: 990_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, true, "the window cap must bite despite old inactive history");
    assert.equal(result.stored, 2, "only in-window messages stored; the crossing message and later pages are not");
    assert.equal(client.calls.length, 2, "should stop at the window-crossing page, not paginate to exhaustion");
  });
});

test("#1: the window-floor stop is not tripped by filtered-out (non-matching) messages", async () => {
  await withStores(async (store, storage) => {
    // A thread timeline. `readMessages` returns the whole room, so each page is
    // dominated by old non-thread traffic far below the window floor, while the
    // thread's own messages sit above it. The window floor must reflect only the
    // events kept for THIS timeline — the non-thread noise must not trip it.
    // anchorTimestamp = 1_000_000; windowMs = 5000 → floor = 995_000.
    const threadTk = `matrix:${ACCOUNT}:room:${ROOM}:thread:$root`;
    const thread = (externalId: string, timestamp: number) =>
      summary({ externalId, timestamp, threadRootExternalId: "$root" });
    const client = new ScriptedClient([
      // Page 1: a thread message above the floor, plus old non-thread noise WAY
      // below the floor. Old behavior: noise drags pageMinTimestamp < floor →
      // stops here. New behavior: only $t1 (999_000) counts → keep paging.
      page([
        thread("$t1", 999_000),
        summary({ externalId: "$noise1", timestamp: 100_000 }),
        summary({ externalId: "$noise2", timestamp: 90_000 }),
      ], "tok1"),
      // Page 2: another in-window thread message + more old noise. Still no
      // thread message below the floor → keep paging.
      page([
        thread("$t2", 998_000),
        summary({ externalId: "$noise3", timestamp: 80_000 }),
      ], "tok2"),
      // Page 3: a thread message that finally crosses the floor → stop here.
      page([thread("$t3", 994_000)], "tok3"),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: threadTk, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.stored, 2, "in-window thread messages stored; noise and the floor-crossing message excluded");
    assert.equal(result.reachedWindow, true, "stops only when a KEPT thread message crosses the floor");
    assert.equal(client.calls.length, 3, "non-thread noise below the floor must not stop backfill early");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$t3`), undefined, "the floor-crossing thread message is not persisted");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$noise1`), undefined, "non-thread noise is not stored on a thread timeline");
  });
});

test("#1: a fully-filtered page leaves the floor untouched and paging continues on the token", async () => {
  await withStores(async (store, storage) => {
    // A thread timeline whose first page is ENTIRELY non-thread traffic, all
    // below the window floor. The floor is checked only against kept messages,
    // so the stop does not fire and paging continues on the advancing token.
    // anchorTimestamp = 1_000_000; windowMs = 5000 → floor = 995_000.
    const threadTk = `matrix:${ACCOUNT}:room:${ROOM}:thread:$root`;
    const client = new ScriptedClient([
      page([
        summary({ externalId: "$noise1", timestamp: 100_000 }),
        summary({ externalId: "$noise2", timestamp: 90_000 }),
      ], "tok1"),
      page([summary({ externalId: "$mine", timestamp: 999_000, threadRootExternalId: "$root" })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: threadTk, ...BASE,
      windowMs: 5000, anchorTimestamp: 1_000_000, maxMessages: 100,
    });
    assert.equal(result.reachedWindow, false, "a fully-filtered page must not trip the window floor");
    assert.equal(result.exhausted, true, "paging continues past the filtered page to exhaustion");
    assert.equal(result.stored, 1, "only the in-thread message is stored");
    assert.equal(client.calls.length, 2, "the second page is fetched on the advancing token");
  });
});

test("a single sparse page spanning months stores only in-window messages (no old UTD stubs)", async () => {
  await withStores(async (store, storage) => {
    // Regression for the real-world failure: a quiet DM whose ENTIRE history fits
    // in one backward page. Under the old page-granular window check, the whole
    // page was stored (months-old permanently-UTD stubs included) before the
    // floor was ever consulted; the per-message check must stop at the first
    // kept message older than the floor and persist nothing beyond it.
    // anchorTimestamp = 10_000_000; windowMs = 3_600_000 → floor = 6_400_000.
    const oldUtds = Array.from({ length: 10 }, (_, i) => utdSummary(`$utd${i}`, 1_000_000 - i * 1000));
    const client = new ScriptedClient([
      page([
        summary({ externalId: "$recent1", timestamp: 9_999_000 }),
        summary({ externalId: "$recent2", timestamp: 9_998_000 }),
        summary({ externalId: "$stale", timestamp: 5_000_000 }),
        ...oldUtds,
      ], "tok1"),
      page([], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE,
      windowMs: 3_600_000, anchorTimestamp: 10_000_000, maxMessages: 200,
    });
    assert.equal(result.reachedWindow, true);
    assert.equal(result.stored, 2, "only the two in-window messages are stored");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$stale`), undefined, "the first too-old message is not persisted");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$utd0`), undefined, "old UTD stubs are never persisted");
    assert.equal(result.haltedOnUtd, false, "the window stops the run before the UTD counter matters");
    assert.equal(client.calls.length, 1, "no further pages are fetched");
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
      page([summary({ externalId: "$a", timestamp: 5000 }), summary({ externalId: "$b", timestamp: 4000 })], null),
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
        summary({ externalId: "$plain", timestamp: 5000, sender: "@alice:example.org" }),
        summary({ externalId: "$self", timestamp: 4900, sender: SELF }),
        summary({ externalId: "$reply", timestamp: 4800, replyToExternalId: "$plain" }),
        summary({ externalId: "$thread", timestamp: 4700, threadRootExternalId: "$root" }),
        summary({ externalId: "$edit", timestamp: 4600, edited: true, editTargetExternalId: "$plain" }),
      ], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.fetched, 5);
    assert.equal(result.stored, 3, "plain + self + reply; thread and edit excluded");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$thread`), undefined, "thread message excluded from room timeline");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "m.replace edit applied to its target, never stored as a standalone row");

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
        summary({ externalId: "$plain", timestamp: 5000 }),
        summary({ externalId: "$mine", timestamp: 4900, threadRootExternalId: "$root" }),
        summary({ externalId: "$other", timestamp: 4800, threadRootExternalId: "$otherRoot" }),
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
      readMessages: () => new Promise<HistoryPageResult>(() => {}),
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
      page([summary({ externalId: "$a", timestamp: 5000 })], "stuck"),
      // Second page returns the same token it was handed: non-advancing.
      page([summary({ externalId: "$a", timestamp: 5000 })], "stuck"),
      // Would loop forever if reached.
      page([summary({ externalId: "$a", timestamp: 5000 })], "stuck"),
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
      page([summary({ externalId: "$a", timestamp: 5000 })], "tok1"),
      page([summary({ externalId: "$b", timestamp: 4000 })], null),
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
      readMessages: async (_request: HistoryPageRequest) => {
        call++;
        if (call === 1) {
          return page([summary({ externalId: "$a", timestamp: 5000 })], "tok1");
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
            externalId: "$img",
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
      page([summary({ externalId: eventId, timestamp: 5000, msgtype: "m.image", body: "cat.png", media })], null),
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
      page([utdSummary("$utd", 5000), summary({ externalId: "$ok", timestamp: 4000 })], null),
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
      page([summary({ externalId: "$never", timestamp: 1000 })], null),
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
      page([...utdsA, summary({ externalId: "$real", timestamp: 160_000 }), ...utdsB], null),
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

test("#5: re-paged already-stored UTD duplicates do not advance the consecutive-UTD halt", async () => {
  await withStores(async (store, storage) => {
    // Pre-store 50 UTD events as if a prior backfill already held them. A new
    // backfill re-pages the SAME 50 (duplicates) followed by genuinely new
    // history. Under the old behavior the 50 re-paged UTD duplicates would reach
    // the threshold and halt on history already held; with the fix the counter
    // only advances on real (newly-stored) events, so paging reaches the new page.
    for (let i = 0; i < 50; i++) {
      await store.appendIfMissing(
        {
          ...seedEvent(`matrix:${ACCOUNT}:$dup${i}`, 100_000 - i),
          id: `matrix:${ACCOUNT}:$dup${i}`,
          externalId: `$dup${i}`,
          undecryptable: { sessionId: "s", reason: "missing_megolm_session" },
        },
        "skipped",
      );
    }
    const dupPage = Array.from({ length: 50 }, (_, i) => utdSummary(`$dup${i}`, 100_000 - i));
    const client = new ScriptedClient([
      page(dupPage, "tok1"),
      page([summary({ externalId: "$fresh", timestamp: 50_000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 1000, utdHaltThreshold: 50,
    });
    assert.equal(result.haltedOnUtd, false, "re-paged UTD duplicates must not trip the halt");
    assert.equal(result.exhausted, true, "paging continues past the duplicate page to the new history");
    assert.equal(result.stored, 1, "only the genuinely-new $fresh is newly stored");
    assert.equal(client.calls.length, 2, "the second page (new history) is fetched");
    assert.ok(store.getById(`matrix:${ACCOUNT}:$fresh`), "the new event is stored");
  });
});

test("#5: a run of newly-stored UTD duplicates still halts only on genuinely new dead history", async () => {
  await withStores(async (store, storage) => {
    // Sanity counterpart to the above: when the UTD events are genuinely new
    // (not duplicates), the halt still fires at the threshold.
    const utds = Array.from({ length: 50 }, (_, i) => utdSummary(`$new${i}`, 100_000 - i));
    const client = new ScriptedClient([
      page(utds, "tok1"),
      page([summary({ externalId: "$never", timestamp: 1000 })], null),
    ]);
    const result = await performInitialBackfill({
      client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 1000, utdHaltThreshold: 50,
    });
    assert.equal(result.haltedOnUtd, true, "genuinely-new dead history still halts");
    assert.equal(result.stored, 50);
    assert.equal(client.calls.length, 1, "the second page is never fetched");
  });
});

// ── Historical edit handling (issues #1 / #11) ──────────────────────────────

test("#11: an edit later in a backward page is applied to its original earlier in the page", async () => {
  await withStores(async (store, storage) => {
    // Backward pages are newest-first, so the original (newer ts) appears BEFORE
    // its edit (older ts is not required, but matrix-sdk does not fold edits — the
    // original keeps its pre-edit body and the m.replace is a separate event).
    const client = new ScriptedClient([
      page([
        summary({ externalId: "$orig", timestamp: 5000, body: "original body" }),
        summary({
          externalId: "$edit",
          timestamp: 5001,
          body: "edited body",
          edited: true, editTargetExternalId: "$orig",
        }),
      ], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    // The edit is never a standalone row and never counts toward stored.
    assert.equal(result.stored, 1, "only the original message is a stored row");
    assert.equal(store.getById(`matrix:${ACCOUNT}:$edit`), undefined, "the edit is not stored standalone");
    const orig = store.getById(`matrix:${ACCOUNT}:$orig`);
    assert.equal(orig?.body, "edited body", "the stored original renders the edited body, not the stale pre-edit body");
  });
});

test("#1: an edit appearing before its original (later backward page) parks and replays on append", async () => {
  await withStores(async (store, storage) => {
    // Backward-page ordering can surface the edit BEFORE the original it targets.
    // The edit parks in pending_edits, and appendIfMissing replays it when the
    // original lands in a later page — so the original still renders the edit.
    const client = new ScriptedClient([
      page([summary({
        externalId: "$edit",
        timestamp: 5001,
        body: "edited body",
        edited: true, editTargetExternalId: "$orig",
      })], "tok1"),
      page([summary({ externalId: "$orig", timestamp: 5000, body: "original body" })], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 1, "only the original message is a stored row");
    const orig = store.getById(`matrix:${ACCOUNT}:$orig`);
    assert.equal(orig?.body, "edited body", "the parked edit is replayed onto the original when it lands");
  });
});

test("#1: a backfilled edit keeps the target 'inactive' (deferred to the activation bulk-flip)", async () => {
  await withStores(async (store, storage) => {
    const client = new ScriptedClient([
      page([
        summary({ externalId: "$orig", timestamp: 5000, body: "original" }),
        summary({
          externalId: "$edit",
          timestamp: 5001,
          body: "edited",
          edited: true, editTargetExternalId: "$orig",
        }),
      ], null),
    ]);
    await performInitialBackfill({ client, store, storage, timelineKey: ROOM_TK, ...BASE, maxMessages: 100 });
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get(`matrix:${ACCOUNT}:$orig`) as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "inactive", "editStatus preserves 'inactive'; enrichment defers to the bulk-flip");
  });
});

test("#5: a UTD event during thread backfill lands on the room timeline, not the thread key", async () => {
  await withStores(async (store, storage) => {
    // Activating a thread. A UTD event has an encrypted relation (relatesTo is
    // undefined), so it fails the thread filter — but instead of being dropped it
    // must land on the ROOM timeline so the re-decryption sweeper can recover and
    // re-home it once keys arrive.
    const threadTk = `matrix:${ACCOUNT}:room:${ROOM}:thread:$root`;
    const client = new ScriptedClient([
      page([
        summary({ externalId: "$mine", timestamp: 5000, threadRootExternalId: "$root" }),
        utdSummary("$utd", 4900),
      ], null),
    ]);
    const result = await performInitialBackfill({ client, store, storage, timelineKey: threadTk, ...BASE, maxMessages: 100 });
    assert.equal(result.stored, 2, "the in-thread message and the UTD placeholder are both stored");

    const mine = store.getById(`matrix:${ACCOUNT}:$mine`);
    assert.equal(mine?.timelineKey, threadTk, "the decrypted thread message stays on the thread timeline");

    const utd = store.getById(`matrix:${ACCOUNT}:$utd`);
    assert.ok(utd, "the UTD event is stored, not dropped");
    assert.equal(utd?.timelineKey, ROOM_TK, "the UTD event lands on the room timeline (sweeper re-homes on decrypt)");
    assert.equal(utd?.threadId, undefined, "no thread id is asserted for a UTD event");
    assert.deepEqual(utd?.undecryptable, { sessionId: "s", reason: "missing_megolm_session" });
    const status = storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get(`matrix:${ACCOUNT}:$utd`) as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "skipped", "a UTD placeholder has nothing to enrich");
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

// ── Provider-aware buildId: Discord timeline key produces discord: event ids ──

const DISCORD_ACCOUNT = "botaccount";
const DISCORD_CHANNEL = "100000000000000001";
const DISCORD_TK = `discord:${DISCORD_ACCOUNT}:room:${DISCORD_CHANNEL}`;
const DISCORD_SELF = "999999999999999999"; // snowflake

test("Discord timeline key → backfilled rows stored as discord:<acct>:<msgId> ids, dedup against live-ingested ids", async () => {
  await withStores(async (store, storage) => {
    // Two Discord message summaries — externalIds are snowflakes.
    const msgA = "200000000000000001";
    const msgB = "200000000000000002";
    const client = new ScriptedClient([
      page([
        summary({ externalId: msgA, timestamp: 5000, sender: "111111111111111111" }),
        summary({ externalId: msgB, timestamp: 4000, sender: "222222222222222222" }),
      ], null),
    ]);

    const result = await performInitialBackfill({
      client,
      store,
      storage,
      timelineKey: DISCORD_TK,
      roomId: DISCORD_CHANNEL,
      accountId: DISCORD_ACCOUNT,
      selfUserId: DISCORD_SELF,
      windowMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 10_000,
      maxMessages: 100,
    });

    assert.equal(result.stored, 2, "both Discord messages stored");
    assert.equal(result.exhausted, true);

    // Canonical ids must use the discord: scheme so they match live-ingest ids
    // built by buildDiscordEventId (discord:<acct>:<messageId>).
    const storedA = store.getById(`discord:${DISCORD_ACCOUNT}:${msgA}`);
    assert.ok(storedA, `event A should be stored as discord:${DISCORD_ACCOUNT}:${msgA}`);
    assert.equal(storedA?.externalId, msgA);
    assert.equal(storedA?.provider, "discord");
    assert.equal(storedA?.timelineKey, DISCORD_TK);

    const storedB = store.getById(`discord:${DISCORD_ACCOUNT}:${msgB}`);
    assert.ok(storedB, `event B should be stored as discord:${DISCORD_ACCOUNT}:${msgB}`);

    // Dedup: re-running with the same messages must produce 0 new stores.
    const client2 = new ScriptedClient([
      page([
        summary({ externalId: msgA, timestamp: 5000, sender: "111111111111111111" }),
      ], null),
    ]);
    const result2 = await performInitialBackfill({
      client: client2,
      store,
      storage,
      timelineKey: DISCORD_TK,
      roomId: DISCORD_CHANNEL,
      accountId: DISCORD_ACCOUNT,
      selfUserId: DISCORD_SELF,
      windowMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 10_000,
      maxMessages: 100,
    });
    assert.equal(result2.stored, 0, "identical message is a duplicate — dedup works across backfill runs");
  });
});
