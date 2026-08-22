import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { CanonicalChatEvent, ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";
import { formatAgentTimestamp } from "../time/index.js";
import { parseTimelineKey } from "../timeline/index.js";
import type { Storage } from "../storage/index.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";

export interface ReadMessagesToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
  /**
   * Optional resolver for the `room` parameter (spec CROSS-CHANNEL-MESSAGING §4.6).
   * When given, `room` is resolved to a ChannelClient for that timeline key.
   * If absent, the `room` parameter returns an error.
   */
  resolveChannelClient?: (timelineKey: string) => ChannelClient | undefined;
  /**
   * Storage, required for `room` user-id sugar and `anchor: "last_self"`.
   * Absent → those features return graceful errors.
   */
  storage?: Storage;
  /** Current timeline key, used as the referent for visibility checks. */
  currentTimelineKey?: string;
  /** Visibility resolver for the `room` parameter. */
  visibilityResolver?: ChannelVisibilityResolver;
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

/** Format a list of CanonicalChatEvents from storage as a simple text listing. */
function formatStorageEvents(events: CanonicalChatEvent[]): string {
  if (events.length === 0) return "No messages found.";
  return events
    .map((e) => {
      const sender = e.sender.displayName ?? e.sender.username ?? e.sender.id;
      const self = e.sender.isSelf ? " [you]" : "";
      const note = e.crossChannel
        ? ` [cross-channel note: ${e.crossChannel.note}]`
        : "";
      return `[${fmtTs(e.timestamp)}] ${sender}${self}: ${e.body}${note}`;
    })
    .join("\n");
}

export function createReadMessagesTool(context: ReadMessagesToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "read_messages",
    label: "Read messages",
    description:
      `Read message history from the current ${t.channelNoun}, or look up a single message by event ID. ` +
      "Use for retrieving messages outside your current context window. " +
      "Pass `room` to read a different channel or DM. Pass `anchor: \"last_self\"` to center the window on your most recent message there (useful for checking on an errand).",
    parameters: Type.Object({
      message_id: Type.Optional(Type.String({ description: `${t.messageIdFmt} to look up a single message. When omitted, returns paginated ${t.channelNoun} history instead.` })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max messages to return for paginated history. Ignored when message_id is provided." })),
      before: Type.Optional(Type.String({ description: "Pagination token for older messages (from a previous read_messages result's next_batch)." })),
      after: Type.Optional(Type.String({ description: "Pagination token for newer messages (from a previous read_messages result's prev_batch)." })),
      room: Type.Optional(Type.String({
        description:
          "Timeline key of another channel to read from, OR a user id as sugar for " +
          "\"my existing DM with this user\" (no DM exists → error with candidates). " +
          "Absent = current channel. Isolated channels outside the current session are refused.",
      })),
      anchor: Type.Optional(
        Type.Union([Type.Literal("end"), Type.Literal("last_self")], {
          description:
            "Where to anchor the history window. \"end\" (default): most recent messages. " +
            "\"last_self\": window centered on the agent's most recent sent message in that channel " +
            "— one indexed lookup; useful for checking the status of an errand.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        message_id?: string;
        limit?: number;
        before?: string;
        after?: string;
        room?: string;
        anchor?: "end" | "last_self";
      };

      // ── Room resolution (spec §4.6) ─────────────────────────────────────────
      let activeClient: ChannelClient = context.channelClient;
      let activeTimelineKey: string | undefined = context.currentTimelineKey;

      if (args.room?.trim()) {
        const roomArg = args.room.trim();

        // Check visibility before doing anything else.
        if (context.visibilityResolver && context.currentTimelineKey) {
          const mode = context.visibilityResolver.modeFor(roomArg);
          if (mode === "isolated" && !context.visibilityResolver.sameChannel(roomArg, context.currentTimelineKey)) {
            return {
              content: [{
                type: "text",
                text:
                  `Cannot read "${roomArg}": that channel is isolated and this session is not in it. ` +
                  "If you were trying to check on a DM errand, the conversation is private — ask the other person directly.",
              }],
              details: null,
            };
          }
        }

        const parsed = parseTimelineKey(roomArg);
        if (parsed) {
          // It's a valid timeline key — resolve its ChannelClient.
          if (!context.resolveChannelClient) {
            return {
              content: [{ type: "text", text: "error: room parameter is not supported in this session context." }],
              details: null,
            };
          }
          const resolved = context.resolveChannelClient(roomArg);
          if (!resolved) {
            return {
              content: [{
                type: "text",
                text: `Cannot resolve a channel client for "${roomArg}". Verify the timeline key is correct and the bot is joined.`,
              }],
              details: null,
            };
          }
          activeClient = resolved;
          activeTimelineKey = roomArg;
        } else {
          // Not a timeline key — treat as a user id and look up an existing DM.
          if (!context.storage) {
            return {
              content: [{ type: "text", text: "error: room user-id sugar requires storage context (not available here)." }],
              details: null,
            };
          }
          const dmKeys = context.storage.findDmTimelineKeysForUser(roomArg, { limit: 5 });
          if (dmKeys.length === 0) {
            return {
              content: [{
                type: "text",
                text: `No existing DM found with user "${roomArg}". A DM channel is only opened by send_dm.`,
              }],
              details: null,
            };
          }
          // Use the most recent DM (first in list, most-recent ordering from DB).
          const dmKey = dmKeys[0];
          // C2 guard: run a second visibility check on the resolved DM key itself.
          // The earlier check on roomArg used the raw (non-parseable) input which
          // resolves to "shared" for all unknown keys — the isolated DM would slip
          // through. We must check the actual timeline key.
          if (context.visibilityResolver && context.currentTimelineKey) {
            const dmMode = context.visibilityResolver.modeFor(dmKey);
            if (dmMode === "isolated" && !context.visibilityResolver.sameChannel(dmKey, context.currentTimelineKey)) {
              return {
                content: [{
                  type: "text",
                  text:
                    `Cannot read DM with "${roomArg}": that conversation is isolated ` +
                    "and this session is not in it.",
                }],
                details: null,
              };
            }
          }
          if (!context.resolveChannelClient) {
            // Fall back to storage-only mode for DM keys when no channel resolver.
            const events = context.storage.getTimelineEvents(dmKey, args.limit ?? 20);
            const anchor = args.anchor ?? "end";
            if (anchor === "last_self") {
              const lastSelf = context.storage.getLastAssistantEvent(dmKey);
              if (!lastSelf) {
                return {
                  content: [{ type: "text", text: `No messages sent by me found in DM ${dmKey}.` }],
                  details: null,
                };
              }
              const idx = events.findIndex((e) => e.id === lastSelf.id);
              const window = idx >= 0
                ? events.slice(Math.max(0, idx - 5), idx + 6)
                : [lastSelf];
              return {
                content: [{ type: "text", text: formatStorageEvents(window) }],
                details: { count: window.length, timelineKey: dmKey, anchor: "last_self" },
              };
            }
            return {
              content: [{ type: "text", text: formatStorageEvents(events) }],
              details: { count: events.length, timelineKey: dmKey },
            };
          }
          const resolved = context.resolveChannelClient(dmKey);
          if (!resolved) {
            // Fall back to storage-only mode.
            const events = context.storage.getTimelineEvents(dmKey, args.limit ?? 20);
            return {
              content: [{ type: "text", text: formatStorageEvents(events) }],
              details: { count: events.length, timelineKey: dmKey },
            };
          }
          activeClient = resolved;
          activeTimelineKey = dmKey;
        }
      }

      // ── anchor: last_self ───────────────────────────────────────────────────
      let beforeCursor = args.before;
      if ((args.anchor ?? "end") === "last_self") {
        if (!context.storage || !activeTimelineKey) {
          // Can't do last_self without storage — degrade gracefully.
          beforeCursor = undefined;
        } else {
          const lastSelf = context.storage.getLastAssistantEvent(activeTimelineKey);
          if (!lastSelf) {
            return {
              content: [{
                type: "text",
                text: `No messages sent by me found in ${activeTimelineKey ?? "this channel"}.`,
              }],
              details: null,
            };
          }
          // Use the external id as the "before" cursor to get messages up to and
          // including the self message. Providers that don't support this cursor
          // will fall through to the default end-window.
          if (lastSelf.externalId) {
            beforeCursor = lastSelf.externalId;
          }
          // Return the storage window around the last self event.
          const events = context.storage.getTimelineEvents(activeTimelineKey, (args.limit ?? 20) + 10);
          const idx = events.findIndex((e) => e.id === lastSelf.id || e.externalId === lastSelf.externalId);
          const window = idx >= 0
            ? events.slice(Math.max(0, idx - 5), idx + 6)
            : events.slice(-10);
          return {
            content: [{ type: "text", text: formatStorageEvents(window) }],
            details: { count: window.length, anchor: "last_self", anchorEventId: lastSelf.id },
          };
        }
      }

      // ── Normal read path ────────────────────────────────────────────────────
      try {
        if (args.message_id?.trim()) {
          const summary = await activeClient.readMessage(args.message_id.trim());
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

        const result = await activeClient.readMessages({
          limit: args.limit,
          before: beforeCursor,
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
