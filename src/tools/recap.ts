import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage, Summary } from "../storage/index.js";
import {
  type ChatSearchIndexer,
  resolveAbsence,
  resolveTimeWindow,
  selectDigest,
  resolveRooms,
} from "../search/index.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface RecapToolContext {
  storage: Storage;
  indexer: ChatSearchIndexer;
  /** Room this session runs in (for rooms:"current"). */
  currentTimelineKey: string;
  /** The asking user's id — default subject of since_user_absence. */
  askerId: string;
  defaults: { budgetTokens: number; gapThresholdMs: number; defaultLookbackMs: number };
  now?: () => number;
}

interface RecapArgs {
  since_user_absence?: string;
  after?: string;
  before?: string;
  last?: string;
  rooms?: string[] | "current" | "all";
  max_tokens?: number;
  granularity?: "fine" | "auto";
}

/** ~5 min: below this, an uncovered recent tail isn't worth flagging. */
const TAIL_NOTE_THRESHOLD_MS = 5 * 60 * 1000;
const FINE_BUDGET_MULTIPLIER = 3;

function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

function fmtDuration(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 24) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function createRecapTool(context: RecapToolContext): AgentTool {
  const now = context.now ?? (() => Date.now());
  return {
    name: "recap",
    label: "Recap",
    description:
      'Catch up on what happened while you were away, from existing summaries (no raw-message ' +
      'dump). The common case — "summarize everything since I was gone" — needs no arguments: it ' +
      "detects when the asker was last absent (skipping their current burst of messages) and " +
      "returns the finest available summaries from then to now. Or give an explicit window with " +
      "last (e.g. \"1d\"), after/before, or since_user_absence:<user>. Defaults to this room; pass " +
      "rooms:\"all\" to span every channel. Returns more detailed (lower-level) summaries than the " +
      "ones already in your context; each one cites its summary id (id=...) for follow-up. For " +
      "finding specific messages, use search_messages instead.",
    parameters: Type.Object({
      since_user_absence: Type.Optional(
        Type.String({
          description:
            "Detect the absence gap for this user id and recap from their last pre-absence " +
            "message. Omit (with no other window) to use yourself, the asker.",
        }),
      ),
      after: Type.Optional(Type.String({ description: "Explicit lower bound — ISO datetime or YYYY-MM-DD." })),
      before: Type.Optional(Type.String({ description: "Explicit upper bound — ISO datetime or YYYY-MM-DD." })),
      last: Type.Optional(Type.String({ description: 'Relative window, e.g. "1d", "12h", "1w".' })),
      rooms: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("all"), Type.Array(Type.String())], {
          description: 'Rooms to recap. "current" (default), "all", or explicit timeline_keys.',
        }),
      ),
      max_tokens: Type.Optional(
        Type.Number({ minimum: 200, maximum: 100_000, description: "Summary budget (default from config)." }),
      ),
      granularity: Type.Optional(
        Type.Union([Type.Literal("fine"), Type.Literal("auto")], {
          description: '"auto" (default) respects the token budget; "fine" pushes for level-1 detail.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as RecapArgs;
      const startedAt = performance.now();
      const nowMs = now();
      const timelineKeys = resolveRooms(args.rooms, context.currentTimelineKey);

      // Resolve the window. Explicit lower bound (last/after) → window mode; otherwise
      // absence-gap mode (the default "what did I miss" path).
      const window = resolveTimeWindow(args, nowMs);
      const end = window.beforeTs ?? nowMs;
      let start: number;
      let basis: string;
      if (window.afterTs !== undefined) {
        start = window.afterTs;
        basis = args.last ? `the last ${args.last}` : `${fmtTs(start)}`;
      } else {
        const subject = args.since_user_absence ?? context.askerId;
        const absence = await resolveAbsence(context.storage, context.indexer, {
          senderId: subject,
          timelineKeys,
          now: nowMs,
          gapThresholdMs: context.defaults.gapThresholdMs,
          defaultLookbackMs: context.defaults.defaultLookbackMs,
        });
        start = absence.startTs;
        // Self case keeps the resolver's second-person phrasing; a named subject is
        // prefixed so the agent knows whose absence anchored the window.
        basis = args.since_user_absence
          ? `since ${subject} was last active — ${absence.basis}`
          : absence.basis;
      }
      if (start > end) start = Math.min(start, end);

      // Gather + group summaries by room, then select coverage under budget per room.
      const allSummaries = context.storage.getSummariesInWindow({ timelineKeys, start, end });
      const byRoom = new Map<string, Summary[]>();
      for (const s of allSummaries) {
        const arr = byRoom.get(s.timelineKey) ?? [];
        arr.push(s);
        byRoom.set(s.timelineKey, arr);
      }
      const nRooms = byRoom.size;
      const baseBudget = args.max_tokens ?? context.defaults.budgetTokens;
      const budget = args.granularity === "fine" ? baseBudget * FINE_BUDGET_MULTIPLIER : baseBudget;
      const perRoomBudget = nRooms <= 1 ? budget : Math.max(800, Math.floor(budget / nRooms));

      const rooms = [...byRoom.entries()].map(([room, summaries]) => {
        const sel = selectDigest(summaries, start, end, perRoomBudget);
        const tailMs = sel.coveredTo !== null ? end - sel.coveredTo : 0;
        return { room, sel, tailMs };
      });

      const elapsedMs = Math.round(performance.now() - startedAt);
      const showRoom = nRooms !== 1;
      const totalSelected = rooms.reduce((n, r) => n + r.sel.summaries.length, 0);

      let text: string;
      if (totalSelected === 0) {
        text =
          `Nothing summarized for ${basis} (${fmtTs(start)} → ${fmtTs(end)}). ` +
          "That period may still be in your live context (too recent to have been summarized), " +
          "or there was no activity. Use search_messages or read_messages for raw messages.\n" +
          `(recap in ${elapsedMs} ms)`;
      } else {
        const sections: string[] = [];
        for (const { room, sel, tailMs } of rooms) {
          if (sel.summaries.length === 0) continue;
          const header = showRoom ? `### {${room}}\n` : "";
          const blocks = sel.summaries
            .map(
              (s) =>
                `— [L${s.level} · ${fmtTs(s.earliestTimestamp)} → ${fmtTs(s.latestTimestamp)} · ${s.eventCount} msgs · id=${s.id}]\n${s.content}`,
            )
            .join("\n\n");
          const notes: string[] = [];
          if (sel.coarsened > 0)
            notes.push(`${sel.coarsened} older stretch(es) condensed to higher-level summaries for space`);
          if (sel.trimmed > 0) notes.push(`${sel.trimmed} oldest summary(ies) omitted for space`);
          if (tailMs > TAIL_NOTE_THRESHOLD_MS)
            notes.push(
              `the most recent ~${fmtDuration(tailMs)} isn't summarized yet (likely already in your context; ` +
                "use search_messages/read_messages for it)",
            );
          const noteLine = notes.length > 0 ? `\n_(${notes.join("; ")})_` : "";
          sections.push(`${header}${blocks}${noteLine}`);
        }
        text =
          `Recap — ${basis} (${fmtTs(start)} → ${fmtTs(end)})` +
          `${showRoom ? `, ${nRooms} rooms` : ""}:\n\n${sections.join("\n\n")}\n\n(recap in ${elapsedMs} ms)`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          window: { start, end, basis },
          elapsedMs,
          roomCount: nRooms,
          rooms: rooms.map((r) => ({
            room: r.room,
            summaryCount: r.sel.summaries.length,
            coarsened: r.sel.coarsened,
            trimmed: r.sel.trimmed,
            coveredFrom: r.sel.coveredFrom,
            coveredTo: r.sel.coveredTo,
            summaryIds: r.sel.summaries.map((s) => s.id),
          })),
        },
      };
    },
  };
}
