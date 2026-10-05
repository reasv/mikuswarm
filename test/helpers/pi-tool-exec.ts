/**
 * Run one tool call through pi-agent-core's real tool-execution path.
 *
 * A tool's raw `execute` return says nothing about how the call lands on the
 * wire: pi marks a toolResult `isError` only when `execute` THROWS (a returned
 * result is always a success). Tests that assert error semantics must look at
 * the toolResult message pi builds, which is what this helper returns.
 *
 * The scripted model answers the first request with the given tool call and
 * the second with a plain stop, so exactly one tool execution happens.
 */
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: string; text?: string }[];
  details: unknown;
  isError: boolean;
  addedToolNames?: string[];
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL = {
  id: "scripted",
  name: "scripted",
  api: "anthropic-messages",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
} as unknown as Model<"anthropic-messages">;

/**
 * Execute `name(args)` via a pi Agent run and return the resulting toolResult
 * message, plus `modelRequests`: 1 when the result terminated the run, 2 when
 * the loop went back to the model.
 */
export async function runToolViaPi(
  tools: AgentTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<PiToolResultMessage & { modelRequests: number }> {
  let requests = 0;
  const streamFn: StreamFn = (model) => {
    requests++;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: requests === 1 ? [{ type: "toolCall", id: "tc_pi_1", name, arguments: args }] : [{ type: "text", text: "done" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: requests === 1 ? "toolUse" : "stop",
      timestamp: Date.now(),
    } as never;
    stream.push({ type: "done", reason: requests === 1 ? "toolUse" : "stop", message } as never);
    stream.end(message);
    return stream;
  };
  const agent = new Agent({
    streamFn,
    initialState: { systemPrompt: "", model: MODEL, tools, messages: [] },
  });
  await agent.prompt("go");
  const result = (agent.state.messages as AgentMessage[]).find(
    (m) => (m as { role?: string }).role === "toolResult",
  );
  if (!result) throw new Error(`pi produced no toolResult for ${name}`);
  return { ...(result as unknown as PiToolResultMessage), modelRequests: requests };
}

/** The concatenated text of a toolResult message. */
export function resultText(result: PiToolResultMessage): string {
  return result.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}
