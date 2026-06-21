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
// The WHOLE first-party tool factory set, for the exhaustive both-directions
// drift test (issue #15) — every work tool too, not just the 11 exempt ones.
import * as allTools from "../src/tools/index.ts";

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

// ── Issue #15: EXHAUSTIVE both-directions drift over the FULL tool set ────────
//
// The drift tests above pin the 11 exempt names positively and three work tools
// negatively, but neither can catch a stray `resumeWorkExempt: true` accidentally
// added to some OTHER work tool (e.g. `bash`, `browser`, `recap`). This test
// constructs EVERY first-party tool factory exported from `src/tools/index.ts`,
// reads each one's static flag, and asserts the flagged set equals EXACTLY the
// spec §7a eleven — so a stray flag on any of the ~28 work tools fails here, and
// dropping a flag off an exempt tool fails too. It is the symmetric closure of the
// two one-directional tests (which are kept as readable, low-dependency guards).

/** The spec §7a built-in exempt set, verbatim — the EXACT expected flagged set. */
const SPEC_EXEMPT_NAMES = [
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
] as const;

/**
 * A self-returning, callable Proxy used as a stub context. Every property read
 * returns the same proxy and every call/construct returns it too, so a factory can
 * dereference and chain whatever it likes at CONSTRUCTION time without us modeling
 * real context — the factories build a plain object and only touch context inside
 * `execute` (the same property `resume-exempt.ts` and the drift tests above rely
 * on). `Symbol.toPrimitive` → "" and a missing `then` keep it from masquerading as
 * a number or a thenable.
 */
function tolerantContextStub(): never {
  const fn = function () {
    return stub;
  };
  const stub: unknown = new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined;
      return stub;
    },
    apply: () => stub,
    construct: () => stub as object,
  });
  return stub as never;
}

/**
 * Four work-tool factories validate a real `config` block at construction (URL /
 * model-name shape), so the blanket stub can't build them. They get a minimal
 * VALID config; everything else still rides the tolerant stub. All four are work
 * tools — the point is to include them so a stray exempt flag on one is caught.
 */
const STRICT_FACTORY_CONTEXTS: Record<string, () => unknown> = {
  createDanbooruTool: () => ({
    fetchClient: tolerantContextStub(),
    config: { base_url: "https://danbooru.donmai.us", default_order: "id_desc" },
  }),
  createFindSourceTool: () => ({
    workspaceRoot: "/tmp",
    fetchClient: tolerantContextStub(),
    inlineImageMaxBytes: 1000,
    inferenceImageOptions: {},
    modelHasVision: false,
    rateLimiter: tolerantContextStub(),
    config: { base_url: "https://saucenao.com/search.php", api_key: "k" },
  }),
  createImageGenTool: () => ({
    fetchClient: tolerantContextStub(),
    // Unified registry (spec MODEL-FALLBACK §2.3): tiers reference resolved chains.
    chains: {
      pro: [{ logicalId: "ig-pro", config: { id: "gemini-2.5-pro", endpoint: "https://example.org/google", api_key: "k" } }],
      flash: [{ logicalId: "ig-flash", config: { id: "gemini-2.5-flash", endpoint: "https://example.org/google", api_key: "k" } }],
    },
    config: {},
  }),
  createXSearchTool: () => ({
    workspaceRoot: "/tmp",
    fastChain: [{ logicalId: "grok", config: { id: "grok-2", endpoint: "https://example.org/grok", api_key: "k" } }],
    deepChain: [{ logicalId: "grok", config: { id: "grok-2", endpoint: "https://example.org/grok", api_key: "k" } }],
    fxTwitterClient: tolerantContextStub(),
    statusHosts: [],
    fetchClient: tolerantContextStub(),
    downloadSizeLimit: 1000,
    cache: tolerantContextStub(),
    config: {},
  }),
};

test("issue #15: across the ENTIRE first-party tool set, exactly the 11 spec tools are resumeWorkExempt", () => {
  const factoryNames = Object.keys(allTools).filter(
    (k) => k.startsWith("create") && typeof (allTools as Record<string, unknown>)[k] === "function",
  );
  // Sanity: the index really exports the full tool surface, not a stub subset — so
  // a future work tool added there without a context override is exercised here.
  assert.ok(factoryNames.length >= 38, `expected the full factory set; saw ${factoryNames.length}`);

  const flaggedExempt: string[] = [];
  const builtNames: string[] = [];
  for (const fname of factoryNames) {
    const factory = (allTools as Record<string, (ctx: never) => AgentTool>)[fname]!;
    const ctx = (STRICT_FACTORY_CONTEXTS[fname]?.() ?? tolerantContextStub()) as never;
    const tool = factory(ctx);
    builtNames.push(tool.name);
    if (tool.resumeWorkExempt === true) flaggedExempt.push(tool.name);
  }

  // Every factory built (none silently skipped) and the flagged set is EXACTLY the
  // spec eleven — a stray flag on any work tool, or a dropped flag on an exempt
  // tool, breaks this equality.
  assert.equal(builtNames.length, factoryNames.length, "every tool factory must construct");
  assert.deepEqual(
    [...new Set(flaggedExempt)].sort(),
    [...SPEC_EXEMPT_NAMES].sort(),
    `resumeWorkExempt set drifted from the spec §7a eleven; flagged: ${flaggedExempt.sort().join(", ")}`,
  );
  // And it agrees with the shipped context-free derivation.
  assert.deepEqual(
    [...collectExemptToolNames(
      factoryNames.map((fname) => {
        const ctx = (STRICT_FACTORY_CONTEXTS[fname]?.() ?? tolerantContextStub()) as never;
        return (allTools as Record<string, (c: never) => AgentTool>)[fname]!(ctx);
      }),
    )].sort(),
    [...SPEC_EXEMPT_NAMES].sort(),
  );
});
