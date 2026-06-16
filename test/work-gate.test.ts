import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { collectExemptToolNames, hasResumableWork } from "../src/agent/work-gate.ts";

// Tool factories that MUST be flagged exempt (spec RESUMABLE-SESSIONS §7a list).
import { createSendMessageTool } from "../src/tools/send-message.ts";
import { createReactTool } from "../src/tools/react.ts";
import { createEditMessageTool } from "../src/tools/edit-message.ts";
import { createDeleteMessageTool } from "../src/tools/delete-message.ts";
import { createCreatePollTool } from "../src/tools/create-poll.ts";
import { createPollVoteTool } from "../src/tools/poll-vote.ts";
import { createPinsTool } from "../src/tools/pins.ts";
import { createSetProfileTool } from "../src/tools/set-profile.ts";
import { createSpawnSessionTool } from "../src/tools/spawn-session.ts";
import { createDelegateToSessionTool } from "../src/tools/delegate.ts";
import { createMediaTool } from "../src/tools/media.ts";
// Representative WORK tools that must NOT be flagged exempt.
import { createReactTool as _unused } from "../src/tools/react.ts"; // keep import grouping
import { createWebSearchTool } from "../src/tools/web.ts";
import { createSearchMessagesTool } from "../src/tools/search-messages.ts";
import { createWriteMemoryTool } from "../src/tools/memory.ts";

void _unused;

// ── Transcript builders ──────────────────────────────────────────────────────

function triggerGroup(content = "user request"): AgentMessage {
  return { type: "triggerGroup", content } as unknown as AgentMessage;
}
function interjection(content = "more"): AgentMessage {
  return { type: "interjection", content } as unknown as AgentMessage;
}
function assistantCalls(...toolNames: string[]): AgentMessage {
  return {
    role: "assistant",
    content: toolNames.map((name, i) => ({ type: "toolCall", id: `c${i}`, name, arguments: {} })),
  } as unknown as AgentMessage;
}
function assistantThinking(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hmm" }],
  } as unknown as AgentMessage;
}

const EXEMPT = new Set(["send_message", "react", "media"]);

test("work gate: empty transcript has no work", () => {
  assert.equal(hasResumableWork([], { scope: "any_in_history", exemptToolNames: EXEMPT }), false);
});

test("work gate: a rollout of only chat-surface tools is not work", () => {
  const t = [triggerGroup(), assistantCalls("send_message"), assistantCalls("react")];
  assert.equal(hasResumableWork(t, { scope: "any_in_history", exemptToolNames: EXEMPT }), false);
  assert.equal(hasResumableWork(t, { scope: "since_last_turn", exemptToolNames: EXEMPT }), false);
});

test("work gate: a non-exempt tool call is work", () => {
  const t = [triggerGroup(), assistantCalls("web_search")];
  assert.equal(hasResumableWork(t, { scope: "any_in_history", exemptToolNames: EXEMPT }), true);
});

test("work gate: thinking blocks never count as work", () => {
  const t = [triggerGroup(), assistantThinking(), assistantCalls("send_message")];
  assert.equal(hasResumableWork(t, { scope: "any_in_history", exemptToolNames: EXEMPT }), false);
});

test("work gate: since_last_turn ignores work before the latest real user turn", () => {
  // Earlier turn did real work; the LATEST turn (after the 2nd triggerGroup) is
  // pure chat. Strict scope → not resumable; loose scope → still resumable.
  const t = [
    triggerGroup("first"),
    assistantCalls("web_search"),
    triggerGroup("follow-up"),
    assistantCalls("send_message"),
  ];
  assert.equal(hasResumableWork(t, { scope: "since_last_turn", exemptToolNames: EXEMPT }), false);
  assert.equal(hasResumableWork(t, { scope: "any_in_history", exemptToolNames: EXEMPT }), true);
});

test("work gate: since_last_turn counts work in the latest segment", () => {
  const t = [triggerGroup("first"), assistantCalls("send_message"), triggerGroup("more"), assistantCalls("bash")];
  assert.equal(hasResumableWork(t, { scope: "since_last_turn", exemptToolNames: EXEMPT }), true);
});

test("work gate: an interjection is NOT a segment boundary (work after it counts)", () => {
  // Only one real user turn (triggerGroup). The interjection sits within the
  // segment; the work after it still belongs to that segment.
  const t = [triggerGroup(), assistantCalls("send_message"), interjection(), assistantCalls("web_fetch")];
  assert.equal(hasResumableWork(t, { scope: "since_last_turn", exemptToolNames: EXEMPT }), true);
});

test("work gate: extra_exempt_tools demote a would-be work tool (incl. mcp__ names)", () => {
  const t = [triggerGroup(), assistantCalls("mcp__weather__get")];
  const exempt = collectExemptToolNames([], ["mcp__weather__get"]);
  assert.equal(hasResumableWork(t, { scope: "any_in_history", exemptToolNames: exempt }), false);
});

test("collectExemptToolNames reads the per-tool flag and merges extras", () => {
  const tools = [
    { name: "send_message", resumeWorkExempt: true } as unknown as AgentTool,
    { name: "web_search" } as unknown as AgentTool,
  ];
  const set = collectExemptToolNames(tools, ["mcp__x__y"]);
  assert.ok(set.has("send_message"));
  assert.ok(!set.has("web_search"));
  assert.ok(set.has("mcp__x__y"));
});

test("drift: the spec's 11 built-in exempt tools are all flagged resumeWorkExempt", () => {
  // Construct each exempt factory with a stub context (factories build a plain
  // object and never touch the context until execute). The flagged set must equal
  // the spec §7a enumeration exactly — a tool that loses its flag, or a new
  // chat-surface tool added without one, fails here.
  const stub = {} as never;
  const exemptTools: AgentTool[] = [
    createSendMessageTool(stub),
    createReactTool(stub),
    createEditMessageTool(stub),
    createDeleteMessageTool(stub),
    createCreatePollTool(stub),
    createPollVoteTool(stub),
    createPinsTool(stub),
    createSetProfileTool(stub),
    createSpawnSessionTool(stub),
    createDelegateToSessionTool(stub),
    createMediaTool(stub),
  ];
  for (const tool of exemptTools) {
    assert.equal(tool.resumeWorkExempt, true, `${tool.name} must be resumeWorkExempt`);
  }
  const names = collectExemptToolNames(exemptTools);
  assert.deepEqual(
    [...names].sort(),
    [
      "create_poll",
      "delegate_to_session",
      "delete_message",
      "edit_message",
      "media",
      "pins",
      "poll_vote",
      "react",
      "send_message",
      "set_profile",
      "spawn_session",
    ],
  );
});

test("drift: representative work tools are NOT flagged exempt", () => {
  const stub = {} as never;
  for (const tool of [createWebSearchTool(stub), createSearchMessagesTool(stub), createWriteMemoryTool(stub)]) {
    assert.notEqual(tool.resumeWorkExempt, true, `${tool.name} must count as work`);
  }
});
