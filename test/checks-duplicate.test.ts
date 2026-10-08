import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_DUPLICATE_CHECKS } from "../src/checks/builtin/duplicate.js";
import {
  DUPLICATE_REJECTION_MARK,
  buildDuplicateJudgeState,
  buildDuplicateState,
  duplicateRejection,
  duplicateTarget,
  lastSeen,
  messageText,
  secondsBefore,
  seenFromMessages,
  selectUnseen,
  withSeenStamp,
  type DuplicateContext,
  type DuplicateRow,
  type UnseenMessage,
} from "../src/checks/duplicate.js";
import { priorDuplicateRejections } from "../src/checks/duplicate-source.js";
import { estimateTokens } from "../src/context/tokens.js";
import { assignItemIds, checksPoint, planDuplicateCalls, type ChecksCallInput } from "../src/decisions/points/checks.js";
import type { PointSettings } from "../src/decisions/config.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// The duplicate-send check's mechanics (DECISION-MODEL §5.4, ARCHITECTURE.md
// §8j "Duplicate sends"): last seen, unseen selection, state, judge state,
// targets, the rejection text, and the checks point's duplicate calls.
// ---------------------------------------------------------------------------

const OWN = "matrix:acct:room:!r:example.org";
const OTHER = "matrix:acct:room:!other:example.org";

function event(id: string, body: string, over: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    timelineKey: OWN,
    provider: "matrix",
    role: "assistant",
    sender: { id: "@bot:example.org", displayName: "Bot", isSelf: true },
    body,
    timestamp: 1000,
    receivedAt: 1000,
    ...over,
  };
}

function row(id: string, body: string, receivedAt: number, sessionId = "s-other", over: Partial<DuplicateRow> = {}): DuplicateRow {
  return {
    event: event(id, body, { receivedAt }),
    sessionId,
    receivedAt,
    answering: { from: "alice", text: "what is 6 times 7?" },
    ...over,
  };
}

function unseen(text: string, receivedAt: number, over: Partial<UnseenMessage> = {}): UnseenMessage {
  return { eventIds: [`e-${receivedAt}`], sessionId: "s-other", receivedAt, text, answering: { from: "alice", text: "what is 6 times 7?" }, ...over };
}

function context(earlier: UnseenMessage[], over: Partial<DuplicateContext> = {}): DuplicateContext {
  return {
    targetTimelineKey: OWN,
    ownTimelineKey: OWN,
    draftAt: 20_000,
    earlier,
    draftAnswering: { from: "bob", text: "6*7?" },
    earlierMaxTokens: 1500,
    ...over,
  };
}

test("last seen: the build stamp is the cutoff of every timeline; stamps move it on", () => {
  const head = withSeenStamp({ type: "triggerGroup", content: "t", timestamp: 500 }, { timelineKey: OWN, upTo: 1000 });
  const seen = seenFromMessages([head]);
  assert.equal(lastSeen(seen, OWN), 1000);
  assert.equal(lastSeen(seen, OTHER), 1000, "a timeline the session never saw: its build cutoff");
  // A later message that shows a room up to a point, and one that shows single messages.
  const more = seenFromMessages([
    head,
    { type: "interjection", content: "i", seen: { eventIds: ["e-quoted"] } },
    { type: "interjection", content: "j", seen: { timelineKey: OTHER, upTo: 3000 } },
  ]);
  assert.equal(lastSeen(more, OTHER), 3000);
  assert.equal(lastSeen(more, OWN), 1000);
  assert.ok(more.eventIds.has("e-quoted"));
  // A redo rebuild stamps the first build's cutoff again: nothing moves.
  const redo = seenFromMessages([withSeenStamp({ type: "triggerGroup", content: "t2", timestamp: 500 }, { timelineKey: OWN, upTo: 1000 })]);
  assert.equal(lastSeen(redo, OWN), 1000);
  // A resume turn's gap shows its messages (ids only).
  const resumed = seenFromMessages([head, { type: "triggerGroup", content: "r", timestamp: 9000, seen: { eventIds: ["g1", "g2"] } }]);
  assert.deepEqual([...resumed.eventIds], ["g1", "g2"]);
  assert.equal(lastSeen(resumed, OWN), 1000, "a resume keeps the original cutoff");
  // Legacy transcript: no stamp, the head's timestamp.
  assert.equal(lastSeen(seenFromMessages([{ type: "triggerGroup", content: "t", timestamp: 777 }]), OWN), 777);
  assert.equal(lastSeen(seenFromMessages([]), OWN), undefined);
});

test("last seen: a rejection's quoted messages count once its tool result carries the rejection", () => {
  const head = withSeenStamp({ type: "triggerGroup", content: "t", timestamp: 1 }, { timelineKey: OWN, upTo: 1000 });
  const rejections = new Map([["call-1", ["e1", "e2"]], ["call-2", ["e3"]]]);
  const messages = [
    head,
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "send_message", arguments: {} }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "send_message", content: [{ type: "text", text: `Not sent. … ago ${DUPLICATE_REJECTION_MARK}: «x»` }], isError: true },
    // A call that was judged but went through: its result shows nothing.
    { role: "toolResult", toolCallId: "call-2", toolName: "send_message", content: [{ type: "text", text: "sent: $e" }], isError: false },
  ];
  const seen = seenFromMessages(messages, rejections);
  assert.deepEqual([...seen.eventIds].sort(), ["e1", "e2"]);
  // A fork that discarded the rejection's result discards what it showed.
  assert.deepEqual([...seenFromMessages(messages.slice(0, 2), rejections).eventIds], []);
});

test("unseen: other sessions only, minus seen ones; chunks join; newest max, oldest first", () => {
  const rows = [
    row("e-own", "mine", 2000, "s-self"),
    row("e1", "first", 2100),
    row("assistant:s-other:x:0", "long part one", 2200),
    row("assistant:s-other:y:1", "long part two", 2201),
    row("e-seen", "seen already", 2300),
    row("e3", "third", 2400, "s-third"),
    row("e4", "", 2500), // nothing to judge
  ];
  const seen = seenFromMessages([]);
  seen.eventIds.add("e-seen");
  const all = selectUnseen(rows, seen, { selfSessionId: "s-self", max: 5 });
  assert.deepEqual(all.map((m) => [m.eventIds, m.text]), [
    [["e1"], "first"],
    [["assistant:s-other:x:0", "assistant:s-other:y:1"], "long part one\nlong part two"],
    [["e3"], "third"],
  ]);
  assert.deepEqual(selectUnseen(rows, seen, { selfSessionId: "s-self", max: 2 }).map((m) => m.text.split("\n")[0]), ["long part one", "third"]);
});

test("message text: the body, then [image: <caption>] per posted attachment", () => {
  const e = event("e", "look", {
    attachments: [
      { mediaType: "image", caption: "a cat on a  keyboard" } as never,
      { mediaType: "image" } as never,
    ],
  });
  assert.equal(messageText(e), "look\n[image: a cat on a keyboard]\n[image]");
  assert.equal(messageText(event("e2", "", { attachments: [{ mediaType: "video", caption: "a clip" } as never] })), "[video: a clip]");
});

test("state: exactly earlier[] and draft, seconds before the draft, answering; nothing else", () => {
  const ctx = context([unseen("It's 42.", 8_000), unseen("posted on my own", 15_500, { answering: "unprompted" })]);
  const state = buildDuplicateState(ctx, "The answer is 42.", 8000);
  assert.deepEqual(state, {
    earlier: [
      { seconds_before_draft: 12, answering: { from: "alice", text: "what is 6 times 7?" }, text: "It's 42." },
      { seconds_before_draft: 5, answering: "unprompted", text: "posted on my own" },
    ],
    draft: { answering: { from: "bob", text: "6*7?" }, text: "The answer is 42." },
  });
  assert.deepEqual(Object.keys(state), ["earlier", "draft"], "no persona, transcript, tool results or reasoning");
  const proactive = buildDuplicateState(context([unseen("x", 1)], { draftAnswering: "unprompted" }), "y", 8000);
  assert.equal((proactive["draft"] as { answering: unknown }).answering, "unprompted");
  assert.equal(secondsBefore(1000, 5000), 0, "never negative");
});

test("state: each earlier text is clipped to about earlier_max_tokens; over budget the oldest go first", () => {
  const long = "word ".repeat(4000);
  const state = buildDuplicateState(context([unseen(long, 1000)]), "draft", 20_000);
  const text = (state["earlier"] as Array<{ text: string }>)[0]!.text;
  assert.ok(estimateTokens(text) <= 1500 && estimateTokens(text) > 1000, `about 1.5k tokens (got ${estimateTokens(text)})`);
  assert.ok(text.endsWith("…"));
  const five = [1, 2, 3, 4, 5].map((i) => unseen(`message ${i} ${"pad ".repeat(300)}`, i * 1000));
  const tight = buildDuplicateState(context(five), "draft", 900);
  const kept = (tight["earlier"] as Array<{ text: string }>).map((m) => m.text.split(" ").slice(0, 2).join(" "));
  assert.ok(kept.length < 5 && kept.length > 0);
  assert.equal(kept[kept.length - 1], "message 5", "the newest is kept");
  // Even one message over budget: the newest stays, shrunk.
  const tiny = buildDuplicateState(context([unseen(long, 1000)]), "draft", 300);
  assert.equal((tiny["earlier"] as unknown[]).length, 1);
  assert.ok(estimateTokens(JSON.stringify(tiny)) <= 300);
});

test("judge state: each earlier message as request + reply, the draft's request last, the draft as output", () => {
  const judge = buildDuplicateJudgeState(context([unseen("It's 42.", 8_000), unseen("hi all", 9_000, { answering: "unprompted" })]), "42!", 2000);
  assert.deepEqual(judge, {
    input: [
      { role: "user", content: "alice: what is 6 times 7?" },
      { role: "assistant", content: "It's 42." },
      { role: "user", content: "(no request: the assistant posted on its own)" },
      { role: "assistant", content: "hi all" },
      { role: "user", content: "bob: 6*7?" },
    ],
    output: { role: "assistant", content: "42!" },
  });
});

test("targets: every posting tool against its own target timeline", () => {
  const dm = (user: string) => (user === "@carol:example.org" ? "matrix:acct:dm:!dm:example.org" : undefined);
  assert.equal(duplicateTarget("send_message", { message: "x" }, OWN, dm), OWN);
  assert.equal(duplicateTarget("edit_message", { message_id: "$e", text: "x" }, OWN, dm), OWN);
  assert.equal(duplicateTarget("create_poll", { question: "q" }, OWN, dm), OWN);
  assert.equal(duplicateTarget("send_to_channel", { channel: ` ${OTHER} `, message: "x" }, OWN, dm), OTHER);
  assert.equal(duplicateTarget("send_dm", { user: "@carol:example.org", message: "x" }, OWN, dm), "matrix:acct:dm:!dm:example.org");
  assert.equal(duplicateTarget("send_dm", { user: "@dave:example.org", message: "x" }, OWN, dm), undefined, "no DM yet: nothing to compare");
  assert.equal(duplicateTarget("send_to_channel", {}, OWN, dm), undefined);
  assert.equal(duplicateTarget("react", {}, OWN, dm), undefined);
});

test("rejection: the spec's text, filled in, naming the questions that fired", () => {
  const one = context([unseen("It's 42.", 8_000)]);
  const r = duplicateRejection(one, ["repeats"], "duplicate");
  assert.equal(
    r.standalone,
    "Not sent. Another session of yours (you, answering a different message in this room in parallel) already posted " +
      "a message here 12 s ago that you have not seen: «It's 42.» (it was answering alice: «what is 6 times 7?»). " +
      "Your draft repeats what that message already says. Rewrite your message so it fits after that one: refer to it, " +
      "correct it, or add only what is new. Call no_reply if nothing is left to add. If your draft is still right as " +
      'written, send it again with override_checks: ["duplicate"].',
  );
  assert.ok(!r.explanation.includes("override_checks") && !r.explanation.startsWith("Not sent"));
  assert.match(duplicateRejection(one, ["answered_already"], "duplicate").standalone, /Your draft answers the same question it already answered\./);
  assert.match(duplicateRejection(one, ["contradicts"], "duplicate").standalone, /Your draft contradicts it\./);
  assert.match(
    duplicateRejection(one, ["answered_already", "repeats", "contradicts"], "duplicate").standalone,
    /Your draft answers the same question it already answered, repeats what that message already says and contradicts it\./,
  );
  // A proactive earlier message, another channel, several messages.
  const proactive = duplicateRejection(context([unseen("hi", 8_000, { answering: "unprompted" })]), ["repeats"], "duplicate").standalone;
  assert.match(proactive, /Another session of yours \(you, posting on your own in parallel\)/);
  assert.match(proactive, /\(it was not answering anyone: you posted it on your own\)/);
  const elsewhere = duplicateRejection(context([unseen("x", 8_000)], { targetTimelineKey: OTHER }), ["repeats"], "duplicate").standalone;
  assert.match(elsewhere, new RegExp(`answering a different message in ${OTHER.replace(/[.!]/g, "\\$&")} in parallel\\) already posted a message in `));
  const many = duplicateRejection(context([unseen("a", 8_000), unseen("b", 19_000)]), ["contradicts"], "duplicate").standalone;
  assert.match(many, /^Not sent\. Other sessions of yours \(you, answering different messages in this room in parallel\) already posted 2 messages here that you have not seen:\n- 12 s ago: «a» \(it was answering alice: «what is 6 times 7\?»\)\n- 1 s ago: «b»/);
  assert.match(many, /Your draft contradicts one of them\. Rewrite your message so it fits after them:/);
  assert.match(duplicateRejection(context([unseen("x", 8_000)], { ownTimelineKey: "matrix:acct:dm:!d:example.org", targetTimelineKey: "matrix:acct:dm:!d:example.org" }), ["repeats"], "duplicate").standalone, /in this DM in parallel/);
});

const SETTINGS: PointSettings = {
  point: "checks",
  model: "decider",
  timeoutMs: 3000,
  stateMaxTokens: 8000,
  minStateTokens: 1,
  minConfidence: 0.6,
  calibration: {},
  persona: "",
};

function duplicateInput(shape: "object" | "conversation" = "object"): ChecksCallInput {
  const check = BUILTIN_DUPLICATE_CHECKS[0]!;
  return {
    items: assignItemIds(check.questions.map((question) => ({ code: check.code, kind: check.kind, source: question.source, question }))),
    shape,
    scope: "duplicate",
    context: { checkpoint: "send", action: "send_message", duplicate: context([unseen("It's 42.", 8_000, { eventIds: ["e1", "e1b"] })]) },
    sources: { message: "The answer is 42." },
    thinkingTailTokens: 800,
  };
}

test("checks point: named question ids, the duplicate state, per-question calibration, the judged ids on the row", () => {
  const input = duplicateInput();
  assert.deepEqual(input.items.map((i) => i.id), ["duplicate__answered_already", "duplicate__repeats", "duplicate__contradicts"]);
  const questions = checksPoint.questions(input, SETTINGS);
  assert.equal(
    (questions["duplicate__repeats"] as { instructions: string }).instructions,
    "Most of the information in `draft.text` already appears in one of `earlier[*].text`.",
  );
  assert.deepEqual(Object.keys(checksPoint.state(input, 8000) as object), ["earlier", "draft"]);
  // Calibration: "checks.duplicate.repeats" for one question beats "checks.duplicate" for the check.
  const overrides: Record<string, number> = { "checks.duplicate.repeats": 0.95, "checks.duplicate": 0.5 };
  const threshold = (name: string, value: number) => overrides[`checks.${name}`] ?? value;
  const verdict = checksPoint.resolve(
    { duplicate__answered_already: { type: "noul", noul: 0.6 }, duplicate__repeats: { type: "noul", noul: 0.9 }, duplicate__contradicts: { type: "noul", noul: 0.1 } } as never,
    input,
    threshold,
    SETTINGS,
  )!;
  assert.deepEqual(verdict.results.map((r) => [r.id, r.threshold, r.fired]), [
    ["duplicate__answered_already", 0.5, true],
    ["duplicate__repeats", 0.95, false],
    ["duplicate__contradicts", 0.5, false],
  ]);
  assert.deepEqual(verdict.earlierIds, ["e1", "e1b"]);
  assert.deepEqual((checksPoint.describe(verdict) as { earlier_ids: string[] }).earlier_ids, ["e1", "e1b"]);
});

test("checks point: a judge-only member gets the conversation, with field names rewritten", () => {
  const judgeMember = { logicalId: "judge", config: { decision: { state_shapes: "text_or_conversation", max_questions: 2 } } } as never;
  const plan = planDuplicateCalls(duplicateInput().items, judgeMember);
  assert.deepEqual(plan.map((c) => [c.shape, c.scope, c.items.length]), [["conversation", "duplicate", 2], ["conversation", "duplicate", 1]]);
  assert.deepEqual(planDuplicateCalls(duplicateInput().items, undefined).map((c) => [c.shape, c.items.length]), [["object", 3]]);
  const input = duplicateInput("conversation");
  const q = checksPoint.questions(input, SETTINGS)["duplicate__answered_already"] as { instructions: string };
  assert.equal(q.instructions, "the assistant's output answers a question or request that one of the assistant's earlier messages in the input already answered.");
  const state = checksPoint.state(input, 4000) as { input: unknown[]; output: { content: string } };
  assert.equal(state.output.content, "The answer is 42.");
  assert.equal(state.input.length, 3);
});

test("prior rejections: live-branch check rows where a duplicate check fired, with the ids it judged", () => {
  const rows = [
    { point: "checks", tool_call_id: "c1", branch_no: 0, verdict_json: JSON.stringify({ fired: ["duplicate"], results: [], earlier_ids: ["e1"] }) },
    { point: "checks", tool_call_id: "c2", branch_no: 0, verdict_json: JSON.stringify({ fired: [], results: [], earlier_ids: ["e2"] }) },
    { point: "checks", tool_call_id: "c3", branch_no: 2, verdict_json: JSON.stringify({ fired: ["duplicate"], earlier_ids: ["e3"] }) },
    { point: "checks", tool_call_id: "c4", branch_no: 0, verdict_json: JSON.stringify({ fired: ["style_em_dash"] }) },
    { point: "routing", tool_call_id: "c5", branch_no: 0, verdict_json: JSON.stringify({ fired: ["duplicate"], earlier_ids: ["e5"] }) },
  ];
  assert.deepEqual([...priorDuplicateRejections(rows, new Set(["duplicate"]))], [["c1", ["e1"]]]);
});
