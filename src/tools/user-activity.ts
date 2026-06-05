import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.js";
import { type ChatSearchIndexer, resolveRooms, resolveTimeWindow } from "../search/index.js";
import { formatAgentTimestamp } from "../time/index.js";

/** A current joined room member, as resolved from the Matrix client (§9e). */
export interface RoomMemberLite {
  userId: string;
  displayName?: string;
}

export interface UserActivityToolContext {
  storage: Storage;
  indexer: ChatSearchIndexer;
  currentTimelineKey: string;
  now?: () => number;
  /**
   * Resolve the currently-joined members of a room by its timeline_key — the source for
   * `include_silent` / least-active never-posted users (who have no `chat_index` row).
   * Optional: when absent (e.g. no live client), the silent union degrades to a note.
   */
  roomMembers?: (timelineKey: string) => Promise<RoomMemberLite[]>;
}

interface UserActivityArgs {
  user?: string;
  rooms?: string[] | "current" | "all";
  last?: string;
  after?: string;
  before?: string;
  limit?: number;
  order?: "most_active" | "least_active";
  max_messages?: number;
  all_time?: boolean;
  include_silent?: boolean;
}

interface SenderAgg {
  senderId: string;
  total: number;
  firstAt: number;
  lastAt: number;
  perRoom: Array<{ room: string; count: number; lastAt: number }>;
  /** True for a current member who has no messages in scope (never posted). */
  neverPosted: boolean;
  displayName?: string;
}

function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

type ActivityRow = { senderId: string; timelineKey: string; count: number; firstAt: number; lastAt: number };

/** Fold per-(sender, room) rows into per-sender aggregates. */
function buildBySender(rows: ActivityRow[]): Map<string, SenderAgg> {
  const bySender = new Map<string, SenderAgg>();
  for (const r of rows) {
    const agg =
      bySender.get(r.senderId) ??
      ({ senderId: r.senderId, total: 0, firstAt: r.firstAt, lastAt: r.lastAt, perRoom: [], neverPosted: false } as SenderAgg);
    agg.total += r.count;
    agg.firstAt = Math.min(agg.firstAt, r.firstAt);
    agg.lastAt = Math.max(agg.lastAt, r.lastAt);
    agg.perRoom.push({ room: r.timelineKey, count: r.count, lastAt: r.lastAt });
    bySender.set(r.senderId, agg);
  }
  return bySender;
}

/** Rank a roster: most-active first (desc) or least-active first (asc); senderId tiebreak. */
function sortRoster(list: SenderAgg[], order: "most" | "least"): void {
  list.sort((a, b) => (order === "least" ? a.total - b.total : b.total - a.total) || (a.senderId < b.senderId ? -1 : 1));
}

export function createUserActivityTool(context: UserActivityToolContext): AgentTool {
  const now = context.now ?? (() => Date.now());
  return {
    name: "user_activity",
    label: "User activity",
    description:
      "Message-count statistics over a time window — how much a user (or everyone) has posted, " +
      "broken down by room, with first/last-seen. Give a user id for one person, or omit it for a " +
      'roster ranked by activity. order:"least_active" (with optional max_messages threshold) is the ' +
      '"who has gone quiet" view; include_silent (or least_active) also surfaces current room members ' +
      "who NEVER posted (total 0). Defaults to all rooms and the last 30 days; all_time removes the " +
      "lower bound. Returns counts, not message text — use search_messages to read messages.",
    parameters: Type.Object({
      user: Type.Optional(Type.String({ description: "Sender id to report on. Omit for an all-users roster." })),
      rooms: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Array(Type.String())], {
          description: 'Rooms to count across. Default "all". (include_silent needs a concrete scope — "current" or a list.)',
        }),
      ),
      last: Type.Optional(Type.String({ description: 'Window, e.g. "30d", "7d", "24h". Default "30d".' })),
      after: Type.Optional(Type.String({ description: "Explicit lower bound (ISO or YYYY-MM-DD); overrides last." })),
      before: Type.Optional(Type.String({ description: "Explicit upper bound (ISO or YYYY-MM-DD)." })),
      all_time: Type.Optional(
        Type.Boolean({ description: "Ignore the default 30d window — count over all of history (no lower bound)." }),
      ),
      order: Type.Optional(
        Type.Union([Type.Literal("most_active"), Type.Literal("least_active")], {
          description: 'Roster ranking. "most_active" (default) or "least_active" (the inactivity view).',
        }),
      ),
      max_messages: Type.Optional(
        Type.Number({ minimum: 0, description: "Roster: keep only senders with total messages <= this (the quiet-threshold view)." }),
      ),
      include_silent: Type.Optional(
        Type.Boolean({
          description:
            "Roster: also list current room members who never posted in the scanned room(s) (total 0). " +
            'Needs a concrete room scope (rooms:"current" or a list). Implied by order:"least_active".',
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Roster size (default 50)." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as UserActivityArgs;
      const startedAt = performance.now();
      const nowMs = now();
      await context.indexer.ensureFreshForQuery();

      const timelineKeys = resolveRooms(args.rooms ?? "all", context.currentTimelineKey);
      // Window. all_time removes the lower bound entirely (an upper `before` may still apply).
      // Otherwise inject the 30d default ONLY when no bound at all is given — a lone `before`
      // must leave the lower bound OPEN, else the default afterTs could invert the window.
      let window: ReturnType<typeof resolveTimeWindow>;
      if (args.all_time) {
        window = resolveTimeWindow({ before: args.before }, nowMs);
      } else {
        const hasExplicit =
          args.last !== undefined || args.after !== undefined || args.before !== undefined;
        window = resolveTimeWindow(
          { last: hasExplicit ? args.last : "30d", after: args.after, before: args.before },
          nowMs,
        );
      }

      const limit = args.limit ?? 50;
      const order: "most" | "least" = args.order === "least_active" ? "least" : "most";
      const elapsed = (): number => Math.round(performance.now() - startedAt);
      const windowLabel =
        window.afterTs !== undefined
          ? `${fmtTs(window.afterTs)} → ${window.beforeTs !== undefined ? fmtTs(window.beforeTs) : "now"}`
          : "all time";
      const scope = timelineKeys ? `${timelineKeys.length} room(s)` : "all rooms";

      // ── Single-user path ──────────────────────────────────────────────────────
      if (args.user) {
        const rows = context.storage.aggregateChatActivity({
          senderId: args.user,
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
        });
        const agg = buildBySender(rows).get(args.user);
        const trailer = `${scope}, ${windowLabel}, ${elapsed()} ms`;
        const text = !agg
          ? `${args.user} has no messages in ${windowLabel} (${scope}).\n(${trailer})`
          : `${args.user}: ${agg.total} message(s) across ${agg.perRoom.length} room(s), ` +
            `last seen ${fmtTs(agg.lastAt)}.\n` +
            agg.perRoom
              .sort((a, b) => b.count - a.count)
              .map((r) => `  • {${r.room}}: ${r.count} (last ${fmtTs(r.lastAt)})`)
              .join("\n") +
            `\n\n(${trailer})`;
        return {
          content: [{ type: "text", text }],
          details: {
            window: { after: window.afterTs ?? null, before: window.beforeTs ?? null },
            elapsedMs: elapsed(),
            senderCount: agg ? 1 : 0,
            ignoredBounds: window.ignored,
            senders: agg
              ? [{ senderId: agg.senderId, total: agg.total, firstAt: agg.firstAt, lastAt: agg.lastAt, perRoom: agg.perRoom, neverPosted: false }]
              : [],
          },
        };
      }

      // ── Roster path ───────────────────────────────────────────────────────────
      // include_silent (or least_active) unions current room membership so never-posted
      // members surface as total 0. It needs a concrete room scope AND a membership source.
      const wantSilent = args.include_silent === true || order === "least";
      const canResolveMembers = context.roomMembers !== undefined && timelineKeys !== undefined;
      const doSilent = wantSilent && canResolveMembers;
      let silentNote = "";
      if (args.include_silent === true && !canResolveMembers) {
        silentNote =
          timelineKeys === undefined
            ? ' (include_silent needs a concrete room scope — pass rooms:"current" or a list; never-posted members not listed for rooms:"all")'
            : " (membership source unavailable; never-posted members not listed)";
      }

      let shown: SenderAgg[];
      let totalSenders: number;
      if (doSilent && timelineKeys) {
        // Full roster of posters in scope (bounded by participants for a concrete scope),
        // then union the current members; members absent from the posting set are
        // never-posted (per-scope semantics: "never posted in the scanned room(s)").
        const rows = context.storage.aggregateChatActivity({
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
        });
        const bySender = buildBySender(rows);
        const memberLists = await Promise.all(
          timelineKeys.map((tk) => context.roomMembers!(tk).catch(() => [] as RoomMemberLite[])),
        );
        for (const members of memberLists) {
          for (const m of members) {
            if (!bySender.has(m.userId)) {
              bySender.set(m.userId, {
                senderId: m.userId,
                total: 0,
                firstAt: 0,
                lastAt: 0,
                perRoom: [],
                neverPosted: true,
                displayName: m.displayName,
              });
            }
          }
        }
        let list = [...bySender.values()];
        if (args.max_messages !== undefined) list = list.filter((s) => s.total <= args.max_messages!);
        totalSenders = list.length;
        sortRoster(list, order);
        shown = list.slice(0, limit);
      } else {
        const res = context.storage.topChatActivity({
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
          limit,
          order,
          maxMessages: args.max_messages,
        });
        shown = [...buildBySender(res.rows).values()];
        sortRoster(shown, order);
        totalSenders = res.totalSenders;
      }

      const elapsedMs = elapsed();
      const trailer = `${scope}, ${windowLabel}, ${elapsedMs} ms`;
      // Top-3-channel breakdown is only meaningful when more than one room is scanned.
      const multiRoom = timelineKeys === undefined || timelineKeys.length > 1;

      let text: string;
      if (shown.length === 0) {
        text = `No activity in ${windowLabel} (${scope})${silentNote}.\n(${trailer})`;
      } else {
        const lines = shown.map((s, i) => {
          const lastSeen = s.neverPosted ? "never posted" : `last ${fmtTs(s.lastAt)}`;
          // A never-posted member is only known by its (opaque) mxid in chat_index — show
          // the resolved display name when we have one so the admin can recognize them.
          const label = s.displayName ? `${s.senderId} (${s.displayName})` : s.senderId;
          let line = `${i + 1}. ${label} — ${s.total} msg(s), ${s.perRoom.length} room(s), ${lastSeen}`;
          if (multiRoom && s.perRoom.length > 0) {
            const top3 = [...s.perRoom]
              .sort((a, b) => b.count - a.count)
              .slice(0, 3)
              .map((r) => `{${r.room}}:${r.count}`)
              .join(", ");
            line += ` · top: ${top3}`;
          }
          return line;
        });
        const header = order === "least" ? "Inactivity roster (least active first)" : "Activity roster";
        const more = totalSenders > shown.length ? `\n(+${totalSenders - shown.length} more)` : "";
        text = `${header} (${totalSenders} sender(s))${silentNote}:\n${lines.join("\n")}${more}\n\n(${trailer})`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          window: { after: window.afterTs ?? null, before: window.beforeTs ?? null },
          elapsedMs,
          order: args.order ?? "most_active",
          includeSilent: doSilent,
          senderCount: totalSenders,
          ignoredBounds: window.ignored,
          senders: shown.map((s) => ({
            senderId: s.senderId,
            displayName: s.displayName ?? null,
            total: s.total,
            firstAt: s.firstAt,
            lastAt: s.lastAt,
            perRoom: s.perRoom,
            neverPosted: s.neverPosted,
          })),
        },
      };
    },
  };
}
