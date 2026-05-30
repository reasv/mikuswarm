import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  ActivationCoordinator,
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
  enriched: string[];
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
  awaitTriggerReadiness?: (inbound: InboundChatEvent) => Promise<void>;
  launchSession?: (inbound: InboundChatEvent, duplicate: boolean, h: Harness) => void;
}): Promise<Harness> {
  return Storage.open({ databasePath: ":memory:" }).then((storage) => {
    const timeline = new TimelineStore(storage);
    const router = new TimelineRouter(timeline);
    const triggerCoordinator = new TriggerCoordinator(SESSIONS_CONFIG);

    const launched: InboundChatEvent[] = [];
    const dispatched: InboundChatEvent[] = [];
    const enriched: string[] = [];

    const harness = {} as Harness;

    const coordinator = new ActivationCoordinator({
      storage,
      router,
      triggerCoordinator,
      setEnrichmentStatus: (eventId, status) => timeline.setEnrichmentStatus(eventId, status),
      notifyEnrichment: (eventId) => {
        enriched.push(eventId);
      },
      notifyCaptions: () => {},
      runInitialBackfill: overrides?.runInitialBackfill ?? (async () => {}),
      resolveTriggerGroup: async () => {},
      awaitTriggerReadiness: overrides?.awaitTriggerReadiness ?? (async () => {}),
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
      logger: silentLogger,
    });

    Object.assign(harness, {
      storage,
      timeline,
      router,
      triggerCoordinator,
      coordinator,
      launched,
      dispatched,
      enriched,
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
  const sessionGate = deferred();
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
    void sessionGate; // session intentionally left running
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
