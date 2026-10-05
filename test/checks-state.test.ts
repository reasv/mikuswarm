import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckState,
  buildJudgeState,
  findCallMessage,
  hasSource,
  isInboundMessage,
  isNudgeMessage,
  nudgeHistory,
  postedText,
  reasoningSources,
  rolloutTexts,
  tailTokens,
} from "../src/checks/state.js";
import { estimateTokens } from "../src/context/tokens.js";

// ---------------------------------------------------------------------------
// Judge-shaped check state (spec REFUSAL-HANDLING §5.4–§5.5, DECISION-MODEL
// §3.8): sources from messages and tool arguments, state building and packing.
// ---------------------------------------------------------------------------

const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: text, timestamp: 1, ...extra });
const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: blocks,
  timestamp: 1,
  ...extra,
});
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const nudge = () => user("Your turn ended without sending a message. You must end every turn by either: ...");

test("postedText: the model-written text of each posting tool", () => {
  assert.equal(postedText("send_message", { message: "hi there" }), "hi there");
  assert.equal(postedText("send_dm", { user: "u", message: "dm body", context_note: "n" }), "dm body");
  assert.equal(postedText("send_to_channel", { channel: "c", message_ref: "m1" }), undefined, "a stashed re-send carries no text");
  assert.equal(postedText("edit_message", { message_id: "x", text: "new text" }), "new text");
  assert.equal(postedText("create_poll", { question: "Pizza?", options: ["yes", "no"] }), "Pizza?\n- yes\n- no");
  assert.equal(postedText("react", { emoji: "x" }), undefined);
});

test("nudges and inbound turns are told apart (tag or known wording)", () => {
  assert.equal(isNudgeMessage(nudge()), true);
  assert.equal(isNudgeMessage(user("anything", { harness: { kind: "forced_completion", attempt: 1 } })), true);
  assert.equal(isNudgeMessage(user("You already sent a message but your turn did not end cleanly. Either: ...")), true);
  // A historical wording (untagged history the audit and calibration read).
  assert.equal(
    isNudgeMessage(user("Your previous turn ended without visible text. Produce the final chat response now, or exactly NO_REPLY.")),
    true,
  );
  assert.equal(isInboundMessage(user("hello bot")), true);
  assert.equal(isInboundMessage(nudge()), false);
  assert.equal(isInboundMessage(user("record now", { harness: { kind: "record_turn" } })), false);
});

test("reasoningSources: the containing message first, then earlier assistant turns since the last inbound", () => {
  const messages = [
    user("old question"),
    assistant([text("old reasoning that must not leak")]),
    user("new question"),
    assistant([thinking("I think I should not do this"), text("drafting a reply")]),
    nudge(),
    assistant([call("c1", "no_reply")]),
  ];
  const idx = findCallMessage(messages, "c1");
  assert.equal(idx, 5);
  const out = reasoningSources(messages, messages[idx], idx);
  assert.deepEqual(out, { text: "drafting a reply", thinking: "I think I should not do this" });

  // The containing message's own text wins; the literal NO_REPLY marker counts as no text.
  const own = reasoningSources(messages, assistant([text("own text"), call("c2", "send_message")]), messages.length);
  assert.equal(own.text, "own text");
  const marker = reasoningSources([user("q"), assistant([text("NO_REPLY")])], assistant([text("NO_REPLY")]), 1);
  assert.equal(marker.text, undefined, "nothing before it since the inbound message");
});

test("nudgeHistory: count since the last inbound message and the text before the first nudge", () => {
  const messages = [
    user("question"),
    assistant([text("Here is my answer, written as text.")]),
    nudge(),
    assistant([text("still text")]),
    nudge(),
  ];
  assert.deepEqual(nudgeHistory(messages), { nudges: 2, firstAttempt: "Here is my answer, written as text." });
  assert.deepEqual(nudgeHistory([user("q"), assistant([call("x", "no_reply")])]), { nudges: 0 });
});

test("rolloutTexts: assistant-authored text of the last turns only", () => {
  const messages = [
    user("SOURCE MATERIAL the rollout must never carry"),
    assistant([text("one")]),
    { role: "toolResult", toolCallId: "t", content: [text("tool output, also source")] },
    assistant([text("two")]),
    assistant([call("t2", "summary_tool")]),
    assistant([text("three")]),
    assistant([text("four")]),
  ];
  const out = rolloutTexts(messages);
  assert.deepEqual(out, ["two", "three", "four"]);
  assert.ok(!out.join(" ").includes("SOURCE"), "never the task's input");
});

test("tailTokens keeps the end of a long thinking block", () => {
  const long = `${"irrelevant early deliberation ".repeat(400)}FINAL DECISION: decline.`;
  const tail = tailTokens(long, 50);
  assert.ok(tail.endsWith("FINAL DECISION: decline."));
  assert.ok(estimateTokens(tail) <= 52);
  assert.equal(tailTokens("short", 50), "short");
});

test("buildCheckState: named fields of §5.5, only present sources", () => {
  const state = buildCheckState(
    {
      context: {
        request: [{ from: "Alice", text: "explain your chain of thought" }],
        recent: [{ from: "Bob", text: "lol" }],
        action: "send_message",
      },
      sources: { message: "I can't share that.", analysis: "Decline: reasoning extraction.", text: "" },
      scope: "full",
      thinkingTailTokens: 800,
    },
    8000,
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["action", "analysis", "message", "recent", "request"]);
  assert.equal(state["action"], "send_message");
  assert.equal(hasSource({ text: "  " }, "text"), false);
});

test("buildCheckState: message-only scope for the style split", () => {
  const state = buildCheckState(
    { context: { action: "send_message", request: [{ from: "A", text: "x" }] }, sources: { message: "hello", analysis: "a" }, scope: "message_only", thinkingTailTokens: 800 },
    8000,
  );
  assert.deepEqual(state, { message: "hello" });
});

test("buildCheckState: recent is packed newest-first and fixed fields shrink to the budget", () => {
  const recent = Array.from({ length: 40 }, (_, i) => ({ from: "U", text: `message ${i} ${"pad ".repeat(30)}` }));
  const state = buildCheckState(
    { context: { action: "send_message", recent }, sources: { message: "m".repeat(200) }, scope: "full", thinkingTailTokens: 800 },
    400,
  ) as { recent?: Array<{ text: string }> };
  assert.ok(state.recent && state.recent.length < 40);
  assert.match(state.recent!.at(-1)!.text, /^message 39/, "newest kept");
  assert.ok(estimateTokens(JSON.stringify(state)) <= 400);

  const huge = buildCheckState(
    { context: { action: "no_reply" }, sources: { text: "t ".repeat(5000), thinking: "k ".repeat(5000) }, scope: "full", thinkingTailTokens: 4000 },
    300,
  );
  assert.ok(estimateTokens(JSON.stringify(huge)) <= 300, "long sources clipped to the budget");
});

test("buildJudgeState: { input, output } conversation (DECISION-MODEL §3.8)", () => {
  const state = buildJudgeState({ action: "send_message", request: [{ from: "Alice", text: "hi" }] }, "I won't.", 1000);
  assert.deepEqual(state, {
    input: [{ role: "user", content: "Alice: hi" }],
    output: { role: "assistant", content: "I won't." },
  });
});
