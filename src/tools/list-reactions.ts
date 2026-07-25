import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface ListReactionsToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createListReactionsTool(context: ListReactionsToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "list_reactions",
    label: "List reactions",
    description: "List all reactions on a specific message, showing who reacted with what.",
    parameters: Type.Object({
      message_id: Type.String({ description: `${t.messageIdFmt} of the message to list reactions for.` }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max number of reactions to return." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string; limit?: number };

      if (!args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: message_id is required." }],
          details: null,
        };
      }

      try {
        const reactions = await context.channelClient.listReactions(args.message_id.trim(), args.limit);

        if (reactions.length === 0) {
          return {
            content: [{ type: "text", text: "No reactions on this message." }],
            details: null,
          };
        }

        const lines = reactions.map((r) => {
          const label = r.shortcode ? `${r.display} :${r.shortcode}:` : r.display;
          return `${label} (${r.count}): ${r.users.join(", ")}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: reactions,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: list reactions failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
