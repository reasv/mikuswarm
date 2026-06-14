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
  client: ScriptedClient;
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
): Promise<Harness> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const recording = new RecordingStore(timeline);
  const client = new ScriptedClient(pages);
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

test("no-gap fast path: first page contains the floor, nothing committed", async () => {
  const h = await makeHarness([
    page([summary({ eventId: "$a", timestamp: 1000 })], "tok1"),
  ]);
  await seedFloor(h.timeline, h.storage, "$a", 1000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(h.recording.inserted, [], "no rows committed");
  assert.equal(h.client.calls.length, 1, "stopped on the first page");
  assert.equal(h.coordinator.isFrozen(ROOM_TK), false);
  h.storage.close();
});

test("floor boundary: an event newer than the floor by id tiebreak at equal timestamp is stored", async () => {
  // floor = $m at ts=2000. $n (same ts, id > floor.id) is ABOVE the floor → stored.
  // $a (same ts, id < floor.id) is at/below the floor → stop.
  const h = await makeHarness([
    page(
      [
        summary({ eventId: "$n", timestamp: 2000 }),
        summary({ eventId: "$m", timestamp: 2000 }), // exactly the floor → stop
        summary({ eventId: "$a", timestamp: 2000 }),
      ],
      null,
    ),
  ]);
  await seedFloor(h.timeline, h.storage, "$m", 2000);

  h.coordinator.prepare();
  await h.coordinator.run();

  assert.deepEqual(h.recording.inserted, [`matrix:${ACCOUNT}:$n`], "only the strictly-above-floor event");
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
  let cappedSpan: { fromTimestamp: number; toTimestamp: number } | undefined;
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
  cappedSpan = snap[0]?.cappedHole;
  assert.deepEqual(cappedSpan, { fromTimestamp: 1000, toTimestamp: 3000 });
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
      if (inserts >= 1) throw new Error("simulated crash mid-commit");
      inserts++;
      return timeline.appendIfMissing(event, status);
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
