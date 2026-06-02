import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface PinsToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createPinsTool(context: PinsToolContext): AgentTool {
  return {
    name: "pins",
    label: "Pin management",
    description: "Pin, unpin, or list pinned messages in the current room. Pinning/unpinning requires sufficient room permissions.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pin"),
        Type.Literal("unpin"),
        Type.Literal("list"),
      ], { description: "Action to perform: pin a message, unpin a message, or list all pinned messages." }),
      message_id: Type.Optional(Type.String({ description: "Matrix event ID. Required for pin/unpin actions." })),
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
          const result = await context.client.listPins({ roomId: context.roomId });
          if (result.events.length === 0) {
            return {
              content: [{ type: "text", text: "No pinned messages in this room." }],
              details: result,
            };
          }
          const lines = result.events.map((ev) => {
            const name = ev.senderName ?? ev.sender;
            const body = ev.body.length > 100 ? ev.body.slice(0, 100) + "…" : ev.body;
            let time: string;
            try {
              time = formatAgentTimestamp(new Date(/^\d+$/.test(ev.timestamp) ? Number(ev.timestamp) : ev.timestamp));
            } catch {
              time = ev.timestamp;
            }
            return `[${ev.eventId}] ${name}: ${body} (${time})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: result,
          };
        }

        if (args.action === "pin") {
          const result = await context.client.pinMessage({
            roomId: context.roomId,
            messageId: args.message_id!.trim(),
          });
          return {
            content: [{ type: "text", text: `pinned message. ${result.pinned.length} total pins.` }],
            details: result,
          };
        }

        const result = await context.client.unpinMessage({
          roomId: context.roomId,
          messageId: args.message_id!.trim(),
        });
        return {
          content: [{ type: "text", text: `unpinned message. ${result.pinned.length} total pins.` }],
          details: result,
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
