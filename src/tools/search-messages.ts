import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage, ChatSearchHit } from "../storage/index.js";
import type { ChatSearchIndexer } from "../search/index.js";
import {
  sanitizeFtsMatch,
  buildSnippet,
  resolveRooms,
  decodeCursor,
  encodeCursor,
  queryTerms,
  runChatSearch,
  resolveAbsence,
  type SearchScope,
} from "../search/index.js";
import { resolveTimeWindow } from "../search/time.js";
import { hydrateEvents } from "../context/hydrate.js";
import { renderCompactMessage, renderRichMessage } from "../context/renderer.js";
import { formatAgentTimestamp } from "../time/index.js";
import type { CanonicalChatEvent } from "../types.js";

export interface SearchMessagesToolContext {
  storage: Storage;
  indexer: ChatSearchIndexer;
  /** The room this session is running in (for `rooms: "current"`). */
  currentTimelineKey: string;
  /** Absence-detection knobs shared with recap (§9e). */
  absenceDefaults?: { gapThresholdMs: number; defaultLookbackMs: number };
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

const ATTACHMENT_TYPES = ["image", "video", "audio", "file"] as const;

interface SearchMessagesArgs {
  query?: string;
  rooms?: string[] | "current" | "all";
  scope?: SearchScope;
  from?: string[];
  mentions?: string[];
  quoted_user?: string[];
  is_reply?: boolean;
  has_attachment?: boolean;
  attachment_type?: Array<(typeof ATTACHMENT_TYPES)[number]>;
  has_link?: boolean;
  after?: string;
  before?: string;
  last?: string;
  since_user_absence?: string;
  limit?: number;
  cursor?: string;
  order?: "newest" | "oldest" | "relevance";
  format?: "compact" | "snippet" | "rich";
}

function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

/** Compact flag tags appended to a result line (attachments / links / reply). */
function flagTags(hit: ChatSearchHit): string {
  const tags: string[] = [];
  if (hit.hasAttachment) {
    tags.push(hit.attachmentTypes ? `📎${hit.attachmentTypes}` : "📎");
  }
  if (hit.hasLink) tags.push("🔗");
  if (hit.isReply) tags.push(hit.quotedSenderId ? `↩${hit.quotedSenderId}` : "↩");
  return tags.length > 0 ? ` ${tags.join(" ")}` : "";
}

export function createSearchMessagesTool(context: SearchMessagesToolContext): AgentTool {
  const now = context.now ?? (() => Date.now());
  return {
    name: "search_messages",
    label: "Search messages",
    description:
      "Full-text + metadata search over chat history (all rooms, not just your context window). " +
      "Combine a text query with filters: rooms, sender (from), who was mentioned, who was quoted, " +
      "replies only, attachments (and type), links, and a time window. By default searches message " +
      "text only; set scope to also search image captions and link-preview text. Each result cites " +
      "its event_id — pass it to read_messages to see the surrounding thread. By default each match is " +
      "returned as the FULL message (compact form); set format:snippet to scan many results as short " +
      "excerpts. Newest-first by default; use order:relevance for best-match ranking with a text query. " +
      "For your own past notes (not chat), use recall_memory instead.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Words to match (implicit AND; trailing * = prefix, e.g. "config*"). Omit for a ' +
            "pure metadata search (e.g. all images from a user).",
        }),
      ),
      rooms: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Array(Type.String())], {
          description:
            'Which rooms to search. "current" (default) = this room; "all" = every room; or an ' +
            "explicit list of timeline_keys (as shown in results).",
        }),
      ),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("text"), Type.Literal("text+captions"), Type.Literal("all")],
          {
            description:
              'Where the query matches: "text" (default, message body only), "text+captions" / ' +
              '"all" (also image captions and link-preview titles/descriptions).',
          },
        ),
      ),
      from: Type.Optional(Type.Array(Type.String(), { description: "Match only these sender ids." })),
      mentions: Type.Optional(
        Type.Array(Type.String(), { description: "Match messages that @-mention any of these user ids." }),
      ),
      quoted_user: Type.Optional(
        Type.Array(Type.String(), { description: "Match replies whose quoted message is from any of these user ids." }),
      ),
      is_reply: Type.Optional(Type.Boolean({ description: "Match only replies (true) or only non-replies (false)." })),
      has_attachment: Type.Optional(Type.Boolean()),
      attachment_type: Type.Optional(
        Type.Array(
          Type.Union(ATTACHMENT_TYPES.map((t) => Type.Literal(t))),
          { description: "Match messages with an attachment of any of these types (implies has_attachment)." },
        ),
      ),
      has_link: Type.Optional(Type.Boolean()),
      after: Type.Optional(Type.String({ description: "Lower time bound — ISO datetime or YYYY-MM-DD." })),
      before: Type.Optional(Type.String({ description: "Upper time bound — ISO datetime or YYYY-MM-DD (inclusive of that day)." })),
      last: Type.Optional(Type.String({ description: 'Relative window, e.g. "24h", "3d", "2w". Wins over after.' })),
      since_user_absence: Type.Optional(
        Type.String({
          description:
            "Set the lower bound to when this user id was last absent (gap-detected from their " +
            'messages). Combine with mentions:[<you>] for "who pinged me while I was gone". ' +
            "Overrides after/last.",
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Max results (default 30)." })),
      cursor: Type.Optional(Type.String({ description: "Pagination token from a previous result's next_cursor (newest/oldest only)." })),
      order: Type.Optional(
        Type.Union([Type.Literal("newest"), Type.Literal("oldest"), Type.Literal("relevance")], {
          description: 'Result order. Default "newest". "relevance" requires a query and returns the first page only.',
        }),
      ),
      format: Type.Optional(
        Type.Union([Type.Literal("compact"), Type.Literal("snippet"), Type.Literal("rich")], {
          description:
            'How each match is rendered. "compact" (default) = the FULL message in the same compact ' +
            'form you see in context (sender, time, reply/attachment/caption context), with an id ' +
            'reference for follow-up. "snippet" = a short one-line excerpt around the match (use when ' +
            'scanning many results). "rich" = the full XML message envelope.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as SearchMessagesArgs;
      const scope: SearchScope = args.scope ?? "text";
      const timelineKeys = resolveRooms(args.rooms, context.currentTimelineKey);
      const window = resolveTimeWindow(args, now());
      // since_user_absence overrides the lower bound with the gap-detected boundary.
      let absenceNote = "";
      if (args.since_user_absence) {
        const absence = await resolveAbsence(context.storage, context.indexer, {
          senderId: args.since_user_absence,
          timelineKeys,
          now: now(),
          gapThresholdMs: context.absenceDefaults?.gapThresholdMs,
          defaultLookbackMs: context.absenceDefaults?.defaultLookbackMs,
        });
        window.afterTs = absence.startTs;
        absenceNote = ` (since ${args.since_user_absence}'s absence: ${absence.basis})`;
      }
      const match = args.query ? sanitizeFtsMatch(args.query, scope) : undefined;

      // relevance needs a text match; fall back to newest otherwise (noted in output).
      let order = args.order ?? "newest";
      let orderNote = "";
      if (order === "relevance" && !match) {
        order = "newest";
        orderNote = " (relevance needs a query — ordered newest instead)";
      }
      const limit = args.limit ?? 30;
      const cursor = order === "relevance" ? undefined : decodeCursor(args.cursor);

      const outcome = await runChatSearch(context.storage, context.indexer, {
        match,
        timelineKeys,
        fromSenders: args.from,
        mentions: args.mentions,
        quotedUsers: args.quoted_user,
        isReply: args.is_reply,
        hasAttachment: args.has_attachment,
        attachmentTypes: args.attachment_type,
        hasLink: args.has_link,
        afterTs: window.afterTs,
        beforeTs: window.beforeTs,
        limit,
        cursor,
        order,
      });

      const terms = queryTerms(args.query);
      const showRoom = outcome.roomCount !== 1;
      const format = args.format ?? "compact";

      // For compact/rich we render the *actual* message via the shared context renderer
      // (full body + reply/attachment/caption context), so a hit is self-sufficient and
      // doesn't force a read_messages round-trip. Load + hydrate the hits' events in one
      // batch; fall back to a snippet line for any event that has since been deleted.
      const eventsById = new Map<string, CanonicalChatEvent>();
      if (format !== "snippet") {
        const base = outcome.hits
          .map((h) => context.storage.getTimelineEventById(h.eventId))
          .filter((e): e is CanonicalChatEvent => e !== undefined);
        for (const ev of hydrateEvents(context.storage, base)) eventsById.set(ev.id, ev);
      }
      const snippetLine = (h: (typeof outcome.hits)[number], ref: string): string => {
        const sender = h.senderDisplayName ?? h.senderId;
        return `[${fmtTs(h.timestamp)}] ${sender}: ${buildSnippet(h, terms)}${flagTags(h)}\n${ref}`;
      };
      const lines = outcome.hits.map((h) => {
        const ref = `   ↳ id: ${h.eventId}${showRoom ? ` · {${h.timelineKey}}` : ""}`;
        if (format !== "snippet") {
          const ev = eventsById.get(h.eventId);
          if (ev) {
            const rendered = format === "rich" ? renderRichMessage(ev) : renderCompactMessage(ev);
            return `${rendered}\n${ref}`;
          }
        }
        return snippetLine(h, ref);
      });
      const lineSep = format === "snippet" ? "\n" : "\n\n";

      const nextCursor =
        order !== "relevance" && outcome.hits.length === limit
          ? encodeCursor(outcome.hits[outcome.hits.length - 1])
          : undefined;

      const dateNote =
        window.ignored.length > 0
          ? ` (ignored unparseable ${window.ignored.join(", ")} bound — use ISO or YYYY-MM-DD / a duration like 3d)`
          : "";
      const trailer =
        `searched ${outcome.roomCount === -1 ? "all rooms" : `${outcome.roomCount} room(s)`}, ` +
        `${outcome.scanned} indexed events, ${outcome.total} match(es) in ${outcome.elapsedMs} ms`;

      let text: string;
      if (outcome.hits.length === 0) {
        text = `No matching messages${orderNote}${dateNote}${absenceNote}.\n(${trailer})`;
      } else {
        const more =
          outcome.total > outcome.hits.length
            ? `\nShowing ${outcome.hits.length} of ${outcome.total}.` +
              (nextCursor ? ` Pass cursor: ${nextCursor} for the next page.` : "")
            : "";
        text =
          `${outcome.total} match(es)${orderNote}${dateNote}${absenceNote}:\n\n${lines.join(lineSep)}${more}\n\n(${trailer})`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          total: outcome.total,
          returned: outcome.hits.length,
          elapsedMs: outcome.elapsedMs,
          scanned: outcome.scanned,
          order,
          format,
          nextCursor: nextCursor ?? null,
          ignoredBounds: window.ignored,
          hits: outcome.hits.map((h) => ({
            eventId: h.eventId,
            timelineKey: h.timelineKey,
            senderId: h.senderId,
            senderDisplayName: h.senderDisplayName,
            timestamp: h.timestamp,
            hasAttachment: h.hasAttachment === 1,
            attachmentTypes: h.attachmentTypes,
            hasLink: h.hasLink === 1,
            isReply: h.isReply === 1,
            quotedSenderId: h.quotedSenderId,
          })),
        },
      };
    },
  };
}
