import assert from "node:assert/strict";
import test from "node:test";

import {
  implicitReplyGateEventOf,
  implicitReplyInputFrom,
  implicitReplyKnobs,
  implicitReplyPoint,
  implicitReplyPreGate,
  jsonTokens,
  lateAdditionInputFrom,
  lateAdditionKnobs,
  lateAdditionPoint,
  pointSettings,
  type DecisionAnswers,
  type ImplicitReplyGateEvent,
  type ImplicitReplyInput,
  type LateAdditionInput,
  type PointSettings,
} from "../src/decisions/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// late_addition and implicit_reply points (spec LATE-INPUT §5.2, §6;
// ARCHITECTURE.md §8h): state, questions, resolve, fallback, input builders,
// knobs, the implicit-reply pre-gate.
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;

function ev(id: string, sec: number, from: string, body: string, over: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: "matrix:acc:!room",
    provider: "matrix",
    role: "user",
    sender: { id: `@${from.toLowerCase()}:x`, displayName: from },
    body,
    timestamp: T0 + sec * 1000,
    receivedAt: T0 + sec * 1000,
    ...over,
  };
}

const noul = (id: string, p: number): DecisionAnswers => ({ [id]: { type: "noul", noul: p } });
const plainThreshold = (_name: string, value: number) => value;

function settingsFor(point: "late_addition" | "implicit_reply", raw: Record<string, unknown> = {}): PointSettings {
  return pointSettings({ enabled: true, model: "decider", [point]: { enabled: true, ...raw } } as any, point)!;
}

// --- knobs -----------------------------------------------------------------------

test("knobs: defaults applied, overrides honoured, readable with the point off", () => {
  assert.deepEqual(lateAdditionKnobs({}), {
    threshold: 0.7,
    candidateWindowMs: 60_000,
    maxJudged: 8,
    maxFolded: 3,
    recentMessages: 5,
  });
  assert.deepEqual(lateAdditionKnobs({ late_addition: { enabled: false, candidate_window_ms: 30_000, max_folded: 1 } }), {
    threshold: 0.7,
    candidateWindowMs: 30_000,
    maxJudged: 8,
    maxFolded: 1,
    recentMessages: 5,
  });
  assert.deepEqual(implicitReplyKnobs({}), { threshold: 0.8, maxMessagesAfter: 3, maxAgeMs: 120_000, recentMessages: 6 });
  assert.equal(implicitReplyKnobs({ implicit_reply: { max_age_ms: 5000 } }).maxAgeMs, 5000);
});

// --- late_addition ---------------------------------------------------------------

test("lateAdditionInputFrom: ages relative to the request, merged request, attachments, image refs", () => {
  const before = [
    ev("b0", -100, "Carol", "old"),
    ev("b1", -60, "Bob", "morning"),
    ev("b2", -40, "Bot", "hi all", { role: "assistant" }),
    ev("b3", -5, "Dave", "lol", { sender: { id: "@self:x", displayName: "Bot" } }),
  ];
  const request = [
    ev("r2", 1, "Alice", "this one", {
      attachments: [{ id: "att-r", mediaType: "image", localPath: "/m/r.jpg", caption: "a tabby cat" }],
    }),
    ev("r1", 0, "Alice", "what breed is   this?"),
  ];
  const between = [ev("x1", 7, "Bob", "cute")];
  const candidate = ev("c", 13, "Alice", "", {
    attachments: [
      { id: "att-c", mediaType: "image", localPath: "/m/c.jpg", mimeType: "image/jpeg" },
      { id: "att-f", mediaType: "file", filename: "notes.txt" },
    ],
  });
  const input = lateAdditionInputFrom({
    before,
    request,
    between,
    candidate,
    selfIds: new Set(["@self:x"]),
    recentMessages: 3,
  });
  assert.deepEqual(input.before, [
    { from: "Bob", text: "morning", age: "1m before" },
    { from: "Bot", text: "hi all", age: "40s before", self: true },
    { from: "Bot", text: "lol", age: "5s before", self: true },
  ]);
  assert.deepEqual(input.request, {
    from: "Alice",
    text: "what breed is this? this one",
    attachments: [{ kind: "image", caption: "a tabby cat", imageRefId: "att-r" }],
  });
  assert.deepEqual(input.between, [{ from: "Bob", text: "cute", age: "6s after request" }]);
  assert.deepEqual(input.message, {
    from: "Alice",
    text: "",
    attachments: [
      { kind: "image", caption: null, imageRefId: "att-c" },
      { kind: "file", caption: null },
    ],
    age: "12s after request",
  });
  assert.deepEqual(input.images, [
    { id: "att-c", messageId: "$c", from: "Alice", localPath: "/m/c.jpg", mimeType: "image/jpeg" },
    { id: "att-r", messageId: "$r2", from: "Alice", caption: "a tabby cat", localPath: "/m/r.jpg" },
  ]);
});

test("lateAdditionInputFrom: texts are clipped", () => {
  const long = "word ".repeat(1000);
  const input = lateAdditionInputFrom({
    before: [ev("b", -1, "Bob", long)],
    request: [ev("r", 0, "Alice", long)],
    between: [],
    candidate: ev("c", 2, "Alice", long),
  });
  assert.ok(Array.from(input.before[0]!.text).length <= 400);
  assert.ok(Array.from(input.request.text).length <= 1200);
  assert.ok(Array.from(input.message.text).length <= 1200);
  assert.ok(input.message.text.endsWith("…"));
});

function lateInput(over: Partial<LateAdditionInput> = {}): LateAdditionInput {
  return {
    before: [{ from: "Bob", text: "nice", age: "40s before" }],
    request: { from: "Alice", text: "what breed is this?", attachments: [] },
    between: [{ from: "Bob", text: "?", age: "6s after request" }],
    message: {
      from: "Alice",
      text: "",
      age: "12s after request",
      attachments: [{ kind: "image", caption: null, imageRefId: "img" }],
    },
    images: [{ id: "img", messageId: "$c", from: "Alice", localPath: "/m/c.jpg" }],
    ...over,
  };
}

test("late_addition state: the spec's shape; captions only; image label on a vision attempt", () => {
  const state = lateAdditionPoint.state(lateInput(), 4000) as any;
  assert.deepEqual(Object.keys(state), ["before", "request", "between", "message"]);
  assert.deepEqual(state.message, {
    from: "Alice",
    text: "",
    attachments: [{ kind: "image", caption: null }],
    age: "12s after request",
  });
  assert.ok(!JSON.stringify(state).match(/bot|assistant|addressed/i), "nothing implies the bot is addressed");
  const vision = lateAdditionPoint.state(lateInput(), 4000, { imageLabels: new Map([["img", "image 1"]]) }) as any;
  assert.deepEqual(vision.message.attachments, [{ kind: "image", image: "image 1", caption: null }]);
  assert.deepEqual(lateAdditionPoint.images!(lateInput()), lateInput().images);
});

test("late_addition state: packing drops context before the request first, then counts dropped between messages", () => {
  const chat = (n: number, age: string) =>
    Array.from({ length: n }, (_, i) => ({ from: "Bob", text: `message number ${i} ${"x".repeat(200)}`, age }));
  const input = lateInput({ before: chat(10, "1m before"), between: chat(10, "5s after request") });
  const full = jsonTokens(lateAdditionPoint.state(input, 1e9));
  const noBefore = jsonTokens({ ...(lateAdditionPoint.state(input, 1e9) as any), before: [] });
  const s1 = lateAdditionPoint.state(input, noBefore + 80) as any;
  assert.ok(s1.before.length > 0 && s1.before.length < 10);
  assert.equal(s1.before.at(-1).text, input.before.at(-1)!.text, "newest kept");
  assert.equal(s1.between.length, 10);
  assert.ok(jsonTokens(s1) <= noBefore + 80);
  const s2 = lateAdditionPoint.state(input, Math.floor(noBefore / 2)) as any;
  assert.equal(s2.before.length, 0);
  assert.ok(s2.between.length < 10);
  assert.equal(s2.between_omitted, 10 - s2.between.length);
  assert.equal(s2.between.at(-1).text, input.between.at(-1)!.text);
  assert.ok(full > noBefore);
});

test("late_addition questions, resolve with threshold and calibration, fallback not judged", () => {
  const settings = settingsFor("late_addition");
  const q = lateAdditionPoint.questions(lateInput(), settings);
  assert.deepEqual(Object.keys(q), ["belongs"]);
  assert.equal(q.belongs!.type, "noul");
  assert.match(String(q.belongs!.instructions), /`message` supplies something `request` refers to or expects/);
  assert.doesNotMatch(String(q.belongs!.instructions), /image/);
  assert.match(String(lateAdditionPoint.questions(lateInput(), settings, { vision: true }).belongs!.instructions), /label/);

  assert.deepEqual(lateAdditionPoint.resolve(noul("belongs", 0.7), lateInput(), plainThreshold, settings), {
    belongs: true,
    probability: 0.7,
    judged: true,
  });
  assert.equal(lateAdditionPoint.resolve(noul("belongs", 0.69), lateInput(), plainThreshold, settings)!.belongs, false);
  const strict = settingsFor("late_addition", { threshold: 0.9 });
  assert.equal(lateAdditionPoint.resolve(noul("belongs", 0.8), lateInput(), plainThreshold, strict)!.belongs, false);
  const calibrated = (name: string, value: number) => (name === "threshold" ? 0.5 : value);
  assert.equal(lateAdditionPoint.resolve(noul("belongs", 0.6), lateInput(), calibrated, settings)!.belongs, true);
  assert.equal(lateAdditionPoint.resolve({}, lateInput(), plainThreshold, settings), null);
  assert.deepEqual(lateAdditionPoint.fallback(lateInput()), { belongs: false, probability: null, judged: false });
  assert.deepEqual(lateAdditionPoint.describe({ belongs: true, probability: 0.71234, judged: true }), {
    belongs: true,
    judged: true,
    probability: 0.712,
  });
});

// --- implicit_reply --------------------------------------------------------------

test("implicitReplyInputFrom: M marked, context before M bounded, ages, candidate excluded", () => {
  const recent = [
    ev("a", 0, "Carol", "one"),
    ev("b", 10, "Dave", "two"),
    ev("c", 20, "Erin", "three"),
    ev("m", 30, "Bot", "it is 20 degrees", { role: "assistant" }),
    ev("d", 40, "Bob", "nice"),
  ];
  const candidate = ev("x", 50, "Alice", "thanks!");
  const input = implicitReplyInputFrom({
    recent: [...recent, candidate],
    botMessage: recent[3]!,
    candidate,
    recentMessages: 2,
  });
  assert.deepEqual(input.recent, [
    { from: "Dave", text: "two", age: "40s ago" },
    { from: "Erin", text: "three", age: "30s ago" },
    { from: "Bot", text: "it is 20 degrees", age: "20s ago", self: true, bot_message: true },
    { from: "Bob", text: "nice", age: "10s ago" },
  ]);
  assert.deepEqual(input.message, { from: "Alice", text: "thanks!", age: "0s ago" });
  assert.equal(input.botMessageId, "$m");

  const missing = implicitReplyInputFrom({ recent: [recent[0]!, recent[4]!], botMessage: recent[3]!, candidate });
  assert.deepEqual(missing.recent.map((m) => m.text), ["one", "it is 20 degrees", "nice"], "M inserted by time");
});

function replyInput(): ImplicitReplyInput {
  return {
    recent: [
      { from: "Carol", text: "x ".repeat(300), age: "2m ago" },
      { from: "Bot", text: "it is 20 degrees", age: "40s ago", self: true, bot_message: true },
      { from: "Bob", text: "ok", age: "20s ago" },
    ],
    message: { from: "Alice", text: "and tomorrow?", age: "0s ago" },
    botMessageId: "$m",
  };
}

test("implicit_reply state: continuous suffix from M kept; context before M dropped first; unfit suffix throws", () => {
  const input = replyInput();
  const full = implicitReplyPoint.state(input, 1e9) as any;
  assert.deepEqual(Object.keys(full), ["recent_chat", "message"]);
  assert.equal(full.recent_chat.length, 3);
  const suffixTokens = jsonTokens({ recent_chat: input.recent.slice(1), message: input.message });
  const tight = implicitReplyPoint.state(input, suffixTokens + 5) as any;
  assert.deepEqual(tight.recent_chat.map((m: any) => m.text), ["it is 20 degrees", "ok"]);
  assert.throws(() => implicitReplyPoint.state(input, suffixTokens - 5), /implicit_reply_bot_message_outside_budget/);
  assert.equal(implicitReplyPoint.images, undefined, "text judgement");
});

test("implicit_reply questions, resolve, fallback (inert)", () => {
  const settings = settingsFor("implicit_reply");
  const q = implicitReplyPoint.questions(replyInput(), settings);
  assert.deepEqual(Object.keys(q), ["replies"]);
  assert.match(String(q.replies!.instructions), /`message` responds to the message marked `bot_message`/);
  assert.deepEqual(implicitReplyPoint.resolve(noul("replies", 0.8), replyInput(), plainThreshold, settings), {
    replies: true,
    probability: 0.8,
    judged: true,
    botMessageId: "$m",
  });
  assert.equal(implicitReplyPoint.resolve(noul("replies", 0.79), replyInput(), plainThreshold, settings)!.replies, false);
  assert.equal(implicitReplyPoint.resolve({}, replyInput(), plainThreshold, settings), null);
  assert.deepEqual(implicitReplyPoint.fallback(replyInput()), {
    replies: false,
    probability: null,
    judged: false,
    botMessageId: "$m",
  });
  assert.equal(settings.vision, undefined);
});

// --- pre-gate ----------------------------------------------------------------------

const human = (id: string, sec: number): ImplicitReplyGateEvent => ({ id, timestamp: T0 + sec * 1000, author: "human" });
const self = (id: string, sec: number): ImplicitReplyGateEvent => ({ id, timestamp: T0 + sec * 1000, author: "self" });
const bot = (id: string, sec: number): ImplicitReplyGateEvent => ({ id, timestamp: T0 + sec * 1000, author: "bot" });

function gate(preceding: ImplicitReplyGateEvent[], sec: number, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  return implicitReplyPreGate({
    isGroup: true,
    candidate: { ...human("cand", sec), hasReply: false, mentionsBot: false, hasTrigger: false, ...over } as any,
    preceding,
    maxMessagesAfter: 3,
    maxAgeMs: 120_000,
    ...input,
  });
}

test("implicitReplyPreGate: message and age bounds", () => {
  assert.deepEqual(gate([human("h0", 0), self("m", 10)], 20), { eligible: true, botMessageIds: ["m"] });
  assert.deepEqual(gate([self("m", 10), human("a", 11), human("b", 12)], 20).botMessageIds, ["m"], "3rd message after M");
  assert.deepEqual(
    gate([self("m", 10), human("a", 11), human("b", 12), human("c", 13)], 20),
    { eligible: false, reason: "no_bot_message", botMessageIds: [] },
    "4th message after M",
  );
  assert.equal(gate([self("m", 0)], 120).eligible, true, "exactly max_age_ms");
  assert.equal(gate([self("m", 0)], 121).eligible, false, "older than max_age_ms");
});

test("implicitReplyPreGate: another bot's message in between blocks; several own messages each evaluated", () => {
  assert.equal(gate([self("m", 10), bot("sib", 12)], 20).eligible, false);
  assert.deepEqual(gate([self("m1", 10), self("m2", 11), human("a", 12)], 20).botMessageIds, ["m2", "m1"]);
  assert.deepEqual(gate([self("m1", 10), bot("sib", 11), self("m2", 12)], 20).botMessageIds, ["m2"]);
  assert.equal(gate([human("a", 10)], 20).eligible, false);
});

test("implicitReplyPreGate: candidate disqualifiers", () => {
  const pre = [self("m", 10)];
  assert.equal((gate(pre, 20, {}, { isGroup: false }) as any).reason, "not_group");
  assert.equal((gate(pre, 20, { author: "bot" }) as any).reason, "not_human");
  assert.equal((gate(pre, 20, { author: "self" }) as any).reason, "not_human");
  assert.equal((gate(pre, 20, { hasReply: true }) as any).reason, "has_reply");
  assert.equal((gate(pre, 20, { mentionsBot: true }) as any).reason, "mentions_bot");
  assert.equal((gate(pre, 20, { hasTrigger: true }) as any).reason, "has_trigger");
  assert.equal((gate(pre, 20, { consumed: true }) as any).reason, "consumed");
});

test("implicitReplyGateEventOf: self, other bots (siblings first), webhooks are human", () => {
  const ids = { selfIds: new Set(["@me:x"]), otherBotIds: new Set(["@sib:x"]) };
  assert.equal(implicitReplyGateEventOf(ev("a", 0, "Me", "x", { sender: { id: "@me:x" } }), ids).author, "self");
  assert.equal(implicitReplyGateEventOf(ev("a", 0, "Bot", "x", { role: "assistant" }), ids).author, "self");
  assert.equal(implicitReplyGateEventOf(ev("a", 0, "Sib", "x", { role: "assistant", sender: { id: "@sib:x" } }), ids).author, "bot");
  assert.equal(implicitReplyGateEventOf(ev("a", 0, "B", "x", { sender: { id: "b", isBot: true } }), ids).author, "bot");
  assert.equal(
    implicitReplyGateEventOf(ev("a", 0, "W", "x", { sender: { id: "w", isBot: true, isWebhook: true } }), ids).author,
    "human",
  );
  assert.equal(implicitReplyGateEventOf(ev("a", 0, "Alice", "x"), ids).author, "human");
});
