/**
 * Calibration of the duplicate-send check (ARCHITECTURE.md §9i "Calibration
 * tool"): its items are rebuilt from history (same-agent sessions in one
 * timeline that sent close together, the drafting session built before the
 * other's send), judged over the live gate's `{ earlier, draft }` state, and the
 * report still carries no message text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openReadOnly, runCalibration, type LabelRequest } from "../src/audit/calibration.js";
import { sampleDuplicateItems } from "../src/audit/duplicate-calibration.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { withSeenStamp } from "../src/checks/duplicate.js";
import { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const SECRET = "ZQX-PRIVATE-MARKER";
const ROOM = "matrix:acct:room:!r:example.org";
const T0 = 1_000_000;

function botEvent(id: string, body: string, receivedAt: number, sessionId: string): CanonicalChatEvent {
  return {
    id,
    timelineKey: ROOM,
    provider: "matrix",
    role: "assistant",
    sender: { id: "@bot:example.org", displayName: "Bot", isSelf: true },
    body,
    timestamp: receivedAt,
    receivedAt,
    agentSessionId: sessionId,
  };
}

const sendCall = (id: string, message: string, ts: number, resultText = "sent: $e") => [
  { role: "assistant", content: [{ type: "toolCall", id, name: "send_message", arguments: { message, final: true } }], stopReason: "toolUse", timestamp: ts },
  { role: "toolResult", toolCallId: id, toolName: "send_message", content: [{ type: "text", text: resultText }], isError: resultText !== "sent: $e", timestamp: ts + 1 },
];

async function withHistory(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "duplicate-calibration-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const storage = await Storage.open({ databasePath: dbPath });
    const session = async (id: string, startedAt: number, trigger: string, transcript: unknown[], over: Record<string, unknown> = {}) => {
      await storage.insertAgentSession({
        id, timelineKey: ROOM, sessionType: "default", status: "completed", createdAt: startedAt, updatedAt: startedAt,
        startedAt, triggerBody: `${SECRET} ${trigger}`, triggerSenderDisplayName: "alice", triggerEventId: `t-${id}`, ...over,
      } as never);
      await storage.saveAgentSessionTranscript(id, JSON.stringify(transcript));
    };
    // A sends at T0+5s. B was built at T0+1s (stamp) and drafts at T0+20s: a pair.
    await session("sA", T0, "what is 6*7", [{ type: "triggerGroup", content: "k", timestamp: T0 }, ...sendCall("a1", `${SECRET} It's 42.`, T0 + 5_000)]);
    await storage.appendTimelineEvent(botEvent("eA", `${SECRET} It's 42.`, T0 + 5_000, "sA"), "complete");
    await session("sB", T0 + 500, "six times seven?", [
      withSeenStamp({ type: "triggerGroup", content: "k", timestamp: T0 + 500 }, { timelineKey: ROOM, upTo: T0 + 1_000 }),
      ...sendCall("b1", `${SECRET} The answer is 42.`, T0 + 20_000),
    ]);
    await storage.appendTimelineEvent(botEvent("eB", `${SECRET} The answer is 42.`, T0 + 20_000, "sB"), "complete");
    // C was built after A's send (it saw it): not an item.
    await session("sC", T0 + 6_000, "and 6*8?", [
      withSeenStamp({ type: "triggerGroup", content: "k", timestamp: T0 + 6_000 }, { timelineKey: ROOM, upTo: T0 + 7_000 }),
      ...sendCall("c1", `${SECRET} 48.`, T0 + 9_000),
    ]);
    await storage.appendTimelineEvent(botEvent("eC", `${SECRET} 48.`, T0 + 9_000, "sC"), "complete");
    // D (legacy transcript, no stamp; started before A's send) drafts 2 minutes later: outside the window.
    await session("sD", T0 + 2_000, "later", [{ type: "triggerGroup", content: "k", timestamp: T0 + 2_000 }, ...sendCall("d1", `${SECRET} hi`, T0 + 130_000)]);
    // E (legacy, started at T0+3s) drafts at T0+12s: A (T0+5s) and C (T0+9s) are unseen; a blocked
    // draft (a live duplicate rejection) is an item too.
    await session("sE", T0 + 3_000, "seven sixes?", [
      { type: "triggerGroup", content: "k", timestamp: T0 + 3_000 },
      ...sendCall("e1", `${SECRET} 42 again`, T0 + 12_000, `Not sent. Another session of yours … that you have not seen: «…»`),
    ]);
    await storage.waitForIdle();
    storage.close();
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("duplicate items: pairs that sent close together, the drafting session built before the other's send", async () => {
  await withHistory(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const sampled = sampleDuplicateItems(db, { sample: 10, seed: 1 });
      assert.equal(sampled.sessions, 5);
      assert.deepEqual(sampled.items.map((i) => i.id).sort(), ["sB:b1", "sE:e1"]);
      const b = sampled.items.find((i) => i.id === "sB:b1")!;
      assert.equal(b.sources.message, `${SECRET} The answer is 42.`);
      const ctx = b.context.duplicate!;
      assert.deepEqual(ctx.earlier.map((m) => [m.eventIds, m.answering]), [
        [["eA"], { from: "alice", text: `${SECRET} what is 6*7` }],
        [["eC"], { from: "alice", text: `${SECRET} and 6*8?` }],
      ]);
      assert.equal(ctx.draftAt, T0 + 20_000);
      assert.deepEqual(ctx.draftAnswering, { from: "alice", text: `${SECRET} six times seven?` });
      const e = sampled.items.find((i) => i.id === "sE:e1")!;
      assert.deepEqual(e.context.duplicate!.earlier.map((m) => m.eventIds[0]), ["eA", "eC"], "after its start (legacy), before its draft");
      // A 10 s window keeps only the pairs whose newest unseen message is that close.
      assert.deepEqual(sampleDuplicateItems(db, { sample: 10, seed: 1, windowMs: 10_000 }).items.map((i) => i.id), ["sE:e1"]);
    } finally {
      db.close();
    }
  });
});

test("duplicate calibration: one named question over { earlier, draft }; the report has no text", async () => {
  await withHistory(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const catalogue = buildCheckCatalogue({ models: {}, checks: {}, agents: {} } as never);
      const check = catalogue.get("duplicate")!;
      const question = check.questions.find((q) => q.name === "repeats")!;
      const prompts: LabelRequest[] = [];
      const report = await runCalibration({
        db,
        catalogue,
        check,
        question,
        checkpoint: "send",
        sampled: sampleDuplicateItems(db, { sample: 10, seed: 1 }),
        sample: 10,
        seed: 1,
        labeller: async (request) => {
          prompts.push(request);
          return { role: "assistant", content: [{ type: "text", text: request.prompt }, { type: "toolCall", id: "t", name: "submit_label", arguments: { label: "true", reason: "matches_definition" } }] };
        },
        scorer: async (_item, state) => {
          const s = state(4000) as { earlier: unknown[]; draft: { text: string } };
          assert.deepEqual(Object.keys(s), ["earlier", "draft"]);
          return s.draft.text.includes("The answer") ? 0.9 : 0.2;
        },
        labellerInfo: { model: "labeller_a", host: "labeller.example" },
        memberInfo: { model: "decider", host: "gw.example" },
      });
      assert.equal(report.question, "duplicate__repeats");
      assert.equal(report.counts.items, 2);
      assert.match(prompts[0]!.prompt, /Most of the information in `draft\.text` already appears in one of `earlier\[\*\]\.text`\./);
      assert.match(prompts[0]!.prompt, /"earlier":\[/);
      assert.ok(!JSON.stringify(report).includes(SECRET), "the report carries no message text");
    } finally {
      db.close();
    }
  });
});
