/**
 * The `memory` decision point (ARCHITECTURE.md §8h "Memory"): questions,
 * state packing, resolve with calibration, the filter questions, the
 * standalone filter point, and its config (on by default with [decisions]).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { memoryPoint, memoryFilterPoint, type MemoryPassageInput } from "../src/decisions/points/memory.js";
import { calibratedThreshold, decisionsFor, memoryPointKnobs, pointSettings, validateDecisionsConfig } from "../src/decisions/config.js";
import { jsonTokens } from "../src/decisions/client.js";

const settings: any = { point: "memory", threshold: 0.7, calibration: {}, minConfidence: 0.6 };
const noul = (p: number) => ({ type: "noul" as const, noul: p });

function input(over: Partial<MemoryPassageInput> = {}): MemoryPassageInput {
  return {
    conversation: [
      { from: "bob", text: "older" },
      { from: "carol", text: "newer" },
    ],
    request: { from: "alice", text: "what about the launch?", reply_to: { from: "bob", text: "we said October" } },
    participants: ["alice", "bob"],
    passage: { date: "2026-05-14", room: "general", text: "We decided the launch is in October." },
    filters: [],
    meta: { citation: "memory/2026-05-14.md:1-3 · general", contentHash: "h", scores: { hybrid: 0.5, late: null, rerank: null } },
    ...over,
  };
}

test("questions: relevant + about_participant (only with participants) + one per judged filter", () => {
  const q = memoryPoint.questions(input(), settings);
  assert.deepEqual(Object.keys(q), ["relevant", "about_participant"]);
  assert.match(String((q["relevant"] as any).instructions), /help respond to `request` in this `conversation`/);
  assert.deepEqual(Object.keys(memoryPoint.questions(input({ participants: [] }), settings)), ["relevant"]);
  const withFilter = memoryPoint.questions(
    input({ filters: [{ key: "habit", description: "The entry shows X.", examplesHide: ["x"], examplesKeep: [], threshold: 0.8 }] }),
    settings,
  );
  assert.equal((withFilter["filter__habit"] as any).instructions, "`passage` matches: The entry shows X.");
  assert.ok((withFilter["filter__habit"] as any).criteria.true.includes('"x"'));
});

test("state: the passage first, then the newest conversation that fits; one passage only", () => {
  const s = memoryPoint.state(input(), 8000) as any;
  assert.deepEqual(Object.keys(s), ["conversation", "request", "participants", "passage"]);
  assert.equal(s.passage.room, "general");
  assert.equal(s.conversation.length, 2);
  const tight = memoryPoint.state(input(), jsonTokens(memoryPoint.state(input({ conversation: [] }), 8000)) + 5) as any;
  assert.ok(tight.conversation.length < 2, "conversation is packed newest-first under the budget");
  assert.equal(tight.passage.text, "We decided the launch is in October.");
  const proactive = memoryPoint.state(input({ request: undefined }), 8000) as any;
  assert.ok(!("request" in proactive));
});

test("resolve: keep at relevance_threshold, per-member calibration, filters hide at their threshold", () => {
  const cal = (name: string, v: number) => calibratedThreshold({ ...settings, calibration: { decider: { "memory.relevance_threshold": 0.9 } } }, "decider", name, v);
  const plain = (_: string, v: number) => v;
  assert.equal(memoryPoint.resolve({ relevant: noul(0.8), about_participant: noul(0.2) }, input(), plain, settings)!.keep, true);
  assert.equal(memoryPoint.resolve({ relevant: noul(0.8), about_participant: noul(0.2) }, input(), cal, settings)!.keep, false);
  const filters = [{ key: "habit", description: "d", examplesHide: [], examplesKeep: [], threshold: 0.8 }];
  const v = memoryPoint.resolve({ relevant: noul(0.9), about_participant: noul(0.1), filter__habit: noul(0.85) }, input({ filters }), plain, settings)!;
  assert.deepEqual(v.filters, { habit: { probability: 0.85, hidden: true } });
  assert.deepEqual((memoryPoint.describe(v) as any).hiddenBy, ["habit"]);
  assert.equal(memoryPoint.resolve({}, input(), plain, settings), null);
  assert.equal(memoryPoint.fallback(input()).keep, false);
});

test("filter point: entry-shaped state and filter-only questions", () => {
  const filters = [{ key: "k", description: "d", examplesHide: [], examplesKeep: [], threshold: 0.5 }];
  const i = { entry: { date: "2026-01-01", room: null, text: "t" }, filters, meta: { citation: "c", contentHash: "h", surface: "recency_layer" } };
  assert.deepEqual(Object.keys(memoryFilterPoint.questions(i, settings)), ["filter__k"]);
  assert.deepEqual(memoryFilterPoint.state(i, 1000), { entry: { date: "2026-01-01", text: "t" } });
  assert.deepEqual(memoryFilterPoint.resolve({ filter__k: noul(0.6) }, i, (_: string, v: number) => v, settings)!.filters, { k: { probability: 0.6, hidden: true } });
});

test("config: memory is on by default with [decisions]; enabled = false turns it off; min_confidence rejected", () => {
  const models = { decider: { id: "d", provider: "p", api: "system-one", endpoint: "x", api_key: "k", input_modalities: ["text"], max_tokens: 1 } };
  const on = pointSettings({ enabled: true, model: "decider" } as any, "memory");
  assert.equal(on?.threshold, 0.7);
  assert.equal(pointSettings({ enabled: true, model: "decider", memory: { enabled: false } } as any, "memory"), undefined);
  assert.equal(pointSettings({ enabled: false, model: "decider" } as any, "memory"), undefined);
  assert.equal(pointSettings({ enabled: true, model: "decider", memory: { relevance_threshold: 0.5 } } as any, "memory")?.threshold, 0.5);
  assert.deepEqual(memoryPointKnobs({ memory: { conversation_messages: 3 } } as any), { relevanceThreshold: 0.7, conversationMessages: 3 });
  assert.throws(
    () => validateDecisionsConfig({ models, decisions: { enabled: true, model: "decider", memory: { min_confidence: 0.5 } } } as any),
    /memory\.min_confidence is not used/,
  );
  // Per-agent override (feature parity: every agent gets it by default).
  const cfg: any = { models, decisions: { enabled: true, model: "decider" }, agents: { chen: { workspace_root: "/w", decisions: { memory: { relevance_threshold: 0.6 } } } } };
  assert.equal(pointSettings(decisionsFor(cfg, "chen"), "memory")?.threshold, 0.6);
  assert.equal(pointSettings(decisionsFor(cfg, "other"), "memory")?.threshold, 0.7);
});
