import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../src/agent/convert.js";
import { buildAgentContextMessages } from "../src/agent/factory.js";
import type { BuiltContext } from "../src/context/index.js";

test("agent context keeps timeline base and preserves live runtime messages", () => {
  const built: BuiltContext = {
    messages: [
      {
        type: "system",
        role: "system",
        content: "system prompt",
        tier: "system",
        tokenEstimate: 1,
      },
      {
        type: "chatEvent",
        role: "user",
        content: "<message>hello</message>",
        tier: "rich",
        tokenEstimate: 1,
      },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  };

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "tool output" }],
    details: {},
    isError: false,
    timestamp: 1,
  };
  const interjection: AgentMessage = { type: "interjection", content: "new user reply" };
  const forcedPrompt: AgentMessage = { role: "user", content: "finish visibly", timestamp: 2 };
  const duplicateTrigger: AgentMessage = {
    type: "chatEvent",
    role: "user",
    content: "hello",
  };

  const messages = buildAgentContextMessages(built, [
    duplicateTrigger,
    toolResult,
    interjection,
    forcedPrompt,
  ]);

  assert.deepEqual(
    messages.map((message) => (message as any).type ?? (message as any).role),
    ["chatEvent", "toolResult", "interjection", "user"],
  );

  const llmMessages = convertToLlm(messages);
  assert.equal(llmMessages.some((message) => (message as any).content === "system prompt"), false);
  assert.equal(llmMessages.some((message) => message.role === "toolResult"), true);
  assert.equal(llmMessages.some((message) => message.role === "user" && message.content === "finish visibly"), true);
  assert.equal(
    llmMessages.some(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("<interjection>"),
    ),
    true,
  );
});

test("summary layer renders as a user turn ahead of chat and trigger", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      {
        type: "summaryLayer",
        role: "user",
        content: "<summary level=\"1\">old history</summary>",
        tier: "summary",
        tokenEstimate: 1,
        timestamp: 10,
      },
      { type: "chatEvent", role: "user", content: "<message>recent</message>", tier: "compact", tokenEstimate: 1, timestamp: 20 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 4,
    compactTokens: 1,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;

  const messages = buildAgentContextMessages(built, []);

  assert.deepEqual(
    messages.map((m) => (m as any).type),
    ["chatEvent", "chatEvent", "triggerGroup"],
  );
  // The summary layer is the first chatEvent, role user, carrying the summary body.
  assert.equal((messages[0] as any).role, "user");
  assert.match((messages[0] as any).content, /<summary/);

  const llm = convertToLlm(messages);
  assert.equal(
    llm.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<summary")),
    true,
  );
});

test("convertToLlm filters accidental system transcript messages", () => {
  const messages = convertToLlm([{ role: "system", content: "duplicate system", timestamp: 1 } as any]);
  assert.deepEqual(messages, []);
});

test("convertToLlm renders historical assistant chat events as assistant messages", () => {
  const messages = convertToLlm([
    {
      type: "chatEvent",
      role: "assistant",
      content: "<message sender=\"Miku\">hello</message>",
      timestamp: 1,
    } as any,
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
});
