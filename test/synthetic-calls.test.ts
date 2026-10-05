import assert from "node:assert/strict";
import test from "node:test";

import { executeSyntheticCalls, buildSyntheticCallFromResult } from "../src/agent/synthetic-calls.js";
import { DynamicToolRegistry } from "../src/agent/dynamic-tools.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// synthetic-calls.ts unit tests (W5 / SESSION-RECORDS spec §4)
// ---------------------------------------------------------------------------

const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude-3-5-sonnet" };

function makeTool(name: string, result: { content?: { type: "text"; text: string }[]; addedToolNames?: string[]; throws?: string }): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params) => {
      if (result.throws) throw new Error(result.throws);
      return {
        content: result.content ?? [],
        ...(result.addedToolNames ? { addedToolNames: result.addedToolNames } : {}),
      };
    },
  } as AgentTool;
}

function makeRegistry(names: string[]): DynamicToolRegistry {
  const tools = names.map((n) => ({ name: n, description: n, parameters: {} }) as any);
  return new DynamicToolRegistry(tools, []);
}

// --- executeSyntheticCalls --------------------------------------------------

test("executeSyntheticCalls: empty specs returns empty array", async () => {
  const result = await executeSyntheticCalls([], [], MODEL);
  assert.deepEqual(result, []);
});

test("executeSyntheticCalls: shape parity — assistant message matches pi-agent-core toolUse shape", async () => {
  const tool = makeTool("my_tool", { content: [{ type: "text", text: "result" }] });
  const messages = await executeSyntheticCalls(
    [{ name: "my_tool", params: { x: 1 }, harness: { kind: "injection" } }],
    [tool],
    MODEL,
  );
  assert.equal(messages.length, 2);
  const assistant = messages[0] as any;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.stopReason, "toolUse");
  assert.ok(Array.isArray(assistant.content));
  assert.equal(assistant.content.length, 1);
  assert.equal(assistant.content[0].type, "toolCall");
  assert.equal(assistant.content[0].name, "my_tool");
  assert.deepEqual(assistant.content[0].arguments, { x: 1 });
  assert.ok(typeof assistant.content[0].id === "string" && assistant.content[0].id.startsWith("synth_"));
  assert.equal(assistant.api, MODEL.api);
  assert.equal(assistant.provider, MODEL.provider);
  assert.equal(assistant.model, MODEL.model);
  assert.deepEqual(assistant.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.ok(typeof assistant.timestamp === "number");
});

test("executeSyntheticCalls: shape parity — toolResult message matches pi-agent-core toolResult shape", async () => {
  const tool = makeTool("my_tool", { content: [{ type: "text", text: "hello" }] });
  const messages = await executeSyntheticCalls(
    [{ name: "my_tool", params: {}, harness: { kind: "injection" } }],
    [tool],
    MODEL,
  );
  const toolResult = messages[1] as any;
  assert.equal(toolResult.role, "toolResult");
  assert.equal(toolResult.toolName, "my_tool");
  assert.equal(toolResult.toolCallId, (messages[0] as any).content[0].id, "toolCallId matches assistantMessage call id");
  assert.deepEqual(toolResult.content, [{ type: "text", text: "hello" }]);
  assert.equal(toolResult.isError, false);
  assert.ok(typeof toolResult.timestamp === "number");
});

test("executeSyntheticCalls: harness marker stamped on both messages", async () => {
  const tool = makeTool("my_tool", { content: [] });
  const harness = { kind: "injection" as const, decisionGroup: "dg-123" };
  const messages = await executeSyntheticCalls(
    [{ name: "my_tool", params: {}, harness }],
    [tool],
    MODEL,
  );
  assert.deepEqual((messages[0] as any).harness, harness, "harness on assistant message");
  assert.deepEqual((messages[1] as any).harness, harness, "harness on toolResult message");
});

test("executeSyntheticCalls: decisionGroup from harness marker is preserved", async () => {
  const tool = makeTool("x", { content: [] });
  const messages = await executeSyntheticCalls(
    [{ name: "x", params: {}, harness: { kind: "injection", decisionGroup: "group-abc" } }],
    [tool],
    MODEL,
  );
  assert.equal((messages[0] as any).harness.decisionGroup, "group-abc");
  assert.equal((messages[1] as any).harness.decisionGroup, "group-abc");
});

test("executeSyntheticCalls: addedToolNames in toolResult when tool returns them", async () => {
  const tool = makeTool("load_skill", { content: [{ type: "text", text: "loaded" }], addedToolNames: ["bash", "python"] });
  const messages = await executeSyntheticCalls(
    [{ name: "load_skill", params: { name: "shell" }, harness: { kind: "injection" } }],
    [tool],
    MODEL,
  );
  const toolResult = messages[1] as any;
  assert.deepEqual(toolResult.addedToolNames, ["bash", "python"]);
});

test("executeSyntheticCalls: no addedToolNames field when tool returns none", async () => {
  const tool = makeTool("my_tool", { content: [{ type: "text", text: "ok" }] });
  const messages = await executeSyntheticCalls(
    [{ name: "my_tool", params: {}, harness: { kind: "injection" } }],
    [tool],
    MODEL,
  );
  const toolResult = messages[1] as any;
  assert.equal("addedToolNames" in toolResult, false);
});

test("executeSyntheticCalls: isError=true when tool throws; no rethrow", async () => {
  const tool = makeTool("failing_tool", { throws: "kaboom" });
  const messages = await executeSyntheticCalls(
    [{ name: "failing_tool", params: {}, harness: { kind: "injection" } }],
    [tool],
    MODEL,
  );
  assert.equal(messages.length, 2, "still produces a pair on error");
  const toolResult = messages[1] as any;
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.content[0].text, "kaboom");
});

test("executeSyntheticCalls: isError=true when tool not in catalog", async () => {
  const messages = await executeSyntheticCalls(
    [{ name: "unknown_tool", params: {}, harness: { kind: "injection" } }],
    [],
    MODEL,
  );
  assert.equal(messages.length, 2);
  const toolResult = messages[1] as any;
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /not found/);
});

test("executeSyntheticCalls: registry.load() called when addedToolNames present; onChange fires", async () => {
  const reg = makeRegistry(["bash", "python"]);
  let fired = 0;
  reg.onChange = () => (fired += 1);
  const tool = makeTool("load_skill", { content: [], addedToolNames: ["bash"] });
  await executeSyntheticCalls(
    [{ name: "load_skill", params: {}, harness: { kind: "injection" } }],
    [tool],
    MODEL,
    { registry: reg },
  );
  assert.ok(reg.current.some((t) => t.name === "bash"), "bash in loaded set");
  assert.equal(fired, 1, "onChange fired once");
});

test("executeSyntheticCalls: multiple specs produce pairs in order", async () => {
  const toolA = makeTool("a", { content: [{ type: "text", text: "A" }] });
  const toolB = makeTool("b", { content: [{ type: "text", text: "B" }] });
  const messages = await executeSyntheticCalls(
    [
      { name: "a", params: { i: 0 }, harness: { kind: "injection" } },
      { name: "b", params: { i: 1 }, harness: { kind: "injection" } },
    ],
    [toolA, toolB],
    MODEL,
  );
  assert.equal(messages.length, 4);
  assert.equal((messages[0] as any).content[0].name, "a");
  assert.equal((messages[1] as any).content[0].text, "A");
  assert.equal((messages[2] as any).content[0].name, "b");
  assert.equal((messages[3] as any).content[0].text, "B");
});

// --- buildSyntheticCallFromResult -------------------------------------------

test("buildSyntheticCallFromResult: builds pair from caller-supplied result", () => {
  const spec = { name: "session_record_tool", params: { session_id: "s1" }, harness: { kind: "record_load" as const } };
  const result = { content: [{ type: "text" as const, text: "record data" }], addedToolNames: ["recall_session_record"] };
  const reg = makeRegistry(["recall_session_record"]);
  let fired = 0;
  reg.onChange = () => (fired += 1);
  const { assistantMessage, toolResultMessage } = buildSyntheticCallFromResult(spec, result, MODEL, reg);
  const am = assistantMessage as any;
  const tr = toolResultMessage as any;
  assert.equal(am.role, "assistant");
  assert.equal(am.content[0].name, "session_record_tool");
  assert.deepEqual(am.harness, spec.harness);
  assert.equal(tr.role, "toolResult");
  assert.deepEqual(tr.content, result.content);
  assert.deepEqual(tr.addedToolNames, result.addedToolNames);
  assert.equal(tr.isError, false);
  assert.deepEqual(tr.harness, spec.harness);
  assert.equal(tr.toolCallId, am.content[0].id);
  assert.ok(reg.current.some((t) => t.name === "recall_session_record"), "tool loaded into registry");
  assert.equal(fired, 1, "onChange fired once");
});

test("buildSyntheticCallFromResult: isError propagated from caller", () => {
  const spec = { name: "t", params: {}, harness: { kind: "record_load" as const } };
  const { toolResultMessage } = buildSyntheticCallFromResult(spec, { content: [{ type: "text" as const, text: "err" }], isError: true }, MODEL);
  assert.equal((toolResultMessage as any).isError, true);
});

test("buildSyntheticCallFromResult: no registry arg — no registry load", () => {
  const spec = { name: "t", params: {}, harness: { kind: "injection" as const } };
  const result = { content: [], addedToolNames: ["bash"] };
  // Should not throw even without a registry.
  const { toolResultMessage } = buildSyntheticCallFromResult(spec, result, MODEL);
  assert.deepEqual((toolResultMessage as any).addedToolNames, ["bash"]);
});
