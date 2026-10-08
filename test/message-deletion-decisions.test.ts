/**
 * Deleted messages in the decision points' recent-chat windows (ARCHITECTURE.md
 * §8h): shown as the deletion placeholder, like the recent tiers; the request
 * itself keeps its content (late input decides what belongs to it).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { toTranscriptMessage } from "../src/decisions/transcript.js";
import { routingInputFrom } from "../src/decisions/points/routing.js";
import { lateAdditionInputFrom } from "../src/decisions/points/late-addition.js";
import { implicitReplyInputFrom } from "../src/decisions/points/implicit-reply.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:miku:room:!room";

function ev(id: string, body: string, ts: number, sender = "@bob:x", extra: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: sender, displayName: sender.slice(1, sender.indexOf(":")) },
    body,
    timestamp: ts,
    receivedAt: ts,
    ...extra,
  };
}

const deleted = ev("gone", "secret words", 1_000, "@bob:x", {
  deleted: { at: 2_000, by: "@mod:x" },
  attachments: [{ id: "a", mediaType: "image", caption: "secret caption" }],
});

test("toTranscriptMessage: a window message shows the placeholder; as of a past time, only deletions by then", () => {
  const shown = toTranscriptMessage(deleted, 400, { deletedPlaceholder: true });
  assert.deepEqual(shown, { id: "$gone", from: "bob", text: "[message deleted by @mod:x]" });
  assert.equal(toTranscriptMessage(deleted, 400, { deletedPlaceholder: 2_000 }).text, "[message deleted by @mod:x]");
  const before = toTranscriptMessage(deleted, 400, { deletedPlaceholder: 1_999 });
  assert.equal(before.text, "secret words", "deleted after that moment: shown as it was");
  assert.equal(toTranscriptMessage(deleted, 400).text, "secret words", "without the option: the stored content");
  const own = ev("own", "mine", 1_000, "@bob:x", { deleted: { at: 2_000, by: "@bob:x" } });
  assert.equal(toTranscriptMessage(own, 400, { deletedPlaceholder: true }).text, "[message deleted]");
});

test("routing: recent chat and the request's quote show the placeholder", () => {
  const trigger = ev("t", "please help", 3_000, "@alice:x", {
    replyTo: { externalId: "$gone", sender: { id: "@bob:x", displayName: "bob" }, body: "secret words", deleted: { at: 2_000, by: "@mod:x" } },
  });
  const input = routingInputFrom({ trigger, recent: [deleted, ev("x", "hi", 1_500)], listedSkills: [], routing: {} });
  const json = JSON.stringify(input);
  assert.ok(!json.includes("secret"), json);
  assert.equal(input.recent[0]!.text, "[message deleted by @mod:x]");
  assert.equal(input.request.text, "please help");
  assert.equal(input.request.reply_to?.text, "[message deleted by @mod:x]");
});

test("late addition: messages before and between show the placeholder", () => {
  const request = ev("t", "my request", 3_000, "@alice:x");
  const between = ev("b", "secret between", 3_500, "@carol:x", { deleted: { at: 3_600 } });
  const input = lateAdditionInputFrom({
    before: [deleted],
    request: [request],
    between: [between],
    candidate: ev("c", "one more thing", 4_000, "@alice:x"),
  });
  const json = JSON.stringify(input);
  assert.ok(!json.includes("secret"), json);
  assert.equal(input.before[0]!.text, "[message deleted by @mod:x]");
  assert.equal(input.between[0]!.text, "[message deleted]");
});

test("implicit reply: the recent window shows the placeholder", () => {
  const bot = ev("bot", "how can I help?", 1_500, "@miku:x", { role: "assistant" });
  const input = implicitReplyInputFrom({
    recent: [deleted, bot],
    botMessage: bot,
    candidate: ev("c", "thanks", 4_000, "@alice:x"),
  });
  const json = JSON.stringify(input);
  assert.ok(!json.includes("secret"), json);
  assert.equal(input.recent[0]!.text, "[message deleted by @mod:x]");
});
