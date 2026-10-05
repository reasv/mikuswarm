/**
 * Observed prompt changes (spec REFUSAL-HANDLING §12.4 source 2): per agent, site
 * and served member; hashes only; a session still sending the previous prompt
 * after an edit is not a change.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { listBehaviourChanges } from "../src/behaviour/changes.js";
import { PROMPT_FLAP_WINDOW_MS, PromptChangeTracker } from "../src/behaviour/prompt-changes.js";
import type { UsageEventInput } from "../src/storage/database.js";
import { Storage } from "../src/storage/index.js";
import { KEY_A, KEY_B, agentFor } from "./behaviour-fixtures.js";

const row = (ts: number, over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  ts,
  class: "agent_loop",
  agentSessionId: "s",
  sessionType: "default",
  timelineKey: KEY_A,
  modelId: "wire-a",
  logicalModelId: "model_a",
  systemPromptHash: "sys1",
  modelPromptHash: "mp1",
  costUsd: 0,
  ...over,
});

async function withTracker(fn: (t: PromptChangeTracker, storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(new PromptChangeTracker({ storage, agentForTimelineKey: agentFor, now: () => 0 }), storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

test("first observation is not a change; a new hash is, with hashes only", async () => {
  await withTracker(async (t, storage) => {
    assert.deepEqual(t.observe(row(1)), []);
    assert.deepEqual(t.observe(row(2)), []);
    const events = t.observe(row(3, { systemPromptHash: "sys2" }));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "prompt_changed");
    assert.deepEqual(events[0]!.detail, { prompt: "system", oldHash: "sys1", newHash: "sys2" });
    assert.deepEqual(events[0]!.agents, ["agent_a"]);
    assert.deepEqual(events[0]!.sites, ["default"]);
    assert.deepEqual(events[0]!.models, ["model_a"]);
    assert.equal(events[0]!.sentence, "agent agent_a, default on model_a: system prompt changed (sys1 → sys2)");
    const model = t.observe(row(4, { systemPromptHash: "sys2", modelPromptHash: null }));
    assert.deepEqual(model.map((e) => e.detail), [{ prompt: "model", oldHash: "mp1", newHash: null }]);
    await storage.waitForIdle();
    assert.equal(listBehaviourChanges(storage, 0, 100).length, 2);
  });
});

test("keys are per agent, site and served member", async () => {
  await withTracker(async (t) => {
    t.observe(row(1));
    // Another site renders its own system prompt: not a change.
    assert.deepEqual(t.observe(row(2, { sessionType: "proactive", systemPromptHash: "sysP" })), []);
    // Another agent, another member: their own first observations.
    assert.deepEqual(t.observe(row(3, { timelineKey: KEY_B, systemPromptHash: "sysB" })), []);
    assert.deepEqual(t.observe(row(4, { logicalModelId: "model_b", modelPromptHash: "mpB" })), []);
    assert.deepEqual(t.observe(row(5)), []);
  });
});

test("sessions still on the previous prompt within the window are not changes; a revert later is", async () => {
  await withTracker(async (t) => {
    t.observe(row(1_000));
    assert.equal(t.observe(row(2_000, { systemPromptHash: "sys2" })).length, 1);
    // An older session keeps sending sys1 for a while.
    assert.deepEqual(t.observe(row(3_000)), []);
    assert.deepEqual(t.observe(row(4_000, { systemPromptHash: "sys2" })), []);
    // Reverted much later: a change again.
    const later = 4_000 + PROMPT_FLAP_WINDOW_MS + 1;
    assert.deepEqual(t.observe(row(later)).map((e) => e.detail), [{ prompt: "system", oldHash: "sys2", newHash: "sys1" }]);
  });
});

test("rows without a system prompt hash and non-agent rows are ignored", async () => {
  await withTracker(async (t) => {
    t.observe(row(1));
    assert.deepEqual(t.observe(row(2, { systemPromptHash: null, modelPromptHash: "other" })), []);
    assert.deepEqual(t.observe(row(3, { class: "tool", systemPromptHash: "x" })), []);
    assert.deepEqual(t.observe(row(4)), []);
  });
});

test("seed: the latest ledger row per key is the baseline after a restart", async () => {
  await withTracker(async (_t, storage) => {
    await storage.insertUsageEvent(row(Date.now() - 10_000, { systemPromptHash: "old" }));
    await storage.insertUsageEvent(row(Date.now() - 5_000, { systemPromptHash: "sys1" }));
    // A pre-feature row (no system hash) seeds the model prompt only.
    await storage.insertUsageEvent(row(Date.now() - 5_000, { logicalModelId: "model_c", systemPromptHash: null, modelPromptHash: "mpc" }));
    const t = new PromptChangeTracker({ storage, agentForTimelineKey: agentFor });
    t.seed();
    const now = Date.now();
    assert.deepEqual(t.observe(row(now)), [], "same as the seeded hash");
    assert.equal(t.observe(row(now + 1, { systemPromptHash: "sys9" })).length, 1);
    // model_c: system hash unknown → first observation, no event; model prompt known.
    assert.deepEqual(t.observe(row(now + 2, { logicalModelId: "model_c", modelPromptHash: "mpc" })), []);
    assert.deepEqual(
      t.observe(row(now + 3, { logicalModelId: "model_c", modelPromptHash: "mpc2" })).map((e) => e.detail),
      [{ prompt: "model", oldHash: "mpc", newHash: "mpc2" }],
    );
  });
});
