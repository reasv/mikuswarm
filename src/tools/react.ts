import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface ReactToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createReactTool(context: ReactToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "react",
    label: "React to message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Add or remove an emoji reaction on a message. Use unicode emoji directly or :shortcode: for custom emoji.",
    parameters: Type.Object({
      message_id: Type.String({ description: `${t.messageIdFmt} of the message to react to.` }),
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
        const messageId = args.message_id.trim();
        const emoji = args.emoji.trim();
        if (args.remove) {
          const removeResult = await context.channelClient.unreact(messageId, emoji);
          const count = (removeResult as { removed?: number } | void)?.removed;
          return {
            content: [{ type: "text", text: count != null ? `removed ${count} reaction(s)` : `removed reaction` }],
            details: null,
          };
        }
        const result = await context.channelClient.react(messageId, emoji);
        const display = (result as { display?: string } | null | void)?.display ?? emoji;
        return {
          content: [{ type: "text", text: `reacted with ${display}` }],
          details: null,
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
