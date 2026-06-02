import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface ReadMessagesToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

/**
 * Render a `MatrixMessageSummary.timestamp` (RFC3339 string or epoch-ms numeric
 * string) in the configured agent timezone, falling back to the raw string on an
 * invalid date — mirrors the treatment in src/tools/pins.ts.
 */
function fmtTs(timestamp: string): string {
  try {
    return formatAgentTimestamp(new Date(/^\d+$/.test(timestamp) ? Number(timestamp) : timestamp));
  } catch {
    return timestamp;
  }
}

export function createReadMessagesTool(context: ReadMessagesToolContext): AgentTool {
  return {
    name: "read_messages",
    label: "Read messages",
    description: "Read message history from the current room, or look up a single message by event ID. Use for retrieving messages outside your current context window.",
    parameters: Type.Object({
      message_id: Type.Optional(Type.String({ description: "Matrix event ID to look up a single message. When omitted, returns paginated room history instead." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max messages to return for paginated history. Ignored when message_id is provided." })),
      before: Type.Optional(Type.String({ description: "Pagination token for older messages (from a previous read_messages result's next_batch)." })),
      after: Type.Optional(Type.String({ description: "Pagination token for newer messages (from a previous read_messages result's prev_batch)." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id?: string; limit?: number; before?: string; after?: string };

      try {
        if (args.message_id?.trim()) {
          const summary = await context.client.messageSummary({
            roomId: context.roomId,
            eventId: args.message_id.trim(),
          });
          if (!summary) {
            return {
              content: [{ type: "text", text: `message "${args.message_id}" not found in this room.` }],
              details: null,
            };
          }
          const senderLabel = summary.senderName ?? summary.sender;
          return {
            content: [{ type: "text", text: `[${fmtTs(summary.timestamp)}] ${senderLabel}: ${summary.body}` }],
            details: summary,
          };
        }

        const result = await context.client.readMessages({
          roomId: context.roomId,
          limit: args.limit,
          before: args.before,
          after: args.after,
        });

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text", text: "No messages found." }],
            details: { nextBatch: result.nextBatch ?? null, prevBatch: result.prevBatch ?? null },
          };
        }

        const lines = result.messages.map((m) => {
          const sender = m.senderName ?? m.sender;
          return `[${fmtTs(m.timestamp)}] ${sender}: ${m.body}`;
        });

        const pagination: string[] = [];
        if (result.nextBatch) pagination.push(`next_batch: ${result.nextBatch}`);
        if (result.prevBatch) pagination.push(`prev_batch: ${result.prevBatch}`);
        const paginationLine = pagination.length > 0 ? `\n\n${pagination.join("\n")}` : "";

        return {
          content: [{ type: "text", text: lines.join("\n") + paginationLine }],
          details: {
            count: result.messages.length,
            nextBatch: result.nextBatch ?? null,
            prevBatch: result.prevBatch ?? null,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (args.message_id && (message.includes("not found") || message.includes("unknown event"))) {
          return {
            content: [{ type: "text", text: `error: message "${args.message_id}" not found in this room. Use a valid event ID from the conversation context.` }],
            details: null,
          };
        }
        return {
          content: [{ type: "text", text: `error: read messages failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
