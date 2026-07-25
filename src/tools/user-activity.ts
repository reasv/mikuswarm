import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatTypeFilter, Storage } from "../storage/index.js";
import { type ChatSearchIndexer, resolveRooms, resolveTimeWindow } from "../search/index.js";
import { roomIdFromTimelineKey } from "../timeline/index.js";
import { formatAgentTimestamp } from "../time/index.js";

/** Attachment kinds the message-type filter understands (mirrors `search_messages`). */
const ATTACHMENT_TYPES = ["image", "video", "audio", "file"] as const;
type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

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
  // Message-type filters (counted set; default = all). Mirror `search_messages`.
  is_reply?: boolean;
  has_attachment?: boolean;
  attachment_type?: AttachmentType[];
  has_link?: boolean;
}

/** Build the storage `ChatTypeFilter` from args, or undefined when no type filter is set. */
function buildFilter(args: UserActivityArgs): ChatTypeFilter | undefined {
  const filter: ChatTypeFilter = {};
  if (args.is_reply !== undefined) filter.isReply = args.is_reply;
  if (args.has_attachment !== undefined) filter.hasAttachment = args.has_attachment;
  if (args.has_link !== undefined) filter.hasLink = args.has_link;
  if (args.attachment_type && args.attachment_type.length > 0) filter.attachmentTypes = args.attachment_type;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** A short human phrase describing the active type filter, for headers/trailers. "" if none. */
function describeFilter(args: UserActivityArgs): string {
  const parts: string[] = [];
  if (args.attachment_type && args.attachment_type.length > 0) {
    parts.push(`${args.attachment_type.join("/")} attachments`);
  } else if (args.has_attachment === true) {
    parts.push("attachments");
  } else if (args.has_attachment === false) {
    parts.push("text only (no attachment)");
  }
  if (args.has_link === true) parts.push("with links");
  else if (args.has_link === false) parts.push("no links");
  if (args.is_reply === true) parts.push("replies");
  else if (args.is_reply === false) parts.push("non-replies");
  return parts.join(", ");
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

/** Compact human duration — "3d" / "5h" / "12m" (rounds; floors at 1m). */
function fmtDuration(ms: number): string {
  const d = ms / 86_400_000;
  if (d >= 1) return `${Math.round(d)}d`;
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Percent of total as a compact string: "0%" only for an exact zero share, "<1%" for a
 *  nonzero share that rounds below 1, one decimal under 10%, whole numbers above. "" when
 *  the denominator is 0 (an empty scope — nothing to take a percentage of). */
function pct(part: number, total: number): string {
  if (total <= 0) return "";
  const p = (part / total) * 100;
  if (p === 0) return "0%";
  if (p < 1) return "<1%";
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

/** Parenthesised share tag for inline append, or "" when not computable. */
function pctTag(part: number, total: number): string {
  const p = pct(part, total);
  return p ? ` (${p})` : "";
}

/** Scope-wide totals for the considered window — denominator + actual data span. The
 *  `total*`/`first*`/`last*` fields honour the type filter (the matching subset); the
 *  `corpus*` span ignores it (the underlying data), so coverage stays a corpus property. */
interface ScopeTotals {
  totalMessages: number;
  distinctSenders: number;
  firstAt: number | null;
  lastAt: number | null;
  corpusFirstAt: number | null;
  corpusLastAt: number | null;
}

// A coverage shortfall is only worth a footnote when the uncovered head of the requested
// window is BOTH absolutely (>30m) and relatively (>10% of the request) non-trivial — so a
// 30d ask served by 3d of data warns, but a 30d ask missing its first hour stays quiet.
const COVERAGE_GAP_ABS_MS = 30 * 60 * 1000;
const COVERAGE_GAP_FRACTION = 0.1;

/**
 * A footnote when the data's actual span falls materially short of the requested lower
 * bound — so the agent doesn't read "requested 30d" as "30d of data" when the bot has only
 * a few days on record (or the channel was silent earlier). Returns "" when the lower bound
 * is open (nothing to fall short of), the scope is empty, or the gap is below the threshold.
 */
function coverageNote(
  requestedAfter: number | undefined,
  requestedUpper: number,
  actualFirst: number | null,
): string {
  if (requestedAfter === undefined || actualFirst === null) return "";
  const head = actualFirst - requestedAfter; // uncovered span at the window start
  const requestedSpan = requestedUpper - requestedAfter;
  if (requestedSpan <= 0 || head <= 0) return "";
  if (head < COVERAGE_GAP_ABS_MS || head < requestedSpan * COVERAGE_GAP_FRACTION) return "";
  return (
    `⚠ Coverage: the requested window reaches back to ${fmtTs(requestedAfter)} (${fmtDuration(requestedSpan)}), ` +
    `but the earliest message in scope is ${fmtTs(actualFirst)} — the first ${fmtDuration(head)} of the window ` +
    `has no data (the bot may have less history than requested, or the channel was quiet then).`
  );
}

/**
 * The shared trailer block reporting the actual data the stats were computed over: how many
 * (matching) messages were considered (the % denominator), how many senders, their real
 * timestamp span, plus a coverage footnote when the CORPUS span undershoots the request. The
 * considered line is omitted when nothing matched, but the coverage note can still fire (a
 * short corpus is worth flagging even when the type filter found nothing). "" for empty data.
 */
function scopeSuffix(scope: ScopeTotals, requestedAfter: number | undefined, requestedUpper: number): string {
  const parts: string[] = [];
  if (scope.totalMessages > 0 && scope.firstAt !== null && scope.lastAt !== null) {
    parts.push(
      `${scope.totalMessages} message(s) from ${scope.distinctSenders} sender(s) considered, ` +
        `actual span ${fmtTs(scope.firstAt)} → ${fmtTs(scope.lastAt)}.`,
    );
  }
  const note = coverageNote(requestedAfter, requestedUpper, scope.corpusFirstAt);
  if (note) parts.push(note);
  return parts.join("\n");
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
      "lower bound. By default every message is counted; restrict by type with has_attachment " +
      '(false = text-only posts, true = any attachment), attachment_type:["image"|"video"|"audio"|"file"] ' +
      "(e.g. only image posts), has_link, or is_reply — so you can ask things like \"who posts the most " +
      'images". Each count is shown as a share of all messages in scope, the roster reports what the ' +
      "listed senders account for together, and the report states how many messages were considered and " +
      "their actual time span — with a coverage warning when the data spans less than the requested " +
      "window. Returns counts, not message text — use search_messages to read messages.",
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
      // ── Message-type filters (restrict the counted set; default counts everything) ──
      has_attachment: Type.Optional(
        Type.Boolean({
          description:
            "Count only messages with an attachment (true) or only text posts with none (false). " +
            "Omit to count both.",
        }),
      ),
      attachment_type: Type.Optional(
        Type.Array(Type.Union(ATTACHMENT_TYPES.map((t) => Type.Literal(t))), {
          description:
            'Count only messages carrying an attachment of any of these kinds (e.g. ["image"]); ' +
            "implies has_attachment. The quiet/silent-member views can't be combined with a type filter.",
        }),
      ),
      has_link: Type.Optional(
        Type.Boolean({ description: "Count only messages that contain a link (true) or that don't (false)." }),
      ),
      is_reply: Type.Optional(
        Type.Boolean({ description: "Count only replies (true) or only non-replies (false)." }),
      ),
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
      // The requested range, for the % denominator's data-coverage footnote. The lower
      // bound may be open (all_time / lone `before`); the upper edge defaults to now.
      const requestedAfter = window.afterTs;
      const requestedUpper = window.beforeTs ?? nowMs;

      // Message-type filter (text/attachment/image/…). When set, every count, the % of
      // total, and the considered span describe only the matching subset; the trailer/header
      // carry the filter label so the numbers aren't mistaken for an all-message count.
      const filter = buildFilter(args);
      const filterLabel = describeFilter(args);
      const filterTrailer = filterLabel ? `, ${filterLabel}` : "";

      // Scope-wide totals (every sender in window+scope): the "% of total" denominator, the
      // ACTUAL matching span, and the unfiltered corpus span behind the coverage footnote.
      const scopeTotals = context.storage.chatActivityScope({
        timelineKeys,
        sinceTs: window.afterTs,
        untilTs: window.beforeTs,
        filter,
      });
      const suffix = scopeSuffix(scopeTotals, requestedAfter, requestedUpper);
      const suffixBlock = suffix ? `\n\n${suffix}` : "";

      // ── Single-user path ──────────────────────────────────────────────────────
      if (args.user) {
        const rows = context.storage.aggregateChatActivity({
          senderId: args.user,
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
          filter,
        });
        const agg = buildBySender(rows).get(args.user);
        const trailer = `${scope}, ${windowLabel}${filterTrailer}, ${elapsed()} ms`;
        const body = !agg
          ? `${args.user} has no messages${filterLabel ? ` matching "${filterLabel}"` : ""} in ${windowLabel} (${scope}).`
          : `${args.user}: ${agg.total} message(s)${pctTag(agg.total, scopeTotals.totalMessages)} across ` +
            `${agg.perRoom.length} room(s), last seen ${fmtTs(agg.lastAt)}.\n` +
            agg.perRoom
              .sort((a, b) => b.count - a.count)
              .map((r) => `  • {${r.room}}: ${r.count} (last ${fmtTs(r.lastAt)})`)
              .join("\n");
        const text = `${body}${suffixBlock}\n\n(${trailer})`;
        return {
          content: [{ type: "text", text }],
          details: {
            window: { after: window.afterTs ?? null, before: window.beforeTs ?? null },
            elapsedMs: elapsed(),
            senderCount: agg ? 1 : 0,
            ignoredBounds: window.ignored,
            filter: filter ?? null,
            scope: {
              totalMessages: scopeTotals.totalMessages,
              distinctSenders: scopeTotals.distinctSenders,
              firstAt: scopeTotals.firstAt,
              lastAt: scopeTotals.lastAt,
              corpusFirstAt: scopeTotals.corpusFirstAt,
              corpusLastAt: scopeTotals.corpusLastAt,
            },
            senders: agg
              ? [
                  {
                    senderId: agg.senderId,
                    total: agg.total,
                    percentOfTotal: scopeTotals.totalMessages > 0 ? agg.total / scopeTotals.totalMessages : null,
                    firstAt: agg.firstAt,
                    lastAt: agg.lastAt,
                    perRoom: agg.perRoom,
                    neverPosted: false,
                  },
                ]
              : [],
          },
        };
      }

      // ── Roster path ───────────────────────────────────────────────────────────
      // include_silent (or least_active) unions current room membership so never-posted
      // members surface as total 0. It needs a concrete room scope AND a membership source.
      // A type filter disables it: "never posted [an image]" would wrongly flag active text
      // posters as silent, so never-posted is only meaningful against ALL message types.
      const wantSilent = args.include_silent === true || order === "least";
      const canResolveMembers = context.roomMembers !== undefined && timelineKeys !== undefined;
      const doSilent = wantSilent && canResolveMembers && filter === undefined;
      let silentNote = "";
      if (args.include_silent === true && filter !== undefined) {
        silentNote = " (never-posted members aren't listed alongside a message-type filter)";
      } else if (args.include_silent === true && !canResolveMembers) {
        silentNote =
          timelineKeys === undefined
            ? ' (include_silent needs a concrete room scope — pass rooms:"current" or a list; never-posted members not listed for rooms:"all")'
            : " (roster unavailable on this channel; never-posted members not listed)";
      }

      let shown: SenderAgg[];
      let totalSenders: number;
      if (doSilent && timelineKeys) {
        // Full roster of posters in scope (bounded by participants for a concrete scope),
        // then union the current members; members absent from the posting set are
        // never-posted (per-scope semantics: "never posted in the scanned room(s)").
        //
        // Unbounded by design: aggregateChatActivity runs with no sender filter and no
        // SQL LIMIT, materializing every poster in scope before the JS-side slice below.
        // `limit` can't be pushed into SQL here because the never-posted view needs the
        // FULL poster set first — the member union and the least-active re-sort happen
        // after this fetch, so a SQL LIMIT would drop posters (or silent members) that
        // belong in the final ranked window. This full-roster scan is an accepted cost of
        // the silent/never-posted admin diagnostic (heavier than the bounded roster path).
        const rows = context.storage.aggregateChatActivity({
          timelineKeys,
          sinceTs: window.afterTs,
          untilTs: window.beforeTs,
        });
        const bySender = buildBySender(rows);
        // Dedup timeline keys by resolved room id before fetching members: multiple
        // timeline keys (e.g. thread keys) can map to the SAME underlying room, and
        // roomMembers resolves the room internally — fetching once per timeline_key would
        // fire duplicate native member fetches (possibly homeserver round-trips) for the
        // same roster. Group by room id and fetch once per unique room with a representative
        // key. (Keys that don't resolve to a room id keep their own key as the group bucket.)
        const repByRoom = new Map<string, string>();
        for (const tk of timelineKeys) {
          const roomId = roomIdFromTimelineKey(tk) ?? tk;
          if (!repByRoom.has(roomId)) repByRoom.set(roomId, tk);
        }
        const memberLists = await Promise.all(
          [...repByRoom.values()].map((tk) => context.roomMembers!(tk).catch(() => [] as RoomMemberLite[])),
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
          filter,
        });
        shown = [...buildBySender(res.rows).values()];
        sortRoster(shown, order);
        totalSenders = res.totalSenders;
      }

      const elapsedMs = elapsed();
      const trailer = `${scope}, ${windowLabel}${filterTrailer}, ${elapsedMs} ms`;
      // Top-3-channel breakdown is only meaningful when more than one room is scanned.
      const multiRoom = timelineKeys === undefined || timelineKeys.length > 1;
      // Combined weight of the returned page: how many messages the shown senders account
      // for together, and their share of the scope total (a slice when the roster is capped
      // by `limit`, or when `max_messages` excludes high-volume senders from the listing).
      const shownMessages = shown.reduce((n, s) => n + s.total, 0);
      const shownPct = pct(shownMessages, scopeTotals.totalMessages);

      let text: string;
      if (shown.length === 0) {
        const none = filterLabel ? `No "${filterLabel}" activity` : "No activity";
        text = `${none} in ${windowLabel} (${scope})${silentNote}.${suffixBlock}\n\n(${trailer})`;
      } else {
        const lines = shown.map((s, i) => {
          const lastSeen = s.neverPosted ? "never posted" : `last ${fmtTs(s.lastAt)}`;
          // A never-posted member is only known by its (opaque) mxid in chat_index — show
          // the resolved display name when we have one so the admin can recognize them.
          const label = s.displayName ? `${s.senderId} (${s.displayName})` : s.senderId;
          let line = `${i + 1}. ${label} — ${s.total} msg(s)${pctTag(s.total, scopeTotals.totalMessages)}, ${s.perRoom.length} room(s), ${lastSeen}`;
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
        const baseHeader = order === "least" ? "Inactivity roster (least active first)" : "Activity roster";
        const header = filterLabel ? `${baseHeader} — ${filterLabel}` : baseHeader;
        const more = totalSenders > shown.length ? `\n(+${totalSenders - shown.length} more)` : "";
        const subtotal = shownPct
          ? `\nThese ${shown.length} sender(s) account for ${shownMessages} of ${scopeTotals.totalMessages} message(s) (${shownPct}).`
          : "";
        text = `${header} (${totalSenders} sender(s))${silentNote}:\n${lines.join("\n")}${more}${subtotal}${suffixBlock}\n\n(${trailer})`;
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
          filter: filter ?? null,
          scope: {
            totalMessages: scopeTotals.totalMessages,
            distinctSenders: scopeTotals.distinctSenders,
            firstAt: scopeTotals.firstAt,
            lastAt: scopeTotals.lastAt,
            corpusFirstAt: scopeTotals.corpusFirstAt,
            corpusLastAt: scopeTotals.corpusLastAt,
          },
          shown: {
            senderCount: shown.length,
            messages: shownMessages,
            percentOfTotal: scopeTotals.totalMessages > 0 ? shownMessages / scopeTotals.totalMessages : null,
          },
          senders: shown.map((s) => ({
            senderId: s.senderId,
            displayName: s.displayName ?? null,
            total: s.total,
            percentOfTotal: scopeTotals.totalMessages > 0 ? s.total / scopeTotals.totalMessages : null,
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
