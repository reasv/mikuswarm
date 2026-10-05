/**
 * Drives an AgentTool through a real pi-agent-core `Agent` run, so tests observe
 * the `toolResult` messages the agent loop actually builds (including the
 * `isError` flag, which pi sets only when `execute()` throws) rather than the raw
 * `execute()` return value.
 *
 * A scripted model issues each entry of `calls` as its own assistant turn (one
 * tool call per turn), then ends the run with a plain text stop. A tool result
 * with `terminate: true` ends the run early, exactly as in a live session, so
 * scripted calls after it never execute.
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

const MODEL = {
  id: "scripted",
  name: "scripted",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://scripted.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
} as Model<Api>;

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export interface ToolRun {
  /** The toolResult messages, in call order, as pi-agent-core built them. */
  results: ToolResultMessage[];
  /** How many model turns the run took (a terminating result skips the rest). */
  turns: number;
}

export async function runToolCalls(tool: AgentTool<any>, calls: Array<Record<string, unknown>>): Promise<ToolRun> {
  let turns = 0;
  const agent = new Agent({
    initialState: { systemPrompt: "", model: MODEL, tools: [tool] },
    streamFn: () => {
      const index = turns++;
      const message = index < calls.length
        ? assistant([{ type: "toolCall", id: `call-${index}`, name: tool.name, arguments: calls[index]! }], "toolUse")
        : assistant([{ type: "text", text: "done" }], "stop");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end(message);
      });
      return stream;
    },
  });
  await agent.prompt("go");
  await agent.waitForIdle();
  if (agent.state.errorMessage) throw new Error(`scripted run failed: ${agent.state.errorMessage}`);
  const results = agent.state.messages.filter(
    (m): m is ToolResultMessage => (m as { role?: string }).role === "toolResult",
  );
  return { results, turns };
}

/** Joined text content of a tool result. */
export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}
