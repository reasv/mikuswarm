import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface DeleteMessageToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createDeleteMessageTool(context: DeleteMessageToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "delete_message",
    label: "Delete message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Redact (delete) a message. This is irreversible. You can freely delete your own messages; deleting others' messages requires moderator permissions.",
    parameters: Type.Object({
      message_id: Type.String({ description: `${t.messageIdFmt} of the message to delete.` }),
      reason: Type.Optional(Type.String({ description: `Reason for deletion (visible to ${t.channelNoun} members).` })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string; reason?: string };

      if (!args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: message_id is required." }],
          details: null,
        };
      }

      try {
        await context.channelClient.deleteMessage(args.message_id.trim(), args.reason);
        return {
          content: [{ type: "text", text: `deleted message ${args.message_id.trim()}` }],
          details: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: delete failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
