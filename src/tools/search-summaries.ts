import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage, SummaryStatus } from "../storage/index.js";
import {
  sanitizeSummaryFtsMatch,
  buildSummarySnippet,
  resolveRoomsForAgent,
  applyVisibilityToRooms,
  decodeCursor,
  encodeSummaryCursor,
  queryTerms,
  runSummarySearch,
  normalizeSearchArgs,
  inapplicableFilters,
} from "../search/index.js";
import { resolveTimeWindow } from "../search/time.js";
import { formatAgentTimestamp } from "../time/index.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
import type { Logger } from "../observability/index.js";

export interface SearchSummariesToolContext {
  storage: Storage;
  /** The room this session is running in (for `rooms: "current"`). */
  currentTimelineKey: string;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
  /** Agents mode: scope `rooms:"all"` to this agent's accounts (§7.2). */
  agentAccountPrefixes?: string[];
  /** Channel visibility resolver (ARCHITECTURE.md §9h). Absent = all-shared. */
  visibilityResolver?: ChannelVisibilityResolver;
  /** Structured logger for `search_rooms_excluded` events. Absent = no log. */
  logger?: Logger;
}

interface SearchSummariesArgs {
  query?: string;
  rooms?: string[] | "current" | "all";
  after?: string;
  before?: string;
  last?: string;
  limit?: number;
  cursor?: string;
  order?: "newest" | "oldest" | "relevance";
  level?: number | number[];
  min_level?: number;
  status?: SummaryStatus[];
}

/**
 * Message-search params this tool has no meaning for. A caller that sends one (a
 * padded schema, or a query that belongs on `search_messages`) still gets its
 * summary results — the filter is ignored with a note naming it and the tool that
 * accepts it, never a failed call.
 */
const MESSAGE_ONLY_FIELDS = [
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

/**
 * The summary-search core (§9e): keyword search over the rolling summaries
 * (`summaries_fts`), separated from the tool wrapper's room resolution.
 */
function runSummaryCorpusSearch(
  storage: Storage,
  args: SearchSummariesArgs,
  timelineKeys: string[] | undefined,
  now: () => number,
  visibilityNote = "",
): AgentToolResult<unknown> {
  // A message-only filter here (post-normalization, so a real value) is ignored
  // with a note naming it and the tool that accepts it — the search still runs.
  const { ignored: ignoredFilters, note: inapplicableNote } = inapplicableFilters(
    args as Record<string, unknown>,
    MESSAGE_ONLY_FIELDS,
    (names) => ` (ignored ${names} — message filter(s); use search_messages for them)`,
  );

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

  const outcome = runSummarySearch(storage, {
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
  const visNote = visibilityNote ? `\n${visibilityNote}` : "";
  const notes = `${orderNote}${dateNote}${inapplicableNote}`;

  let text: string;
  if (outcome.hits.length === 0 && visibilityNote && !timelineKeys?.length) {
    text = visibilityNote;
  } else if (outcome.hits.length === 0) {
    text = `No matching summaries${notes}.\n(${trailer})${visNote}`;
  } else {
    const more =
      outcome.total > outcome.hits.length
        ? `\nShowing ${outcome.hits.length} of ${outcome.total}.` +
          (nextCursor ? ` Pass cursor: ${nextCursor} for the next page.` : "")
        : "";
    text =
      `${outcome.total} summary match(es)${notes} ` +
      `(pass any id to expand_summary to drill into it):\n\n${lines.join("\n\n")}${more}\n\n(${trailer})${visNote}`;
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
      ignoredFilters,
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

export function createSearchSummariesTool(context: SearchSummariesToolContext): AgentTool {
  const now = context.now ?? (() => Date.now());
  return {
    name: "search_summaries",
    label: "Search summaries",
    description:
      "Keyword search over the rolling conversation summaries — NOT the raw transcript (for " +
      "specific messages, senders, or attachments use search_messages). Use when you hold only " +
      "a coarse summary of a period and need to find the finer detail underneath a topic: each " +
      "hit cites a summary id you can pass to expand_summary to drill down into the finer " +
      "summaries — and ultimately the raw messages — it condensed. Filter by rooms, time " +
      "window, and summary level. Newest-first by default; order:relevance for best-match " +
      "ranking with a query.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Words to match (implicit AND; trailing * = prefix, e.g. "config*"). Omit to list ' +
            "summaries by time window / level alone.",
        }),
      ),
      rooms: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Array(Type.String())], {
          description:
            'Which rooms to search. "current" (default) = this room; "all" = every room; or an ' +
            "explicit list of timeline_keys (as shown in results).",
        }),
      ),
      after: Type.Optional(Type.String({ description: "Lower time bound — ISO datetime or YYYY-MM-DD." })),
      before: Type.Optional(Type.String({ description: "Upper time bound — ISO datetime or YYYY-MM-DD (inclusive of that day)." })),
      last: Type.Optional(Type.String({ description: 'Relative window, e.g. "24h", "3d", "2w". Wins over after.' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Max results (default 30)." })),
      cursor: Type.Optional(Type.String({ description: "Pagination token from a previous result's next_cursor (newest/oldest only)." })),
      order: Type.Optional(
        Type.Union([Type.Literal("newest"), Type.Literal("oldest"), Type.Literal("relevance")], {
          description: 'Result order. Default "newest". "relevance" requires a query and returns the first page only.',
        }),
      ),
      level: Type.Optional(
        Type.Union([Type.Number(), Type.Array(Type.Number())], {
          description:
            "Restrict to summaries at this level (or any of these levels). Level 1 = finest " +
            "(covers raw events); higher = coarser.",
        }),
      ),
      min_level: Type.Optional(
        Type.Number({ description: "Restrict to summaries at level >= this (e.g. only coarse summaries)." }),
      ),
      status: Type.Optional(
        Type.Array(Type.Union([Type.Literal("complete"), Type.Literal("truncated")]), {
          description:
            'Which summary statuses to include (default both). "truncated" summaries are lossy ' +
            "but still expandable; superseded summaries are never returned.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = normalizeSearchArgs<SearchSummariesArgs>(params as Record<string, unknown>);
      const rawKeys = resolveRoomsForAgent(
        args.rooms,
        context.currentTimelineKey,
        context.agentAccountPrefixes,
        context.storage,
      );
      const isExplicitList = Array.isArray(args.rooms);
      const { keys: timelineKeys, note: visibilityNote, excludedCount } = applyVisibilityToRooms(
        rawKeys,
        context.currentTimelineKey,
        context.visibilityResolver,
        context.storage,
        isExplicitList,
      );
      // Structured log: operator-side answer to "why can't the bot see that room?" (§8).
      if (excludedCount > 0 && context.logger) {
        context.logger.info("search_rooms_excluded", {
          tool: "search_summaries",
          viewerKey: context.currentTimelineKey,
          excludedCount,
        });
      }
      // Short-circuit: all requested rooms were excluded — no storage query needed.
      if (timelineKeys !== undefined && timelineKeys.length === 0) {
        const text = visibilityNote || "Searched 0 room(s) — all requested rooms excluded by operator visibility config.";
        return {
          content: [{ type: "text", text }],
          details: { hits: 0, total: 0, rooms: 0, excluded: excludedCount },
        };
      }
      return runSummaryCorpusSearch(context.storage, args, timelineKeys, now, visibilityNote);
    },
  };
}
