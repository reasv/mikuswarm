import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { evaluateResumeGate } from "../src/app.ts";
import type { ResumeMaterial } from "../src/agent/index.ts";
import type { AgentSessionRow } from "../src/storage/index.ts";
import {
  candidateKey,
  continuationMessageFrom,
  continuationPoint,
  type ContinuationInput,
} from "../src/decisions/index.js";

// ---------------------------------------------------------------------------
// Decision-model continuation (ARCHITECTURE.md §8h "Continuation"): the point's
// questions and verdicts, and the decided resume gate (work gate mandatory, any
// participant may resume, no time window).
// ---------------------------------------------------------------------------

const settings: any = { point: "continuation", minConfidence: 0.7, calibration: {} };
const same = (_n: string, v: number) => v;

function input(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    message: { id: "$m", from: "Bob", text: "and what about the second one?", mentions_bot: false },
    context: [],
    candidates: [
      { sessionId: "s-run", status: "running", askedBy: "Alice", asked: "compare these two GPUs", age: "40s ago" },
      {
        sessionId: "s-done",
        status: "completed",
        askedBy: "Alice",
        asked: "find the paper",
        lastReply: "here it is",
        age: "6m ago",
      },
    ],
    triggered: true,
    ...over,
  };
}

const choice = (c: string, confidence: number) => ({ type: "choice" as const, choice: c, probabilities: {}, confidence });
const noul = (p: number) => ({ type: "noul" as const, noul: p });

test("continuation questions: candidate options + new; not_for_bot only for untriggered messages", () => {
  const triggered = continuationPoint.questions(input(), settings);
  assert.deepEqual(Object.keys((triggered.target as any).criteria), ["c1", "c2", "new"]);
  assert.match((triggered.target as any).criteria.c2, /Alice asked: "find the paper"\. The assistant's last reply: "here it is"\. \(finished 6m ago\)/);
  assert.equal(triggered.is_followup?.type, "noul");
  const untriggered = continuationPoint.questions(input({ triggered: false }), settings);
  assert.deepEqual(Object.keys((untriggered.target as any).criteria), ["c1", "c2", "new", "not_for_bot"]);
});

test("continuation resolve: a confident candidate that also reads as a follow-up continues it", () => {
  const v = continuationPoint.resolve({ target: choice(candidateKey(1), 0.9), is_followup: noul(0.8) }, input(), same, settings);
  assert.deepEqual(v, { kind: "continue", sessionId: "s-done", status: "completed" });
  const run = continuationPoint.resolve({ target: choice("c1", 0.9), is_followup: noul(0.8) }, input(), same, settings);
  assert.deepEqual(run, { kind: "continue", sessionId: "s-run", status: "running" });
});

test("continuation resolve: the answers must agree; low confidence → fallback (today's chain)", () => {
  assert.equal(continuationPoint.resolve({ target: choice("c2", 0.9), is_followup: noul(0.2) }, input(), same, settings), null);
  assert.equal(continuationPoint.resolve({ target: choice("c2", 0.5), is_followup: noul(0.9) }, input(), same, settings), null);
  assert.deepEqual(continuationPoint.fallback(input()), { kind: "default" });
});

test("continuation resolve: new → fresh; not_for_bot → inert only when untriggered", () => {
  assert.deepEqual(continuationPoint.resolve({ target: choice("new", 0.9), is_followup: noul(0.1) }, input(), same, settings), { kind: "new" });
  assert.deepEqual(
    continuationPoint.resolve({ target: choice("not_for_bot", 0.9), is_followup: noul(0.1) }, input({ triggered: false }), same, settings),
    { kind: "not_for_bot" },
  );
  assert.equal(
    continuationPoint.resolve({ target: choice("not_for_bot", 0.9), is_followup: noul(0.1) }, input(), same, settings),
    null,
  );
});

test("continuation state: candidates by short id, context packed newest-first", () => {
  const context = Array.from({ length: 40 }, (_, i) => ({ id: `$${i}`, from: `u${i}`, text: `line ${i} `.repeat(30) }));
  const state = continuationPoint.state(input({ context }), 900) as any;
  assert.deepEqual(state.candidates.map((c: any) => c.id), ["c1", "c2"]);
  assert.equal(state.candidates[1].last_reply, "here it is");
  assert.ok(state.context.length < 40 && state.context.at(-1).from === "u39");
});

test("continuationMessageFrom: reply target, mention flag, context slice", () => {
  const ev = (id: string, body: string, over: any = {}) =>
    ({ id, timelineKey: "k", provider: "matrix", role: "user", sender: { id: `@${id}:x`, displayName: id }, body, timestamp: 1, receivedAt: 1, ...over }) as any;
  const message = ev("m", "this one?", { replyTo: { sender: { id: "@a:x", displayName: "Alice" }, body: "two options" } });
  const out = continuationMessageFrom({ message, context: [ev("a", "1"), ev("b", "2"), message], contextMessages: 1, mentionsBot: true });
  assert.equal(out.message.mentions_bot, true);
  assert.deepEqual(out.message.reply_to, { from: "Alice", text: "two options" });
  assert.deepEqual(out.context.map((m) => m.text), ["2"]);
});

// --- the decided resume gate -------------------------------------------------

const NOW = 10_000_000;

function row(over: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "s1",
    timeline_key: "matrix:miku:room:!room",
    session_type: "default",
    status: "completed",
    trigger_sender_id: "alice",
    trigger_sender_display_name: "Alice",
    trigger_body: "find the paper",
    context_tokens: 500,
    resume_generation: 2,
    completed_at: NOW - 5 * 60 * 60_000, // five hours ago
    chat_upper_bound_ts: null,
    ...over,
  } as AgentSessionRow;
}

function material(tool: string): ResumeMaterial {
  return {
    snapshot: [],
    transcript: [
      { type: "triggerGroup", content: "find the paper" },
      { role: "assistant", content: [{ type: "toolCall", id: "c0", name: tool, arguments: {} }] },
    ] as unknown as AgentMessage[],
  };
}

function gate(over: Partial<Parameters<typeof evaluateResumeGate>[0]> = {}) {
  return evaluateResumeGate({
    sessionId: "s1",
    getSession: () => row(),
    decided: true,
    inbound: { timelineKey: "matrix:miku:room:!room", event: { sender: { id: "bob" }, timestamp: NOW } },
    ctx: "group",
    resumeCfg: { same_user_only: true, window: { group: 60_000 } },
    exemptToolNames: new Set(["send_message", "react"]),
    resolveCeiling: () => 100_000,
    loadMaterial: async () => material("web_search"),
    logger: { warn: () => {} },
    ...over,
  });
}

test("decided gate: any participant may resume, outside the reply window, with no target message", async () => {
  const v = await gate();
  assert.equal(v.resume, true, "bob resumes alice's session five hours later");
});

test("decided gate: the work gate still excludes a pure-conversation session", async () => {
  assert.deepEqual(await gate({ loadMaterial: async () => material("send_message") }), { resume: false });
});

test("decided gate: an explicit reply keeps the generation gate", async () => {
  assert.equal((await gate({ targetEvent: { agentSessionGeneration: 2 } })).resume, true);
  assert.deepEqual(await gate({ targetEvent: { agentSessionGeneration: 1 } }), { resume: false });
});

test("decided gate: status, synthetic type and capability gates still apply", async () => {
  assert.deepEqual(await gate({ getSession: () => row({ status: "running" }) }), { resume: false });
  assert.deepEqual(await gate({ getSession: () => row({ session_type: "summarize" }) }), { resume: false });
  assert.deepEqual(await gate({ getSession: () => row({ context_tokens: 200_000 }) }), { resume: false });
});

test("undecided gate (today's chain) still applies same_user_only and the window", async () => {
  assert.deepEqual(await gate({ decided: false, targetEvent: { agentSessionGeneration: 2 } }), { resume: false });
  const sameUserInWindow = await gate({
    decided: false,
    targetEvent: { agentSessionGeneration: 2 },
    getSession: () => row({ completed_at: NOW - 1000 }),
    inbound: { timelineKey: "matrix:miku:room:!room", event: { sender: { id: "alice" }, timestamp: NOW } },
  });
  assert.equal(sameUserInWindow.resume, true);
});
