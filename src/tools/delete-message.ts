import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface DeleteMessageToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createDeleteMessageTool(context: DeleteMessageToolContext): AgentTool {
  return {
    name: "delete_message",
    label: "Delete message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Redact (delete) a message. This is irreversible. You can freely delete your own messages; deleting others' messages requires moderator permissions.",
    parameters: Type.Object({
      message_id: Type.String({ description: "Matrix event ID of the message to delete." }),
      reason: Type.Optional(Type.String({ description: "Reason for deletion (visible to room members)." })),
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
        const result = await context.client.deleteMessage({
          roomId: context.roomId,
          messageId: args.message_id.trim(),
          reason: args.reason,
        });
        return {
          content: [{ type: "text", text: `deleted message ${result.messageId}` }],
          details: result,
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
