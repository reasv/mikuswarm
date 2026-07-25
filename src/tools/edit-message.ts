import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface EditMessageToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createEditMessageTool(context: EditMessageToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "edit_message",
    label: "Edit message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Edit one of your own previously sent messages. Only messages sent by you can be edited.",
    parameters: Type.Object({
      message_id: Type.String({ description: `${t.messageIdFmt} of the message to edit.` }),
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
        const result = await context.channelClient.editMessage(args.message_id.trim(), args.text);
        const newId = (result as { externalId?: string } | null | void)?.externalId;
        return {
          content: [{ type: "text", text: newId != null ? `edited message, new event ID: ${newId}` : `edited message` }],
          details: null,
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
