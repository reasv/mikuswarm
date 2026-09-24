import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * `no_reply`: the agent's way to end a turn without posting. Calling it is the
 * default silence signal in every chat session (the text marker `NO_REPLY` is
 * still accepted for compatibility, see ARCHITECTURE.md §8 "Turn contract").
 * The result carries `terminate: true`, so the run ends exactly as it does after
 * a final `send_message`; the runner treats the call as an explicit no-reply for
 * dedup, claim, and diary purposes. Under a prefill-enabled model the wire
 * transform gives it the same leading `analysis` argument as every other tool.
 */
export function createNoReplyTool(): AgentTool {
  return {
    name: "no_reply",
    label: "No reply",
    description:
      "End your turn without posting anything. Call this instead of send_message when you have nothing to say.",
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ noReply: true }>> => ({
      content: [{ type: "text", text: "NO_REPLY_CALLED" }],
      details: { noReply: true },
      terminate: true,
    }),
  } as unknown as AgentTool;
}
