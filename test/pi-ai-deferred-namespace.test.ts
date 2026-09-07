/**
 * Guards the pnpm patch on @earendil-works/pi-ai (patches/): on the OpenAI
 * Responses API a bare deferred function (loaded through tool_search, not
 * declared inside a `namespace` tool) lives in a namespace named after itself,
 * and the API requires that namespace on the replayed `function_call` item.
 * pi-ai replays the namespace it captured from the model's item; some
 * Responses-compatible endpoints omit it there while still rejecting a
 * namespace-less replay with 400 "Missing namespace for function_call". The
 * patch defaults the replayed namespace to the function name in that case.
 * If a pi-ai bump drops the patch, this test fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

const model = {
  id: "gpt-test",
  name: "gpt-test",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
} as unknown as Model<"openai-responses">;

const loadSkill: Tool = {
  name: "load_skill",
  description: "Load a skill",
  parameters: Type.Object({ skill: Type.String() }),
};
const ping: Tool = {
  name: "ping",
  description: "Ping",
  parameters: Type.Object({ value: Type.Number() }),
};

function transcript(opts: { pingNamespace?: string; pingModel?: string }): Context {
  const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content: unknown[], modelId = "gpt-test") => ({
    role: "assistant",
    content,
    provider: "openai",
    api: "openai-responses",
    model: modelId,
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  });
  return {
    tools: [loadSkill, ping],
    messages: [
      { role: "user", content: "go", timestamp: 1 },
      assistant([{ type: "toolCall", id: "call_a|fc_a", name: "load_skill", arguments: { skill: "media" } }]),
      {
        role: "toolResult", toolCallId: "call_a|fc_a", toolName: "load_skill",
        content: [{ type: "text", text: "loaded" }], isError: false, timestamp: 1,
        addedToolNames: ["ping"],
      },
      assistant(
        [{
          type: "toolCall", id: "call_b|fc_b", name: "ping", arguments: { value: 1 },
          ...(opts.pingNamespace !== undefined ? { namespace: opts.pingNamespace } : {}),
        }],
        opts.pingModel,
      ),
      {
        role: "toolResult", toolCallId: "call_b|fc_b", toolName: "ping",
        content: [{ type: "text", text: "pong" }], isError: false, timestamp: 1,
      },
    ] as unknown as Context["messages"],
  };
}

type FunctionCallItem = { type: string; name?: string; namespace?: string };

function convert(context: Context, deferredToolsMode: "tool-search" | "additional-tools" | undefined) {
  const deferredTools = deferredToolsMode ? new Map([["ping", ping]]) : undefined;
  const items = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    deferredTools,
    deferredToolsMode,
    toolOptions: { supportsStrictMode: true, supportsOpenAIGrammarTools: false },
  } as never) as unknown as FunctionCallItem[];
  const calls = items.filter((i) => i.type === "function_call");
  return {
    loadSkill: calls.find((c) => c.name === "load_skill"),
    ping: calls.find((c) => c.name === "ping"),
    toolSearchOutputs: items.filter((i) => i.type === "tool_search_output").length,
  };
}

test("tool-search mode: a deferred function_call without a captured namespace replays with its own name", () => {
  const out = convert(transcript({}), "tool-search");
  assert.equal(out.toolSearchOutputs, 1, "the load point is serialized as tool_search items");
  assert.equal(out.ping?.namespace, "ping");
  assert.equal(out.loadSkill?.namespace, undefined, "immediate tools stay in the default namespace");
});

test("tool-search mode: a captured namespace always wins over the fallback", () => {
  const out = convert(transcript({ pingNamespace: "custom" }), "tool-search");
  assert.equal(out.ping?.namespace, "custom");
});

test("tool-search mode: the fallback also applies when the call came from another model (health fallback)", () => {
  const out = convert(transcript({ pingModel: "gpt-other" }), "tool-search");
  assert.equal(out.ping?.namespace, "ping");
});

test("additional-tools mode and plain mode never synthesize a namespace", () => {
  assert.equal(convert(transcript({}), "additional-tools").ping?.namespace, undefined);
  assert.equal(convert(transcript({}), undefined).ping?.namespace, undefined);
});
