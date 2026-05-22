import assert from "node:assert/strict";
import test from "node:test";
import { compactTimelineEvents } from "../src/context/index.js";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import type { TimelineCompactionState } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

test("compaction advances rich boundary by event, not same-role turn", () => {
  const events = [
    chatEvent("u1", "user", "x".repeat(420), 1_000),
    chatEvent("u2", "user", "small follow-up", 2_000),
    chatEvent("a1", "assistant", "answer", 3_000),
  ];

  const result = compactTimelineEvents(
    events,
    renderRichMessage,
    renderCompactMessage,
    {
      rich_max_tokens: 100,
      rich_target_tokens: 80,
      compact_max_tokens: 10_000,
      compact_target_tokens: 9_000,
    },
    { timelineKey: "matrix:test:room:!room", now: 123 },
  );

  assert.equal(result.stateChanged, true);
  assert.equal(result.state?.compactStartEventId, "u1");
  assert.equal(result.state?.richStartEventId, "u2");
  assert.deepEqual(
    result.turns.map((turn) => [turn.tier, turn.role, turn.messageIds]),
    [
      ["mixed", "user", ["u1", "u2"]],
      ["rich", "assistant", ["a1"]],
    ],
  );
});

test("compaction state keeps boundaries stable below max threshold", () => {
  const events = [
    chatEvent("u1", "user", "x".repeat(420), 1_000),
    chatEvent("u2", "user", "small follow-up", 2_000),
    chatEvent("a1", "assistant", "answer", 3_000),
    chatEvent("u3", "user", "later", 4_000),
  ];
  const state: TimelineCompactionState = {
    schemaVersion: 1,
    timelineKey: "matrix:test:room:!room",
    compactStartEventId: "u1",
    richStartEventId: "u2",
    updatedAt: 123,
  };

  const result = compactTimelineEvents(
    events,
    renderRichMessage,
    renderCompactMessage,
    {
      rich_max_tokens: 1_000,
      rich_target_tokens: 900,
      compact_max_tokens: 10_000,
      compact_target_tokens: 9_000,
    },
    { timelineKey: "matrix:test:room:!room", state, now: 999 },
  );

  assert.equal(result.stateChanged, false);
  assert.equal(result.state?.compactStartEventId, "u1");
  assert.equal(result.state?.richStartEventId, "u2");
  assert.equal(result.state?.updatedAt, 123);
  assert.deepEqual(result.compactedMessageIds, []);
  assert.deepEqual(result.droppedMessageIds, []);
});

test("compact tier drops by event cursor only after compact max threshold", () => {
  const events = [
    chatEvent("u1", "user", "x".repeat(500), 1_000),
    chatEvent("a1", "assistant", "y".repeat(500), 2_000),
    chatEvent("u2", "user", "z".repeat(500), 3_000),
    chatEvent("a2", "assistant", "fresh", 4_000),
  ];
  const state: TimelineCompactionState = {
    schemaVersion: 1,
    timelineKey: "matrix:test:room:!room",
    compactStartEventId: "u1",
    richStartEventId: "a2",
    updatedAt: 123,
  };

  const result = compactTimelineEvents(
    events,
    renderRichMessage,
    renderCompactMessage,
    {
      rich_max_tokens: 10_000,
      rich_target_tokens: 9_000,
      compact_max_tokens: 180,
      compact_target_tokens: 80,
    },
    { timelineKey: "matrix:test:room:!room", state, now: 999 },
  );

  assert.equal(result.stateChanged, true);
  assert.equal(result.state?.compactStartEventId, "u2");
  assert.equal(result.state?.richStartEventId, "a2");
  assert.deepEqual(result.droppedMessageIds, ["u1", "a1"]);
});

function chatEvent(
  id: string,
  role: CanonicalChatEvent["role"],
  body: string,
  timestamp: number,
): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: "matrix:test:room:!room",
    provider: "matrix",
    role,
    sender: role === "user" ? { id: "@alice:example.org" } : { id: "@miku:example.org", isSelf: true },
    body,
    timestamp,
    receivedAt: timestamp,
  };
}
