import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.js";
import { type ChatSearchIndexer, resolveRooms, resolveTimeWindow } from "../search/index.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface UserActivityToolContext {
  storage: Storage;
  indexer: ChatSearchIndexer;
  currentTimelineKey: string;
  now?: () => number;
}

interface UserActivityArgs {
  user?: string;
  rooms?: string[] | "current" | "all";
  last?: string;
  after?: string;
  before?: string;
  limit?: number;
}

interface SenderAgg {
  senderId: string;
  total: number;
  firstAt: number;
  lastAt: number;
  perRoom: Array<{ room: string; count: number; lastAt: number }>;
}

function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

export function createUserActivityTool(context: UserActivityToolContext): AgentTool {
  const now = context.now ?? (() => Date.now());
  return {
    name: "user_activity",
    label: "User activity",
    description:
      "Message-count statistics over a time window — how much a user (or everyone) has posted, " +
      "broken down by room, with first/last-seen. Give a user id for one person, or omit it for a " +
      'roster of everyone ranked by activity (the "who is inactive?" view). Defaults to all rooms ' +
      'and the last 30 days. Returns counts, not message text — use search_messages to read messages.',
    parameters: Type.Object({
      user: Type.Optional(Type.String({ description: "Sender id to report on. Omit for an all-users roster." })),
      rooms: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Array(Type.String())], {
          description: 'Rooms to count across. Default "all".',
        }),
      ),
      last: Type.Optional(Type.String({ description: 'Window, e.g. "30d", "7d", "24h". Default "30d".' })),
      after: Type.Optional(Type.String({ description: "Explicit lower bound (ISO or YYYY-MM-DD); overrides last." })),
      before: Type.Optional(Type.String({ description: "Explicit upper bound (ISO or YYYY-MM-DD)." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Roster size (default 50)." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as UserActivityArgs;
      const startedAt = performance.now();
      const nowMs = now();
      await context.indexer.ensureFreshForQuery();

      const timelineKeys = resolveRooms(args.rooms ?? "all", context.currentTimelineKey);
      // Inject the "30d" default ONLY when no bound at all is given. A lone `before`
      // must leave the lower bound OPEN (all-time up to `before`) — otherwise the
      // default `last:"30d"` injects `afterTs = now-30d`, which for a `before` older
      // than 30 days inverts the window (afterTs > beforeTs) and matches nothing.
      const hasExplicit =
        args.last !== undefined || args.after !== undefined || args.before !== undefined;
      const window = resolveTimeWindow(
        { last: hasExplicit ? args.last : "30d", after: args.after, before: args.before },
        nowMs,
      );

      const limit = args.limit ?? 50;
      // Single-user path: one sender's per-room breakdown (unbounded work is fine — it's
      // one sender). Roster path: bound the work in SQL via `topChatActivity`, which ranks
      // senders by global total and fetches per-room detail only for the top `limit`
      // (review #6); `totalSenders` carries the true count for the "(+N more)" line.
      let rows: Array<{ senderId: string; timelineKey: string; count: number; firstAt: number; lastAt: number }>;
      let totalSenders: number;
      if (args.user) {
        rows = context.storage.aggregateChatActivity({
          senderId: args.user,
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
        });
        totalSenders = rows.length > 0 ? 1 : 0;
      } else {
        const res = context.storage.topChatActivity({
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
          limit,
        });
        rows = res.rows;
        totalSenders = res.totalSenders;
      }

      const bySender = new Map<string, SenderAgg>();
      for (const r of rows) {
        const agg =
          bySender.get(r.senderId) ??
          ({ senderId: r.senderId, total: 0, firstAt: r.firstAt, lastAt: r.lastAt, perRoom: [] } as SenderAgg);
        agg.total += r.count;
        agg.firstAt = Math.min(agg.firstAt, r.firstAt);
        agg.lastAt = Math.max(agg.lastAt, r.lastAt);
        agg.perRoom.push({ room: r.timelineKey, count: r.count, lastAt: r.lastAt });
        bySender.set(r.senderId, agg);
      }
      // `topChatActivity` already returns only the top `limit` senders (per-room rows for
      // each), so `shown` is the full roster page; `totalSenders` is the true overflow base.
      const shown = [...bySender.values()].sort((a, b) => b.total - a.total);
      const elapsedMs = Math.round(performance.now() - startedAt);

      const windowLabel =
        window.afterTs !== undefined
          ? `${fmtTs(window.afterTs)} → ${window.beforeTs !== undefined ? fmtTs(window.beforeTs) : "now"}`
          : "all time";
      const scope = timelineKeys ? `${timelineKeys.length} room(s)` : "all rooms";
      const trailer = `${scope}, ${windowLabel}, ${elapsedMs} ms`;

      let text: string;
      if (args.user) {
        const agg = bySender.get(args.user);
        if (!agg) {
          text = `${args.user} has no messages in ${windowLabel} (${scope}).\n(${trailer})`;
        } else {
          const roomLines = agg.perRoom
            .sort((a, b) => b.count - a.count)
            .map((r) => `  • {${r.room}}: ${r.count} (last ${fmtTs(r.lastAt)})`);
          text =
            `${args.user}: ${agg.total} message(s) across ${agg.perRoom.length} room(s), ` +
            `last seen ${fmtTs(agg.lastAt)}.\n${roomLines.join("\n")}\n\n(${trailer})`;
        }
      } else if (shown.length === 0) {
        text = `No activity in ${windowLabel} (${scope}).\n(${trailer})`;
      } else {
        const lines = shown.map(
          (s, i) =>
            `${i + 1}. ${s.senderId} — ${s.total} msg(s), ${s.perRoom.length} room(s), last ${fmtTs(s.lastAt)}`,
        );
        const more = totalSenders > shown.length ? `\n(+${totalSenders - shown.length} more)` : "";
        text = `Activity roster (${totalSenders} sender(s)):\n${lines.join("\n")}${more}\n\n(${trailer})`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          window: { after: window.afterTs ?? null, before: window.beforeTs ?? null },
          elapsedMs,
          senderCount: totalSenders,
          ignoredBounds: window.ignored,
          senders: shown.map((s) => ({
            senderId: s.senderId,
            total: s.total,
            firstAt: s.firstAt,
            lastAt: s.lastAt,
            perRoom: s.perRoom,
          })),
        },
      };
    },
  };
}
