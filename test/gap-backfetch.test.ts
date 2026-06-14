import assert from "node:assert/strict";
import test from "node:test";
import {
  GapBackfetchCoordinator,
  type GapBackfetchConfig,
  type GapBackfetchCoordinatorOptions,
} from "../src/backfill/coordinator.js";
import type { BackfillReadClient } from "../src/backfill/paginate.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent, InboundChatEvent } from "../src/types.js";
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

function summary(over: Partial<MatrixMessageSummary> & { eventId: string; timestamp: number }): MatrixMessageSummary {
  return {
    eventId: over.eventId,
    sender: over.sender ?? "@alice:example.org",
    senderName: over.senderName,
    body: over.body ?? "hello",
    msgtype: over.msgtype ?? "m.text",
    timestamp: iso(over.timestamp),
    relatesTo: over.relatesTo,
    media: over.media,
    undecryptable: over.undecryptable,
    sessionId: over.sessionId,
    utdReason: over.utdReason,
  };
}

function page(messages: MatrixMessageSummary[], nextBatch: string | null): MatrixReadMessagesResult {
  return { messages, nextBatch, prevBatch: null };
}

class ScriptedClient implements BackfillReadClient {
  readonly calls: Array<string | undefined> = [];
  constructor(private readonly pages: MatrixReadMessagesResult[]) {}
  async readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult> {
    this.calls.push(request.before);
    return this.pages[this.calls.length - 1] ?? { messages: [], nextBatch: null, prevBatch: null };
  }
}

/**
 * Like ScriptedClient but the Nth (1-based) `readMessages` rejects, simulating a
 * mid-descent network/read failure. Earlier and later calls serve `pages` as usual.
 */
class FailingAtClient implements BackfillReadClient {
  readonly calls: Array<string | undefined> = [];
  constructor(
    private readonly pages: MatrixReadMessagesResult[],
    private readonly failOnCall: number,
    private readonly error = new Error("simulated read failure"),
  ) {}
  async readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult> {
    this.calls.push(request.before);
    if (this.calls.length === this.failOnCall) throw this.error;
    return this.pages[this.calls.length - 1] ?? { messages: [], nextBatch: null, prevBatch: null };
  }
}

/**
 * Like ScriptedClient but each `readMessages` resolves after a per-call delay
 * (`delaysMs[n]` for the Nth 0-based call, default 0), to exercise the descent's
 * wall-clock timeout: a delay larger than `timeoutMs` makes `withDeadline` reject
 * the in-flight read with `BackfillTimeoutError`, which paginateBackward records as
 * `timedOut` (reason `timeout`), distinct from a read `error`.
 */
class DelayingClient implements BackfillReadClient {
  readonly calls: Array<string | undefined> = [];
  constructor(
    private readonly pages: MatrixReadMessagesResult[],
    private readonly delaysMs: number[],
  ) {}
  async readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult> {
    this.calls.push(request.before);
    const i = this.calls.length - 1;
    const delay = this.delaysMs[i] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return this.pages[i] ?? { messages: [], nextBatch: null, prevBatch: null };
  }
}

/** A summary marked undecryptable (UTD), as the native client reports key-less events. */
function utdSummary(over: { eventId: string; timestamp: number; sessionId?: string }): MatrixMessageSummary {
  return summary({
    eventId: over.eventId,
    timestamp: over.timestamp,
    undecryptable: true,
    sessionId: over.sessionId ?? "sess-1",
    utdReason: "missing_keys",
  });
}

/** A TimelineStore wrapper that records the canonical id of every appendIfMissing insert, in order. */
class RecordingStore {
  readonly inserted: string[] = [];
  constructor(private readonly inner: TimelineStore) {}
  async appendIfMissing(event: CanonicalChatEvent, status?: string) {
    const result = await this.inner.appendIfMissing(event, status);
    if (!result.duplicate) this.inserted.push(event.id);
    return result;
  }
  applyEdit(...args: Parameters<TimelineStore["applyEdit"]>) {
    return this.inner.applyEdit(...args);
  }
  resolveEditTargetTimelineKey(...args: Parameters<TimelineStore["resolveEditTargetTimelineKey"]>) {
    return this.inner.resolveEditTargetTimelineKey(...args);
  }
}

interface Harness {
  storage: Storage;
  timeline: TimelineStore;
  recording: RecordingStore;
  client: BackfillReadClient & { calls: Array<string | undefined> };
  coordinator: GapBackfetchCoordinator;
  replayed: InboundChatEvent[];
  enriched: string[];
  summarized: string[];
  chatIndexed: string[];
}

const DEFAULT_CONFIG: GapBackfetchConfig = {
  enabled: true,
  maxMessages: 0,
  windowMs: 0,
  timeoutMs: 0,
  pageSize: 100,
  utdHaltThreshold: 50,
  concurrency: 3,
};

async function makeHarness(
  pages: MatrixReadMessagesResult[],
  configOverride: Partial<GapBackfetchConfig> = {},
  storeOverride?: Pick<GapBackfetchCoordinatorOptions, "timeline">,
  clientOverride?: BackfillReadClient & { calls: Array<string | undefined> },
): Promise<Harness> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const recording = new RecordingStore(timeline);
  const client = clientOverride ?? new ScriptedClient(pages);
  const replayed: InboundChatEvent[] = [];
  const enriched: string[] = [];
  const summarized: string[] = [];
  const chatIndexed: string[] = [];

  const coordinator = new GapBackfetchCoordinator({
    storage,
    timeline: (storeOverride?.timeline ?? (recording as unknown as TimelineStore)),
    config: { ...DEFAULT_CONFIG, ...configOverride },
    getClient: () => client,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment: (id) => enriched.push(id),
    notifyCaptions: () => {},
    enqueueChatSearch: (id) => chatIndexed.push(id),
    enqueueSummarization: (tk) => summarized.push(tk),
    replayLiveInbound: (inbound) => replayed.push(inbound),
    isDraining: () => false,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      child() {
        return this;
      },
    } as never,
  });

  return { storage, timeline, recording, client, coordinator, replayed, enriched, summarized, chatIndexed };
}

/** Seed a committed event (the floor) and mark its timeline active. */
async function seedFloor(timeline: TimelineStore, storage: Storage, eventId: string, timestamp: number, timelineKey = ROOM_TK): Promise<void> {
  const event: CanonicalChatEvent = {
    id: `matrix:${ACCOUNT}:${eventId}`,
    externalId: eventId,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", isSelf: false },
    body: "old",
    timestamp,
    receivedAt: timestamp,
  };
  await timeline.appendIfMissing(event, "skipped");
  await storage.setTimelineState(timelineKey, "active");
}

function statusOf(storage: Storage, eventId: string): string | undefined {
  return storage.read((db) =>
    (db.prepare(`select enrichment_status from timeline_events where id = ?`).get(`matrix:${ACCOUNT}:${eventId}`) as
      | { enrichment_status: string }
      | undefined)?.enrichment_status,
  );
}

function storedIds(storage: Storage, timelineKey: string): string[] {
  return storage
    .read((db) =>
      db
        .prepare(`select external_id from timeline_events where timeline_key = ? order by timestamp asc, received_at asc, id asc`)
        .all(timelineKey) as Array<{ external_id: string }>,
    )
    .map((r) => r.external_id);
}

test("fills the gap: stops at floor, commits the gap oldest-first, unfreezes", async () => {
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }), // the floor — stop here, not stored
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  assert.equal(h.coordinator.isFrozen(ROOM_TK), true, "room is frozen after prepare");
  await h.coordinator.run();

  assert.equal(h.coordinator.isFrozen(ROOM_TK), false, "room unfreezes after run");
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b", "$c", "$d"]);
  // Committed oldest-first (crash-safety, §5.4): only the three gap events, ascending.
  assert.deepEqual(h.recording.inserted, [`matrix:${ACCOUNT}:$b`, `matrix:${ACCOUNT}:$c`, `matrix:${ACCOUNT}:$d`]);
  // Active timeline ⇒ gap events are 'skipped' (plain text needs no enrichment).
  assert.equal(statusOf(h.storage, "$b"), "skipped");
  // Summarization nudged once for the affected timeline.
  assert.deepEqual(h.summarized, [ROOM_TK]);
  h.storage.close();
});

test("no-gap fast path: first page reaches the floor, nothing committed", async () => {
  // The floor event ($a, === floor.id) is the exact-match boundary (#4): the descent
  // hard-stops on it and commits nothing.
  const h = await makeHarness([
    page([summary({ eventId: "$a", timestamp: 1000 })], "tok1"),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(h.recording.inserted, [], "no rows newly committed");
  assert.equal(h.client.calls.length, 1, "stopped on the first page at the floor event");
  assert.equal(h.coordinator.isFrozen(ROOM_TK), false);
  h.storage.close();
});

test("floor boundary: same-ms gap events on both sides of floor.id are recovered (#4 exact-match)", async () => {
  // floor = $m at ts=2000. Same-ms gap events arrived during the outage, so by the
  // canonical (timestamp, received_at, id) order they sort ABOVE the floor regardless
  // of how their eventId compares to floor.id — a fetched summary has no received_at
  // and a backfetched event is assigned received_at = now ≫ the floor's. Backward
  // pagination returns them (newer stream order) before the floor event. Both $n
  // (id > floor.id) and $a (id < floor.id) must be recovered; only the exact floor
  // event $m is the boundary. Pre-fix (`<=` and the interim `<`) mistook $a for the
  // floor and silently dropped it; exact-match (`=== floor.id`) recovers it.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$n", timestamp: 2000 }), // same ts, id > floor.id → recovered
        summary({ eventId: "$a", timestamp: 2000 }), // same ts, id < floor.id → recovered (the fix)
        summary({ eventId: "$m", timestamp: 2000 }), // exactly the floor → stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$m", 2000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // Both same-ms gap events recovered; the exact floor event is the boundary and is
  // not stored. Compare order-insensitively (commit sort by received_at can vary).
  assert.deepEqual(
    [...h.recording.inserted].sort(),
    [`matrix:${ACCOUNT}:$a`, `matrix:${ACCOUNT}:$n`].sort(),
    "both same-ms gap events recovered; the floor event itself is the boundary",
  );
  h.storage.close();
});

test("backfetched messages carry no trigger and never replay as a session", async () => {
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$b", timestamp: 2000, body: "hey @miku", sender: "@alice:example.org" }),
        summary({ eventId: "$a", timestamp: 1000 }),
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  const stored = h.storage.getTimelineEventById(`matrix:${ACCOUNT}:$b`);
  assert.ok(stored, "gap mention stored");
  assert.equal(stored?.trigger, undefined, "gap mention carries no trigger (G3)");
  assert.deepEqual(h.replayed, [], "no live replays — backfill-buffer events never replay (G3)");
  h.storage.close();
});

test("live events arriving during the freeze are buffered and replayed after commit (G4)", async () => {
  const h = await makeHarness([
    page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  // Two live events arrive while frozen (above the head).
  const live1 = makeInbound("$live1", 5000);
  const live2 = makeInbound("$live2", 6000);
  assert.equal(h.coordinator.isFrozen(ROOM_TK), true);
  h.coordinator.bufferLive(live1);
  h.coordinator.bufferLive(live2);

  await h.coordinator.run();

  assert.deepEqual(h.replayed.map((i) => i.event.externalId), ["$live1", "$live2"], "live buffer replayed in order");
  assert.equal(h.coordinator.isFrozen(ROOM_TK), false);
  h.storage.close();
});

test("cap leaves a hole below the oldest committed gap message and logs capped", async () => {
  const h = await makeHarness(
    [
      page(
        [
          summary({ eventId: "$d", timestamp: 4000 }),
          summary({ eventId: "$c", timestamp: 3000 }),
        ],
        "tok1",
      ),
      page([summary({ eventId: "$b", timestamp: 2000 })], "tok2"),
    ],
    { maxMessages: 2 },
  );
  await seedFloor(h.timeline, h.storage, "$a", 1000);
  // Capture the capped warning via the snapshot's cappedHole.
  h.coordinator.prepare();
  await h.coordinator.run();

  // Only the newest 2 of the gap committed; $b never fetched → hole [1000, 3000).
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$c", "$d"]);
  const snap = h.coordinator.snapshot();
  // The capped hole carries the cap stop reason (#6: `count`) so an operator can
  // tell this opt-in cap apart from a window/timeout/UTD-halt hole.
  assert.deepEqual(snap[0]?.cappedHole, { fromTimestamp: 1000, toTimestamp: 3000, reason: "count" });
  h.storage.close();
});

test("window stop leaves a capped hole tagged reason 'window' (#6)", async () => {
  // windowMs bounds the descent to events newer than now − windowMs. $c/$d are
  // inside the window and committed; $b is older than the window floor → the
  // descent stops with reason `window`, leaving a hole below $c. Use a wide window
  // and small fixed timestamps so the window floor sits between $b and $c
  // deterministically (relative to wall-clock now).
  const now = Date.now();
  const h = await makeHarness(
    [
      page(
        [
          summary({ eventId: "$d", timestamp: now - 1000 }),
          summary({ eventId: "$c", timestamp: now - 2000 }),
          summary({ eventId: "$b", timestamp: now - 100_000 }), // older than the window floor → stop
        ],
        null,
      ),
    ],
    { windowMs: 50_000 },
  );
  await seedFloor(h.timeline, h.storage, "$a", now - 200_000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // Only the two in-window events committed; $b (below the window floor) is the
  // boundary and is not stored.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), [`$a`, `$c`, `$d`]);
  const hole = h.coordinator.snapshot()[0]?.cappedHole;
  assert.equal(hole?.reason, "window", "window stop tagged reason 'window'");
  assert.equal(hole?.fromTimestamp, now - 200_000, "hole spans up from the floor");
  assert.equal(hole?.toTimestamp, now - 2000, "hole spans up to the oldest committed gap message ($c)");
  h.storage.close();
});

test("timeout stop leaves a capped hole tagged reason 'timeout' (#6)", async () => {
  // A per-page delay larger than the descent's timeout: page 1 commits, then the
  // deadline trips before page 2 lands → the descent stops with reason `timeout`,
  // burying $b under a capped hole. `withDeadline` rejects the in-flight read with
  // BackfillTimeoutError, which paginateBackward records as `timedOut` (not errored).
  const client = new DelayingClient(
    [
      page([summary({ eventId: "$d", timestamp: 4000 }), summary({ eventId: "$c", timestamp: 3000 })], "tok1"),
      page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null),
    ],
    // Page 1 is instant; page 2 stalls well past the timeout so the deadline trips.
    [0, 1000],
  );
  const h = await makeHarness([], { timeoutMs: 50 }, undefined, client);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // Page 1 ($c,$d) committed; the timeout fired before page 2, so $b stays buried.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$c", "$d"]);
  const hole = h.coordinator.snapshot()[0]?.cappedHole;
  assert.equal(hole?.reason, "timeout", "timeout stop tagged reason 'timeout'");
  assert.deepEqual(
    { from: hole?.fromTimestamp, to: hole?.toTimestamp },
    { from: 1000, to: 3000 },
    "hole spans from the floor up to the oldest committed gap message ($c)",
  );
  h.storage.close();
});

test("whole-room capture: thread events route to their thread timeline key", async () => {
  const THREAD_TK = `${ROOM_TK}:thread:$root`;
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$t1", timestamp: 3000, relatesTo: { relType: "m.thread", eventId: "$root" } }),
        summary({ eventId: "$r1", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }),
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$r1"], "non-thread events on the room key");
  assert.deepEqual(storedIds(h.storage, THREAD_TK), ["$t1"], "thread event routed to the thread key");
  h.storage.close();
});

test("crash mid-commit (fails after K oldest rows) leaves a single gap above K next run", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  await seedFloor(timeline, storage, "$a", 1000);

  // First coordinator: a timeline wrapper that throws after committing 1 gap row.
  const pages1 = [
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }),
      ],
      null,
    ),
  ];
  const client1 = new ScriptedClient(pages1);
  let inserts = 0;
  const failingStore = {
    async appendIfMissing(event: CanonicalChatEvent, status?: string) {
      // Crash after the first committed gap row. Oldest-first commit lands $b first,
      // then the store throws. The floor event ($a) is the exact-match boundary (#4)
      // and is never buffered, so the budget counts only real gap inserts.
      if (inserts >= 1) throw new Error("simulated crash mid-commit");
      const result = await timeline.appendIfMissing(event, status);
      if (!result.duplicate) inserts++;
      return result;
    },
    applyEdit: timeline.applyEdit.bind(timeline),
    resolveEditTargetTimelineKey: timeline.resolveEditTargetTimelineKey.bind(timeline),
  } as unknown as TimelineStore;

  const coord1 = new GapBackfetchCoordinator({
    storage,
    timeline: failingStore,
    config: DEFAULT_CONFIG,
    getClient: () => client1,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment() {},
    notifyCaptions() {},
    enqueueChatSearch() {},
    enqueueSummarization() {},
    replayLiveInbound() {},
    isDraining: () => false,
    logger: silentLogger(),
  });
  coord1.prepare();
  await coord1.run();

  // Oldest-first ⇒ only $b committed (K=$b). High-water is now $b. No buried hole.
  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a", "$b"]);

  // Second coordinator (fresh, after "restart"): re-derives the gap above $b.
  const pages2 = [
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }), // new floor — stop
      ],
      null,
    ),
  ];
  const coord2 = new GapBackfetchCoordinator({
    storage,
    timeline,
    config: DEFAULT_CONFIG,
    getClient: () => new ScriptedClient(pages2),
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment() {},
    notifyCaptions() {},
    enqueueChatSearch() {},
    enqueueSummarization() {},
    replayLiveInbound() {},
    isDraining: () => false,
    logger: silentLogger(),
  });
  coord2.prepare();
  await coord2.run();

  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a", "$b", "$c", "$d"], "gap fully closed across two runs");
  storage.close();
});

test("disabled: prepare/run are no-ops and isFrozen is always false", async () => {
  const h = await makeHarness([page([summary({ eventId: "$b", timestamp: 2000 })], null)], { enabled: false });
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  assert.equal(h.coordinator.isFrozen(ROOM_TK), false);
  await h.coordinator.run();
  assert.equal(h.client.calls.length, 0, "no fetch when disabled");
  assert.deepEqual(h.recording.inserted, []);
  h.storage.close();
});

test("every committed gap event lands strictly above the floor (guards the coverage-cursor landmine)", async () => {
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1500 }),
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1500);

  h.coordinator.prepare();
  await h.coordinator.run();

  // No committed gap row may be at/below the floor timestamp (1500) — that is the
  // §3 buried-gap precondition. Everything inserted is strictly newer.
  for (const id of h.recording.inserted) {
    const ev = h.storage.getTimelineEventById(id)!;
    assert.ok(ev.timestamp > 1500, `${id} must be above the floor`);
  }
  h.storage.close();
});

// --- #1a: a read failure mid-descent must NOT commit-and-bury the partial gap ---
test("read failure mid-descent: nothing committed, room failed/frozen, high-water unmoved, no replay", async () => {
  // The descent pages newest-first; the floor ($a@1000) is on the *second* page,
  // which never arrives because the 2nd readMessages rejects. The pre-fix code
  // committed the partial newest-suffix ($d,$c) and buried the unfetched older span.
  const pages = [
    page([summary({ eventId: "$d", timestamp: 4000 }), summary({ eventId: "$c", timestamp: 3000 })], "tok1"),
    // call #2 rejects (see failOnCall) — this page is never served.
    page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null),
  ];
  const client = new FailingAtClient(pages, 2);
  const h = await makeHarness(pages, {}, undefined, client);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  // A live @ arrives during the freeze — it must NOT be replayed on the failed path.
  h.coordinator.bufferLive(makeInbound("$live1", 9000));
  await h.coordinator.run();

  // Nothing from the partial buffer is committed; the high-water never advanced
  // past the unfetched remainder (only the seeded floor row exists).
  assert.deepEqual(h.recording.inserted, [], "no rows committed on a read failure");
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a"], "only the pre-existing floor row remains");
  // The room is left in the failed phase (not unfrozen-and-done) and its live
  // buffer is retained, not drained, so the §4 invariant re-derives the gap next run.
  const snap = h.coordinator.snapshot();
  assert.equal(snap[0]?.phase, "failed", "room left in the failed phase");
  assert.equal(snap[0]?.liveBuffered, 1, "live buffer NOT drained on the failed path");
  assert.deepEqual(h.replayed, [], "live buffer NOT replayed on a read failure");
  assert.equal(snap[0]?.committed, 0, "committed count is zero");

  // A clean re-run (fresh coordinator, full page set) closes the gap with no hole.
  const client2 = new ScriptedClient([
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  const coord2 = new GapBackfetchCoordinator({
    storage: h.storage,
    timeline: h.timeline,
    config: DEFAULT_CONFIG,
    getClient: () => client2,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment() {},
    notifyCaptions() {},
    enqueueChatSearch() {},
    enqueueSummarization() {},
    replayLiveInbound() {},
    isDraining: () => false,
    logger: silentLogger(),
  });
  coord2.prepare();
  await coord2.run();
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b", "$c", "$d"], "re-run closes the gap, no buried hole");
  h.storage.close();
});

// --- #1b: a floor-bounded UTD run must NOT halt-and-bury; UTD stored skipped, gap recovered ---
test("floor-bounded UTD run does not halt-and-bury: UTD stored 'skipped', descent reaches the floor", async () => {
  // A run of UTD events (>= the configured halt threshold) sits at the head of the
  // gap, above several decryptable events and the floor. Pre-fix, the UTD-halt
  // guard tripped and buried the decryptable remainder ($e..$g) plus the floor.
  const UTD_THRESHOLD = 3;
  const h = await makeHarness(
    [
      page(
        [
          // 3 consecutive UTD events at the head (>= threshold) — a startup key-sync wall.
          utdSummary({ eventId: "$utd3", timestamp: 7000 }),
          utdSummary({ eventId: "$utd2", timestamp: 6000 }),
          utdSummary({ eventId: "$utd1", timestamp: 5000 }),
          // decryptable gap traffic below the UTD wall.
          summary({ eventId: "$g", timestamp: 4000 }),
          summary({ eventId: "$f", timestamp: 3000 }),
          summary({ eventId: "$e", timestamp: 2000 }),
          summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
        ],
        null,
      ),
    ],
    { utdHaltThreshold: UTD_THRESHOLD },
  );
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // The descent reached the floor and recovered the ENTIRE gap — UTD events and
  // the decryptable remainder alike — nothing buried.
  assert.deepEqual(
    storedIds(h.storage, ROOM_TK),
    ["$a", "$e", "$f", "$g", "$utd1", "$utd2", "$utd3"],
    "whole gap recovered (UTD + decryptable), nothing buried by a UTD halt",
  );
  assert.equal(h.coordinator.isFrozen(ROOM_TK), false, "room unfroze (committed, not failed)");
  // UTD rows are stored 'skipped' (the sweeper heals them later), like the live path.
  assert.equal(statusOf(h.storage, "$utd1"), "skipped");
  assert.equal(statusOf(h.storage, "$utd3"), "skipped");
  // No capped hole — the gap closed at the floor, it was not a capped/halted stop.
  assert.equal(h.coordinator.snapshot()[0]?.cappedHole, undefined, "no capped hole — floor reached");
  h.storage.close();
});

// --- #1c (optional): a floor-undefined descent still honors the UTD halt ---
test("floor-undefined descent still halts on a long UTD run (guard retained for initial-backfill-style)", async () => {
  // No seeded floor ⇒ room.floor is undefined ⇒ the UTD-halt guard stays enabled.
  // A run of UTD events >= the threshold halts the descent (pre-join history risk).
  const UTD_THRESHOLD = 3;
  const h = await makeHarness(
    [
      page(
        [
          utdSummary({ eventId: "$utd3", timestamp: 7000 }),
          utdSummary({ eventId: "$utd2", timestamp: 6000 }),
          utdSummary({ eventId: "$utd1", timestamp: 5000 }),
          summary({ eventId: "$deep", timestamp: 4000 }), // below the wall — never reached
        ],
        null,
      ),
    ],
    { utdHaltThreshold: UTD_THRESHOLD },
  );
  // No seedFloor — the room must be enumerated but have NO committed events so its
  // floor is undefined. Register it via timeline_compaction_state (listKnownTimelineKeys
  // unions that table) without inserting any timeline_events ⇒ getHighWaterMark = undefined.
  await h.storage.setTimelineState(ROOM_TK, "active");

  h.coordinator.prepare();
  await h.coordinator.run();

  // The UTD halt fired: $deep (below the wall) was never reached/stored.
  assert.equal(
    storedIds(h.storage, ROOM_TK).includes("$deep"),
    false,
    "deep event below the UTD wall is not recovered — guard retained for floor-undefined",
  );
  h.storage.close();
});

// --- #4: exact-id-match floor boundary (the received_at omission) ---
test("equal-timestamp floor: same-ms lower-id gap event recovered; exact floor event stops without over-paging", async () => {
  // floor = $m at ts=2000. On the backward page the genuine gap event $a (same ts,
  // id < floor.id) precedes the exact floor event $m. Exact-match recovers $a and
  // stops AT $m on page 1, never paging to $pre on page 2.
  //
  // Pre-fix (`<=` and the interim `<`): $a (id < floor.id) was mistaken for the floor
  //   and silently dropped, halting the descent on $a.
  // Exact-match (`=== floor.id`): $a is recovered; $m is the boundary; calls == 1.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$a", timestamp: 2000 }), // same ts, id < floor.id → recovered (the fix)
        summary({ eventId: "$m", timestamp: 2000 }), // === floor.id → exact-match stop
      ],
      "tok2",
    ),
    page([summary({ eventId: "$pre", timestamp: 1000 })], null), // reached only if $m failed to stop
  ]);
  await seedFloor(h.timeline, h.storage, "$m", 2000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(
    h.recording.inserted,
    [`matrix:${ACCOUNT}:$a`],
    "the same-ms lower-id gap event is recovered (not dropped)",
  );
  assert.equal(
    h.client.calls.length,
    1,
    "the exact floor event stops the descent on page 1; it does not page to $pre",
  );
  assert.equal(
    storedIds(h.storage, ROOM_TK).includes("$pre"),
    false,
    "the strictly-older event below the floor is not committed",
  );
  h.storage.close();
});

function makeInbound(eventId: string, timestamp: number): InboundChatEvent {
  const event: CanonicalChatEvent = {
    id: `matrix:${ACCOUNT}:${eventId}`,
    externalId: eventId,
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", isSelf: false },
    body: "live",
    timestamp,
    receivedAt: timestamp,
  };
  return { provider: "matrix", timelineKey: ROOM_TK, event };
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return this;
    },
  } as never;
}
