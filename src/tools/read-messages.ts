import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface ReadMessagesToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

/**
 * Render a timestamp (epoch ms number) in the configured agent timezone,
 * falling back to the raw number string on an invalid date — mirrors the
 * treatment in src/tools/pins.ts.
 */
function fmtTs(timestamp: number): string {
  try {
    return formatAgentTimestamp(new Date(timestamp));
  } catch {
    return String(timestamp);
  }
}

export function createReadMessagesTool(context: ReadMessagesToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "read_messages",
    label: "Read messages",
    description: `Read message history from the current ${t.channelNoun}, or look up a single message by event ID. Use for retrieving messages outside your current context window.`,
    parameters: Type.Object({
      message_id: Type.Optional(Type.String({ description: `${t.messageIdFmt} to look up a single message. When omitted, returns paginated ${t.channelNoun} history instead.` })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max messages to return for paginated history. Ignored when message_id is provided." })),
      before: Type.Optional(Type.String({ description: "Pagination token for older messages (from a previous read_messages result's next_batch)." })),
      after: Type.Optional(Type.String({ description: "Pagination token for newer messages (from a previous read_messages result's prev_batch)." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id?: string; limit?: number; before?: string; after?: string };

      try {
        if (args.message_id?.trim()) {
          const summary = await context.channelClient.readMessage(args.message_id.trim());
          if (!summary) {
            return {
              content: [{ type: "text", text: `message "${args.message_id}" not found in this ${t.channelNoun}.` }],
              details: null,
            };
          }
          const senderLabel = summary.sender.displayName ?? summary.sender.id;
          return {
            content: [{ type: "text", text: `[${fmtTs(summary.timestamp)}] ${senderLabel}: ${summary.body}` }],
            details: summary,
          };
        }

        const result = await context.channelClient.readMessages({
          limit: args.limit,
          before: args.before,
          after: args.after,
        });

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text", text: "No messages found." }],
            details: { nextBatch: result.nextCursor ?? null, prevBatch: result.prevCursor ?? null },
          };
        }

        const lines = result.messages.map((m) => {
          const sender = m.sender.displayName ?? m.sender.id;
          return `[${fmtTs(m.timestamp)}] ${sender}: ${m.body}`;
        });

        const pagination: string[] = [];
        if (result.nextCursor) pagination.push(`next_batch: ${result.nextCursor}`);
        if (result.prevCursor) pagination.push(`prev_batch: ${result.prevCursor}`);
        const paginationLine = pagination.length > 0 ? `\n\n${pagination.join("\n")}` : "";

        return {
          content: [{ type: "text", text: lines.join("\n") + paginationLine }],
          details: {
            count: result.messages.length,
            nextBatch: result.nextCursor ?? null,
            prevBatch: result.prevCursor ?? null,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (args.message_id && (message.includes("not found") || message.includes("unknown event"))) {
          return {
            content: [{ type: "text", text: `error: message "${args.message_id}" not found in this ${t.channelNoun}. Use a valid event ID from the conversation context.` }],
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
