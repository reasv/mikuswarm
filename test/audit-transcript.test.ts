/**
 * Offline audit, pure parts (spec REFUSAL-HANDLING §5.4, §7.2–§7.3, §10.2): the
 * outputs the check pass judges (anchored like the live gate), the nudged runs
 * of the send-contract diagnosis, the mechanical comparison, and the
 * diagnosis's questions and results.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AFTER_CORRECTION_UNCERTAIN,
  contractAuditPoint,
  diagnoseRun,
  planRun,
  type RunAttempt,
} from "../src/audit/contract-audit.js";
import { compareMessages, editDistance, normalizeForComparison } from "../src/audit/compare.js";
import { checkItems, contractRuns, textualCallMessage } from "../src/audit/transcript.js";
import { auditKnobs, inSample } from "../src/audit/config.js";
import { asst, call, kick, noReply, nudge, result, sent, text, thinking } from "./audit-fixtures.js";

test("checkItems: delivered sends, no_reply, NO_REPLY text and exhaustion, anchored like the gate", () => {
  const transcript = [
    kick(),
    asst([text("let me answer"), call("c1", "send_message", { message: "the answer", analysis: "they asked" })], { stopReason: "toolUse" }),
    result("c1", "send_message"),
    // A failed send is not delivered: never judged.
    asst([call("c2", "send_message", { message: "broken" })], { stopReason: "toolUse" }),
    result("c2", "send_message", true),
    // Harness-written assistant turns are never judged.
    asst([text("NO_REPLY")], { harness: { kind: "injection" } }),
    kick("second run"),
    asst([thinking("should I reply? no"), text("nothing to add")]),
    nudge(1),
    ...noReply("c3", { analysis: "not addressed to me" }),
    kick("third run"),
    asst([text("NO_REPLY")]),
    kick("fourth run"),
    asst([text("a reply written as text")]),
    nudge(1),
    asst([text("still text")]),
    // A record turn and everything up to the next run start is skipped.
    { role: "user", content: "write the record", harness: { kind: "record_turn" }, timestamp: 5 },
    asst([call("rec", "session_record_tool", {})]),
  ];
  const items = checkItems(transcript);
  const summary = items.map((i) => `${i.checkpoint}:${i.action}:${i.toolCallId ?? "-"}:${i.attemptNo ?? "-"}`);
  assert.deepEqual(summary, [
    "send:send_message:c1:-",
    "ending:no_reply:c3:1",
    "ending:NO_REPLY:-:0",
    "ending:exhausted:-:1",
  ]);
  const send = items[0]!;
  assert.equal(send.sources.message, "the answer");
  assert.equal(send.sources.analysis, "they asked");
  assert.equal(send.sources.text, "let me answer");
  assert.equal(send.sources.thinking, undefined, "thinking is never judged at a send");
  assert.equal(send.wireModel, "wire-a");
  const ending = items[1]!;
  assert.equal(ending.sources.analysis, "not addressed to me");
  assert.equal(ending.sources.text, "nothing to add");
  assert.equal(ending.sources.thinking, "should I reply? no");
  assert.equal(ending.nudges, 1);
  assert.equal(ending.firstAttempt, "nothing to add");
});

test("contractRuns: first attempt from text, a textual call, a failed send; what happened after", () => {
  const transcript = [
    // Run 0: clean, not returned.
    kick(),
    ...sent("s0", "hi"),
    // Run 1: text-only, nudged, then sent.
    kick("run 1"),
    asst([text("Here is my reply to you")]),
    nudge(1),
    ...sent("s1", "Here is my reply to you!"),
    // Run 2: a textual tool call, then no_reply.
    kick("run 2"),
    asst([text('send_message({"message": "the hidden reply"})')]),
    nudge(1),
    ...noReply("n2"),
    // Run 3: a failed native send, then nothing valid.
    kick("run 3"),
    asst([call("f3", "send_message", { message: "failed body" })], { stopReason: "toolUse" }),
    result("f3", "send_message", true),
    asst([text("hmm")]),
    nudge(1),
    asst([text("still nothing")]),
    nudge(2),
    asst([text("no")]),
  ];
  const runs = contractRuns(transcript);
  assert.deepEqual(runs.map((r) => [r.run, r.nudges, r.firstAttemptSource, r.result]), [
    [1, 1, "text", "sent"],
    [2, 1, "textual_tool_call", "switched_to_no_reply"],
    [3, 2, "invalid_tool_call", "nothing"],
  ]);
  assert.equal(runs[0]!.firstAttempt, "Here is my reply to you");
  assert.deepEqual(runs[0]!.sent, ["Here is my reply to you!"]);
  assert.equal(runs[1]!.firstAttempt, "the hidden reply");
  assert.equal(runs[2]!.firstAttempt, "failed body");
  assert.ok(runs[0]!.endings.length >= 2, "every model ending of the run has its timestamp");
});

test("contractRuns: a contract redo's discarded attempts are read from the branch", () => {
  const live = [kick("run"), asst([text("first try as text")]), nudge(1)];
  const discarded = [asst([text("second try")]), nudge(2), asst([text("third")])];
  const after = [...sent("s9", "the real message")];
  // The fork kept `live` (index 3) and discarded `discarded`; the redo continued live.
  const runs = contractRuns([...live, ...after], [{ branchNo: 1, forkIndex: 3, reason: "contract_redo", messages: discarded }]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.firstAttempt, "first try as text");
  assert.equal(runs[0]!.nudges, 2);
  assert.equal(runs[0]!.result, "sent");
});

test("textualCallMessage: JSON and keyword arguments; undefined without one", () => {
  assert.equal(textualCallMessage('<tool_call>{"name":"send_message","arguments":{"message":"a\\nb"}}'), "a\nb");
  assert.equal(textualCallMessage('send_message(message="hello \\"x\\"")'), 'hello "x"');
  assert.equal(textualCallMessage("send_message(final=true)"), undefined);
});

test("compareMessages: normalized equality, edit similarity, length ratio", () => {
  assert.equal(normalizeForComparison("  Hello\n\nWORLD "), "hello world");
  assert.equal(editDistance([..."kitten"], [..."sitting"]), 3);
  const same = compareMessages("Hello  world", "hello world");
  assert.deepEqual(same, { normalizedEqual: true, similarity: 1, lengthRatio: 1 });
  const edited = compareMessages("kitten", "sitting");
  assert.equal(edited.normalizedEqual, false);
  assert.equal(edited.similarity, Math.round((1 - 3 / 7) * 1000) / 1000);
  assert.equal(edited.lengthRatio, Math.round((7 / 6) * 1000) / 1000);
  assert.equal(compareMessages("", "x").lengthRatio, null);
  // Very long texts are compared by words, bounded.
  const long = "word ".repeat(3000);
  const r = compareMessages(long, `${long} extra`);
  assert.equal(r.normalizedEqual, false);
  assert.ok(r.similarity >= 0.99);
  assert.equal(compareMessages(long, "other ".repeat(3000)).similarity, 0);
});

function attempt(ts: number, types: string[], txt: string, attemptNo = 0): RunAttempt {
  return {
    row: {
      id: attemptNo + 1, agent_session_id: "s", branch_no: 0, redo_no: 0, attempt_no: attemptNo, ts,
      served_model: "model_a", wire_model: "wire-a", variant: "original",
      failure_types_json: JSON.stringify(types), primary_type: types[0] ?? null,
    },
    text: txt,
  };
}

test("planRun / diagnoseRun: self_talk, ambiguous textual call, after_correction model and mechanical", () => {
  const run = {
    run: 1, nudges: 1, firstAttempt: "I think the answer is 4", firstAttemptSource: "text" as const,
    ts: 10, servedModel: "model_a", wireModel: "wire-a", sent: ["The answer is 4."], result: "sent" as const,
    endings: [{ ts: 10, text: "I think the answer is 4" }, { ts: 11, text: "maybe use send_message here" }],
  };
  const attempts = [attempt(10, ["text_only"], "I think the answer is 4"), attempt(11, ["text_only"], "maybe use send_message here", 1)];
  const plan = planRun(run, attempts, [{ from: "u", text: "what is 2+2" }]);
  assert.ok(plan.input);
  const ids = Object.keys(contractAuditPoint.questions(plan.input!, {} as never));
  assert.deepEqual(ids.sort(), ["a0__had_user_message", "a1__had_user_message", "a1__textual_tool_call", "after_correction"].sort());
  const q = contractAuditPoint.questions(plan.input!, {} as never)["after_correction"]!;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys((q as { criteria: object }).criteria), [
    "same", "minor_rewording", "parts_removed", "rewritten_same_substance", "different_substance",
  ]);
  const state = contractAuditPoint.state(plan.input!, 100_000) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["attempts", "ending", "first_attempt", "nudges", "request", "sent"]);
  // A tiny budget shrinks every text.
  const small = JSON.stringify(contractAuditPoint.state({ ...plan.input!, firstAttempt: "x".repeat(5000) }, 200));
  assert.ok(small.length < 2000);

  const { diagnosis, updates } = diagnoseRun(run, attempts, plan, {
    a0__had_user_message: { type: "noul", noul: 0.9 },
    a1__had_user_message: { type: "noul", noul: 0.1 },
    a1__textual_tool_call: { type: "noul", noul: 0.2 },
    after_correction: { type: "choice", choice: "minor_rewording", confidence: 0.8, probabilities: { minor_rewording: 0.8 } },
  }, { selfTalk: 0.7, textual: 0.8, minConfidence: 0.6 });
  assert.deepEqual(diagnosis.afterCorrection, {
    choice: "minor_rewording", source: "model", confidence: 0.8, picked: "minor_rewording", probabilities: { minor_rewording: 0.8 },
  });
  assert.equal(diagnosis.mechanical!.normalizedEqual, false);
  assert.equal(diagnosis.attempts[0]!.selfTalk, false);
  assert.equal(diagnosis.attempts[1]!.selfTalk, true);
  assert.deepEqual(updates, [
    { branchNo: 0, redoNo: 0, attemptNo: 1, failureTypes: ["self_talk", "text_only"], primaryType: "self_talk" },
  ]);

  // Below min_confidence: kept, counted as uncertain. A textual call outranks self-talk.
  const low = diagnoseRun(run, attempts, plan, {
    a1__had_user_message: { type: "noul", noul: 0.1 },
    a1__textual_tool_call: { type: "noul", noul: 0.95 },
    after_correction: { type: "choice", choice: "same", confidence: 0.3, probabilities: {} },
  }, { selfTalk: 0.7, textual: 0.8, minConfidence: 0.6 });
  assert.equal(low.diagnosis.afterCorrection!.choice, AFTER_CORRECTION_UNCERTAIN);
  assert.deepEqual(low.updates, [
    { branchNo: 0, redoNo: 0, attemptNo: 1, failureTypes: ["textual_tool_call", "text_only"], primaryType: "textual_tool_call" },
  ]);
});

test("planRun: mechanics decide without a call (equal texts, no_reply, exhaustion, no text)", () => {
  const base = { run: 0, nudges: 1, firstAttemptSource: "text" as const, ts: 1, servedModel: null, wireModel: null, endings: [] };
  const equal = { ...base, firstAttempt: "Hello there", sent: ["hello  there"], result: "sent" as const };
  const p1 = planRun(equal, [], []);
  assert.equal(p1.input, undefined);
  assert.equal(diagnoseRun(equal, [], p1, undefined, { selfTalk: 0.7, textual: 0.8, minConfidence: 0.6 }).diagnosis.afterCorrection!.choice, "same");
  for (const result of ["switched_to_no_reply", "nothing"] as const) {
    const r = { ...base, firstAttempt: "x", sent: [], result };
    const plan = planRun(r, [], []);
    assert.equal(plan.input, undefined);
    const d = diagnoseRun(r, [], plan, undefined, { selfTalk: 0.7, textual: 0.8, minConfidence: 0.6 }).diagnosis;
    assert.deepEqual(d.afterCorrection, { choice: result, source: "mechanical" });
  }
  const empty = { ...base, firstAttempt: "", firstAttemptSource: "none" as const, sent: ["x"], result: "sent" as const };
  const pe = planRun(empty, [], []);
  assert.equal(pe.input, undefined);
  assert.equal(diagnoseRun(empty, [], pe, undefined, { selfTalk: 0.7, textual: 0.8, minConfidence: 0.6 }).diagnosis.afterCorrection, null);
});

test("audit knobs: defaults and seeded sampling", () => {
  const k = auditKnobs({});
  assert.deepEqual(k.audits, ["send_contract", "refusal"]);
  assert.deepEqual(k.checkKinds, ["refusal", "contract"]);
  assert.equal(k.sampleCleanSessions, 1);
  assert.equal(k.workers, 1);
  assert.equal(k.backlogPaceMs, 1000);
  assert.equal(k.settleMs, 60_000);
  assert.equal(k.maxRetries, 3);
  assert.equal(inSample("any", 1), true);
  assert.equal(inSample("any", 0), false);
  const ids = Array.from({ length: 2000 }, (_, i) => `s-${i}`);
  const share = ids.filter((id) => inSample(id, 0.25)).length / ids.length;
  assert.ok(share > 0.2 && share < 0.3, `share ${share}`);
  assert.equal(inSample("s-7", 0.25), inSample("s-7", 0.25), "seeded per session id");
});
