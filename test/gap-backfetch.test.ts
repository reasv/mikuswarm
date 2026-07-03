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
import { SummarizationIndexer } from "../src/summarization/index.js";
import { selectSummaryCoverage } from "../src/context/summary-layer.js";
import { estimateTokens } from "../src/context/index.js";
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
  /** Number of `notifyCaptions()` nudges (the pool drains all pending; it takes no id). */
  captioned: { count: number };
  /** Every `logger.warn(event, fields)` call, captured in order. */
  warnings: Array<{ event: string; fields?: Record<string, unknown> }>;
}

/** A logger stub that records `warn` calls into `sink`; other levels are silent. */
function capturingLogger(sink: Array<{ event: string; fields?: Record<string, unknown> }>) {
  return {
    info() {},
    warn(event: string, fields?: Record<string, unknown>) {
      sink.push({ event, fields });
    },
    error() {},
    debug() {},
    child() {
      return this;
    },
  } as never;
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
  isDraining: () => boolean = () => false,
): Promise<Harness> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const recording = new RecordingStore(timeline);
  const client = clientOverride ?? new ScriptedClient(pages);
  const replayed: InboundChatEvent[] = [];
  const enriched: string[] = [];
  const summarized: string[] = [];
  const chatIndexed: string[] = [];
  const captioned = { count: 0 };
  const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];

  const coordinator = new GapBackfetchCoordinator({
    storage,
    timeline: (storeOverride?.timeline ?? (recording as unknown as TimelineStore)),
    config: { ...DEFAULT_CONFIG, ...configOverride },
    getClient: () => client,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment: (id) => enriched.push(id),
    notifyCaptions: () => { captioned.count++; },
    enqueueChatSearch: (id) => chatIndexed.push(id),
    enqueueSummarization: (tk) => summarized.push(tk),
    replayLiveInbound: (inbound) => replayed.push(inbound),
    isDraining,
    logger: capturingLogger(warnings),
  });

  return { storage, timeline, recording, client, coordinator, replayed, enriched, summarized, chatIndexed, captioned, warnings };
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

// --- #3: commit() bails when draining begins, leaving the room frozen ---
test("draining before commit: room does NOT commit, stays frozen, gap re-derivable next run", async () => {
  // The fill completes (descent reaches the floor), but shutdown has begun before
  // the room issues its first write. commit() must bail at the top: nothing is
  // committed, the live buffer is NOT drained, and the room is left frozen so the
  // §4 invariant re-derives the same single gap on the next (non-draining) startup.
  let draining = false;
  const h = await makeHarness(
    [
      page(
        [
          summary({ eventId: "$d", timestamp: 4000 }),
          summary({ eventId: "$c", timestamp: 3000 }),
          summary({ eventId: "$b", timestamp: 2000 }),
          summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
        ],
        null,
      ),
    ],
    {},
    undefined,
    undefined,
    () => draining,
  );
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  // A live @ arrives during the freeze — it must NOT be replayed on the bailed path.
  h.coordinator.bufferLive(makeInbound("$live1", 9000));
  // Shutdown begins after prepare/buffer but before run launches the room's commit.
  draining = true;
  await h.coordinator.run();

  // Nothing committed; the high-water never advanced (only the seeded floor row).
  assert.deepEqual(h.recording.inserted, [], "no rows committed while draining");
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a"], "only the pre-existing floor row remains");
  // The room is left frozen (still in an active phase) with its live buffer intact,
  // not unfrozen-and-done — so it re-derives the gap next startup.
  assert.equal(h.coordinator.isFrozen(ROOM_TK), true, "room left frozen after a draining bail");
  const snap = h.coordinator.snapshot();
  assert.equal(snap[0]?.committed, 0, "committed count is zero");
  assert.equal(snap[0]?.liveBuffered, 1, "live buffer NOT drained on the draining bail");
  assert.deepEqual(h.replayed, [], "live buffer NOT replayed while draining");

  // A clean re-run (fresh coordinator, not draining) closes the gap with no hole.
  const coord2 = new GapBackfetchCoordinator({
    storage: h.storage,
    timeline: h.timeline,
    config: DEFAULT_CONFIG,
    getClient: () =>
      new ScriptedClient([
        page(
          [
            summary({ eventId: "$d", timestamp: 4000 }),
            summary({ eventId: "$c", timestamp: 3000 }),
            summary({ eventId: "$b", timestamp: 2000 }),
            summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
          ],
          null,
        ),
      ]),
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

test("draining that flips true mid-run bails the commit (no partial writes)", async () => {
  // isDraining flips true only when first observed inside commit(): the fill loop
  // sees draining=false (so the room is launched and filled), then commit's top
  // check sees true and bails. Proves the bail is evaluated at commit start, not
  // only at room-launch time.
  let observed = 0;
  const h = await makeHarness(
    [page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null)],
    {},
    undefined,
    undefined,
    // false for the run-loop's pre-launch check, true once commit() asks.
    () => observed++ >= 1,
  );
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(h.recording.inserted, [], "commit bailed — no rows written");
  assert.equal(h.coordinator.isFrozen(ROOM_TK), true, "room remains frozen");
  h.storage.close();
});

// --- #7: mixed room:/dm: keys — base kind chosen by most-recent high-water ---
test("mixed room/dm keys: base kind is the newest-high-water side (room wins), events route to room", async () => {
  const DM_TK = `matrix:${ACCOUNT}:dm:${ROOM}`;
  // Same roomId held BOTH a room: and a dm: committed event (m.direct flipped over
  // time). The room: side has the NEWER high-water (3000 > 2000), so the room
  // currently behaves as a regular room and recovered events must base on `room:`,
  // NOT the dm base (the old unconditional dm-preference would mis-home them).
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$g2", timestamp: 5000 }),
        summary({ eventId: "$g1", timestamp: 4000 }),
        summary({ eventId: "$room", timestamp: 3000 }), // === room: floor (the MAX over all keys) → stop
      ],
      null,
    ),
  ]);
  // Seed a dm: floor (older) and a room: floor (newer). getHighWaterMark over all
  // keys returns the room: event ($room@3000) as the floor; the room: side also
  // wins the base-kind comparison.
  await seedFloor(h.timeline, h.storage, "$dm", 2000, DM_TK);
  await seedFloor(h.timeline, h.storage, "$room", 3000, ROOM_TK);

  h.coordinator.prepare();
  await h.coordinator.run();

  // Recovered gap events ($g1,$g2) route to the room: base, not the dm: base.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$room", "$g1", "$g2"], "recovered events based on room:");
  assert.deepEqual(storedIds(h.storage, DM_TK), ["$dm"], "dm: side untouched (no recovered events re-homed)");
  // A mixed-kind warning was emitted naming the chosen kind.
  const mixed = h.warnings.find((w) => w.event === "gap_backfetch_mixed_room_kind");
  assert.ok(mixed, "gap_backfetch_mixed_room_kind warning emitted");
  assert.equal(mixed?.fields?.chosen, "room", "warning names the chosen base kind (room)");
  assert.equal(mixed?.fields?.roomId, ROOM, "warning carries the roomId");
  h.storage.close();
});

test("mixed room/dm keys: dm side newer ⇒ dm base chosen; single-kind groups emit no mixed warning", async () => {
  const DM_TK = `matrix:${ACCOUNT}:dm:${ROOM}`;
  // Symmetric case: the dm: side has the newer high-water (4000 > 2000), so the dm:
  // base is chosen. Floor = MAX over all keys = $dm@4000; the descent stops there.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$g2", timestamp: 6000 }),
        summary({ eventId: "$g1", timestamp: 5000 }),
        summary({ eventId: "$dm", timestamp: 4000 }), // === dm: floor (MAX over all keys) → stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$room", 2000, ROOM_TK);
  await seedFloor(h.timeline, h.storage, "$dm", 4000, DM_TK);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(storedIds(h.storage, DM_TK), ["$dm", "$g1", "$g2"], "recovered events based on dm:");
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$room"], "room: side untouched");
  const mixed = h.warnings.find((w) => w.event === "gap_backfetch_mixed_room_kind");
  assert.equal(mixed?.fields?.chosen, "dm", "warning names dm as the chosen base kind");
  h.storage.close();
});

test("single-kind group: no mixed-kind warning, unchanged behavior", async () => {
  // The normal case (room: only) must be completely unchanged: no mixed warning.
  const h = await makeHarness([
    page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b"]);
  assert.equal(
    h.warnings.some((w) => w.event === "gap_backfetch_mixed_room_kind"),
    false,
    "single-kind groups emit no mixed-kind warning",
  );
  h.storage.close();
});

// --- #12: a gap commit feeds the REAL summarization coverage cursor ---
test("coverage cursor extends to the newest committed gap row after real summarization (#12)", async () => {
  // The earlier consistency test only asserts `timestamp > floor`. This drives the
  // real SummarizationIndexer + a fake worker over the committed gap and asserts the
  // summary coverage cursor (`selectSummaryCoverage(...).coverageEndEventId`) extends
  // to the NEWEST committed gap row with NO committed event left below it — the §3
  // landmine (a buried gap row at/below the floor would strand the cursor and
  // double-render or drop history). Bodies are long so the compact-tier total
  // crosses the generation threshold; tiny rich tiers keep nothing in the rich tail.
  const longBody = "this is a reasonably long gap message body with many tokens ".repeat(6);
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$d", timestamp: 4000, body: longBody }),
        summary({ eventId: "$c", timestamp: 3000, body: longBody }),
        summary({ eventId: "$b", timestamp: 2000, body: longBody }),
        summary({ eventId: "$a", timestamp: 1000 }), // the floor — stop, not stored
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // The whole gap committed above the floor.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b", "$c", "$d"]);

  // Before summarization there is no coverage yet.
  assert.equal(
    selectSummaryCoverage(h.storage, ROOM_TK).coverageEndEventId,
    null,
    "no coverage cursor before any summary exists",
  );

  // Drive the real indexer: enqueue a level-1 job over the committed range.
  // With tiny rich tiers the NEWEST committed event ($d) is carved into the rich
  // tail (it always renders raw), so the summarizable compact-tier range runs from
  // the oldest committed gap row up to the last pre-tail event. The job's end is
  // therefore the newest COMPACT-tier committed row — what the cursor must reach.
  const tiers = { rich_target_tokens: 1, rich_max_tokens: 1, compact_target_tokens: 40000, compact_max_tokens: 80000 };
  const indexer = new SummarizationIndexer({
    storage: h.storage,
    store: h.timeline,
    config: { enabled: true, generation_threshold_tokens: 1, leaf_input_tokens: 100000, leaf_target_tokens: 50 },
    tiers,
  });
  indexer.enqueueReconcileTimeline(ROOM_TK);
  await indexer.stop();

  const jobs = h.storage.getActiveSummarizationJobs(ROOM_TK, 1);
  assert.equal(jobs.length, 1, "the gap commit crossed the threshold and enqueued one job");
  const job = jobs[0]!;
  // The job's input range begins at the OLDEST committed row overall (the floor
  // row $a — itself a genuine committed event with no summary yet) and runs up to
  // the newest compact-tier committed gap row ($c; $d is the rich tail). Crucially
  // the chunk start is the true oldest committed row: there is NO committed gap row
  // stranded BELOW it (the §3 landmine — a gap row buried at/below the floor would
  // leave the cursor unable to reach the head and history would double-render/drop).
  assert.equal(job.inputStartId, `matrix:${ACCOUNT}:$a`, "chunk starts at the oldest committed row (the floor); nothing stranded below");
  assert.equal(job.inputEndId, `matrix:${ACCOUNT}:$c`, "chunk ends at the newest compact-tier committed gap row");

  // Fake worker: complete the job with real lineage over its [start, end] range.
  const start = h.storage.getEventCursor(ROOM_TK, job.inputStartId)!;
  const end = h.storage.getEventCursor(ROOM_TK, job.inputEndId)!;
  const covered = h.storage.getTimelineEventsBetween(ROOM_TK, start, end);
  const content = "summary of the recovered gap";
  await h.storage.insertSummaryWithLineage({
    id: "sum_gap",
    timelineKey: ROOM_TK,
    level: 1,
    content,
    earliestTimestamp: covered[0]!.timestamp,
    latestTimestamp: covered[covered.length - 1]!.timestamp,
    latestEventId: covered[covered.length - 1]!.id,
    eventCount: covered.length,
    tokenCount: estimateTokens(content),
    modelId: "test-model",
    status: "complete",
    generatedAt: Date.now(),
    eventIds: covered.map((e) => e.id),
    jobId: job.id,
  });

  // After completion the coverage cursor extends to the job's newest covered gap
  // row ($c). The CRITICAL §3 invariant: NO committed event sits BELOW the cursor
  // un-covered — the only un-covered committed event ($d) is strictly NEWER than
  // the cursor (the rich tail), never an older buried row.
  const selection = selectSummaryCoverage(h.storage, ROOM_TK);
  assert.equal(
    selection.coverageEndEventId,
    `matrix:${ACCOUNT}:$c`,
    "coverage cursor reaches the newest summarized gap row — no buried row stranded below it",
  );
  const cursorTs = h.storage.getEventCursor(ROOM_TK, selection.coverageEndEventId!)!.timestamp;
  const remaining = h.timeline.queryAfterContext(ROOM_TK, selection.coverageEndEventId!);
  // Every un-covered committed event is strictly newer than the cursor (the rich
  // tail), so nothing older than the cursor is left un-summarized — the gap was
  // recovered contiguously and the cursor advanced cleanly over it.
  for (const ev of remaining) {
    assert.ok(ev.timestamp > cursorTs, `${ev.id} (uncovered) must be newer than the cursor, never a buried older row`);
  }
  assert.deepEqual(remaining.map((e) => e.externalId), ["$d"], "only the newer rich-tail event remains un-covered");
  h.storage.close();
});

// --- #13(a): a crash mid-fill (no commit) leaves nothing committed; a fresh run closes the gap ---
test("crash mid-fill: a discarded run commits nothing; a fresh coordinator re-derives and closes the same gap (#13a)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  await seedFloor(timeline, storage, "$a", 1000);

  // First coordinator: fill descends and buffers, but the run is abandoned WITHOUT
  // commit (crash mid-fill). Simulate by calling prepare() + fill via run() but
  // making commit a no-op through the draining bail — the descent fully buffers,
  // then commit() bails at the top, so NOTHING is committed by this run and the
  // backfill buffer is discarded with the coordinator.
  const pages1 = [
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ];
  // isDraining is false through the fill loop (room launches + fills), then true at
  // commit() — the buffered descent is discarded uncommitted, exactly like a crash
  // after fill but before any write landed.
  let observed = 0;
  const coord1 = new GapBackfetchCoordinator({
    storage,
    timeline,
    config: DEFAULT_CONFIG,
    getClient: () => new ScriptedClient(pages1),
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment() {},
    notifyCaptions() {},
    enqueueChatSearch() {},
    enqueueSummarization() {},
    replayLiveInbound() {},
    isDraining: () => observed++ >= 1, // false at room-launch, true at commit()
    logger: silentLogger(),
  });
  coord1.prepare();
  await coord1.run();

  // Nothing was committed by the crashed/discarded run — only the seeded floor row.
  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a"], "crashed mid-fill run committed nothing");

  // A FRESH coordinator (after "restart") re-derives the SAME floor/gap and fully
  // closes it — the §4 invariant: no durable coordinator state, restart-from-scratch.
  const coord2 = new GapBackfetchCoordinator({
    storage,
    timeline,
    config: DEFAULT_CONFIG,
    getClient: () =>
      new ScriptedClient([
        page(
          [
            summary({ eventId: "$d", timestamp: 4000 }),
            summary({ eventId: "$c", timestamp: 3000 }),
            summary({ eventId: "$b", timestamp: 2000 }),
            summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
          ],
          null,
        ),
      ]),
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

  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a", "$b", "$c", "$d"], "fresh run closes the whole gap, no buried hole");
  storage.close();
});

// --- #13(c): compounding downtime across two crashes ⇒ one contiguous timeline, no buried hole ---
test("compounding downtime: crash-K then new traffic then full close yields one contiguous timeline (#13c)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  await seedFloor(timeline, storage, "$a", 1000);

  // Phase 1: commit-K crashes mid-commit after one oldest row ($b). High-water → $b.
  const client1 = new ScriptedClient([
    page(
      [
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }),
      ],
      null,
    ),
  ]);
  let inserts1 = 0;
  const failingStore1 = {
    async appendIfMissing(event: CanonicalChatEvent, status?: string) {
      if (inserts1 >= 1) throw new Error("crash mid-commit (phase 1)");
      const result = await timeline.appendIfMissing(event, status);
      if (!result.duplicate) inserts1++;
      return result;
    },
    applyEdit: timeline.applyEdit.bind(timeline),
    resolveEditTargetTimelineKey: timeline.resolveEditTargetTimelineKey.bind(timeline),
  } as unknown as TimelineStore;
  const coord1 = makeBareCoordinator(storage, failingStore1, () => client1);
  coord1.prepare();
  await coord1.run();
  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a", "$b"], "phase 1: only $b committed (K=$b)");

  // Phase 2: NEW traffic ($e,$f) arrived above K during further downtime, and this
  // run ALSO crashes mid-commit after one oldest row (the new floor is $b ⇒ oldest
  // gap row is $c). High-water → $c. The §4 "at most one gap" invariant must hold:
  // the still-unfilled span is the single contiguous (floor, head] above $c.
  const client2 = new ScriptedClient([
    page(
      [
        summary({ eventId: "$f", timestamp: 6000 }),
        summary({ eventId: "$e", timestamp: 5000 }),
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }), // new floor — stop
      ],
      null,
    ),
  ]);
  let inserts2 = 0;
  const failingStore2 = {
    async appendIfMissing(event: CanonicalChatEvent, status?: string) {
      if (inserts2 >= 1) throw new Error("crash mid-commit (phase 2)");
      const result = await timeline.appendIfMissing(event, status);
      if (!result.duplicate) inserts2++;
      return result;
    },
    applyEdit: timeline.applyEdit.bind(timeline),
    resolveEditTargetTimelineKey: timeline.resolveEditTargetTimelineKey.bind(timeline),
  } as unknown as TimelineStore;
  const coord2 = makeBareCoordinator(storage, failingStore2, () => client2);
  coord2.prepare();
  await coord2.run();
  // Oldest-first ⇒ $c committed next. Contiguous, no buried hole between $b and $c.
  assert.deepEqual(storedIds(storage, ROOM_TK), ["$a", "$b", "$c"], "phase 2: $c committed; timeline stays contiguous");

  // Phase 3: full close — a clean run re-derives the single gap above $c ($d,$e,$f)
  // and commits it. The final timeline is ONE contiguous block, no buried hole
  // anywhere across the compounding downtime.
  const client3 = new ScriptedClient([
    page(
      [
        summary({ eventId: "$f", timestamp: 6000 }),
        summary({ eventId: "$e", timestamp: 5000 }),
        summary({ eventId: "$d", timestamp: 4000 }),
        summary({ eventId: "$c", timestamp: 3000 }), // new floor — stop
      ],
      null,
    ),
  ]);
  const coord3 = makeBareCoordinator(storage, timeline, () => client3);
  coord3.prepare();
  await coord3.run();

  assert.deepEqual(
    storedIds(storage, ROOM_TK),
    ["$a", "$b", "$c", "$d", "$e", "$f"],
    "single contiguous timeline after compounding downtime — no buried hole",
  );
  storage.close();
});

// --- #14: a live-buffer event sharing a canonical id with a descent-fetched event
//          is committed once (dedup) AND still replayed with its trigger ---
test("boundary overlap: a live @ that the descent also fetched is committed once and replayed with its trigger (#14)", async () => {
  // $b is BOTH a backward-descent gap row AND a live-buffered inbound carrying a
  // trigger (it straddles the freeze boundary — captured by the descent and also
  // delivered live). It must be inserted exactly once (commit-time dedup by
  // canonical id) yet still replayed through replayLiveInbound so its trigger
  // re-attaches via the live path (§7c "duplicate insert re-attaches the trigger").
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$b", timestamp: 2000, body: "hey @miku", sender: "@alice:example.org" }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  // The SAME event ($b) is buffered live with a trigger while frozen.
  const liveB = makeInbound("$b", 2000);
  h.coordinator.bufferLive(liveB);
  // And a strictly-newer live event after it, to prove ordering is preserved.
  h.coordinator.bufferLive(makeInbound("$c", 3000));
  await h.coordinator.run();

  // $b inserted exactly once by the commit (the descent buffer) — not twice.
  assert.deepEqual(
    h.recording.inserted,
    [`matrix:${ACCOUNT}:$b`],
    "the boundary-overlap event is committed exactly once (dedup)",
  );
  // …and still replayed through the live path with its trigger so the reply fires.
  assert.deepEqual(
    h.replayed.map((i) => i.event.externalId),
    ["$b", "$c"],
    "both live events replayed in order — the overlap event is NOT swallowed by dedup",
  );
  // The replayed $b is the live inbound (the trigger carrier), not the backfill row.
  assert.equal(h.replayed[0]!.event.body, "live", "the replayed overlap event is the live inbound (trigger carrier)");
  h.storage.close();
});

// --- #15(a): a duplicate canonical id in the backfill buffer ⇒ exactly one insert ---
test("commit dedup: a duplicate canonical id in the backfill buffer inserts exactly once (#15a)", async () => {
  // The same eventId appears twice across pages (server returned an overlapping
  // page boundary). The commit dedups by canonical id before inserting.
  const h = await makeHarness([
    page([summary({ eventId: "$c", timestamp: 3000 }), summary({ eventId: "$b", timestamp: 2000 })], "tok1"),
    // page 2 re-includes $b (overlap) plus reaches the floor.
    page([summary({ eventId: "$b", timestamp: 2000 }), summary({ eventId: "$a", timestamp: 1000 })], null),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // $b appears once in the inserted list and once in the stored timeline.
  assert.deepEqual(
    h.recording.inserted,
    [`matrix:${ACCOUNT}:$b`, `matrix:${ACCOUNT}:$c`],
    "the duplicated buffer id is committed exactly once",
  );
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b", "$c"]);
  h.storage.close();
});

// --- #15(b): active committed rows nudge enrichment / chat-search / captions ---
test("commit nudges: active gap rows fire enrichment, chat-search, and caption nudges (#15b)", async () => {
  // A link-bearing gap event needs enrichment (link preview) ⇒ status 'pending',
  // enrichment nudged, chat-search projected, and the caption pool nudged. A
  // plain-text gap event is chat-indexed but 'skipped' (no enrichment). The harness
  // captures these arrays but the prior tests never asserted them (#15 review).
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$link", timestamp: 3000, body: "see http://example.com for details" }),
        summary({ eventId: "$txt", timestamp: 2000, body: "plain text" }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  const linkId = `matrix:${ACCOUNT}:$link`;
  const txtId = `matrix:${ACCOUNT}:$txt`;
  // Chat-search projection fires for BOTH active committed gap rows.
  assert.ok(h.chatIndexed.includes(linkId), "link gap row projected into chat-search");
  assert.ok(h.chatIndexed.includes(txtId), "text gap row projected into chat-search");
  // The link-bearing event needs enrichment ⇒ stored 'pending' and enrichment nudged.
  assert.equal(statusOf(h.storage, "$link"), "pending", "link gap row is 'pending' (needs enrichment)");
  assert.ok(h.enriched.includes(linkId), "enrichment nudged for the link gap row");
  // Plain text needs no enrichment ⇒ 'skipped', not enrichment-nudged.
  assert.equal(statusOf(h.storage, "$txt"), "skipped", "plain text gap row is 'skipped'");
  assert.equal(h.enriched.includes(txtId), false, "no enrichment nudge for plain text");
  // The caption pool was nudged at least once (committedAnyActive ⇒ notifyCaptions).
  assert.ok(h.captioned.count >= 1, "caption pool nudged for the active commit");
  // Summarization nudged for the affected timeline.
  assert.deepEqual(h.summarized, [ROOM_TK]);
  h.storage.close();
});

// --- #15(c): an INACTIVE timeline stores gap rows 'inactive' with NO downstream nudge ---
test("commit status: an inactive timeline stores gap rows 'inactive' with no enrichment/summarization nudge (#15c)", async () => {
  // Seed the floor on an INACTIVE timeline (the room exists / has history but is
  // not active). Committed gap rows must be stored 'inactive' (deferred to a future
  // activation flip), and NONE of the active-only nudges fire.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$b", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  // Seed a committed floor row but force the timeline INACTIVE.
  await seedFloor(h.timeline, h.storage, "$a", 1000);
  await h.storage.setTimelineState(ROOM_TK, "inactive");

  h.coordinator.prepare();
  await h.coordinator.run();

  // Gap rows committed (the descent still runs) but stored 'inactive'.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$b", "$c"]);
  assert.equal(statusOf(h.storage, "$b"), "inactive", "inactive-timeline gap row stored 'inactive'");
  assert.equal(statusOf(h.storage, "$c"), "inactive");
  // No active-only nudges: no enrichment, no chat-search, no captions, no summarization.
  assert.deepEqual(h.enriched, [], "no enrichment nudge for inactive timeline");
  assert.deepEqual(h.chatIndexed, [], "no chat-search projection for inactive timeline");
  assert.deepEqual(h.summarized, [], "no summarization nudge for inactive timeline");
  assert.equal(h.captioned.count, 0, "no caption nudge for inactive timeline");
  h.storage.close();
});

// --- #15(c'): a UTD event is stored 'skipped' regardless of timeline state ---
test("commit status: a UTD gap row is stored 'skipped' even on an inactive timeline (#15c-utd)", async () => {
  // UTD events are ALWAYS 'skipped' (the sweeper heals them), independent of the
  // timeline's active/inactive state — the status branch checks UTD first.
  const h = await makeHarness([
    page(
      [
        utdSummary({ eventId: "$utd", timestamp: 3000 }),
        summary({ eventId: "$plain", timestamp: 2000 }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);
  await h.storage.setTimelineState(ROOM_TK, "inactive");

  h.coordinator.prepare();
  await h.coordinator.run();

  // UTD ⇒ 'skipped' regardless of state; the plain text follows the inactive state.
  assert.equal(statusOf(h.storage, "$utd"), "skipped", "UTD gap row is 'skipped' regardless of timeline state");
  assert.equal(statusOf(h.storage, "$plain"), "inactive", "non-UTD row on the inactive timeline is 'inactive'");
  h.storage.close();
});

// --- #15(d): an m.replace edit in a backfetched page is applied at commit ---
test("commit edits: an m.replace in a backfetched page updates its gap target's body at commit (#15d)", async () => {
  // The page carries the original message ($orig) AND an m.replace edit of it
  // ($edit, relType m.replace → $orig). The edit is buffered separately and applied
  // AFTER all inserts (the target now exists), updating $orig's body in place. The
  // edit is never stored as a standalone row.
  const h = await makeHarness([
    page(
      [
        summary({
          eventId: "$edit",
          timestamp: 3000,
          body: "* edited body",
          relatesTo: { relType: "m.replace", eventId: "$orig" },
        }),
        summary({ eventId: "$orig", timestamp: 2000, body: "original body" }),
        summary({ eventId: "$a", timestamp: 1000 }), // floor — stop
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  // Only $orig is stored (the edit is not a standalone row); its body is updated.
  assert.deepEqual(storedIds(h.storage, ROOM_TK), ["$a", "$orig"], "the edit is not a standalone row");
  const orig = h.storage.getTimelineEventById(`matrix:${ACCOUNT}:$orig`);
  assert.equal(orig?.body, "* edited body", "the m.replace edit was applied to the target's body at commit");
  h.storage.close();
});

// --- #15(e): a room known ONLY via agent_sessions is frozen by prepare() ---
test("enumeration: a room known only via agent_sessions (no timeline_events) is frozen by prepare() (#15e)", async () => {
  // listKnownTimelineKeys() unions timeline_events, agent_sessions, and
  // timeline_compaction_state. A room that has only an agent_sessions row (e.g. a
  // session was created but its events were pruned/never persisted) must still be
  // enumerated and frozen so a gap there is recoverable.
  const h = await makeHarness([page([summary({ eventId: "$x", timestamp: 1 })], null)]);
  // No timeline_events, no compaction-state row — register the room ONLY via a
  // session row keyed to ROOM_TK.
  await h.storage.insertAgentSession({
    id: "sess-known-only",
    timelineKey: ROOM_TK,
    sessionType: "chat",
    status: "created",
    createdAt: 1000,
    updatedAt: 1000,
  });

  h.coordinator.prepare();
  assert.equal(
    h.coordinator.isFrozen(ROOM_TK),
    true,
    "a room known only via agent_sessions is enumerated and frozen by prepare()",
  );
  h.storage.close();
});

/** A coordinator with all-silent downstreams and a custom timeline + client. */
function makeBareCoordinator(
  storage: Storage,
  timeline: TimelineStore,
  getClient: () => BackfillReadClient,
): GapBackfetchCoordinator {
  return new GapBackfetchCoordinator({
    storage,
    timeline,
    config: DEFAULT_CONFIG,
    getClient,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment() {},
    notifyCaptions() {},
    enqueueChatSearch() {},
    enqueueSummarization() {},
    replayLiveInbound() {},
    isDraining: () => false,
    logger: silentLogger(),
  });
}

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

// ── Bot self-message dedup (assistant-echo duplicates) ─────────────────────

/** Seed a bot-sent message the way send_message persists it: an `assistant:` canonical id. */
async function seedAssistantRow(
  timeline: TimelineStore,
  storage: Storage,
  eventId: string,
  timestamp: number,
): Promise<void> {
  const event: CanonicalChatEvent = {
    id: `assistant:sess-1:${eventId}:0`,
    externalId: eventId,
    timelineKey: ROOM_TK,
    provider: "matrix",
    agentSessionId: "sess-1",
    role: "assistant",
    sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
    body: "bot reply",
    timestamp,
    receivedAt: timestamp,
  };
  await timeline.append(event);
  await storage.setTimelineState(ROOM_TK, "active");
}

test("floor stop recognizes a bot-sent floor stored under an assistant: canonical id via its external id", async () => {
  // The newest committed event is the bot's own message: send_message stored it as
  // `assistant:sess-1:$f:0`, so the descent's re-derived `matrix:miku:$f` candidate
  // id can never equal floor.id — only the external-id comparison stops here.
  // Without it the descent would page past the floor and re-buffer the bot's own
  // message (the historical duplicate-row bug).
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$f", timestamp: 2000, sender: SELF, body: "bot reply" }),
      ],
      "tok1",
    ),
    page([summary({ eventId: "$old", timestamp: 500 })], null),
  ]);
  await seedAssistantRow(h.timeline, h.storage, "$f", 2000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.equal(h.client.calls.length, 1, "stopped on the first page at the assistant-row floor");
  assert.deepEqual(h.recording.inserted, [`matrix:${ACCOUNT}:$c`], "only the genuine gap event commits");
  assert.equal(
    h.storage.read((db) =>
      (db.prepare(`select count(*) as n from timeline_events where external_id = '$f'`).get() as { n: number }).n,
    ),
    1,
    "the bot's own floor message is not duplicated",
  );
  h.storage.close();
});

test("commit dedups a re-fetched same-ms bot message against its assistant: row by external id", async () => {
  // Floor = a user message at ts 2000; the bot's reply $s shares that millisecond
  // and is already stored under an assistant: id. The descent must buffer $s (same
  // ts, not the floor event — #4 exact-match), and the commit must then drop it by
  // (provider, external_id, timeline_key) instead of inserting a matrix: duplicate.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$c", timestamp: 3000 }),
        summary({ eventId: "$s", timestamp: 2000, sender: SELF, body: "bot reply" }),
        summary({ eventId: "$u", timestamp: 2000 }), // the floor — exact id match
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$u", 2000);
  await seedAssistantRow(h.timeline, h.storage, "$s", 2000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(h.recording.inserted, [`matrix:${ACCOUNT}:$c`], "the self message dedups at commit");
  assert.equal(
    h.storage.read((db) =>
      (db.prepare(`select count(*) as n from timeline_events where external_id = '$s'`).get() as { n: number }).n,
    ),
    1,
    "exactly one row for the bot's same-ms message",
  );
  h.storage.close();
});
