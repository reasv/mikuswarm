import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface ReactToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createReactTool(context: ReactToolContext): AgentTool {
  return {
    name: "react",
    label: "React to message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Add or remove an emoji reaction on a message. Use unicode emoji directly or :shortcode: for custom emoji.",
    parameters: Type.Object({
      message_id: Type.String({ description: "Matrix event ID of the message to react to." }),
      emoji: Type.String({ description: "Emoji to react with. Unicode emoji (e.g. 👍) or :shortcode: (e.g. :custom_emoji:)." }),
      remove: Type.Optional(Type.Boolean({ description: "Set to true to remove the reaction instead of adding it." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string; emoji: string; remove?: boolean };

      if (!args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: message_id is required." }],
          details: null,
        };
      }
      if (!args.emoji?.trim()) {
        return {
          content: [{ type: "text", text: "error: emoji is required." }],
          details: null,
        };
      }

      try {
        const result = await context.client.reactMessage({
          roomId: context.roomId,
          messageId: args.message_id.trim(),
          key: args.emoji.trim(),
          remove: args.remove ?? false,
        });
        if (args.remove) {
          return {
            content: [{ type: "text", text: `removed ${result.removed} reaction(s)` }],
            details: result,
          };
        }
        const display = result.reaction?.display ?? args.emoji.trim();
        return {
          content: [{ type: "text", text: `reacted with ${display}` }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found") || message.includes("unknown event")) {
          return {
            content: [{ type: "text", text: `error: message_id "${args.message_id}" not found in this room. Use a valid event ID from the conversation context.` }],
            details: null,
          };
        }
        return {
          content: [{ type: "text", text: `error: reaction failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
