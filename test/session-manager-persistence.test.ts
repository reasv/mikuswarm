import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Storage } from "../src/storage/index.js";
import { SessionManager } from "../src/agent/session-manager.js";
import type { InboundChatEvent } from "../src/types.js";

async function openStorage(): Promise<{ storage: Storage; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "miku-sessmgr-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  return { storage, dir };
}

function makeTrigger(overrides: Partial<InboundChatEvent["event"]> = {}): InboundChatEvent {
  return {
    provider: "test",
    timelineKey: "tl:room1",
    event: {
      id: "evt-1",
      externalId: "ext-1",
      timelineKey: "tl:room1",
      provider: "test",
      role: "user",
      sender: { id: "u1", displayName: "User" },
      body: "hello there",
      timestamp: 1000,
      receivedAt: 1000,
      ...overrides,
    },
  };
}

test("SessionManager persists the full status lifecycle through the write queue", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    const record = sessions.createPlaceholder(makeTrigger(), "default");

    await storage.waitForIdle();
    let row = storage.getAgentSession(record.id);
    assert.ok(row, "row should be inserted on createPlaceholder");
    assert.equal(row!.status, "created");
    assert.equal(row!.timeline_key, "tl:room1");
    assert.equal(row!.session_type, "default");
    assert.equal(row!.trigger_event_id, "evt-1");
    assert.equal(row!.trigger_external_id, "ext-1");
    assert.equal(row!.trigger_body, "hello there");
    // Trigger-sender identity (v18, issue #18): persisted so a manual resume
    // rebuilds the same sender-bound tool set from the durable row.
    assert.equal(row!.trigger_sender_id, "u1");
    assert.equal(row!.trigger_sender_display_name, "User");
    assert.equal(row!.no_reply, 0);

    sessions.markRunning(record.id);
    await storage.waitForIdle();
    row = storage.getAgentSession(record.id);
    assert.equal(row!.status, "running");
    assert.ok(typeof row!.started_at === "number" && row!.started_at! > 0, "started_at set");

    sessions.markCompleted(record.id, { noReply: true });
    await storage.waitForIdle();
    row = storage.getAgentSession(record.id);
    assert.equal(row!.status, "completed");
    assert.equal(row!.no_reply, 1);
    assert.ok(typeof row!.completed_at === "number" && row!.completed_at! > 0, "completed_at set");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager.markDiscarded persists discarded status with error", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    const record = sessions.createPlaceholder(makeTrigger(), "default");
    await storage.waitForIdle();

    sessions.markDiscarded(record.id, { error: "boom" });
    await storage.waitForIdle();
    const row = storage.getAgentSession(record.id);
    assert.equal(row!.status, "discarded");
    assert.equal(row!.error, "boom");
    assert.ok(typeof row!.completed_at === "number" && row!.completed_at! > 0, "completed_at set");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager persists the trigger's triggeredBy over the event sender when present (#18)", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    // Mirrors buildSessionTools' resolution: a grouped trigger may carry a
    // different effective sender (`triggeredBy`) than the raw event.
    const trigger = makeTrigger();
    trigger.trigger = {
      type: "mention",
      reason: "mentioned",
      triggeredBy: { id: "u2", displayName: "Trigger User" },
    };
    const record = sessions.createPlaceholder(trigger, "default");
    await storage.waitForIdle();
    const row = storage.getAgentSession(record.id);
    assert.equal(row!.trigger_sender_id, "u2");
    assert.equal(row!.trigger_sender_display_name, "Trigger User");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager truncates an overlong trigger body before persisting", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    const longBody = "x".repeat(1000);
    const record = sessions.createPlaceholder(makeTrigger({ body: longBody }), "default");
    await storage.waitForIdle();
    const row = storage.getAgentSession(record.id);
    assert.equal(row!.trigger_body!.length, 500);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Live agent stub: `signal` is defined (active run) and `abort()` records the call. */
function fakeAbortableAgent(opts: { live: boolean } = { live: true }): {
  agent: any;
  aborted: () => boolean;
} {
  const controller = new AbortController();
  let didAbort = false;
  const agent = {
    get signal() {
      return opts.live ? controller.signal : undefined;
    },
    abort() {
      didAbort = true;
      controller.abort();
    },
    hasQueuedMessages: () => false,
    clearAllQueues() {},
  };
  return { agent, aborted: () => didAbort };
}

/**
 * Drive the session into the run-in-progress state the way the runner does:
 * markRunning + attachAgent + mark the lifecycle in-progress. Without this,
 * `interrupt()` (which now gates on the explicit run-in-progress flag) returns
 * false.
 */
function startRun(sessions: SessionManager, sessionId: string, agent: any): void {
  sessions.markRunning(sessionId);
  sessions.attachAgent(sessionId, agent);
  sessions.runLifecycle(sessionId).markRunInProgress();
}

test("SessionManager.interrupt aborts a live run and persists interrupted status", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    const record = sessions.createPlaceholder(makeTrigger(), "default");
    const { agent, aborted } = fakeAbortableAgent();
    startRun(sessions, record.id, agent);

    const ok = sessions.interrupt(record.id);
    assert.equal(ok, true, "interrupt returns true for a live run");
    assert.ok(aborted(), "agent.abort() was called");
    assert.equal(sessions.get(record.id)?.status, "interrupted");

    await storage.waitForIdle();
    const row = storage.getAgentSession(record.id);
    assert.equal(row!.status, "interrupted");
    assert.ok(typeof row!.completed_at === "number" && row!.completed_at! > 0, "completed_at set");

    // The settling run's natural terminal handler must NOT clobber `interrupted`.
    sessions.markCompleted(record.id, { noReply: true });
    await storage.waitForIdle();
    assert.equal(storage.getAgentSession(record.id)!.status, "interrupted");
    // ...but it still evicts the now-finished session from the live map.
    assert.equal(sessions.get(record.id), undefined);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager.interrupt: markDiscarded after interrupt keeps interrupted status and evicts", async () => {
  const { storage, dir } = await openStorage();
  try {
    const sessions = new SessionManager({ storage });
    const record = sessions.createPlaceholder(makeTrigger(), "default");
    const { agent } = fakeAbortableAgent();
    startRun(sessions, record.id, agent);

    assert.equal(sessions.interrupt(record.id), true);
    assert.equal(sessions.get(record.id)?.status, "interrupted");

    // The settling run may reach the ERROR/discard handler instead of completion
    // (e.g. an aborted tool surfaces as a rejection). markDiscarded must defer to
    // the authoritative `interrupted` status — no clobber — but still evict.
    sessions.markDiscarded(record.id, { error: "aborted mid-tool" });
    await storage.waitForIdle();
    const row = storage.getAgentSession(record.id);
    assert.equal(row!.status, "interrupted", "discard must not clobber interrupted");
    // The discard error must not be written over the interrupted record.
    assert.equal(row!.error, null);
    assert.equal(sessions.get(record.id), undefined, "session evicted from live map");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager.interrupt: clears pending steering/follow-up queues", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");
  let cleared = false;
  const controller = new AbortController();
  const agent: any = {
    get signal() {
      return controller.signal;
    },
    abort() {
      controller.abort();
    },
    hasQueuedMessages: () => true,
    clearAllQueues: () => {
      cleared = true;
    },
  };
  startRun(sessions, record.id, agent);

  assert.equal(sessions.interrupt(record.id), true);
  assert.ok(cleared, "interrupt must clear pending queues (clearAllQueues)");
});

test("SessionManager.interrupt: honored in the inter-turn gap (signal undefined but run in progress)", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");
  let aborted = false;
  // Inter-turn gap: no active prompt, so `agent.signal` is undefined, but the
  // run is logically still in progress. interrupt() must gate on run-in-progress
  // (not signal) and still succeed.
  const agent: any = {
    signal: undefined,
    abort() {
      aborted = true;
    },
    hasQueuedMessages: () => false,
    clearAllQueues() {},
  };
  startRun(sessions, record.id, agent);

  assert.equal(sessions.interrupt(record.id), true, "interrupt honored in inter-turn gap");
  assert.equal(sessions.get(record.id)?.status, "interrupted");
  // No signal present, so abort() is (correctly) not called — the loop break is
  // what terminates the run in this window.
  assert.equal(aborted, false, "abort() skipped when no active signal");
  assert.equal(sessions.runLifecycle(record.id).isInterrupted(), true);
});

test("SessionManager.interrupt returns false when no run is in progress", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");

  // No agent attached / not running / no run-in-progress.
  assert.equal(sessions.interrupt(record.id), false);

  // Running with an attached agent, but no run-in-progress flag set (the runner
  // never entered run(), or the run already settled and cleared the flag).
  sessions.markRunning(record.id);
  const { agent } = fakeAbortableAgent({ live: true });
  sessions.attachAgent(record.id, agent);
  assert.equal(sessions.interrupt(record.id), false, "no run-in-progress → not interruptible");

  // Unknown id.
  assert.equal(sessions.interrupt("s-nope"), false);
});

test("SessionManager.onSettle fires once when the run settles (evict)", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");
  sessions.markRunning(record.id);
  sessions.attachAgent(record.id, fakeAbortableAgent().agent);

  let fired = 0;
  sessions.onSettle(record.id, () => {
    fired += 1;
  });
  assert.equal(fired, 0, "must not fire before settlement");

  sessions.markCompleted(record.id);
  assert.equal(fired, 1, "fires exactly once on settle");
});

test("SessionManager.onSettle fires for every terminal path and supports unsubscribe", () => {
  for (const settle of [
    (s: SessionManager, id: string) => s.markDiscarded(id),
    (s: SessionManager, id: string) => s.markFailedResumable(id),
    (s: SessionManager, id: string) => {
      s.interrupt(id); // sets interrupted; the run promise settles via markCompleted
      s.markCompleted(id);
    },
  ]) {
    const sessions = new SessionManager();
    const record = sessions.createPlaceholder(makeTrigger(), "default");
    sessions.markRunning(record.id);
    sessions.attachAgent(record.id, fakeAbortableAgent().agent);
    let fired = 0;
    sessions.onSettle(record.id, () => {
      fired += 1;
    });
    settle(sessions, record.id);
    assert.equal(fired, 1, "every terminal path fires settle once");
  }

  // Unsubscribe before settlement → never fires.
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");
  sessions.markRunning(record.id);
  sessions.attachAgent(record.id, fakeAbortableAgent().agent);
  let fired = 0;
  const unsubscribe = sessions.onSettle(record.id, () => {
    fired += 1;
  });
  unsubscribe();
  sessions.markCompleted(record.id);
  assert.equal(fired, 0, "unsubscribed listener does not fire");
});

test("SessionManager without storage is a no-op and never throws", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");
  assert.equal(record.status, "created");
  // None of these should throw when storage is absent.
  sessions.markRunning(record.id);
  assert.equal(sessions.get(record.id)?.status, "running");
  sessions.markCompleted(record.id, { noReply: true });
  // Completed sessions are evicted from the in-memory map.
  assert.equal(sessions.get(record.id), undefined);
});
