import assert from "node:assert/strict";
import test from "node:test";
import {
  MessageBackfetchCoordinator,
  type MessageBackfetchConfig,
} from "../src/backfill/message-backfetch.js";
import type { BackfillReadClient } from "../src/backfill/paginate.js";
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

function summary(
  over: Partial<MatrixMessageSummary> & { eventId: string; timestamp: number },
): MatrixMessageSummary {
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

const DEFAULT_CONFIG: MessageBackfetchConfig = {
  enabled: true,
  pageSize: 100,
  maxBacklog: 0,
  pageMinIntervalMs: 0,
  defaultSafetyCap: 0,
  defaultTimeoutMs: 0,
  utdHaltThreshold: 50,
  captionBackfetched: false,
};

interface Harness {
  storage: Storage;
  timeline: TimelineStore;
  coordinator: MessageBackfetchCoordinator;
  enriched: string[];
  chatIndexed: string[];
  captionNudges: { count: number };
}

async function makeHarness(
  client: BackfillReadClient,
  configOverride: Partial<MessageBackfetchConfig> = {},
): Promise<Harness> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const enriched: string[] = [];
  const chatIndexed: string[] = [];
  const captionNudges = { count: 0 };
  const coordinator = new MessageBackfetchCoordinator({
    storage,
    timeline,
    config: { ...DEFAULT_CONFIG, ...configOverride },
    getClient: () => client,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment: (id) => enriched.push(id),
    notifyCaptions: () => captionNudges.count++,
    enqueueChatSearch: (id) => chatIndexed.push(id),
    isDraining: () => false,
    sleep: () => Promise.resolve(),
    logger: silentLogger(),
  });
  return { storage, timeline, coordinator, enriched, chatIndexed, captionNudges };
}

/** Seed an existing (first-class) event via the live append path. */
async function seedLive(
  timeline: TimelineStore,
  storage: Storage,
  eventId: string,
  timestamp: number,
): Promise<void> {
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
  await timeline.appendIfMissing(event, "skipped");
  await storage.setTimelineState(ROOM_TK, "active");
}

function storedExternalIds(storage: Storage): string[] {
  return storage
    .read((db) =>
      db
        .prepare(
          `select external_id from timeline_events where timeline_key = ? order by timestamp asc, received_at asc, id asc`,
        )
        .all(ROOM_TK) as Array<{ external_id: string }>,
    )
    .map((r) => r.external_id);
}

/** Await a coordinator job to finish by polling the in-memory run set via snapshot status. */
async function waitForTerminal(h: Harness, jobId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const job = h.storage.getBackfetchJob(jobId);
    if (job && ["completed", "failed", "cancelled", "paused"].includes(job.status)) return job.status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not terminate");
}

test("beginning: pins floor at current-oldest, stores only below-floor rows as is_backfetch, excludes them from context", async () => {
  const client = new ScriptedClient([
    page(
      [
        summary({ eventId: "$e200", timestamp: 200 }),
        summary({ eventId: "$e100", timestamp: 100 }), // current oldest = the floor
        summary({ eventId: "$e090", timestamp: 90 }),
        summary({ eventId: "$e080", timestamp: 80 }),
      ],
      "t1",
    ),
    page([summary({ eventId: "$e070", timestamp: 70 }), summary({ eventId: "$e060", timestamp: 60 })], null),
  ]);
  const h = await makeHarness(client);
  await seedLive(h.timeline, h.storage, "$e100", 100);
  await seedLive(h.timeline, h.storage, "$e200", 200);

  const started = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "beginning",
  });
  assert.equal(started.ok, true);
  const jobId = started.ok ? started.job.id : "";
  const status = await waitForTerminal(h, jobId);
  assert.equal(status, "completed");

  // Floor pinned to the current-oldest ($e100).
  assert.equal(h.storage.getContextFloorEventId(ROOM_TK), `matrix:${ACCOUNT}:$e100`);

  // The 4 below-floor events are stored, marked is_backfetch; the 2 already-held
  // events ($e100/$e200) are NOT re-stored.
  assert.deepEqual(storedExternalIds(h.storage), ["$e060", "$e070", "$e080", "$e090", "$e100", "$e200"]);
  for (const id of ["$e060", "$e070", "$e080", "$e090"]) {
    assert.equal(h.storage.isBackfetchEvent(`matrix:${ACCOUNT}:${id}`), true, `${id} should be backfetch`);
  }
  assert.equal(h.storage.isBackfetchEvent(`matrix:${ACCOUNT}:$e100`), false);

  // Context query is clamped to the floor: only the first-class ($e100/$e200) show;
  // the raw timeline query still returns everything (search-only region is searchable).
  const ctx = h.timeline.queryForContext(ROOM_TK).map((e) => e.externalId);
  assert.deepEqual(ctx, ["$e100", "$e200"]);
  const raw = h.timeline.query({ timelineKey: ROOM_TK }).map((e) => e.externalId);
  assert.deepEqual(raw, ["$e060", "$e070", "$e080", "$e090", "$e100", "$e200"]);

  // Backfetched rows get FRESH, larger rowids (inserted last) — the rowid-anchored
  // chat_index sweep picks them up with no consumer change (spec §2).
  const rowids = h.storage.read((db) =>
    (db.prepare(`select external_id, rowid from timeline_events order by rowid`).all() as Array<{
      external_id: string;
      rowid: number;
    }>).map((r) => r.external_id),
  );
  assert.equal(rowids[0], "$e100"); // seeded first
  assert.equal(rowids[1], "$e200");
  assert.equal(rowids[2], "$e090"); // backfetched after → larger rowid

  // Chat-search projection nudged for every committed below-floor row.
  assert.deepEqual([...h.chatIndexed].sort(), ["$e060", "$e070", "$e080", "$e090"].map((e) => `matrix:${ACCOUNT}:${e}`).sort());

  await h.storage.close();
});

test("count target stops at the requested number of stored rows", async () => {
  const client = new ScriptedClient([
    page(
      [
        summary({ eventId: "$e100", timestamp: 100 }),
        summary({ eventId: "$e090", timestamp: 90 }),
        summary({ eventId: "$e080", timestamp: 80 }),
        summary({ eventId: "$e070", timestamp: 70 }),
      ],
      "t1",
    ),
  ]);
  const h = await makeHarness(client);
  await seedLive(h.timeline, h.storage, "$e100", 100);

  const started = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "count",
    targetValue: "2",
  });
  const jobId = started.ok ? started.job.id : "";
  assert.equal(await waitForTerminal(h, jobId), "completed");
  const job = h.storage.getBackfetchJob(jobId)!;
  assert.equal(job.stored, 2);
  assert.equal(job.stopReason, "count");
  assert.deepEqual(storedExternalIds(h.storage), ["$e080", "$e090", "$e100"]);

  await h.storage.close();
});

test("date target stops at the requested instant (window)", async () => {
  const client = new ScriptedClient([
    page(
      [
        summary({ eventId: "$e100", timestamp: 100 }),
        summary({ eventId: "$e090", timestamp: 90 }),
        summary({ eventId: "$e050", timestamp: 50 }), // below the date floor (75) → window stop
      ],
      "t1",
    ),
  ]);
  const h = await makeHarness(client);
  await seedLive(h.timeline, h.storage, "$e100", 100);

  const started = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "date",
    targetValue: iso(75),
  });
  const jobId = started.ok ? started.job.id : "";
  assert.equal(await waitForTerminal(h, jobId), "completed");
  const job = h.storage.getBackfetchJob(jobId)!;
  assert.equal(job.stopReason, "window");
  // $e090 stored, $e050 not (below the floor).
  assert.deepEqual(storedExternalIds(h.storage), ["$e090", "$e100"]);

  await h.storage.close();
});

test("single-flight: a second job for the same room is rejected", async () => {
  const client = new ScriptedClient([page([], null)]);
  const h = await makeHarness(client);
  await seedLive(h.timeline, h.storage, "$e100", 100);
  const first = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "beginning",
  });
  assert.equal(first.ok, true);
  const second = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "beginning",
  });
  assert.equal(second.ok, false);
  await h.storage.close();
});

test("resume uses the stored cursor token as the initial backward continuation", async () => {
  const client = new ScriptedClient([
    page([summary({ eventId: "$e070", timestamp: 70 }), summary({ eventId: "$e060", timestamp: 60 })], null),
  ]);
  const h = await makeHarness(client);
  await seedLive(h.timeline, h.storage, "$e100", 100);
  // A paused job with a persisted cursor (as if a prior run parked here).
  const job = await h.storage.insertBackfetchJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "beginning",
  });
  await h.storage.updateBackfetchJob(job.id, { status: "paused", cursorToken: "resume-token" });

  const res = await h.coordinator.resumeJob(job.id);
  assert.equal(res.ok, true);
  assert.equal(await waitForTerminal(h, job.id), "completed");
  // First read used the stored token, not the room head.
  assert.equal(client.calls[0], "resume-token");
  await h.storage.close();
});

test("re-running over already-fetched history is idempotent (dedup, floor unchanged)", async () => {
  const pages = [
    page(
      [
        summary({ eventId: "$e100", timestamp: 100 }),
        summary({ eventId: "$e090", timestamp: 90 }),
        summary({ eventId: "$e080", timestamp: 80 }),
      ],
      null,
    ),
  ];
  const h = await makeHarness(new ScriptedClient(pages));
  await seedLive(h.timeline, h.storage, "$e100", 100);
  const a = await h.coordinator.startJob({ roomId: ROOM, accountId: ACCOUNT, timelineKey: ROOM_TK, targetKind: "beginning" });
  await waitForTerminal(h, a.ok ? a.job.id : "");
  const floorAfterFirst = h.storage.getContextFloorEventId(ROOM_TK);
  const idsAfterFirst = storedExternalIds(h.storage);

  // Second job, fresh client serving the same pages: every event dedups, floor is
  // set-once (not moved), nothing new is stored.
  const h2Client = new ScriptedClient([
    page(
      [
        summary({ eventId: "$e100", timestamp: 100 }),
        summary({ eventId: "$e090", timestamp: 90 }),
        summary({ eventId: "$e080", timestamp: 80 }),
      ],
      null,
    ),
  ]);
  // Reuse the SAME storage/timeline by swapping the client via a fresh coordinator.
  const coordinator2 = new MessageBackfetchCoordinator({
    storage: h.storage,
    timeline: h.timeline,
    config: DEFAULT_CONFIG,
    getClient: () => h2Client,
    selfUserIds: new Map([[ACCOUNT, SELF]]),
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    enqueueChatSearch: () => {},
    isDraining: () => false,
    sleep: () => Promise.resolve(),
    logger: silentLogger(),
  });
  const b = await coordinator2.startJob({ roomId: ROOM, accountId: ACCOUNT, timelineKey: ROOM_TK, targetKind: "beginning" });
  await waitForTerminal({ ...h, coordinator: coordinator2 }, b.ok ? b.job.id : "");
  assert.deepEqual(storedExternalIds(h.storage), idsAfterFirst);
  assert.equal(h.storage.getContextFloorEventId(ROOM_TK), floorAfterFirst);
  await h.storage.close();
});

test("setContextFloorIfUnset is set-once and never moved", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const r1 = await storage.setContextFloorIfUnset(ROOM_TK, "evt-A");
  assert.deepEqual(r1, { set: true, floorEventId: "evt-A" });
  const r2 = await storage.setContextFloorIfUnset(ROOM_TK, "evt-B");
  assert.deepEqual(r2, { set: false, floorEventId: "evt-A" });
  assert.equal(storage.getContextFloorEventId(ROOM_TK), "evt-A");
  await storage.close();
});

test("deferred backfetched captions are inert until promoted, even under caption_all", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  // A backfetched event with a captionable, downloaded media asset marked 'deferred'.
  await timeline.appendIfMissing(
    {
      id: `matrix:${ACCOUNT}:$img`,
      externalId: "$img",
      timelineKey: ROOM_TK,
      provider: "matrix",
      role: "user",
      sender: { id: "@alice:example.org", isSelf: false },
      body: "pic",
      timestamp: 50,
      receivedAt: 50,
    },
    "skipped",
    { isBackfetch: true },
  );
  await storage.write((db) => {
    db.prepare(
      `insert into media_assets (id, event_id, role, media_type, caption_status, download_status, created_at, updated_at)
       values ('m1', 'matrix:${ACCOUNT}:$img', 'attachment', 'image', 'deferred', 'complete', 1, 1)`,
    ).run();
    return null;
  });

  // Even with caption_all=true, a 'deferred' asset is never claimed.
  let claimed = await storage.claimPendingCaptions(10, true, true);
  assert.equal(claimed.length, 0);

  // Promote deferred → pending; now it is claimable even with caption_all=false (the
  // promote IS the opt-in for a backfetched event with no trigger group).
  const promoted = await storage.promoteBackfetchedCaptions(ROOM_TK);
  assert.equal(promoted, 1);
  claimed = await storage.claimPendingCaptions(10, false, false);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.id, "m1");
  await storage.close();
});

test("disabled coordinator refuses to start jobs", async () => {
  const h = await makeHarness(new ScriptedClient([page([], null)]), { enabled: false });
  await seedLive(h.timeline, h.storage, "$e100", 100);
  const res = await h.coordinator.startJob({
    roomId: ROOM,
    accountId: ACCOUNT,
    timelineKey: ROOM_TK,
    targetKind: "beginning",
  });
  assert.equal(res.ok, false);
  await h.storage.close();
});
