import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatProvider, CanonicalChatEvent, OutboundTarget } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";

export interface SendMessageToolContext {
  provider: ChatProvider;
  target: OutboundTarget;
  timeline: TimelineStore;
  agentSessionId: string;
  recordSentMessage?: (message: string) => void;
}

export function createSendMessageTool(context: SendMessageToolContext): AgentTool {
  return {
    name: "send_message",
    label: "Send message",
    description: "Send a message immediately to the current Matrix room.",
    parameters: Type.Object({
      message: Type.String(),
      html: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message: string; html?: string };
      const receipt = await context.provider.send(context.target, {
        body: args.message,
        htmlBody: args.html,
        agentSessionId: context.agentSessionId,
      });
      context.recordSentMessage?.(args.message);
      const event: CanonicalChatEvent = {
        id: `assistant:${context.agentSessionId}:${receipt.externalId ?? Date.now()}`,
        externalId: receipt.externalId,
        timelineKey: context.target.timelineKey,
        provider: context.provider.id,
        agentSessionId: context.agentSessionId,
        role: "assistant",
        sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
        body: args.message,
        htmlBody: args.html,
        timestamp: receipt.deliveredAt,
        receivedAt: Date.now(),
      };
      await context.timeline.append(event);
      return {
        content: [{ type: "text", text: `sent: ${receipt.externalId ?? "local"}` }],
        details: receipt,
      };
    },
  };
}
