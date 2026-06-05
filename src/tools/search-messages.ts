import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage, ChatSearchHit, SummaryStatus } from "../storage/index.js";
import type { ChatSearchIndexer } from "../search/index.js";
import {
  sanitizeFtsMatch,
  sanitizeSummaryFtsMatch,
  buildSnippet,
  buildSummarySnippet,
  resolveRooms,
  decodeCursor,
  encodeCursor,
  encodeSummaryCursor,
  queryTerms,
  runChatSearch,
  runSummarySearch,
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

/**
 * Per-message body cap for `format:"rich"` (chars). Mirrors the 6000-char body
 * truncation `renderCompactMessage` already applies, so rich isn't unbounded
 * relative to compact. The live context builder never passes a cap — only this
 * tool does, over arbitrary-size historical events.
 */
const RICH_BODY_MAX = 6000;

/**
 * Aggregate cap (chars) on the total full-message output across all rendered hits
 * in compact/rich mode. Once exceeded, remaining hits degrade to one-line snippets
 * and a note is surfaced. With `limit` up to 200 this is the hard ceiling that keeps
 * a single search from blowing the model's context window.
 */
const RICH_AGGREGATE_MAX = 200_000;

interface SearchMessagesArgs {
  corpus?: "messages" | "summaries";
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
  // corpus:"summaries" only
  level?: number | number[];
  min_level?: number;
  status?: SummaryStatus[];
}

/**
 * Message-only / corpus-inapplicable params, keyed by the public arg name. When
 * `corpus:"summaries"` these are rejected (fail-fast, naming the field) rather than
 * silently ignored — they have no meaning for a summary, and a silent ignore would
 * mask a malformed query. See §5.1.
 */
const SUMMARY_INAPPLICABLE_FIELDS = [
  "scope",
  "from",
  "mentions",
  "quoted_user",
  "is_reply",
  "has_attachment",
  "attachment_type",
  "has_link",
  "since_user_absence",
  "format",
] as const;

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
      'Set corpus:"summaries" to instead search the rolling conversation summaries by keyword (each hit ' +
      "cites a summary id you can expand_summary on) — useful when you only hold a coarse summary and " +
      "need the finer detail underneath a topic. For your own past notes (not chat), use recall_memory instead.",
    parameters: Type.Object({
      corpus: Type.Optional(
        Type.Union([Type.Literal("messages"), Type.Literal("summaries")], {
          description:
            'Which corpus to search. "messages" (default) = the raw chat transcript. ' +
            '"summaries" = the rolling conversation summaries (§9b) by keyword, when you ' +
            "hold only a coarse summary and want to find the right one to expand_summary on. " +
            "A call returns EITHER message hits OR summary hits, never both. With " +
            'corpus:"summaries", the message-only filters (from, mentions, quoted_user, ' +
            "is_reply, has_attachment, attachment_type, has_link, scope, since_user_absence, " +
            "format) do not apply and are rejected; level/min_level/status apply instead.",
        }),
      ),
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
            'scanning many results). "rich" = the full XML message envelope. (messages corpus only.)',
        }),
      ),
      // ── corpus:"summaries" only ───────────────────────────────────────────────
      level: Type.Optional(
        Type.Union([Type.Number(), Type.Array(Type.Number())], {
          description:
            "corpus:\"summaries\" only. Restrict to summaries at this level (or any of these " +
            "levels). Level 1 = finest (covers raw events); higher = coarser.",
        }),
      ),
      min_level: Type.Optional(
        Type.Number({
          description: 'corpus:"summaries" only. Restrict to summaries at level >= this (e.g. only coarse summaries).',
        }),
      ),
      status: Type.Optional(
        Type.Array(Type.Union([Type.Literal("complete"), Type.Literal("truncated")]), {
          description:
            'corpus:"summaries" only. Which summary statuses to include (default both). ' +
            '"truncated" summaries are lossy but still expandable; superseded summaries are never returned.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as SearchMessagesArgs;
      const timelineKeys = resolveRooms(args.rooms, context.currentTimelineKey);
      if ((args.corpus ?? "messages") === "summaries") {
        return runSummaryCorpus(context, args, timelineKeys, now);
      }
      const scope: SearchScope = args.scope ?? "text";
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
      // batch; fall back to a snippet line for any event that has since been deleted or
      // whose stored event_json is corrupt (a single bad row must not abort the render).
      const eventsById = new Map<string, CanonicalChatEvent>();
      if (format !== "snippet") {
        const base: CanonicalChatEvent[] = [];
        for (const h of outcome.hits) {
          // getTimelineEventById JSON.parses the stored row; a corrupt event_json
          // throws. Guard per-hit so one bad row degrades to a snippet (#5).
          try {
            const ev = context.storage.getTimelineEventById(h.eventId);
            if (ev !== undefined) base.push(ev);
          } catch {
            // leave it out → falls through to the snippet line below.
          }
        }
        for (const ev of hydrateEvents(context.storage, base)) eventsById.set(ev.id, ev);
      }
      const snippetLine = (h: (typeof outcome.hits)[number], ref: string): string => {
        const sender = h.senderDisplayName ?? h.senderId;
        return `[${fmtTs(h.timestamp)}] ${sender}: ${buildSnippet(h, terms)}${flagTags(h)}\n${ref}`;
      };
      // Rich/compact render the full message verbatim; over arbitrary-size historical
      // events with limit up to 200 this can blow the context window. Bound it two ways:
      // a per-message body cap (matches compact mode's 6000-char body truncation) and a
      // total aggregate-byte budget across all rendered hits, after which remaining hits
      // degrade to one-line snippets. A note is surfaced when the aggregate cap trips.
      const bodyMax = format === "rich" ? RICH_BODY_MAX : undefined;
      let renderedBudget = RICH_AGGREGATE_MAX;
      let aggregateTruncated = false;
      const lines = outcome.hits.map((h) => {
        const ref = `   ↳ id: ${h.eventId}${showRoom ? ` · {${h.timelineKey}}` : ""}`;
        if (format !== "snippet") {
          const ev = eventsById.get(h.eventId);
          if (ev && renderedBudget > 0) {
            const rendered =
              format === "rich" ? renderRichMessage(ev, { bodyMax }) : renderCompactMessage(ev);
            const line = `${rendered}\n${ref}`;
            renderedBudget -= line.length;
            return line;
          }
          if (ev) aggregateTruncated = true; // had a full render to give but the budget is spent
        }
        return snippetLine(h, ref);
      });
      const lineSep = format === "snippet" ? "\n" : "\n\n";
      const truncationNote = aggregateTruncated
        ? `\n(Output cap reached — remaining matches shown as one-line snippets; narrow your query or use format:snippet.)`
        : "";

      const nextCursor =
        order !== "relevance" && outcome.hits.length === limit
          ? encodeCursor(outcome.hits[outcome.hits.length - 1])
          : undefined;

      const dateNote =
        window.ignored.length > 0
          ? ` (ignored unparseable ${window.ignored.join(", ")} bound — use ISO or YYYY-MM-DD / a duration like 3d)`
          : "";
      // `scanned` is the size of the indexed corpus in the searched room(s) only — it
      // does NOT reflect the time/sender/attachment/etc. filters (those are applied by
      // the query, and `total` is the honest count of matches under ALL filters). Label
      // it as the in-scope corpus so it can't be read as "N events examined under your
      // filters" (#10). Kept to one cheap room-scoped count.
      const trailer =
        `searched ${outcome.roomCount === -1 ? "all rooms" : `${outcome.roomCount} room(s)`} ` +
        `(${outcome.scanned} indexed events in scope), ${outcome.total} match(es) in ${outcome.elapsedMs} ms`;

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
          `${outcome.total} match(es)${orderNote}${dateNote}${absenceNote}:\n\n${lines.join(lineSep)}${more}${truncationNote}\n\n(${trailer})`;
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
          aggregateTruncated,
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

/**
 * The `corpus:"summaries"` branch of `search_messages` (§9e): keyword search over the
 * rolling summaries (`summaries_fts`) instead of the raw transcript. Returns summary
 * hits — each citing its `id` for `expand_summary` — never message hits, so the two
 * corpora never interleave. Message-only filters are rejected up front (fail-fast).
 */
function runSummaryCorpus(
  context: SearchMessagesToolContext,
  args: SearchMessagesArgs,
  timelineKeys: string[] | undefined,
  now: () => number,
): AgentToolResult<unknown> {
  // Fail-fast: reject any message-only / inapplicable filter rather than ignoring it.
  const rejected = SUMMARY_INAPPLICABLE_FIELDS.filter(
    (f) => (args as Record<string, unknown>)[f] !== undefined,
  );
  if (rejected.length > 0) {
    const text =
      `error: these filters do not apply to corpus:"summaries": ${rejected.join(", ")}. ` +
      "Applicable parameters are: query, rooms, after/before/last, limit, cursor, order, " +
      "level, min_level, status. (Searching summaries finds the summary to expand_summary on; " +
      "to filter by sender/mentions/attachments, search the raw transcript with corpus:\"messages\".)";
    return {
      content: [{ type: "text", text }],
      details: { corpus: "summaries", error: "inapplicable_filters", rejected },
    };
  }

  const window = resolveTimeWindow(args, now());
  const match = args.query ? sanitizeSummaryFtsMatch(args.query) : undefined;

  let order = args.order ?? "newest";
  let orderNote = "";
  if (order === "relevance" && !match) {
    order = "newest";
    orderNote = " (relevance needs a query — ordered newest instead)";
  }
  const limit = args.limit ?? 30;
  const cursor = order === "relevance" ? undefined : decodeCursor(args.cursor);
  const levels =
    args.level === undefined ? undefined : Array.isArray(args.level) ? args.level : [args.level];

  const outcome = runSummarySearch(context.storage, {
    match,
    timelineKeys,
    levels,
    minLevel: args.min_level,
    statuses: args.status,
    afterTs: window.afterTs,
    beforeTs: window.beforeTs,
    limit,
    cursor,
    order,
  });

  const terms = queryTerms(args.query);
  const showRoom = outcome.roomCount !== 1;
  const lines = outcome.hits.map((h) => {
    const statusTag = h.status === "truncated" ? " · truncated" : "";
    const header = `[L${h.level} · ${fmtTs(h.earliestTimestamp)} → ${fmtTs(h.latestTimestamp)} · ${h.eventCount} msgs${statusTag}]`;
    const ref = `   ↳ id: ${h.id}${showRoom ? ` · {${h.timelineKey}}` : ""}`;
    return `${header} ${buildSummarySnippet(h.content, terms)}\n${ref}`;
  });

  const nextCursor =
    order !== "relevance" && outcome.hits.length === limit
      ? encodeSummaryCursor(outcome.hits[outcome.hits.length - 1])
      : undefined;

  const dateNote =
    window.ignored.length > 0
      ? ` (ignored unparseable ${window.ignored.join(", ")} bound — use ISO or YYYY-MM-DD / a duration like 3d)`
      : "";
  const trailer =
    `searched ${outcome.roomCount === -1 ? "all rooms" : `${outcome.roomCount} room(s)`}, ` +
    `${outcome.total} summary match(es) in ${outcome.elapsedMs} ms`;

  let text: string;
  if (outcome.hits.length === 0) {
    text = `No matching summaries${orderNote}${dateNote}.\n(${trailer})`;
  } else {
    const more =
      outcome.total > outcome.hits.length
        ? `\nShowing ${outcome.hits.length} of ${outcome.total}.` +
          (nextCursor ? ` Pass cursor: ${nextCursor} for the next page.` : "")
        : "";
    text =
      `${outcome.total} summary match(es)${orderNote}${dateNote} ` +
      `(each id= is expandable with expand_summary):\n\n${lines.join("\n\n")}${more}\n\n(${trailer})`;
  }

  return {
    content: [{ type: "text", text }],
    details: {
      corpus: "summaries",
      total: outcome.total,
      returned: outcome.hits.length,
      elapsedMs: outcome.elapsedMs,
      order,
      nextCursor: nextCursor ?? null,
      ignoredBounds: window.ignored,
      hits: outcome.hits.map((h) => ({
        id: h.id,
        timelineKey: h.timelineKey,
        level: h.level,
        earliestTimestamp: h.earliestTimestamp,
        latestTimestamp: h.latestTimestamp,
        eventCount: h.eventCount,
        tokenCount: h.tokenCount,
        status: h.status,
      })),
    },
  };
}
