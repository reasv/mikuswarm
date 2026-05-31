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
