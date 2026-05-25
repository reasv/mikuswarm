import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface EditMessageToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createEditMessageTool(context: EditMessageToolContext): AgentTool {
  return {
    name: "edit_message",
    label: "Edit message",
    description: "Edit one of your own previously sent messages. Only messages sent by you can be edited.",
    parameters: Type.Object({
      message_id: Type.String({ description: "Matrix event ID of the message to edit." }),
      text: Type.String({ description: "New message text to replace the original." }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string; text: string };

      if (!args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: message_id is required." }],
          details: null,
        };
      }
      if (!args.text?.trim()) {
        return {
          content: [{ type: "text", text: "error: text is required." }],
          details: null,
        };
      }

      try {
        const result = await context.client.editMessage({
          roomId: context.roomId,
          messageId: args.message_id.trim(),
          text: args.text,
        });
        return {
          content: [{ type: "text", text: `edited message, new event ID: ${result.eventId}` }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: edit failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
