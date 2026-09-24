import assert from "node:assert/strict";
import test from "node:test";
import {
  strictify,
  applyPrefillToParams,
  buildAnalysisPattern,
  escapeForPattern,
  dropReasoningBlocks,
  buildNoReplyTool,
  wrapToolWithAnalysisStripping,
} from "../src/agent/openai-prefill.js";
import { isTerminallyValid, isExplicitNoReply } from "../src/agent/runner.js";

// ---------------------------------------------------------------------------
// escapeForPattern and buildAnalysisPattern
// ---------------------------------------------------------------------------

test("escapeForPattern escapes regex special characters", () => {
  assert.equal(escapeForPattern("We must "), "We must ");
  assert.equal(escapeForPattern("We (must) be."), "We \\(must\\) be\\.");
  assert.equal(escapeForPattern("a+b*c"), "a\\+b\\*c");
  assert.equal(escapeForPattern("a^b$c"), "a\\^b\\$c");
  assert.equal(escapeForPattern("a[b]c"), "a\\[b\\]c");
  assert.equal(escapeForPattern("a{b}c"), "a\\{b\\}c");
});

test("buildAnalysisPattern anchors and allows multiline", () => {
  const pattern = buildAnalysisPattern("We must ");
  assert.equal(pattern, "^We must [\\s\\S]*");
  // Verify the pattern matches multiline strings
  const re = new RegExp(pattern);
  assert.ok(re.test("We must think carefully\nabout this."));
  assert.ok(!re.test("I think we must go."));
  assert.ok(!re.test(""));
});

// ---------------------------------------------------------------------------
// strictify
// ---------------------------------------------------------------------------

test("strictify: plain object gets additionalProperties: false and required array", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
    },
    required: ["name"],
  };
  const result = strictify(schema) as Record<string, unknown>;
  assert.equal(result["additionalProperties"], false);
  const req = result["required"] as string[];
  assert.ok(req.includes("name"));
  assert.ok(req.includes("count")); // was optional, now required
  const props = result["properties"] as Record<string, unknown>;
  // name was already required, stays as-is
  assert.deepEqual(props["name"], { type: "string" });
  // count was optional, becomes nullable
  const countProp = props["count"] as Record<string, unknown>;
  assert.deepEqual(countProp["type"], ["integer", "null"]);
});

test("strictify: already-required properties are not made nullable", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  };
  const result = strictify(schema) as Record<string, unknown>;
  const props = result["properties"] as Record<string, unknown>;
  const x = props["x"] as Record<string, unknown>;
  assert.equal(x["type"], "string"); // not made into array
});

test("strictify: removes unsupported keywords", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string", default: "hello", format: "email", minLength: 1, maxLength: 100 } },
    required: ["x"],
  };
  const result = strictify(schema) as Record<string, unknown>;
  const props = result["properties"] as Record<string, unknown>;
  const x = props["x"] as Record<string, unknown>;
  assert.equal(x["default"], undefined);
  assert.equal(x["format"], undefined);
  assert.equal(x["minLength"], undefined);
  assert.equal(x["maxLength"], undefined);
});

test("strictify: preserves $defs and $ref", () => {
  const schema = {
    type: "object",
    properties: { x: { $ref: "#/$defs/Foo" } },
    required: ["x"],
    $defs: { Foo: { type: "string" } },
  };
  const result = strictify(schema) as Record<string, unknown>;
  assert.ok(result["$defs"]);
  const defs = result["$defs"] as Record<string, unknown>;
  assert.ok(defs["Foo"]);
});

test("strictify: handles anyOf optional pattern correctly", () => {
  const schema = {
    type: "object",
    properties: {
      x: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  };
  const result = strictify(schema) as Record<string, unknown>;
  const props = result["properties"] as Record<string, unknown>;
  const x = props["x"] as Record<string, unknown>;
  // Was optional: should get null added to anyOf
  const anyOf = x["anyOf"] as unknown[];
  assert.ok(anyOf.some((v) => (v as Record<string, unknown>)["type"] === "null"));
});

test("strictify: is idempotent on already-strict schemas", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
    additionalProperties: false,
  };
  const once = strictify(schema) as Record<string, unknown>;
  const twice = strictify(once) as Record<string, unknown>;
  assert.deepEqual(once, twice);
});

test("strictify: recursively processes nested objects", () => {
  const schema = {
    type: "object",
    properties: {
      nested: {
        type: "object",
        properties: {
          inner: { type: "string" },
        },
      },
    },
    required: ["nested"],
  };
  const result = strictify(schema) as Record<string, unknown>;
  const nestedProp = (result["properties"] as Record<string, unknown>)["nested"] as Record<string, unknown>;
  assert.equal(nestedProp["additionalProperties"], false);
});

// ---------------------------------------------------------------------------
// applyPrefillToParams
// ---------------------------------------------------------------------------

test("applyPrefillToParams: adds analysis first, strict=true, and tool_choice=required", () => {
  const params = {
    model: "gpt-6",
    tools: [
      {
        type: "function",
        name: "send_message",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
    input: [{ role: "user", content: "hello" }],
  };
  const result = applyPrefillToParams(params, "We must ");
  assert.equal(result["tool_choice"], "required");
  const tools = result["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  const t = tools[0];
  assert.equal(t["strict"], true);
  const tParams = t["parameters"] as Record<string, unknown>;
  const req = tParams["required"] as string[];
  assert.equal(req[0], "analysis"); // analysis first
  assert.ok(req.includes("text"));
  const props = tParams["properties"] as Record<string, unknown>;
  assert.ok(props["analysis"]);
  const analysis = props["analysis"] as Record<string, unknown>;
  assert.ok((analysis["pattern"] as string).startsWith("^We must "));
});

test("applyPrefillToParams: transforms tool_search_output deferred tools", () => {
  const deferredTool = {
    type: "function",
    name: "deferred_tool",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  };
  const params = {
    tools: [],
    input: [
      { type: "tool_search_output", tools: [deferredTool] },
      { type: "message", role: "user", content: "hi" },
    ],
  };
  const result = applyPrefillToParams(params, "We must ");
  const input = result["input"] as Array<Record<string, unknown>>;
  const tsOutput = input[0];
  const deferredTools = tsOutput["tools"] as Array<Record<string, unknown>>;
  const t = deferredTools[0];
  assert.equal(t["strict"], true);
  const req = (t["parameters"] as Record<string, unknown>)["required"] as string[];
  assert.equal(req[0], "analysis");
  // Non-tool_search_output items not affected
  const message = input[1];
  assert.equal(message["type"], "message");
  assert.equal((message["content"] as string), "hi");
});

test("applyPrefillToParams: does not mutate the input object", () => {
  const original = { model: "gpt-6", tools: [{ type: "function", name: "x", parameters: { type: "object", properties: {}, required: [] } }] };
  const copy = JSON.parse(JSON.stringify(original));
  applyPrefillToParams(original, "We must ");
  assert.deepEqual(original, copy);
});

// ---------------------------------------------------------------------------
// Per-member gating (model descriptor check)
// ---------------------------------------------------------------------------

test("makePrefillInjector: only transforms when compat.prefillText is set", async () => {
  const { makePrefillInjector } = await import("../src/agent/openai-prefill.js");
  const injector = makePrefillInjector();
  const payload = { tools: [{ type: "function", name: "x", parameters: { type: "object", properties: {}, required: [] } }] };

  // Model without prefillText: payload unchanged
  const noPrefix = injector(payload, { compat: {} });
  assert.deepEqual(noPrefix, payload);

  // Model with prefillText: payload transformed
  const withPrefix = injector(payload, { compat: { prefillText: "We must " } }) as Record<string, unknown>;
  assert.equal(withPrefix["tool_choice"], "required");
});

// ---------------------------------------------------------------------------
// dropReasoningBlocks
// ---------------------------------------------------------------------------

test("dropReasoningBlocks: removes thinking and redacted_thinking blocks", () => {
  const content = [
    { type: "thinking", thinking: "private" },
    { type: "text", text: "hello" },
    { type: "redacted_thinking", data: "x" },
    { type: "toolCall", name: "send_message" },
  ];
  const filtered = dropReasoningBlocks(content);
  assert.equal(filtered.length, 2);
  assert.equal((filtered[0] as Record<string, unknown>)["type"], "text");
  assert.equal((filtered[1] as Record<string, unknown>)["type"], "toolCall");
});

test("dropReasoningBlocks: preserves non-thinking blocks unchanged", () => {
  const content = [{ type: "text", text: "hello" }];
  const filtered = dropReasoningBlocks(content);
  assert.deepEqual(filtered, content);
});

// ---------------------------------------------------------------------------
// no_reply tool
// ---------------------------------------------------------------------------

test("buildNoReplyTool: execute returns NO_REPLY_CALLED content", async () => {
  const tool = buildNoReplyTool("We must ");
  assert.equal(tool.name, "no_reply");
  const result = await (tool.execute as Function)("id", {});
  assert.equal((result.content as Array<Record<string, unknown>>)[0]["text"], "NO_REPLY_CALLED");
  // Under tool_choice = "required" only the tool result can end the run.
  assert.equal(result.terminate, true);
});

// ---------------------------------------------------------------------------
// wrapToolWithAnalysisStripping
// ---------------------------------------------------------------------------

test("wrapToolWithAnalysisStripping: strips analysis arg before execute", async () => {
  let received: Record<string, unknown> | undefined;
  const tool = {
    name: "my_tool",
    label: "My tool",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (_id: string, params: unknown) => {
      received = params as Record<string, unknown>;
      return { content: [{ type: "text", text: "ok" }], details: null };
    },
  };
  const wrapped = wrapToolWithAnalysisStripping(tool as any);
  await (wrapped.execute as Function)("id", { analysis: "reasoning here", text: "hello" });
  assert.equal(received?.["analysis"], undefined);
  assert.equal(received?.["text"], "hello");
});

// ---------------------------------------------------------------------------
// runner.ts: isTerminallyValid and isExplicitNoReply with no_reply tool
// ---------------------------------------------------------------------------

function makeMsg(blocks: unknown[]) {
  return { role: "assistant", content: blocks };
}

test("isTerminallyValid: true when no_reply tool call present", () => {
  const messages = [makeMsg([{ type: "toolCall", name: "no_reply", input: { analysis: "silent" } }])];
  assert.equal(isTerminallyValid(messages), true);
});

test("isExplicitNoReply: true when no_reply tool call present", () => {
  const messages = [makeMsg([{ type: "toolCall", name: "no_reply", input: { analysis: "silent" } }])];
  assert.equal(isExplicitNoReply(messages), true);
});

test("isTerminallyValid: false when only non-terminal tool call present", () => {
  const messages = [makeMsg([{ type: "toolCall", name: "some_other_tool" }])];
  assert.equal(isTerminallyValid(messages), false);
});

test("isExplicitNoReply: false when send_message is called (not a no-reply)", () => {
  const messages = [makeMsg([{ type: "toolCall", name: "send_message" }])];
  assert.equal(isExplicitNoReply(messages), false);
});
