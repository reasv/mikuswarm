import assert from "node:assert/strict";
import test from "node:test";

import { makeBreakpointInjector } from "../src/agent/cache-breakpoints.js";

// ---------------------------------------------------------------------------
// Explicit Bedrock prompt-cache breakpoint injection (ARCHITECTURE.md §8
// "Cache control").  These tests operate on synthetic wire payloads matching
// the openai-responses format produced by pi-ai's convertResponsesMessages.
//
// The injector now gates on the `model` argument of the onPayload callback:
// `model.compat.cacheBreakpoints === "explicit"` must be true for a given
// serving member or the payload is passed through unchanged.  Tests build a
// minimal model descriptor to simulate the Bedrock and non-Bedrock cases.
// ---------------------------------------------------------------------------

/** Rough token estimator: 1 token per 4 characters. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Minimal wire Model descriptor with cacheBreakpoints enabled (Bedrock member). */
const bedrockModel = { compat: { cacheBreakpoints: "explicit" as const } };
/** Minimal wire Model descriptor without cacheBreakpoints (direct-OpenAI fallback). */
const directModel = { compat: {} };
/** Undefined model descriptor (missing arg). */
const noModel = undefined;

/** Build a developer/system input item (pi-ai produces a string content). */
function devItem(text: string, role: "developer" | "system" = "developer") {
  return { role, content: text };
}

/** Build a user input item with one input_text block. */
function userItem(text: string) {
  return { role: "user", content: [{ type: "input_text", text }] };
}

/** Build a user input item with multiple content blocks. */
function userItemMultiBlock(texts: string[], lastIsImage = false) {
  const blocks: object[] = texts.map((t) => ({ type: "input_text", text: t }));
  if (lastIsImage) blocks.push({ type: "input_image", image_url: "data:image/png;base64,abc" });
  return { role: "user", content: blocks };
}

/** Build an assistant message item. */
function assistantItem(text = "") {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
    id: "msg_test",
  };
}

const BREAKPOINT = { prompt_cache_breakpoint: { mode: "explicit" } };

/** Retrieve the breakpoint object from the last input_text block of an item. */
function getBreakpoint(item: any): unknown {
  const content = item.content;
  if (typeof content === "string") return undefined;
  if (!Array.isArray(content)) return undefined;
  const lastInputText = [...content].reverse().find((b: any) => b.type === "input_text");
  return lastInputText?.prompt_cache_breakpoint;
}

// ---------------------------------------------------------------------------

test("makeBreakpointInjector: identity passthrough when model has no cacheBreakpoints", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const payload = { input: [devItem("instructions"), userItem("<conversation_summary>S</conversation_summary>")] };
  assert.strictEqual(inject(payload, directModel), payload, "should return the same object reference");
});

test("makeBreakpointInjector: identity passthrough when model arg is undefined", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const payload = { input: [devItem("x")] };
  assert.strictEqual(inject(payload, noModel), payload);
});

test("makeBreakpointInjector: returns payload unchanged when input is empty", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const payload = { input: [] };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(result.input, []);
});

test("makeBreakpointInjector: returns payload unchanged when not an object", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  assert.strictEqual(inject(null, bedrockModel), null);
  assert.strictEqual(inject("string", bedrockModel), "string");
  assert.strictEqual(inject(42, bedrockModel), 42);
});

// ── breakpoint (a): developer item ───────────────────────────────────────────

test("breakpoint (a): developer item with string content is converted to input_text array", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  // Pad text to exceed the 1024-token minimum (at 1 token/4 chars: 4100 chars)
  const instructions = "A".repeat(4100);
  const payload = {
    input: [
      devItem(instructions),
      userItem("<system> <runtime_state>now</runtime_state> </system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  const dev = result.input[0];
  assert.ok(Array.isArray(dev.content), "content should be converted to array");
  assert.strictEqual(dev.content.length, 1);
  assert.strictEqual(dev.content[0].type, "input_text");
  assert.strictEqual(dev.content[0].text, instructions);
  assert.deepEqual(getBreakpoint(dev), { mode: "explicit" });
});

test("breakpoint (a): developer item with system role", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "S".repeat(4100);
  const payload = {
    input: [
      devItem(instructions, "system"),
      userItem("<system>x</system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[0]), { mode: "explicit" });
});

test("breakpoint (a): no injection when developer text is below 1024-token minimum", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  // 100 chars → 25 tokens, well below 1024
  const payload = {
    input: [
      devItem("x".repeat(100)),
      userItem("<system>x</system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  // string content means no breakpoint was added — content is still a string or converted without breakpoint
  const dev = result.input[0];
  if (Array.isArray(dev.content)) {
    assert.equal(dev.content[0].prompt_cache_breakpoint, undefined, "no breakpoint below minimum");
  } else {
    assert.strictEqual(typeof dev.content, "string", "string unchanged if not converted");
  }
});

// ── breakpoint (b): conversation-summary item ─────────────────────────────────

test("breakpoint (b): summary item gets breakpoint on its last input_text block", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),
      userItem("<system>x</system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[1]), { mode: "explicit" });
});

test("breakpoint (b): no injection when there is no summary item", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const payload = {
    input: [
      devItem(instructions),
      userItem("[2026-01-01] user: hello"),
      userItem("<system>x</system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  // No summary marker → item[1] should not get breakpoint (b)
  assert.equal(getBreakpoint(result.input[1]), undefined);
});

test("breakpoint (b): summary item with multiple input_text blocks — breakpoint on last", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const item = {
    role: "user",
    content: [
      { type: "input_text", text: "<conversation_summary>first" },
      { type: "input_text", text: "second" + "S".repeat(4100) },
    ],
  };
  const payload = {
    input: [
      devItem(instructions),
      item,
      userItem("<system>x</system>"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  const summaryContent = result.input[1].content;
  // breakpoint on the LAST input_text block (index 1), not the first
  assert.equal(summaryContent[0].prompt_cache_breakpoint, undefined);
  assert.deepEqual(summaryContent[1].prompt_cache_breakpoint, { mode: "explicit" });
});

// ── breakpoint (c): last stable timeline item ─────────────────────────────────

test("breakpoint (c): second-to-last user item before trigger gets breakpoint", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const chat1 = "[2026-01-01] user: hi";
  const chat2 = "[2026-01-02] user: how are you" + "X".repeat(2000);
  const chat3 = "[2026-01-03] user: growing batch" + "Y".repeat(2000);
  const trigger = "<system> <runtime_state>now</runtime_state> </system>";

  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),        // [1] summary → (b)
      userItem(chat1),          // [2] timeline
      assistantItem("Hello!"),  // [3] assistant
      userItem(chat2),          // [4] stable timeline user → (c)
      assistantItem("Fine."),   // [5] assistant
      userItem(chat3),          // [6] growing batch — excluded
      userItem(trigger),        // [7] trigger
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[1]), { mode: "explicit" }, "(b) on summary");
  assert.deepEqual(getBreakpoint(result.input[4]), { mode: "explicit" }, "(c) on stable item");
  // growing batch and trigger should have no breakpoint
  assert.equal(getBreakpoint(result.input[6]), undefined, "no breakpoint on growing batch");
  assert.equal(getBreakpoint(result.input[7]), undefined, "no breakpoint on trigger");
});

test("breakpoint (c): skipped when only summary + one user item before trigger", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const growing = "[2026-01-03] user: only batch" + "Y".repeat(2000);
  const trigger = "<system>x</system>";

  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),   // [1] summary → (b)
      userItem(growing),   // [2] growing batch — only user item before trigger
      userItem(trigger),   // [3] trigger
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[1]), { mode: "explicit" }, "(b) on summary");
  // item[2] is the growing batch — should NOT get breakpoint
  assert.equal(getBreakpoint(result.input[2]), undefined, "no breakpoint on growing batch");
});

test("breakpoint (c): skipped when second-to-last user item equals summary (would duplicate)", () => {
  // Layout: dev, summary, growing_batch, trigger
  // second-to-last user = summary → skip (c) since (b) already covers it
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const growing = "[2026-01-03] user: batch";
  const trigger = "<system>x</system>";
  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),  // [1] summary
      userItem(growing),  // [2] growing batch
      userItem(trigger),  // [3] trigger
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  // summary should have (b) but NOT a second injection from (c)
  const summaryContent = result.input[1].content;
  const breakpointCount = summaryContent.filter((b: any) => b.prompt_cache_breakpoint !== undefined).length;
  assert.equal(breakpointCount, 1, "only one breakpoint on summary item");
});

test("breakpoint (c): trigger identified by <retrieved_memory> prefix", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const chat1 = "[2026-01-01] user: hi" + "X".repeat(2000);
  const chat2 = "[2026-01-02] user: growing" + "Y".repeat(2000);
  const trigger = "<retrieved_memory>memory</retrieved_memory><system>x</system>";

  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),
      userItem(chat1),   // [2] stable → (c)
      userItem(chat2),   // [3] growing batch
      userItem(trigger), // [4] trigger (starts with <retrieved_memory>)
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[2]), { mode: "explicit" }, "(c) on stable item");
  assert.equal(getBreakpoint(result.input[3]), undefined, "no breakpoint on growing batch");
  assert.equal(getBreakpoint(result.input[4]), undefined, "no breakpoint on trigger");
});

// ── original items are not mutated ────────────────────────────────────────────

test("injection does not mutate the original payload", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const original = {
    input: [
      devItem(instructions),
      userItem(summary),
      userItem("<system>x</system>"),
    ],
  };
  const original0Content = original.input[0].content;
  const original1Content = original.input[1].content;
  inject(original, bedrockModel);
  // Original items must not be modified
  assert.strictEqual(original.input[0].content, original0Content, "developer item content unchanged");
  assert.strictEqual(original.input[1].content, original1Content, "summary item content unchanged");
});

// ── no trigger item ───────────────────────────────────────────────────────────

test("no trigger item found: breakpoints still injected on (a) and (b)", () => {
  const inject = makeBreakpointInjector(estimateTokens);
  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  // No trigger-like item
  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),
      userItem("[2026-01-01] user: last msg"),
    ],
  };
  const result = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(result.input[0]), { mode: "explicit" }, "(a)");
  assert.deepEqual(getBreakpoint(result.input[1]), { mode: "explicit" }, "(b)");
  // No (c) since we can't find the trigger boundary
  assert.equal(getBreakpoint(result.input[2]), undefined, "no (c) without trigger");
});

// ── all three breakpoints in a realistic layout ───────────────────────────────

test("full realistic layout: all three breakpoints injected", () => {
  const inject = makeBreakpointInjector(estimateTokens);

  const instructions = "<agent_instructions>" + "A".repeat(5000) + "</agent_instructions>";
  const diary = "<recent_memory>" + "D".repeat(500) + "</recent_memory>";
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const batch1 = "[2026-09-23 17:32] User: hello there" + "X".repeat(2000);
  const resp1 = "Hi!";
  const batch2 = "[2026-09-23 18:00] User: how are you" + "X".repeat(2000);
  const resp2 = "Good!";
  const batch3 = "[2026-09-23 19:00] User: stable batch" + "X".repeat(2000);
  const resp3 = "Sure.";
  const batch4 = "[2026-09-23 20:00] User: growing batch" + "X".repeat(2000);
  const trigger = "<system> <runtime_state>Current time: 2026-09-23</runtime_state> </system>";

  const payload = {
    input: [
      devItem(instructions),      // [0] → (a)
      userItem(diary),            // [1] diary
      userItem(summary),          // [2] → (b)
      userItem(batch1),           // [3]
      assistantItem(resp1),       // [4]
      userItem(batch2),           // [5]
      assistantItem(resp2),       // [6]
      userItem(batch3),           // [7] → (c) stable
      assistantItem(resp3),       // [8]
      userItem(batch4),           // [9] growing batch
      userItem(trigger),          // [10] trigger
    ],
  };

  const result = inject(payload, bedrockModel) as any;

  assert.deepEqual(getBreakpoint(result.input[0]), { mode: "explicit" }, "(a) dev instructions");
  assert.deepEqual(getBreakpoint(result.input[2]), { mode: "explicit" }, "(b) summary");
  assert.deepEqual(getBreakpoint(result.input[7]), { mode: "explicit" }, "(c) stable batch3");

  // Items that should NOT have breakpoints
  assert.equal(getBreakpoint(result.input[1]), undefined, "no bp on diary");
  assert.equal(getBreakpoint(result.input[3]), undefined, "no bp on batch1");
  assert.equal(getBreakpoint(result.input[5]), undefined, "no bp on batch2");
  assert.equal(getBreakpoint(result.input[9]), undefined, "no bp on growing batch4");
  assert.equal(getBreakpoint(result.input[10]), undefined, "no bp on trigger");
});

// ── per-member gating: chain with Bedrock head + direct-OpenAI fallback ───────

test("per-member gate: Bedrock member injects, direct-OpenAI member passes through", () => {
  // This models the two-rung fallback chain used in production:
  //   sol_aws  (openai-responses, cacheBreakpoints="explicit") → bedrockModel
  //   sol      (openai-responses, no cacheBreakpoints)         → directModel
  //
  // Both share the same onPayload closure (installed once at session creation).
  // The injector must inject only when called with bedrockModel, and pass
  // through unchanged when called with directModel.
  const inject = makeBreakpointInjector(estimateTokens);

  const instructions = "A".repeat(4100);
  const summary = "<conversation_summary>" + "S".repeat(9000) + "</conversation_summary>";
  const payload = {
    input: [
      devItem(instructions),
      userItem(summary),
      userItem("<system>x</system>"),
    ],
  };

  // Bedrock member: should inject
  const bedrockResult = inject(payload, bedrockModel) as any;
  assert.deepEqual(getBreakpoint(bedrockResult.input[0]), { mode: "explicit" }, "Bedrock: (a) injected");
  assert.deepEqual(getBreakpoint(bedrockResult.input[1]), { mode: "explicit" }, "Bedrock: (b) injected");

  // Direct-OpenAI fallback member: must be identity passthrough — no injection
  const directResult = inject(payload, directModel);
  assert.strictEqual(directResult, payload, "direct member: same object reference (identity passthrough)");

  // Verify bedrockResult is a new object (not the original) so directResult
  // being the original confirms no mutation happened.
  assert.notStrictEqual(bedrockResult, payload, "Bedrock result is a new object");
});

// ── non-responses API passthrough ─────────────────────────────────────────────

test("makeBreakpointInjector: non-responses model (no compat.cacheBreakpoints) → identity", () => {
  // Simulates an anthropic-messages or openai-completions model whose
  // createModelFromConfig sets cache_breakpoints: undefined in compat.
  const inject = makeBreakpointInjector(estimateTokens);
  const payload = { input: [devItem("instructions")] };
  assert.strictEqual(inject(payload, directModel), payload, "non-Bedrock model: identity passthrough");
});
