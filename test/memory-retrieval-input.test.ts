/**
 * The pipeline input built at launch (ARCHITECTURE.md §9d "Judged retrieval"):
 * request text, reply target, participants, active people, the conversation
 * with deletion placeholders; and the build's bounded wait on the plan.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanInput } from "../src/retrieval/auto/input.js";
import { awaitPlan } from "../src/context/auto-retrieval.js";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:acc:!room";

function ev(id: string, sender: string, body: string, ts: number, extra: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
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

test("buildPlanInput: request, reply target, participants, active people, deleted placeholders", () => {
  const recent = [
    ev("r1", "@dave:x", "dave was here", 1),
    ev("r2", "@erin:x", "secret", 2, { deleted: { at: 3 } }),
    ev("r3", "@miku:x", "bot line", 4, { role: "assistant", sender: { id: "@miku:x", displayName: "Miku", isSelf: true } }),
  ];
  const reply = ev("rt", "@bob:x", "the original", 0);
  const trigger = [
    ev("t1", "@alice:x", "what about it", 10, { mentions: { mentionedUserIds: ["@dave:x"] }, replyTo: { externalId: "x" } }),
    ev("t2", "@alice:x", "and more", 11),
  ];
  const input = buildPlanInput({
    agentName: null,
    timelineKey: TK,
    attribution: { agentSessionId: "s" },
    proactive: false,
    now: 11,
    triggerEvents: trigger,
    replyTarget: reply,
    recent,
    queryMessages: 6,
  });
  assert.deepEqual(input.request, { from: "alice", text: "what about it\nand more", replyTo: { from: "bob", text: "the original" } });
  assert.deepEqual(
    input.participants.map((p) => [p.senderId, p.role]),
    [
      ["@alice:x", "requester"],
      ["@bob:x", "reply_author"],
      ["@dave:x", "mentioned"],
    ],
  );
  assert.deepEqual(input.participants.find((p) => p.senderId === "@dave:x")!.name, "dave");
  // Active people: participants plus recent human senders (not the agent).
  assert.deepEqual(input.activePeople!.map((p) => p.senderId).sort(), ["@alice:x", "@bob:x", "@dave:x", "@erin:x"]);
  assert.equal(input.conversation[1]!.text, "[message deleted]");
  assert.equal(input.conversation[2]!.self, true);
});

test("buildPlanInput: proactive has no request and no participants, but active people from the window", () => {
  const input = buildPlanInput({
    agentName: "a",
    timelineKey: TK,
    attribution: {},
    proactive: true,
    now: 5,
    triggerEvents: [],
    recent: [ev("r1", "@dave:x", "hello all", 1)],
  });
  assert.equal(input.request, undefined);
  assert.equal(input.participants.length, 0);
  assert.deepEqual(input.activePeople!.map((p) => p.senderId), ["@dave:x"]);
});

test("awaitPlan: returns the plan, or null on timeout or failure", async () => {
  const plan = { block: "b", report: {} as any };
  assert.equal(await awaitPlan(Promise.resolve(plan), 100), plan);
  assert.equal(await awaitPlan(new Promise(() => {}), 10), null);
  let seen: unknown;
  assert.equal(await awaitPlan(Promise.reject(new Error("x")), 100, (e) => (seen = e)), null);
  assert.ok(seen instanceof Error);
});
