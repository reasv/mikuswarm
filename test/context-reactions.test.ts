import assert from "node:assert/strict";
import test from "node:test";
import { compactTimelineEvents } from "../src/context/index.js";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { synthesizeReactionLines } from "../src/context/reactions.js";
import type { DiscreteReactionRow } from "../src/storage/index.js";
import type { CanonicalChatEvent, ReactionAggregate } from "../src/types.js";

const TK = "matrix:test:room:!room";

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
  const lines = synthesizeReactionLines(rows, new Map([["$a1", "a fairly short message body"]]), { nameCap: 8 });
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0].content,
    `<reaction>Fleur, Alice and Bo reacted 👍 to your message [$a1]: "a fairly short message body"</reaction>`,
  );
  // Placement timestamp is the group's most recent reaction.
  assert.equal(lines[0].timestamp, 1200);
});

test("a single sender reads naturally", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderDisplay: "Fleur", display: ":ohman:", kind: "custom", shortcode: ":ohman:" })],
    new Map([["$a1", "hi"]]),
    { nameCap: 8 },
  );
  assert.equal(lines[0].content, `<reaction>Fleur reacted :ohman: to your message [$a1]: "hi"</reaction>`);
});

test("more than the name cap collapses to first 4 + (and N others)", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    discrete({ reactionEventId: `$r${i}`, senderId: `@u${i}:test`, senderDisplay: `U${i}`, reactedAt: 1000 + i }),
  );
  const lines = synthesizeReactionLines(rows, new Map([["$a1", "msg"]]), { nameCap: 8 });
  // First 4 by reacted_at (oldest), then "(and 6 others)" = 10 - 4.
  assert.match(lines[0].content, /^<reaction>U0, U1, U2, U3 \(and 6 others\) reacted/);
});

test("the same sender reacting twice with one key counts once", () => {
  const rows = [
    discrete({ reactionEventId: "$r1", senderId: "@fleur:test", senderDisplay: "Fleur", reactedAt: 1000 }),
    discrete({ reactionEventId: "$r2", senderId: "@fleur:test", senderDisplay: "Fleur", reactedAt: 1100 }),
  ];
  const lines = synthesizeReactionLines(rows, new Map([["$a1", "msg"]]), { nameCap: 8 });
  assert.match(lines[0].content, /^<reaction>Fleur reacted/);
});

test("a long snippet is whitespace-normalized and truncated", () => {
  const body = "line one\n\n   line two with    extra spaces ".concat("x".repeat(100));
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1" })],
    new Map([["$a1", body]]),
    { nameCap: 8 },
  );
  const m = lines[0].content.match(/: "([^"]*)"/);
  assert.ok(m);
  assert.ok(m[1].length <= 80);
  assert.ok(m[1].endsWith("…"));
  assert.doesNotMatch(m[1], /\n/);
});

test("an unresolvable target falls back to the bare event ref with no snippet", () => {
  const lines = synthesizeReactionLines([discrete({ reactionEventId: "$r1" })], new Map(), { nameCap: 8 });
  assert.equal(lines[0].content, `<reaction>Alice reacted 👍 to your message [$a1]</reaction>`);
});

test("falls back to sender id when no display name is known", () => {
  const lines = synthesizeReactionLines(
    [discrete({ reactionEventId: "$r1", senderId: "@nodisplay:test", senderDisplay: null })],
    new Map([["$a1", "msg"]]),
    { nameCap: 8 },
  );
  assert.match(lines[0].content, /^<reaction>@nodisplay:test reacted/);
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
      reactionLines: [{ timestamp: 2000, content: "<reaction>Bo reacted 👍 to your message [$a1]</reaction>" }],
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
        { timestamp: 2000, content: "<reaction>OLD reacted 👍 to your message [$a0]</reaction>" },
        { timestamp: 6000, content: "<reaction>NEW reacted 👍 to your message [$u1]</reaction>" },
      ],
    },
  );
  const all = result.turns.map((t) => t.content).join("\n");
  assert.doesNotMatch(all, /OLD reacted/, "a reaction older than the rich horizon must not render as a line");
  assert.match(all, /NEW reacted/, "a reaction within the rich span must render");
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
