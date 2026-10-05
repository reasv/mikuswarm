/**
 * Tests for I3: legacy initial_preloads.tools compat.
 *
 * Old rows written before W5 stored preloaded tool names directly in
 * initial_preloads.tools. getSessionInitialPreloads must expose them as
 * legacyTools so the factory's resume branch can load them into the registry
 * before seedFromTranscript.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";

async function withStorage(fn: (s: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

// ── getSessionInitialPreloads: exposes legacyTools from old rows ──────────────

test("getSessionInitialPreloads: legacy tools array is exposed as legacyTools", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-legacy-tools";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    // Inject a legacy initial_preloads blob that includes a `tools` array
    // (the pre-W5 shape, written when tool loading used explicit preloads).
    const legacyBlob = JSON.stringify({
      skills: ["shell"],
      model: "sol6",
      tools: ["read_file", "send_message"],
    });
    await storage.write((db) => {
      db.prepare(`update agent_sessions set initial_preloads = @json where id = @id`)
        .run({ id: sessionId, json: legacyBlob });
    });

    const preloads = storage.getSessionInitialPreloads(sessionId);
    assert.ok(preloads, "preloads should be present");
    assert.deepEqual(preloads.skills, ["shell"]);
    assert.equal(preloads.model, "sol6");
    // The legacy tools array must be exposed for the resume branch to use.
    assert.deepEqual(preloads.legacyTools, ["read_file", "send_message"]);
  });
});

test("getSessionInitialPreloads: no legacyTools when tools array absent (modern row)", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-modern-preloads";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    // Modern row: no `tools` field — just skills + model.
    await storage.setSessionInitialPreloads(sessionId, {
      skills: ["search"],
      model: "luna6",
    });

    const preloads = storage.getSessionInitialPreloads(sessionId);
    assert.ok(preloads, "preloads should be present");
    assert.deepEqual(preloads.skills, ["search"]);
    assert.equal(preloads.legacyTools, undefined, "legacyTools must be absent on modern rows");
  });
});

test("getSessionInitialPreloads: empty tools array produces no legacyTools", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-empty-tools";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    // Old row with an empty tools array — no tools to load.
    const emptyToolsBlob = JSON.stringify({ skills: [], tools: [] });
    await storage.write((db) => {
      db.prepare(`update agent_sessions set initial_preloads = @json where id = @id`)
        .run({ id: sessionId, json: emptyToolsBlob });
    });

    const preloads = storage.getSessionInitialPreloads(sessionId);
    assert.ok(preloads, "preloads should be present");
    // Empty tools array → legacyTools not set (nothing to load).
    assert.equal(preloads.legacyTools, undefined);
  });
});
