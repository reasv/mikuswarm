/**
 * Send-contract derivation (spec REFUSAL-HANDLING §7.1–§7.2, DECISION-MODEL
 * §5.8): corrective prompt constants (current + historical), the pure
 * `deriveContractEvents` over synthetic transcripts (every mechanical failure
 * type, every outcome, precedence, runs, record turns, branches), and the
 * renderer tag vocabulary the mimicry detector follows.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTRACT_FAILURE_TYPES,
  FORCED_COMPLETION_PROMPTS,
  deriveContractEvents,
  isRunStart,
  looksLikeContextMimicry,
  looksLikeTextualToolCall,
  matchForcedCompletionPrompt,
  nudgeOf,
  primaryContractFailure,
} from "../src/agent/contract.js";
import { RENDERED_MESSAGE_TAGS } from "../src/context/renderer.js";

// --- synthetic message builders --------------------------------------------

let clock = 100;
const kick = (text = "hi") => ({ type: "triggerGroup", content: text, timestamp: clock++ });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const asst = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: blocks,
  stopReason: "stop",
  model: "wire-a",
  timestamp: clock++,
  ...extra,
});
const result = (id: string, name: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: isError ? "error" : "ok" }],
  isError,
  timestamp: clock++,
});
const nudge = (attempt: number, variant: "not_sent" | "sent_not_final" = "not_sent") => ({
  role: "user",
  content: FORCED_COMPLETION_PROMPTS.current[variant],
  harness: { kind: "forced_completion", attempt, variant },
  timestamp: clock++,
});
const legacyNudge = (t: string) => ({ role: "user", content: t, timestamp: clock++ });
const send = (id: string, final = true) => asst([call(id, "send_message", { text: "hello there", final })], { stopReason: "toolUse" });
const noReply = (id: string) => asst([call(id, "no_reply", {})], { stopReason: "toolUse" });
const sent = (id: string, final = true) => [send(id, final), result(id, "send_message")];

// --- prompt constants -------------------------------------------------------

test("FORCED_COMPLETION_PROMPTS: current and historical wordings map to their variant", () => {
  assert.equal(matchForcedCompletionPrompt(FORCED_COMPLETION_PROMPTS.current.not_sent), "not_sent");
  assert.equal(matchForcedCompletionPrompt(FORCED_COMPLETION_PROMPTS.current.sent_not_final), "sent_not_final");
  assert.ok(FORCED_COMPLETION_PROMPTS.historical.length >= 4);
  const texts = new Set<string>([
    FORCED_COMPLETION_PROMPTS.current.not_sent,
    FORCED_COMPLETION_PROMPTS.current.sent_not_final,
  ]);
  for (const h of FORCED_COMPLETION_PROMPTS.historical) {
    assert.equal(matchForcedCompletionPrompt(`  ${h.text}\n`), h.variant, h.text);
    assert.ok(!texts.has(h.text), "historical wordings are distinct from the current ones");
    texts.add(h.text);
  }
  assert.equal(matchForcedCompletionPrompt("Your turn ended without sending a message."), undefined);
});

test("nudgeOf / isRunStart: marker, legacy text, harness and run-start turns", () => {
  assert.deepEqual(nudgeOf(nudge(2, "sent_not_final")), { variant: "sent_not_final", attempt: 2 });
  assert.deepEqual(nudgeOf(legacyNudge(FORCED_COMPLETION_PROMPTS.historical[0]!.text)), { variant: "not_sent" });
  assert.deepEqual(
    nudgeOf({ role: "user", content: [{ type: "text", text: FORCED_COMPLETION_PROMPTS.current.not_sent }] }),
    { variant: "not_sent" },
  );
  assert.equal(nudgeOf({ role: "user", content: "x", harness: { kind: "record_turn" } }), undefined);
  assert.equal(isRunStart(kick()), true);
  assert.equal(isRunStart({ type: "satellite", content: "c" }), true);
  assert.equal(isRunStart({ role: "user", content: "plain" }), true);
  assert.equal(isRunStart(nudge(1)), false);
  assert.equal(isRunStart({ role: "user", content: "r", harness: { kind: "record_turn" } }), false);
  assert.equal(isRunStart({ type: "interjection", content: "x" }), false);
});

test("primary type follows the documented precedence", () => {
  assert.deepEqual([...CONTRACT_FAILURE_TYPES], [
    "invalid_tool_call",
    "textual_tool_call",
    "context_mimicry",
    "sent_not_final",
    "self_talk",
    "text_only",
    "empty",
  ]);
  assert.equal(primaryContractFailure(["text_only", "invalid_tool_call"]), "invalid_tool_call");
  assert.equal(primaryContractFailure(["text_only", "context_mimicry", "textual_tool_call"]), "textual_tool_call");
  assert.equal(primaryContractFailure(["text_only", "sent_not_final"]), "sent_not_final");
  assert.equal(primaryContractFailure(["empty"]), "empty");
  assert.equal(primaryContractFailure([]), null);
});

// --- patterns ---------------------------------------------------------------

test("textual_tool_call patterns: function syntax, JSON, XML markup, name with arguments", () => {
  for (const t of [
    'send_message({"text": "hi", "final": true})',
    'send_message(text="hi", final=true)',
    '{"name": "send_message", "arguments": {"text": "hi"}}',
    '<tool_call>{"name": "no_reply"}</tool_call>',
    '<function_calls><invoke name="send_message"></invoke></function_calls>',
    '<function=send_message>{"text": "hi"}</function>',
    '[TOOL_CALLS] [{"name": "send_message"}]',
    'send_message {"text": "hi", "final": true}',
    '"tool_calls": [{"id": "1"}]',
  ]) {
    assert.ok(looksLikeTextualToolCall(t), t);
  }
  for (const t of [
    "I will use send_message to reply now.",
    "Nothing worth saying here (no reply needed).",
    "The message was about functions in math.",
  ]) {
    assert.ok(!looksLikeTextualToolCall(t), t);
  }
  assert.ok(looksLikeTextualToolCall("custom_tool({})", ["custom_tool"]));
});

test("context_mimicry follows the renderer's tag vocabulary", () => {
  assert.ok(looksLikeContextMimicry('<message sender="a" time="t">hello</message>'));
  assert.ok(looksLikeContextMimicry("<reply_to>quoted</reply_to> sure"));
  assert.ok(looksLikeContextMimicry("<interjection>\nhi\n</interjection>"));
  assert.ok(looksLikeContextMimicry('<handled_by_session id="s-1"/>'));
  assert.ok(!looksLikeContextMimicry("a < b and messages > 3"));
  assert.ok(!looksLikeContextMimicry("<messages>"));
});

test("RENDERED_MESSAGE_TAGS covers every element the renderer writes", () => {
  const source = readFileSync(new URL("../src/context/renderer.ts", import.meta.url), "utf8").replace(/\\n/g, " ");
  const written = new Set<string>();
  for (const m of source.matchAll(/(?<![\w)\]])<\/?([a-z_]+)(?=[\s>/$"])/g)) written.add(m[1]!);
  for (const tag of written) assert.ok(RENDERED_MESSAGE_TAGS.includes(tag), `renderer writes <${tag}> but it is not listed`);
  for (const tag of RENDERED_MESSAGE_TAGS) assert.ok(written.has(tag), `<${tag}> is listed but not written`);
});

// --- derivation: outcomes and types -----------------------------------------

test("clean: a terminal send, or a silent no_reply, with no nudge", () => {
  const a = deriveContractEvents([kick(), ...sent("s1")]);
  assert.equal(a.outcome, "clean");
  assert.equal(a.nudges, 0);
  assert.equal(a.attempts.length, 1);
  assert.deepEqual(
    { ...a.attempts[0], ts: 0 },
    { branchNo: 0, redoNo: 0, attemptNo: 0, ts: 0, servedModel: null, wireModel: "wire-a", variant: "original", failureTypes: [], primaryType: null },
  );
  const b = deriveContractEvents([kick(), noReply("n1"), result("n1", "no_reply")]);
  assert.equal(b.outcome, "clean");
  const c = deriveContractEvents([kick(), asst([text("NO_REPLY")])]);
  assert.equal(c.outcome, "clean");
});

test("recovered: text_only, nudge, send", () => {
  const d = deriveContractEvents([kick(), asst([text("Here is my answer")]), nudge(1), ...sent("s1")]);
  assert.equal(d.outcome, "recovered");
  assert.equal(d.nudges, 1);
  assert.deepEqual(
    d.attempts.map((a) => [a.attemptNo, a.variant, a.failureTypes, a.primaryType]),
    [
      [0, "original", ["text_only"], "text_only"],
      [1, "not_sent", [], null],
    ],
  );
});

test("each mechanical failure type", () => {
  const types = (messages: unknown[]) => deriveContractEvents([kick(), ...messages]).attempts[0]!.failureTypes;
  assert.deepEqual(types([asst([])]), ["empty"]);
  assert.deepEqual(types([asst([{ type: "thinking", thinking: "hmm" }])]), ["empty"]);
  assert.deepEqual(types([asst([text("just text")])]), ["text_only"]);
  assert.deepEqual(types([asst([text('send_message({"text": "hi", "final": true})')])]), ["textual_tool_call", "text_only"]);
  assert.deepEqual(types([asst([text('<message sender="me">hi</message>')])]), ["context_mimicry", "text_only"]);
  // a native send that failed validation, then the model stopped
  assert.deepEqual(types([send("s1"), result("s1", "send_message", true), asst([])]), ["invalid_tool_call"]);
  assert.deepEqual(
    types([send("s1"), result("s1", "send_message", true), asst([text("oops")])]),
    ["invalid_tool_call", "text_only"],
  );
  // a failed send retried successfully with final=false, then stopped
  assert.deepEqual(
    types([send("s1"), result("s1", "send_message", true), ...sent("s2", false), asst([text("done")])]),
    ["sent_not_final", "text_only"],
  );
  assert.deepEqual(types([...sent("s1", false), asst([])]), ["sent_not_final"]);
});

test("gave_up_no_reply vs recovered after a sent_not_final nudge", () => {
  const gaveUp = deriveContractEvents([kick(), asst([text("my reply")]), nudge(1), noReply("n1"), result("n1", "no_reply")]);
  assert.equal(gaveUp.outcome, "gave_up_no_reply");
  const ended = deriveContractEvents([
    kick(),
    ...sent("s1", false),
    asst([text("anything else?")]),
    nudge(1, "sent_not_final"),
    noReply("n1"),
    result("n1", "no_reply"),
  ]);
  assert.equal(ended.outcome, "recovered", "a message was delivered: ending with no_reply is the asked-for clean end");
  assert.deepEqual(ended.attempts.map((a) => [a.variant, a.primaryType]), [
    ["original", "sent_not_final"],
    ["sent_not_final", null],
  ]);
});

test("exhausted: no valid ending after every nudge", () => {
  const d = deriveContractEvents([
    kick(),
    asst([text("a")]),
    nudge(1),
    asst([text("b")]),
    nudge(2),
    asst([]),
    nudge(3),
    asst([text("d")]),
  ]);
  assert.equal(d.outcome, "exhausted");
  assert.equal(d.nudges, 3);
  assert.deepEqual(d.attempts.map((a) => [a.attemptNo, a.primaryType]), [
    [0, "text_only"],
    [1, "text_only"],
    [2, "empty"],
    [3, "text_only"],
  ]);
});

test("historical transcripts: untagged legacy wordings count as nudges, numbered in order", () => {
  const [old, notSentV1, sentV1, sentV2] = FORCED_COMPLETION_PROMPTS.historical;
  const d = deriveContractEvents([
    kick(),
    asst([text("x")]),
    legacyNudge(old!.text),
    asst([text("y")]),
    legacyNudge(notSentV1!.text),
    ...sent("s1", false),
    asst([text("z")]),
    legacyNudge(sentV1!.text),
    asst([text("w")]),
    legacyNudge(sentV2!.text),
    asst([text("NO_REPLY")]),
  ]);
  assert.equal(d.nudges, 4);
  assert.deepEqual(d.attempts.map((a) => [a.attemptNo, a.variant]), [
    [0, "original"],
    [1, "not_sent"],
    [2, "not_sent"],
    [3, "sent_not_final"],
    [4, "sent_not_final"],
  ]);
  assert.equal(d.outcome, "recovered");
});

test("aborted / failed endings are not attempts; a run that ends on one has no verdict", () => {
  const d = deriveContractEvents([kick(), asst([text("")], { stopReason: "aborted" })]);
  assert.deepEqual(d.attempts, []);
  assert.equal(d.outcome, null);
  const e = deriveContractEvents([kick(), asst([text("t")]), nudge(1), asst([], { stopReason: "error" })]);
  assert.equal(e.attempts.length, 1);
  assert.equal(e.outcome, null);
});

test("served model: stamped logical id, else history falls back to the wire model only", () => {
  const d = deriveContractEvents([
    kick(),
    asst([text("t")], { served: { logicalId: "model_a" }, model: "wire-a" }),
    nudge(1),
    asst([call("s1", "send_message", { final: true })], { served: { logicalId: "model_b" }, model: "wire-b" }),
    result("s1", "send_message"),
  ]);
  assert.deepEqual(d.attempts.map((a) => [a.servedModel, a.wireModel]), [
    ["model_a", "wire-a"],
    ["model_b", "wire-b"],
  ]);
});

test("record turn is skipped; a resumed run is a new run and colliding numbers are renumbered", () => {
  const d = deriveContractEvents([
    kick(),
    asst([text("t")]),
    nudge(1),
    ...sent("s1"),
    { role: "user", content: "write the record", harness: { kind: "record_turn" } },
    asst([call("r1", "session_record_tool", { command: "finalize" })]),
    result("r1", "session_record_tool"),
    asst([text("record done")]),
    kick("follow-up"),
    ...sent("s2"),
  ]);
  assert.equal(d.nudges, 1);
  assert.deepEqual(d.attempts.map((a) => [a.attemptNo, a.variant, a.primaryType]), [
    [0, "original", "text_only"],
    [1, "not_sent", null],
    [2, "original", null],
  ]);
  assert.equal(d.outcome, "recovered", "the session takes its most severe run");
});

test("synthetic injection messages at the kickoff are never endings", () => {
  const d = deriveContractEvents([
    kick(),
    asst([call("i1", "load_skill", { name: "x" })], { harness: { kind: "injection" } }),
    { ...result("i1", "load_skill"), harness: { kind: "injection" } },
    asst([text("plain")]),
  ]);
  assert.equal(d.attempts.length, 1);
  assert.equal(d.attempts[0]!.primaryType, "text_only");
});

// --- derivation: branches ---------------------------------------------------

test("contract redo: failed attempts live in the branch (redo 0), the redo's in the live list (redo 1)", () => {
  const k = kick();
  const live = [k, ...sent("s9")];
  const branch = [asst([text("a")]), nudge(1), asst([text("b")]), nudge(2), asst([text("c")]), nudge(3), asst([text("d")])];
  const d = deriveContractEvents(live, { branches: [{ branchNo: 1, forkIndex: 1, reason: "contract_redo", messages: branch }] });
  assert.equal(d.outcome, "redo_recovered");
  assert.equal(d.nudges, 3);
  assert.equal(d.redos, 1);
  assert.deepEqual(d.attempts.map((a) => [a.branchNo, a.redoNo, a.attemptNo, a.variant, a.primaryType]), [
    [1, 0, 0, "original", "text_only"],
    [1, 0, 1, "not_sent", "text_only"],
    [1, 0, 2, "not_sent", "text_only"],
    [1, 0, 3, "not_sent", "text_only"],
    [0, 1, 0, "original", null],
  ]);
});

test("contract redo exhausted twice in the same span: outcome exhausted", () => {
  const live = [kick(), asst([text("e")]), nudge(1), asst([text("f")])];
  const branch = [asst([text("a")]), nudge(1), asst([text("b")])];
  const d = deriveContractEvents(live, { branches: [{ branchNo: 1, forkIndex: 1, reason: "contract_redo", messages: branch }] });
  assert.equal(d.outcome, "exhausted");
  assert.equal(d.nudges, 2);
  assert.deepEqual(d.attempts.map((a) => [a.branchNo, a.redoNo, a.attemptNo]), [
    [1, 0, 0],
    [1, 0, 1],
    [0, 1, 0],
    [0, 1, 1],
  ]);
});

test("refusal fork: the cut ending is no attempt; attempts the fork kept stay in the live branch", () => {
  // Live: text-only, nudge, a delivered final=false send, then the redo's send.
  const live = [kick(), asst([text("a")]), nudge(1), ...sent("s1", false), ...sent("s3")];
  // Discarded at index 5: the refused send (gate) and the aborted tail.
  const branch = [send("g1"), result("g1", "send_message", true), asst([text("")], { stopReason: "aborted" })];
  const d = deriveContractEvents(live, { branches: [{ branchNo: 1, forkIndex: 5, reason: "refusal_redo", messages: branch }] });
  assert.deepEqual(d.attempts.map((a) => [a.branchNo, a.attemptNo, a.variant, a.primaryType]), [
    [0, 0, "original", "text_only"],
    [0, 1, "original", null],
  ]);
  assert.equal(d.outcome, "recovered");
});

test("refusal fork back to the kickoff: discarded attempts keep their branch", () => {
  const live = [kick(), ...sent("s2")];
  const branch = [asst([text("a")]), nudge(1), send("g1"), result("g1", "send_message", true), asst([], { stopReason: "aborted" })];
  const d = deriveContractEvents(live, { branches: [{ branchNo: 1, forkIndex: 1, reason: "refusal_redo", messages: branch }] });
  assert.deepEqual(d.attempts.map((a) => [a.branchNo, a.attemptNo, a.variant, a.primaryType]), [
    [1, 0, "original", "text_only"],
    [0, 0, "original", null],
  ]);
  assert.equal(d.nudges, 1);
  assert.equal(d.outcome, "recovered");
});
