import assert from "node:assert/strict";
import test from "node:test";
import { compactTimelineEvents } from "../src/context/index.js";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { synthesizeReactionLines, type ReactionTarget } from "../src/context/reactions.js";
import type { DiscreteReactionRow } from "../src/storage/index.js";
import type { CanonicalChatEvent, ReactionAggregate } from "../src/types.js";

const TK = "matrix:test:room:!room";

/** A self (assistant-owned) target map for a single message, the common case. */
function selfTarget(eventId: string, body: string): Map<string, ReactionTarget> {
  return new Map([[eventId, { body, self: true }]]);
}

function chatEvent(
  id: string,
  role: CanonicalChatEvent["role"],
  body: string,
  timestamp: number,
  reactions?: ReactionAggregate[],
): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: TK,
    provider: "matrix",
    role,
    sender: role === "user" ? { id: "@alice:example.org" } : { id: "@miku:example.org", isSelf: true },
    body,
    timestamp,
    receivedAt: timestamp,
    ...(reactions ? { reactions } : {}),
  };
}

function discrete(over: Partial<DiscreteReactionRow> & { reactionEventId: string }): DiscreteReactionRow {
  return {
    targetEventId: "$a1",
    timelineKey: "matrix:main:room:!room:test",
    senderId: "@alice:test",
    senderDisplay: "Alice",
    normalizedKey: "👍",
    kind: "unicode",
    display: "👍",
    shortcode: null,
    reactedAt: 1000,
    ...over,
  };
}

// --- View A: renderer ---

test("renderRichMessage emits a <reactions> line; renderCompactMessage omits it", () => {
  const event = chatEvent("a1", "assistant", "hello", 1000, [
    { normalizedKey: "👍", kind: "unicode", display: "👍", count: 3 },
    { normalizedKey: "mxc://x/blob", kind: "custom", display: ":blobwave:", shortcode: ":blobwave:", count: 1 },
    { normalizedKey: "😮", kind: "unicode", display: "😮", count: 1 },
  ]);
  const rich = renderRichMessage(event);
  assert.match(rich, /<reactions>👍×3 :blobwave:×1 😮×1<\/reactions>/);
  // Sits inside the message envelope.
  assert.match(rich, /<message[^>]*>[\s\S]*<reactions>[\s\S]*<\/message>/);

  const compact = renderCompactMessage(event);
  assert.doesNotMatch(compact, /reactions/);
});

test("a message with no reactions renders no <reactions> line", () => {
  const rich = renderRichMessage(chatEvent("a1", "assistant", "hello", 1000));
  assert.doesNotMatch(rich, /<reactions>/);
});

// --- View B: synthesize lines ---

test("coalesces reactions per (target, key) and lists senders with the message snippet", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@fleur:test", senderDisplay: "Fleur", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@alice:test", senderDisplay: "Alice", reactedAt: 1100 }),
    discrete({ reactionEventId: "$r3", senderId: "@bo:test", senderDisplay: "Bo", reactedAt: 1200 }),
  ];
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "a fairly short message body"), { nameCap: 8 });
  assert.equal(lines.length, 1);
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present.
  assert.equal(
    lines[0].content,
    `<reaction>Fleur, Alice and Bo reacted 👍 to your message: "a fairly short message body"</reaction>`,
  );
  // Placement timestamp is the group's most recent reaction.
  assert.equal(lines[0].timestamp, 1200);
});

test("a single sender reads naturally", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderDisplay: "Fleur", display: ":ohman:", kind: "custom", shortcode: ":ohman:" })],
    selfTarget("$a1", "hi"),
    { nameCap: 8 },
  );
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present.
  assert.equal(lines[0].content, `<reaction>Fleur reacted :ohman: to your message: "hi"</reaction>`);
});

test("more than the name cap collapses to first 4 + (and N others)", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    discrete({ reactionEventId: `$r${i}`, senderId: `@u${i}:test`, senderDisplay: `U${i}`, reactedAt: 1000 + i }),
  );
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), { nameCap: 8 });
  // First 4 by reacted_at (oldest), then "(and 6 others)" = 10 - 4.
  assert.match(lines[0].content, /^<reaction>U0, U1, U2, U3 \(and 6 others\) reacted/);
});

test("the same sender reacting twice with one key counts once", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@fleur:test", senderDisplay: "Fleur", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@fleur:test", senderDisplay: "Fleur", reactedAt: 1100 }),
  ];
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), { nameCap: 8 });
  assert.match(lines[0].content, /^<reaction>Fleur reacted/);
});

test("a long snippet is whitespace-normalized and truncated", () => {
  const body = "line one\n\n   line two with    extra spaces ".concat("x".repeat(100));
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1" })],
    selfTarget("$a1", body),
    { nameCap: 8 },
  );
  const m = lines[0].content.match(/: "([^"]*)"/);
  assert.ok(m);
  assert.ok(m[1].length <= 80);
  assert.ok(m[1].endsWith("…"));
  assert.doesNotMatch(m[1], /\n/);
});

test("snippet truncation never splits an emoji surrogate pair", () => {
  // Emoji straddles the 80th code point; truncation must keep it whole.
  const body = "x".repeat(78) + "😀" + "y".repeat(40);
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1" })],
    selfTarget("$a1", body),
    { nameCap: 8 },
  );
  const snippet = lines[0].content.match(/: "([^"]*)"/)![1];
  assert.ok(snippet.includes("😀"), "the emoji must survive truncation intact");
  // No lone surrogate: re-encoding round-trips cleanly.
  assert.equal([...snippet].some((c) => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff), false);
});

test("an unresolvable target falls back to the bare event ref with no snippet", () => {
  const lines = synthesizeReactionLines([discrete({ reactionEventId: "$r1" })], new Map(), { nameCap: 8 });
  assert.equal(lines[0].content, `<reaction>Alice reacted 👍 to a message [$a1]</reaction>`);
});

test("a non-self target reads \"<author>'s message\" (discrete_assistant_only = false)", () => {
  const target = new Map<string, ReactionTarget>([
    ["$u9", { body: "someone else said this", self: false, authorDisplay: "Bob" }],
  ]);
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", targetEventId: "$u9", senderDisplay: "Fleur" })],
    target,
    { nameCap: 8 },
  );
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present.
  assert.equal(
    lines[0].content,
    `<reaction>Fleur reacted 👍 to Bob's message: "someone else said this"</reaction>`,
  );
});

test("a non-self target with no known author reads \"a message\"", () => {
  const target = new Map<string, ReactionTarget>([["$u9", { body: "hi", self: false }]]);
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", targetEventId: "$u9" })],
    target,
    { nameCap: 8 },
  );
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present; snippet is "hi".
  assert.match(lines[0].content, /to a message: "hi"/);
});

test("synthesized lines carry the target's self flag", () => {
  const targets = new Map<string, ReactionTarget>([
    ["$a1", { body: "mine", self: true }],
    ["$u9", { body: "theirs", self: false, authorDisplay: "Bob" }],
  ]);
  const rows = [
    discrete({ reactionEventId: "$r1", targetEventId: "$a1", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", targetEventId: "$u9", reactedAt: 2000 }),
  ];
  const lines = synthesizeReactionLines(rows, targets, { nameCap: 8 });
  assert.deepEqual(
    lines.map((l) => l.self),
    [true, false],
  );
});

test("a high-participation NON-self reaction stays a single coalesced line", () => {
  // Coalescing + name cap already bound a pile-on to one line (first 4 + others),
  // so no participation ceiling is needed — there is exactly one discrete line.
  const target = new Map<string, ReactionTarget>([["$u9", { body: "hot take", self: false, authorDisplay: "Bob" }]]);
  const rows = Array.from({ length: 10 }, (_, i) =>
    discrete({ reactionEventId: `$r${i}`, targetEventId: "$u9", senderId: `@u${i}:test`, senderDisplay: `U${i}`, reactedAt: 1000 + i }),
  );
  const lines = synthesizeReactionLines(rows, target, { nameCap: 8 });
  assert.equal(lines.length, 1);
  assert.match(lines[0].content, /^<reaction>U0, U1, U2, U3 \(and 6 others\) reacted 👍 to Bob's message/);
});

test("falls back to sender id when no display name is known", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderId: "@nodisplay:test", senderDisplay: null })],
    selfTarget("$a1", "msg"),
    { nameCap: 8 },
  );
  assert.match(lines[0].content, /^<reaction>@nodisplay:test reacted/);
});

test("a self-reactor renders as \"You\" (§9f View B polish)", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderId: "@miku:example.org", senderDisplay: "Miku" })],
    selfTarget("$a1", "hi"),
    { nameCap: 8, selfUserId: "@miku:example.org" },
  );
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present.
  assert.equal(lines[0].content, `<reaction>You reacted 👍 to your message: "hi"</reaction>`);
});

test("a non-self reactor still renders its display name when selfUserId is set", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderId: "@alice:test", senderDisplay: "Alice" })],
    selfTarget("$a1", "hi"),
    { nameCap: 8, selfUserId: "@miku:example.org" },
  );
  assert.match(lines[0].content, /^<reaction>Alice reacted/);
});

test("mixed self + others: \"You\" composes with correct grammar", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@miku:example.org", senderDisplay: "Miku", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@alice:test", senderDisplay: "Alice", reactedAt: 1100 }),
  ];
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "hi"), {
    nameCap: 8,
    selfUserId: "@miku:example.org",
  });
  // audit §3.4 finding 12: [id] bracket omitted when snippet is present.
  assert.equal(lines[0].content, `<reaction>You and Alice reacted 👍 to your message: "hi"</reaction>`);
});

test("without selfUserId, a self-reactor falls back to its display name (no crash)", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderId: "@miku:example.org", senderDisplay: "Miku" })],
    selfTarget("$a1", "hi"),
    { nameCap: 8 },
  );
  assert.match(lines[0].content, /^<reaction>Miku reacted/);
});

test("multiple groups render in deterministic timestamp order across repeated calls", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", targetEventId: "$a1", normalizedKey: "👍", display: "👍", reactedAt: 3000 }),
    discrete({ reactionEventId: "$r2", targetEventId: "$a1", normalizedKey: "😮", display: "😮", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r3", targetEventId: "$a2", normalizedKey: "👍", display: "👍", reactedAt: 2000 }),
  ];
  const targets = new Map<string, ReactionTarget>([
    ["$a1", { body: "one", self: true }],
    ["$a2", { body: "two", self: true }],
  ]);
  const first = synthesizeReactionLines(rows, targets, { nameCap: 8 });
  const second = synthesizeReactionLines(rows, targets, { nameCap: 8 });
  // Same input → identical output (deterministic-render invariant, §9).
  assert.deepEqual(first, second);
  // Ordered by the group's most recent reaction timestamp.
  assert.deepEqual(
    first.map((l) => l.timestamp),
    [1000, 2000, 3000],
  );
});

// --- View B: episode splitting ---

const SPLIT = { splitMessages: 5, splitGapMs: 30 * 60_000 };

test("a (target,key) splits across a message seam into one line per episode", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 5000 }),
  ];
  // 5 messages strictly between the two reactions → hard seam → two lines.
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), {
    nameCap: 8,
    messageTimestamps: [1500, 2000, 2500, 3000, 3500],
    ...SPLIT,
  });
  assert.equal(lines.length, 2);
  // Each episode is placed at its own latest reaction (not both at the later one).
  assert.deepEqual(
    lines.map((l) => l.timestamp),
    [1000, 5000],
  );
  assert.match(lines[0].content, /^<reaction>Aa reacted/);
  assert.match(lines[1].content, /^<reaction>Bb reacted/);
});

test("no messages between two reactions → always coalesced, however large the time gap", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 9_000_000 }),
  ];
  // Splitting enabled (non-empty timestamps), but the only message predates both
  // reactions → 0 strictly between → never split despite the huge gap.
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), {
    nameCap: 8,
    messageTimestamps: [500],
    splitMessages: 5,
    splitGapMs: 1,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0].content, /Aa and Bb reacted/);
});

test("1..N-1 messages between → split only when the time gap exceeds the threshold", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 5000 }),
  ];
  // 1 message between (below the seam of 5); gap 4000ms > 1000ms threshold → split.
  const split = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), {
    nameCap: 8,
    messageTimestamps: [2000],
    splitMessages: 5,
    splitGapMs: 1000,
  });
  assert.equal(split.length, 2);
  // Same shape but the reactions are close in time (gap 500ms ≤ 1000ms) → coalesced.
  const closeRows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 1500 }),
  ];
  const merged = synthesizeReactionLines(closeRows, selfTarget("$a1", "msg"), {
    nameCap: 8,
    messageTimestamps: [1200],
    splitMessages: 5,
    splitGapMs: 1000,
  });
  assert.equal(merged.length, 1);
});

test("a time gap exactly equal to the threshold coalesces (the seam is strictly >)", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 2000 }),
  ];
  // 1 message between (below the seam of 5); gap is exactly 1000ms === the threshold.
  // The rule is "split only when the gap *exceeds* the threshold", so == coalesces.
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), {
    nameCap: 8,
    messageTimestamps: [1500],
    splitMessages: 5,
    splitGapMs: 1000,
  });
  assert.equal(lines.length, 1, "gap == splitGapMs is not a seam (strict greater-than)");
  assert.match(lines[0].content, /Aa and Bb reacted/);
});

test("without messageTimestamps, splitting is off (legacy single-line behavior)", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@a:test", senderDisplay: "Aa", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@b:test", senderDisplay: "Bb", reactedAt: 9_000_000 }),
  ];
  const lines = synthesizeReactionLines(rows, selfTarget("$a1", "msg"), { nameCap: 8 });
  assert.equal(lines.length, 1);
});

// --- View B integration: compaction interleaving ---

test("reaction lines interleave chronologically into the rich tier", () => {
  const events = [
    chatEvent("a1", "assistant", "first", 1000),
    chatEvent("u1", "user", "reply", 3000),
  ];
  const result = compactTimelineEvents(
    events,
    renderRichMessage,
    renderCompactMessage,
    { rich_max_tokens: 10_000, rich_target_tokens: 9_000, compact_max_tokens: 10_000, compact_target_tokens: 9_000 },
    {
      timelineKey: TK,
      now: 1,
      // A reaction at t=2000 lands between the two messages.
      reactionLines: [{ timestamp: 2000, self: true, content: "<reaction>Bo reacted 👍 to your message [$a1]</reaction>" }],
    },
  );
  // The reaction (user role) merges with the later user turn; the assistant turn
  // stays separate and first.
  assert.deepEqual(
    result.turns.map((t) => t.role),
    ["assistant", "user"],
  );
  const userTurn = result.turns[1];
  assert.match(userTurn.content, /<reaction>Bo reacted 👍 to your message \[\$a1\]<\/reaction>[\s\S]*reply/);
});

test("reaction lines before the rich horizon are dropped (View A still has the count)", () => {
  const events = [
    chatEvent("a0", "assistant", "x".repeat(600), 1000), // forced into compact tier
    chatEvent("u1", "user", "recent", 5000),
  ];
  const result = compactTimelineEvents(
    events,
    renderRichMessage,
    renderCompactMessage,
    // Tight rich budget so a0 is compacted and the rich horizon starts at u1 (t=5000).
    { rich_max_tokens: 30, rich_target_tokens: 20, compact_max_tokens: 10_000, compact_target_tokens: 9_000 },
    {
      timelineKey: TK,
      now: 1,
      reactionLines: [
        { timestamp: 2000, self: true, content: "<reaction>OLD reacted 👍 to your message [$a0]</reaction>" },
        { timestamp: 6000, self: true, content: "<reaction>NEW reacted 👍 to your message [$u1]</reaction>" },
      ],
    },
  );
  const all = result.turns.map((t) => t.content).join("\n");
  assert.doesNotMatch(all, /OLD reacted/, "a reaction older than the rich horizon must not render as a line");
  assert.match(all, /NEW reacted/, "a reaction within the rich span must render");
});

test("discreteHorizonMessages restricts lines to the last N rich messages", () => {
  // Four rich messages at t=1000,2000,3000,4000. With horizon=2, only reactions
  // at/after the 3rd-from-... i.e. the last 2 messages' span (>= t=3000) render.
  const events = [
    chatEvent("a1", "assistant", "m1", 1000),
    chatEvent("a2", "assistant", "m2", 2000),
    chatEvent("a3", "assistant", "m3", 3000),
    chatEvent("a4", "assistant", "m4", 4000),
  ];
  const opts = { rich_max_tokens: 10_000, rich_target_tokens: 9_000, compact_max_tokens: 10_000, compact_target_tokens: 9_000 };
  const result = compactTimelineEvents(events, renderRichMessage, renderCompactMessage, opts, {
    timelineKey: TK,
    now: 1,
    discreteHorizonMessages: 2,
    reactionLines: [
      { timestamp: 2500, self: true, content: "<reaction>OLD reacted 👍 to your message [$a2]</reaction>" },
      { timestamp: 3500, self: true, content: "<reaction>NEW reacted 👍 to your message [$a3]</reaction>" },
    ],
  });
  const all = result.turns.map((t) => t.content).join("\n");
  assert.doesNotMatch(all, /OLD reacted/, "a reaction before the last-2-message span is excluded");
  assert.match(all, /NEW reacted/, "a reaction within the last-2-message span renders");
});

test("discreteOtherHorizonMessages clamps non-self lines tighter than self lines", () => {
  // Four rich messages at t=1000..4000. Self horizon = whole tier (0); non-self
  // horizon = last 1 message (>= t=4000). A self and a non-self line both at
  // t=2500: the self one survives, the non-self one is dropped.
  const events = [
    chatEvent("a1", "assistant", "m1", 1000),
    chatEvent("a2", "assistant", "m2", 2000),
    chatEvent("a3", "assistant", "m3", 3000),
    chatEvent("a4", "assistant", "m4", 4000),
  ];
  const opts = { rich_max_tokens: 10_000, rich_target_tokens: 9_000, compact_max_tokens: 10_000, compact_target_tokens: 9_000 };
  const result = compactTimelineEvents(events, renderRichMessage, renderCompactMessage, opts, {
    timelineKey: TK,
    now: 1,
    discreteHorizonMessages: 0,
    discreteOtherHorizonMessages: 1,
    reactionLines: [
      { timestamp: 2500, self: true, content: "<reaction>SELFLINE reacted 👍 to your message [$a2]</reaction>" },
      { timestamp: 2500, self: false, content: "<reaction>OTHERLINE reacted 👍 to Bob's message [$a2]</reaction>" },
    ],
  });
  const all = result.turns.map((t) => t.content).join("\n");
  assert.match(all, /SELFLINE reacted/, "the self line is within the whole-tier self horizon");
  assert.doesNotMatch(all, /OTHERLINE reacted/, "the non-self line is before the tighter inter-user horizon");
});

test("an unset discreteOtherHorizonMessages makes non-self lines inherit discreteHorizonMessages (§9f)", () => {
  // Production passes the knob through unresolved (builder.ts), so "unset" must fall
  // back to the self horizon — NOT a hardcoded literal. Here the self horizon is the
  // last-1-message span (>= t=4000); with the field omitted the non-self line shares
  // it and a t=2500 non-self line is dropped exactly like the self one would be.
  const events = [
    chatEvent("a1", "assistant", "m1", 1000),
    chatEvent("a2", "assistant", "m2", 2000),
    chatEvent("a3", "assistant", "m3", 3000),
    chatEvent("a4", "assistant", "m4", 4000),
  ];
  const opts = { rich_max_tokens: 10_000, rich_target_tokens: 9_000, compact_max_tokens: 10_000, compact_target_tokens: 9_000 };
  const result = compactTimelineEvents(events, renderRichMessage, renderCompactMessage, opts, {
    timelineKey: TK,
    now: 1,
    discreteHorizonMessages: 1,
    // discreteOtherHorizonMessages intentionally omitted → inherits the above.
    reactionLines: [
      { timestamp: 2500, self: false, content: "<reaction>OTHEROLD reacted 👍 to Bob's message [$a2]</reaction>" },
      { timestamp: 4500, self: false, content: "<reaction>OTHERNEW reacted 👍 to Bob's message [$a4]</reaction>" },
    ],
  });
  const all = result.turns.map((t) => t.content).join("\n");
  assert.doesNotMatch(all, /OTHEROLD reacted/, "before the inherited last-1-message horizon → dropped");
  assert.match(all, /OTHERNEW reacted/, "within the inherited horizon → renders");
});

test("with no reaction lines, compaction output is unchanged", () => {
  const events = [chatEvent("a1", "assistant", "hi", 1000), chatEvent("u1", "user", "yo", 2000)];
  const opts = { rich_max_tokens: 10_000, rich_target_tokens: 9_000, compact_max_tokens: 10_000, compact_target_tokens: 9_000 };
  const withNone = compactTimelineEvents(events, renderRichMessage, renderCompactMessage, opts, { timelineKey: TK, now: 1 });
  assert.deepEqual(
    withNone.turns.map((t) => [t.role, t.tier, t.messageIds]),
    [
      ["assistant", "rich", ["a1"]],
      ["user", "rich", ["u1"]],
    ],
  );
});
