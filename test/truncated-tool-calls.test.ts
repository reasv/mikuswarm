import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { withTruncatedToolCallsAsLength } from "../src/agent/truncated-tool-calls.js";

// ---------------------------------------------------------------------------
// A Chat Completions tool call cut off at the output cap but reported as
// `finish_reason: "tool_calls"` is surfaced as a `length` stop, so the agent
// loop fails the call instead of running salvaged, incomplete arguments.
// ---------------------------------------------------------------------------

const model = (api: string) => ({ id: "m", api, provider: "p", maxTokens: 1000 }) as any;

function doneBase(reason: "toolUse" | "stop", output: number) {
  return () => {
    const s = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }],
      api: "openai-completions",
      provider: "p",
      model: "m",
      usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason,
      timestamp: 1,
    } as any;
    queueMicrotask(() => s.push({ type: "done", reason, message }));
    return s;
  };
}

async function terminal(stream: any) {
  let last: any;
  for await (const event of stream) last = event;
  return last;
}

test("a tool-call stop whose output reached the request cap becomes a length stop", async () => {
  const seen: unknown[] = [];
  const fn = withTruncatedToolCallsAsLength(doneBase("toolUse", 800) as any, (info) => seen.push(info));
  const event = await terminal(await fn(model("openai-completions"), { messages: [] } as any, { maxTokens: 800 }));
  assert.equal(event.reason, "length");
  assert.equal(event.message.stopReason, "length");
  assert.deepEqual(seen, [{ model: "m", outputTokens: 800, maxTokens: 800 }]);
});

test("the model's max_tokens is the cap when the request sets none", async () => {
  const fn = withTruncatedToolCallsAsLength(doneBase("toolUse", 1000) as any);
  const event = await terminal(await fn(model("openai-completions"), { messages: [] } as any, {}));
  assert.equal(event.message.stopReason, "length");
});

test("under the cap, non-tool stops and other APIs pass through untouched", async () => {
  const under = withTruncatedToolCallsAsLength(doneBase("toolUse", 999) as any);
  assert.equal((await terminal(await under(model("openai-completions"), { messages: [] } as any, {}))).message.stopReason, "toolUse");
  const stop = withTruncatedToolCallsAsLength(doneBase("stop", 1000) as any);
  assert.equal((await terminal(await stop(model("openai-completions"), { messages: [] } as any, {}))).message.stopReason, "stop");
  const other = withTruncatedToolCallsAsLength(doneBase("toolUse", 1000) as any);
  assert.equal((await terminal(await other(model("anthropic-messages"), { messages: [] } as any, {}))).message.stopReason, "toolUse");
});

test("a base that throws ends the stream with an error event", async () => {
  const fn = withTruncatedToolCallsAsLength((() => {
    throw new Error("boom");
  }) as any);
  const event = await terminal(await fn(model("openai-completions"), { messages: [] } as any, {}));
  assert.equal(event.type, "error");
  assert.equal(event.error.errorMessage, "boom");
});
