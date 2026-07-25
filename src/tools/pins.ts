import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface PinsToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createPinsTool(context: PinsToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "pins",
    label: "Pin management",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: `Pin, unpin, or list pinned messages in the current ${t.channelNoun}. Pinning/unpinning requires sufficient ${t.channelNoun} permissions.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pin"),
        Type.Literal("unpin"),
        Type.Literal("list"),
      ], { description: "Action to perform: pin a message, unpin a message, or list all pinned messages." }),
      message_id: Type.Optional(Type.String({ description: `${t.messageIdFmt}. Required for pin/unpin actions.` })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { action: "pin" | "unpin" | "list"; message_id?: string };

      if ((args.action === "pin" || args.action === "unpin") && !args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: `error: message_id is required for ${args.action} action.` }],
          details: null,
        };
      }

      try {
        if (args.action === "list") {
          const pins = await context.channelClient.pins();
          if (pins.length === 0) {
            return {
              content: [{ type: "text", text: `No pinned messages in this ${t.channelNoun}.` }],
              details: { events: [] },
            };
          }
          const lines = pins.map((p) => {
            const name = p.sender.displayName ?? p.sender.id;
            const body = p.body.length > 100 ? p.body.slice(0, 100) + "…" : p.body;
            let time: string;
            try {
              time = formatAgentTimestamp(new Date(p.timestamp));
            } catch {
              time = String(p.timestamp);
            }
            return `[${p.externalId}] ${name}: ${body} (${time})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: pins.length },
          };
        }

        if (args.action === "pin") {
          const result = await context.channelClient.pinMessage(args.message_id!.trim());
          const pinCount = (result as { pinCount?: number } | null | void)?.pinCount;
          const suffix = pinCount != null ? ` ${pinCount} total pins.` : "";
          return {
            content: [{ type: "text", text: `pinned message.${suffix}` }],
            details: null,
          };
        }

        const result = await context.channelClient.unpinMessage(args.message_id!.trim());
        const pinCount = (result as { pinCount?: number } | null | void)?.pinCount;
        const suffix = pinCount != null ? ` ${pinCount} total pins.` : "";
        return {
          content: [{ type: "text", text: `unpinned message.${suffix}` }],
          details: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${args.action} failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
