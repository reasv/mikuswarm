import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  ActivationCoordinator,
  type ActivationStorage,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent, InboundChatEvent, TriggerInfo } from "../src/types.js";

const TK = "matrix:miku:room:!room:example.org";

const SESSIONS_CONFIG: AppConfig["agent"]["sessions"] = {
  max_concurrent: 1,
  max_concurrent_dm: 1,
  max_queued_per_timeline: 10,
} as AppConfig["agent"]["sessions"];

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

function userEvent(overrides: { id: string; body?: string; timestamp?: number }): CanonicalChatEvent {
  return {
    id: overrides.id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: overrides.body ?? "hi",
    timestamp: overrides.timestamp ?? 1_000,
    receivedAt: overrides.timestamp ?? 1_000,
  };
}

function triggerInbound(event: CanonicalChatEvent): InboundChatEvent {
  const trigger: TriggerInfo = {
    type: "mention",
    reason: "test",
    triggeredBy: event.sender,
  };
  return {
    provider: "matrix",
    timelineKey: TK,
    event: { ...event, trigger },
    trigger,
    outboundTarget: { provider: "matrix", accountId: "miku", roomId: "!room:example.org" } as InboundChatEvent["outboundTarget"],
  };
}

function plainInbound(event: CanonicalChatEvent): InboundChatEvent {
  return {
    provider: "matrix",
    timelineKey: TK,
    event,
    outboundTarget: { provider: "matrix", accountId: "miku", roomId: "!room:example.org" } as InboundChatEvent["outboundTarget"],
  };
}

interface Harness {
  storage: Storage;
  timeline: TimelineStore;
  router: TimelineRouter;
  triggerCoordinator: TriggerCoordinator;
  coordinator: ActivationCoordinator;
  launched: InboundChatEvent[];
  dispatched: InboundChatEvent[];
  claimed: InboundChatEvent[];
  released: InboundChatEvent[];
  enriched: string[];
  warnings: Array<{ event: string; fields?: Record<string, unknown> }>;
  setDraining: (value: boolean) => void;
  hooks: {
    runInitialBackfill: (inbound: InboundChatEvent) => Promise<void>;
    awaitTriggerReadiness: (inbound: InboundChatEvent) => Promise<void>;
    activateTimelineEventsCount: () => number;
  };
}

/**
 * Build a coordinator wired to a real in-memory Storage/router/trigger
 * coordinator. The heavy operations are injected as controllable fakes. By
 * default `dispatch` re-enters gateInbound (mirroring app.ts's handleInbound
 * delegation) so held-trigger replay is exercised end to end.
 */
function makeHarness(overrides?: {
  runInitialBackfill?: (inbound: InboundChatEvent) => Promise<void>;
  resolveTriggerGroup?: (inbound: InboundChatEvent) => Promise<void>;
  awaitTriggerReadiness?: (inbound: InboundChatEvent) => Promise<void>;
  launchSession?: (inbound: InboundChatEvent, duplicate: boolean, h: Harness) => void;
  // Wrap the storage surface handed to the coordinator (e.g. to make the
  // catch-path 'inactive' reset throw). The real Storage is still used by the
  // router/timeline so events persist normally.
  wrapStorage?: (storage: Storage) => ActivationStorage;
}): Promise<Harness> {
  return Storage.open({ databasePath: ":memory:" }).then((storage) => {
    const timeline = new TimelineStore(storage);
    const router = new TimelineRouter(timeline);
    const triggerCoordinator = new TriggerCoordinator(SESSIONS_CONFIG);

    const launched: InboundChatEvent[] = [];
    const dispatched: InboundChatEvent[] = [];
    const claimed: InboundChatEvent[] = [];
    const released: InboundChatEvent[] = [];
    const enriched: string[] = [];
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    let draining = false;

    const harness = {} as Harness;

    const coordinator = new ActivationCoordinator({
      storage: overrides?.wrapStorage ? overrides.wrapStorage(storage) : storage,
      router,
      triggerCoordinator,
      setEnrichmentStatus: (eventId, status) => timeline.setEnrichmentStatus(eventId, status),
      notifyEnrichment: (eventId) => {
        enriched.push(eventId);
      },
      notifyCaptions: () => {},
      runInitialBackfill: overrides?.runInitialBackfill ?? (async () => {}),
      resolveTriggerGroup: overrides?.resolveTriggerGroup ?? (async () => {}),
      awaitTriggerReadiness: overrides?.awaitTriggerReadiness ?? (async () => {}),
      addClaim: (inbound) => {
        claimed.push(inbound);
      },
      releaseClaim: (inbound) => {
        released.push(inbound);
      },
      launchSession: async (inbound, duplicate) => {
        launched.push(inbound);
        if (overrides?.launchSession) overrides.launchSession(inbound, duplicate, harness);
      },
      // Mirror app.ts handleInbound: gate first; if the timeline is active, run
      // the active-path trigger handling (accept → spawn-or-queue).
      dispatch: (inbound) => {
        dispatched.push(inbound);
        void coordinator.gateInbound(inbound).then((outcome) => {
          if (outcome !== "active" || !inbound.trigger) return;
          const decision = triggerCoordinator.accept(inbound);
          if (decision.action === "spawn") {
            launched.push(inbound);
            if (overrides?.launchSession) overrides.launchSession(inbound, false, harness);
          }
        });
      },
      isDraining: () => draining,
      logger: {
        info() {},
        warn(event, fields) {
          warnings.push({ event, fields });
        },
        error() {},
      },
    });

    Object.assign(harness, {
      storage,
      timeline,
      router,
      triggerCoordinator,
      coordinator,
      launched,
      dispatched,
      claimed,
      released,
      enriched,
      warnings,
      setDraining: (value: boolean) => {
        draining = value;
      },
    });
    return harness;
  });
}

test("non-trigger event on an inactive timeline is stored cheaply and stays inactive", async () => {
  const h = await makeHarness();
  try {
    const result = await h.coordinator.gateInbound(plainInbound(userEvent({ id: "e1" })));
    assert.equal(result, "handled");
    const status = h.storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("e1") as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "inactive");
    assert.equal(h.storage.getTimelineState(TK), "inactive");
    assert.equal(h.launched.length, 0);
  } finally {
    h.storage.close();
  }
});

test("first trigger activates the timeline and launches a session", async () => {
  const h = await makeHarness();
  try {
    const result = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    assert.equal(result, "handled");
    // Yield so the post-prelude void launchSession runs.
    await new Promise((r) => setImmediate(r));
    assert.equal(h.storage.getTimelineState(TK), "active");
    assert.equal(h.launched.length, 1, "the initiating trigger should launch a session");
    assert.equal(h.launched[0].event.id, "t1");
    assert.equal(h.triggerCoordinator.activeCount(TK), 1, "the slot is claimed by the active session");
  } finally {
    h.storage.close();
  }
});

test("activation claims the activating trigger (spec CLAIM-VISIBILITY-SERIALIZATION §4.3) so its message renders a marker", async () => {
  const h = await makeHarness();
  try {
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    await new Promise((r) => setImmediate(r));
    // The activating trigger is claimed exactly once, on the spawn decision — like
    // every other accepted trigger. (The real registry is what makes the message
    // render a `<handled_by_session>` marker; here we assert the claim is inserted.)
    assert.equal(h.claimed.length, 1, "the activating trigger is claimed");
    assert.equal(h.claimed[0].event.id, "t1");
    // A successful launch never releases the claim here (it is released on settle).
    assert.equal(h.released.length, 0, "a successful launch does not release the activation claim early");
  } finally {
    h.storage.close();
  }
});

test("activation releases the claim when the session launch fails before attribution (no leaked deterrent)", async () => {
  const h = await makeHarness({
    // Force the fire-and-forget launchSession to reject so the activation catch runs.
    launchSession: () => {
      throw new Error("launch boom");
    },
  });
  try {
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    // Let the void launchSession(...).catch chain settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.claimed.length, 1, "the trigger was claimed before launch");
    assert.equal(h.released.length, 1, "a pre-attribution launch failure releases the claim");
    assert.equal(h.released[0].event.id, "t1");
    // The per-timeline slot is freed so future triggers aren't blocked.
    assert.equal(h.triggerCoordinator.activeCount(TK), 0, "the slot is released after the failed launch");
  } finally {
    h.storage.close();
  }
});

test("#1: a second trigger arriving during activation is not dropped — it queues behind the activating session", async () => {
  const backfillGate = deferred();
  const h = await makeHarness({
    // Block the prelude inside backfill so a concurrent trigger lands while the
    // timeline is still 'activating'.
    runInitialBackfill: () => backfillGate.promise,
  });
  try {
    // Kick off activation; it will park in backfill.
    const activation = h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    // Let activation reach the backfill await.
    await new Promise((r) => setImmediate(r));
    assert.ok(h.coordinator.isActivating(TK), "timeline should be mid-activation");

    // A second trigger arrives during the activation window.
    const second = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    assert.equal(second, "handled", "the held trigger is consumed by the activating path, not the active path");
    assert.equal(h.launched.length, 0, "no session spawns while activation holds the slot");

    // Release the prelude.
    backfillGate.resolve();
    await activation;
    await new Promise((r) => setImmediate(r));

    // The initiating trigger launched; the held trigger was replayed and queued
    // behind it (slot already claimed) — not dropped.
    assert.equal(h.launched.length, 1, "only the initiating trigger spawns immediately");
    assert.equal(h.launched[0].event.id, "t1");
    assert.equal(h.dispatched.length, 1, "the held trigger was replayed");
    assert.equal(h.dispatched[0].event.id, "t2");
    assert.equal(h.triggerCoordinator.queuedCount(TK), 1, "the held trigger is queued, not dropped");
  } finally {
    h.storage.close();
  }
});

test("#2: once active, the timeline uses the normal path — a trigger after activation queues via the coordinator (guard cleared before session run)", async () => {
  const h = await makeHarness({
    // The first session never completes during the test, so the slot stays held.
    launchSession: () => {},
  });
  try {
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.storage.getTimelineState(TK), "active");
    assert.ok(!h.coordinator.isActivating(TK), "the activation guard is cleared before the session run");

    // A new trigger now goes through the active path (gateInbound returns
    // "active", and the caller's normal path would handle it). We assert the
    // gate no longer claims it as a lifecycle event.
    const gate = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    assert.equal(gate, "active", "post-activation triggers fall through to the active path");
  } finally {
    h.storage.close();
  }
});

test("#2: concurrent first triggers do not double-activate (in-memory guard)", async () => {
  const backfillGate = deferred();
  let backfillCalls = 0;
  const h = await makeHarness({
    runInitialBackfill: () => {
      backfillCalls++;
      return backfillGate.promise;
    },
  });
  try {
    // Two first triggers race. gateInbound adds the guard synchronously before
    // any await, so only one activation prelude runs.
    const a = h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    const b = h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    await new Promise((r) => setImmediate(r));
    assert.equal(backfillCalls, 1, "only one activation prelude runs");

    backfillGate.resolve();
    await Promise.all([a, b]);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.launched.length, 1, "exactly one initiating session launches");
    assert.equal(h.triggerCoordinator.queuedCount(TK), 1, "the second first-trigger is queued, not dropped");
  } finally {
    h.storage.close();
  }
});

test("#3: a failure mid-activation (after the old inactive→pending flip point) leaves previously-stored events 'inactive'", async () => {
  const h = await makeHarness({
    // Throw during readiness — this is AFTER backfill and where the OLD code had
    // already flipped inactive→pending. With the fix the bulk flip runs only
    // after readiness, so the backlog must remain 'inactive'.
    awaitTriggerReadiness: async () => {
      throw new Error("readiness boom");
    },
  });
  try {
    // Pre-seed inactive backlog events.
    await h.storage.appendTimelineEvent(userEvent({ id: "b1", timestamp: 10 }), "inactive");
    await h.storage.appendTimelineEvent(userEvent({ id: "b2", timestamp: 20 }), "inactive");

    await assert.rejects(
      () => h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1", timestamp: 30 }))),
      /readiness boom/,
    );

    const statuses = h.storage.read((db) =>
      Object.fromEntries(
        (db.prepare("select id, enrichment_status from timeline_events").all() as Array<{ id: string; enrichment_status: string }>).map((r) => [r.id, r.enrichment_status]),
      ),
    );
    assert.equal(statuses.b1, "inactive", "backlog must stay inactive on a pre-active failure");
    assert.equal(statuses.b2, "inactive", "backlog must stay inactive on a pre-active failure");
    assert.equal(h.storage.getTimelineState(TK), "inactive", "state resets to inactive");
    assert.ok(!h.coordinator.isActivating(TK), "the guard is cleared after failure");
  } finally {
    h.storage.close();
  }
});

test("#3/#9: on successful activation the backlog flips to pending and the trigger event reaches pending (duplicate case)", async () => {
  const h = await makeHarness();
  try {
    // The trigger event already exists as an 'inactive' row (provider emitted it
    // once without a trigger). It needs enrichment (contains a URL).
    await h.storage.appendTimelineEvent(
      userEvent({ id: "t1", body: "see http://example.com", timestamp: 30 }),
      "inactive",
    );
    // A separate backlog event.
    await h.storage.appendTimelineEvent(userEvent({ id: "b1", timestamp: 10 }), "inactive");

    const trigger = triggerInbound(userEvent({ id: "t1", body: "see http://example.com", timestamp: 30 }));
    await h.coordinator.gateInbound(trigger);
    await new Promise((r) => setImmediate(r));

    const statuses = h.storage.read((db) =>
      Object.fromEntries(
        (db.prepare("select id, enrichment_status from timeline_events").all() as Array<{ id: string; enrichment_status: string }>).map((r) => [r.id, r.enrichment_status]),
      ),
    );
    // The trigger event was flipped to pending BEFORE readiness (so readiness
    // could resolve) — and remains pending after the bulk flip.
    assert.equal(statuses.t1, "pending", "the duplicate trigger event must reach pending so readiness resolves");
    assert.equal(statuses.b1, "pending", "the backlog flips to pending after readiness");
    assert.equal(h.storage.getTimelineState(TK), "active");
    assert.equal(h.launched.length, 1);
  } finally {
    h.storage.close();
  }
});

test("#4: a backfilled 'inactive' event flips to 'pending' (and nudges enrichment) on a successful activation", async () => {
  // Simulate backfill storing a fetched history event 'inactive' (the post-#4
  // backfill behavior). After a successful activation the bulk-flip must promote
  // it to 'pending' and the enrichment pool must be nudged.
  const h = await makeHarness({
    runInitialBackfill: async () => {
      await h.storage.appendTimelineEvent(userEvent({ id: "bf1", timestamp: 5 }), "inactive");
    },
  });
  try {
    const enrichedBefore = h.enriched.length;
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1", timestamp: 30 })));
    await new Promise((r) => setImmediate(r));

    const status = h.storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("bf1") as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "pending", "the backfilled inactive event flips to pending via the bulk activation");
    assert.equal(h.storage.getTimelineState(TK), "active");
    assert.ok(h.enriched.length > enrichedBefore, "the enrichment pool is nudged after the bulk flip");
  } finally {
    h.storage.close();
  }
});

test("#4: a backfilled 'inactive' event stays 'inactive' (NOT pending) when activation fails after the fetch phase", async () => {
  // The fix's core invariant: on a FAILED activation (readiness throws AFTER
  // backfill), the backfilled event must remain 'inactive' so it is not enriched
  // under a now-inactive timeline. This test FAILS under the old 'pending'
  // backfill storage (the event would be left enrichable).
  const h = await makeHarness({
    runInitialBackfill: async () => {
      await h.storage.appendTimelineEvent(userEvent({ id: "bf1", timestamp: 5 }), "inactive");
    },
    awaitTriggerReadiness: async () => {
      throw new Error("readiness boom");
    },
  });
  try {
    await assert.rejects(
      () => h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1", timestamp: 30 }))),
      /readiness boom/,
    );

    const status = h.storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("bf1") as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "inactive", "the backfilled event must stay inactive on a failed activation (no enrichment under an inactive timeline)");
    assert.equal(h.storage.getTimelineState(TK), "inactive", "state resets to inactive");
  } finally {
    h.storage.close();
  }
});

function imageEvent(overrides: { id: string; timestamp?: number }): CanonicalChatEvent {
  return {
    ...userEvent({ id: overrides.id, timestamp: overrides.timestamp }),
    body: "",
    attachments: [{ id: `att-${overrides.id}`, mediaType: "image" }],
  };
}

test("#2: a grouped attachment message that was 'inactive' is flipped to 'pending' (and enrichment nudged) BEFORE readiness", async () => {
  // Reproduces #2: user posts media in an inactive channel, then mentions the bot
  // within the trigger-group lookback. resolveTriggerGroup pulls the prior
  // attachment message into the group. Under the OLD code that grouped event
  // stayed 'inactive' until the post-readiness bulk flip, so awaitTriggerReadiness
  // saw it as ready (no enrichment, no caption) and the first session rendered the
  // image uncaptioned. The fix flips the group's still-'inactive' members BEFORE
  // readiness.
  let statusAtReadiness: string | undefined;
  let enrichedAtReadiness = 0;
  const h = await makeHarness({
    // Mimic app.ts resolveTriggerGroup pulling the prior media event m1 into the group.
    resolveTriggerGroup: async (inbound) => {
      inbound.trigger = { ...inbound.trigger!, groupedEventIds: [inbound.event.id, "m1"] };
      inbound.event.trigger = inbound.trigger;
    },
    awaitTriggerReadiness: async () => {
      statusAtReadiness = h.storage.read((db) =>
        (db.prepare("select enrichment_status from timeline_events where id = ?").get("m1") as { enrichment_status: string }).enrichment_status,
      );
      enrichedAtReadiness = h.enriched.length;
    },
  });
  try {
    // Prior media message, stored cheaply as 'inactive' while the channel was inactive.
    await h.storage.appendTimelineEvent(imageEvent({ id: "m1", timestamp: 10 }), "inactive");

    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1", body: "look @miku", timestamp: 20 })));
    await new Promise((r) => setImmediate(r));

    assert.equal(statusAtReadiness, "pending", "the grouped media event must be 'pending' BEFORE readiness so it enriches + captions");
    assert.ok(enrichedAtReadiness > 0, "the enrichment pool must be nudged for the grouped media before readiness");
    assert.equal(h.storage.getTimelineState(TK), "active");
    assert.equal(h.launched.length, 1);
  } finally {
    h.storage.close();
  }
});

test("#9: a non-enriching duplicate trigger event leaves 'inactive' (marked skipped) and is not swept by the bulk flip", async () => {
  const h = await makeHarness();
  try {
    // Trigger event already stored inactive, plain text (no enrichment needed).
    await h.storage.appendTimelineEvent(userEvent({ id: "t1", body: "hello", timestamp: 30 }), "inactive");

    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1", body: "hello", timestamp: 30 })));
    await new Promise((r) => setImmediate(r));

    const status = h.storage.read((db) =>
      (db.prepare("select enrichment_status from timeline_events where id = ?").get("t1") as { enrichment_status: string }).enrichment_status,
    );
    assert.equal(status, "skipped", "a non-enriching duplicate trigger is marked skipped, not left inactive or flipped to pending");
    assert.equal(h.storage.getTimelineState(TK), "active");
  } finally {
    h.storage.close();
  }
});

test("#4: a held trigger replayed after a failed activation re-activates the timeline (initiating trigger not permanently stuck)", async () => {
  let readinessCalls = 0;
  const backfillGate = deferred();
  const h = await makeHarness({
    runInitialBackfill: () => backfillGate.promise,
    awaitTriggerReadiness: async () => {
      readinessCalls++;
      // Fail the first activation, succeed the second (the replayed held trigger).
      if (readinessCalls === 1) throw new Error("first activation fails");
    },
  });
  try {
    const activation = h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    await new Promise((r) => setImmediate(r));
    // A concurrent trigger is held during the (about-to-fail) activation.
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));

    backfillGate.resolve();
    await assert.rejects(() => activation, /first activation fails/);
    // The held trigger is replayed; it re-activates the now-inactive timeline.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(h.storage.getTimelineState(TK), "active", "the replayed held trigger re-activated the timeline");
    assert.equal(h.launched.length, 1, "the replayed held trigger launched a session");
    assert.equal(h.launched[0].event.id, "t2");
  } finally {
    h.storage.close();
  }
});

test("#2/#14: a stranded 'activating' state (catch-path reset threw) does not busy-loop on the next trigger and does not drop it", async () => {
  // Make the catch-path 'inactive' reset throw, so after a prelude failure the
  // persisted state stays 'activating' while the in-memory guard/buffer were
  // cleared by finishActivation — the inconsistent state from #2.
  const wrapStorage = (storage: Storage): ActivationStorage => ({
    getTimelineState: (timelineKey) => storage.getTimelineState(timelineKey),
    setTimelineState: (timelineKey, state) => {
      if (state === "inactive") {
        return Promise.reject(new Error("reset write boom"));
      }
      return storage.setTimelineState(timelineKey, state as Parameters<Storage["setTimelineState"]>[1]);
    },
    activateTimelineEvents: (timelineKey) => storage.activateTimelineEvents(timelineKey),
    getTimelineEventById: (eventId) => storage.getTimelineEventById(eventId),
    getEnrichmentStatus: (eventId) => storage.getEnrichmentStatus(eventId),
  });

  const h = await makeHarness({
    // Fail the prelude so the catch path runs (and its 'inactive' reset throws).
    awaitTriggerReadiness: async () => {
      throw new Error("readiness boom");
    },
    wrapStorage,
  });
  try {
    await assert.rejects(
      () => h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" }))),
      /readiness boom/,
    );

    // The reset failed: persisted state is stranded 'activating', guard cleared.
    assert.equal(h.storage.getTimelineState(TK), "activating", "the failed reset left state stranded in 'activating'");
    assert.ok(!h.coordinator.isActivating(TK), "the in-memory guard was cleared by finishActivation");

    // A follow-up trigger arrives. Pre-fix this re-dispatched into gateInbound
    // which re-read 'activating', found no buffer, re-dispatched again... a tight
    // unbounded loop. The fix must NOT re-dispatch in the inconsistent case.
    const before = h.dispatched.length;
    const outcome = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    // Let any (erroneous) async re-dispatch chain run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(outcome, "handled", "the inconsistent-state trigger is consumed by the lifecycle path");
    const dispatchedDuringFollowup = h.dispatched.length - before;
    assert.ok(
      dispatchedDuringFollowup <= 1,
      `the follow-up trigger must not busy-loop re-dispatching (got ${dispatchedDuringFollowup} dispatches)`,
    );

    // The event must not be dropped — it is stored.
    const stored = h.storage.read((db) =>
      db.prepare("select id from timeline_events where id = ?").get("t2"),
    );
    assert.ok(stored, "the follow-up event was stored (not dropped)");
  } finally {
    h.storage.close();
  }
});

test("#7/#14: one-shot recovery clears the stranded 'activating' AND re-dispatches the trigger so it re-activates without waiting for a later trigger", async () => {
  // Make the FIRST 'inactive' write (the catch-path reset) throw, but allow
  // subsequent 'inactive' writes (the gateInbound one-shot recovery) to succeed.
  let inactiveWrites = 0;
  const wrapStorage = (storage: Storage): ActivationStorage => ({
    getTimelineState: (timelineKey) => storage.getTimelineState(timelineKey),
    setTimelineState: (timelineKey, state) => {
      if (state === "inactive") {
        inactiveWrites++;
        if (inactiveWrites === 1) return Promise.reject(new Error("reset write boom"));
      }
      return storage.setTimelineState(timelineKey, state as Parameters<Storage["setTimelineState"]>[1]);
    },
    activateTimelineEvents: (timelineKey) => storage.activateTimelineEvents(timelineKey),
    getTimelineEventById: (eventId) => storage.getTimelineEventById(eventId),
    getEnrichmentStatus: (eventId) => storage.getEnrichmentStatus(eventId),
  });

  let readinessCalls = 0;
  const h = await makeHarness({
    awaitTriggerReadiness: async () => {
      readinessCalls++;
      if (readinessCalls === 1) throw new Error("readiness boom");
    },
    wrapStorage,
  });
  try {
    await assert.rejects(
      () => h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" }))),
      /readiness boom/,
    );
    assert.equal(h.storage.getTimelineState(TK), "activating", "stranded after failed reset");

    // Follow-up trigger hits the inconsistent path: stores the event, the
    // one-shot recovery re-persists 'inactive' (succeeds this time), and because
    // the reset write SUCCEEDED the trigger is re-dispatched (#7). The replay
    // re-enters gateInbound, reads 'inactive', and re-activates cleanly — no loop
    // and no waiting for a separate later trigger.
    const before = h.dispatched.length;
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(h.dispatched.length - before, 1, "the recovered trigger is re-dispatched exactly once after the successful reset");
    assert.equal(h.dispatched[before].event.id, "t2");
    assert.equal(h.storage.getTimelineState(TK), "active", "the re-dispatched trigger re-activated from the recovered 'inactive' state");
    assert.equal(h.launched.length, 1, "the re-dispatched trigger launched a session — the user gets a response");
    assert.equal(h.launched[0].event.id, "t2");
  } finally {
    h.storage.close();
  }
});

test("#7: when the stranded-recovery reset write FAILS, the trigger is NOT re-dispatched (no busy-loop)", async () => {
  // Every 'inactive' write fails — both the catch-path reset (creating the
  // stranded state) and the gateInbound one-shot recovery. The trigger must NOT
  // be re-dispatched, otherwise each pass would re-read 'activating' and
  // re-dispatch forever against a persistently-failing write.
  const wrapStorage = (storage: Storage): ActivationStorage => ({
    getTimelineState: (timelineKey) => storage.getTimelineState(timelineKey),
    setTimelineState: (timelineKey, state) => {
      if (state === "inactive") return Promise.reject(new Error("reset write boom"));
      return storage.setTimelineState(timelineKey, state as Parameters<Storage["setTimelineState"]>[1]);
    },
    activateTimelineEvents: (timelineKey) => storage.activateTimelineEvents(timelineKey),
    getTimelineEventById: (eventId) => storage.getTimelineEventById(eventId),
    getEnrichmentStatus: (eventId) => storage.getEnrichmentStatus(eventId),
  });

  const h = await makeHarness({
    awaitTriggerReadiness: async () => {
      throw new Error("readiness boom");
    },
    wrapStorage,
  });
  try {
    await assert.rejects(
      () => h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" }))),
      /readiness boom/,
    );
    assert.equal(h.storage.getTimelineState(TK), "activating", "stranded after failed reset");

    const before = h.dispatched.length;
    const outcome = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(outcome, "handled", "the inconsistent-state trigger is consumed by the lifecycle path");
    assert.equal(h.dispatched.length - before, 0, "a failing reset must NOT re-dispatch (would busy-loop)");
    assert.equal(h.storage.getTimelineState(TK), "activating", "state stays stranded when the recovery write keeps failing");
    // The event must not be dropped — it is stored regardless.
    const stored = h.storage.read((db) =>
      db.prepare("select id from timeline_events where id = ?").get("t2"),
    );
    assert.ok(stored, "the follow-up event was stored (not dropped) even though it wasn't re-dispatched");
    // #7: the otherwise-silent drop is logged distinctly so an operator can
    // correlate it (trigger stored but neither spawned nor buffered).
    const dropWarn = h.warnings.find((w) => w.event === "activation_trigger_dropped_pending_heal");
    assert.ok(dropWarn, "a WARN must be emitted when the dropped trigger awaits a heal");
    assert.equal(dropWarn?.fields?.timelineKey, TK);
    assert.equal(dropWarn?.fields?.eventId, "t2");
  } finally {
    h.storage.close();
  }
});

test("#2: an in-flight activation that observes draining bails before flipping to active and never launches a session", async () => {
  // Shutdown begins (draining) while the prelude is held inside
  // awaitTriggerReadiness. The prelude must re-check draining after readiness and
  // bail cleanly — no bulk-flip, no 'active' write, no session launch — so it
  // can't spawn a session whose writes race storage.waitForIdle()/close().
  let release!: () => void;
  const readinessGate = new Promise<void>((r) => {
    release = r;
  });
  const h = await makeHarness({
    awaitTriggerReadiness: async () => {
      await readinessGate;
    },
  });
  try {
    const gate = h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    // Let the prelude advance to the readiness await, then begin draining.
    await new Promise((r) => setImmediate(r));
    h.setDraining(true);
    release();
    await gate;

    assert.equal(h.launched.length, 0, "no session is launched once draining is observed");
    assert.equal(h.storage.getTimelineState(TK), "activating", "the timeline is left 'activating' (healed by resetStaleActivations on restart)");
    // The guard/buffer must be cleared so a stale guard doesn't linger.
    assert.equal(h.coordinator.isActivating(TK), false, "the activation guard is cleared on the draining bail");
  } finally {
    h.storage.close();
  }
});

test("#14: the legitimate just-cleared-guard re-dispatch still works (guard present at entry, cleared during the route await)", async () => {
  // The real just-cleared race: a trigger enters while the in-memory guard is
  // still set (so it takes the activating branch), but during the `router.route`
  // await the activation finishes — finishActivation clears the guard AND the
  // held-trigger buffer. The code then reads heldTriggers.get() (now undefined)
  // and, because the guard WAS present at entry (not the inconsistent stranded
  // case), must re-dispatch rather than drop. We reproduce this by clearing the
  // guard/buffer mid-route (one-shot router hook), with persisted state 'active'
  // (a successful activation), and the dispatch hook detached so the re-dispatch
  // doesn't recurse (we only assert the single re-dispatch happened).
  const h = await makeHarness();
  try {
    // Activate normally so persisted state is 'active' and the guard is cleared.
    await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t1" })));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.storage.getTimelineState(TK), "active");

    const activating = (h.coordinator as unknown as { activatingTimelines: Set<string> }).activatingTimelines;
    const held = (h.coordinator as unknown as { heldTriggers: Map<string, InboundChatEvent[]> }).heldTriggers;
    // Re-arm the guard + an empty buffer to mimic an activation prelude still in
    // flight at the moment the follow-up trigger enters gateInbound.
    activating.add(TK);
    held.set(TK, []);

    // During the route await of the follow-up trigger, simulate finishActivation
    // racing to completion: clear the guard and buffer. One-shot.
    const realRoute = h.router.route.bind(h.router);
    let cleared = false;
    (h.router as unknown as { route: typeof realRoute }).route = async (inbound, status) => {
      const result = await realRoute(inbound, status);
      if (!cleared) {
        cleared = true;
        activating.delete(TK);
        held.delete(TK);
      }
      return result;
    };

    const before = h.dispatched.length;
    const outcome = await h.coordinator.gateInbound(triggerInbound(userEvent({ id: "t2", timestamp: 2_000 })));

    assert.equal(outcome, "handled", "the just-cleared-guard trigger is consumed by the lifecycle path");
    assert.equal(h.dispatched.length - before, 1, "the trigger is re-dispatched exactly once (legitimate just-cleared race), not dropped");
    assert.equal(h.dispatched[h.dispatched.length - 1].event.id, "t2");
  } finally {
    h.storage.close();
  }
});
