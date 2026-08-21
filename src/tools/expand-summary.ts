import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage, Summary } from "../storage/index.js";
import { hydrateEvents } from "../context/hydrate.js";
import { renderCompactMessage } from "../context/renderer.js";
import { estimateTokens } from "../context/tokens.js";
import { formatAgentTimestamp } from "../time/index.js";
import type { CanonicalChatEvent } from "../types.js";

export interface ExpandSummaryToolContext {
  storage: Storage;
  /** Output bounds (from `[search.summaries]`, §9e). */
  defaults: { tokenCap: number; maxDepth: number };
}

interface ExpandSummaryArgs {
  id?: string;
  depth?: number;
  include_messages?: boolean;
  token_cap?: number;
}

/** One constituent in traversal order — either a child summary or a raw event. */
type Item = { kind: "summary"; summary: Summary } | { kind: "event"; event: CanonicalChatEvent };

function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

/** Header line for a child summary, mirroring recap's format (carries its expandable id). */
function summaryHeader(s: Summary): string {
  const statusTag =
    s.status === "truncated" ? " · truncated" :
    s.status === "superseded" ? " · superseded" : "";
  return `— [L${s.level} · ${fmtTs(s.earliestTimestamp)} → ${fmtTs(s.latestTimestamp)} · ${s.eventCount} msgs${statusTag} · id=${s.id}]`;
}

export function createExpandSummaryTool(context: ExpandSummaryToolContext): AgentTool {
  const { storage } = context;
  return {
    name: "expand_summary",
    label: "Expand summary",
    description:
      "Recover the real history beneath a <summary> block. The summaries in your context are lossy " +
      "approximations that grow coarser with age — one can compress weeks of chat. Whenever your " +
      "answer rests on a period you hold only as a summary, expand it BEFORE answering instead of " +
      "answering from the approximation. Pass a summary id (the id=... shown on summaries in your " +
      "context, in recap, or in search_messages corpus:\"summaries\" results). A level-1 summary " +
      "expands to its raw source messages (hydrated with caption/reply/link context, same as " +
      "search_messages); a higher-level summary expands to the finer summaries underneath it, each " +
      "with its own id you can expand again. Prefer expanding the one relevant summary over paging " +
      "raw history. Output is depth- and token-bounded; if it overflows, it says how many " +
      "constituents were omitted (drill a specific child instead of widening depth).",
    parameters: Type.Object({
      id: Type.String({ description: "The summary id to expand (from context, recap, or summary search)." }),
      depth: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 5,
          description:
            "How many tiers to auto-recurse. 1 (default) = the immediate constituents only (recommended — " +
            "drill a specific child next rather than widening). Capped by the configured max depth.",
        }),
      ),
      include_messages: Type.Optional(
        Type.Boolean({
          description:
            "When recursing, drill all the way to raw messages at the leaves instead of stopping at " +
            "level-1 summaries. Default false. (For a level-1 id, raw messages are returned regardless.)",
        }),
      ),
      token_cap: Type.Optional(
        Type.Number({
          minimum: 200,
          maximum: 100_000,
          description: "Max rendered tokens to accumulate before truncating (default from config).",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as ExpandSummaryArgs;
      const id = args.id?.trim();
      if (!id) {
        return { content: [{ type: "text", text: "error: id is required." }], details: null };
      }

      const root = storage.getSummaryById(id);
      if (!root) {
        return {
          content: [{ type: "text", text: `error: summary "${id}" not found.` }],
          details: { error: "not_found", id },
        };
      }
      const maxDepth = context.defaults.maxDepth;
      const requestedDepth = args.depth ?? 1;
      const depth = Math.max(1, Math.min(requestedDepth, maxDepth));
      const depthNote = requestedDepth > maxDepth ? ` (depth capped at the configured max ${maxDepth})` : "";
      const includeMessages = args.include_messages ?? false;
      const tokenCap = args.token_cap ?? context.defaults.tokenCap;

      // Walk the lineage in order. getSummaryLineage(id) returns the constituents one tier
      // below `id`: `events` for a level-1 summary (its raw source events), else `children`
      // (the lower-level summaries condensed into it). Recurse for depth > 1; with
      // include_messages, drill a level-1 leaf into its events rather than stopping at it.
      const ordered: Item[] = [];
      const walk = (summaryId: string, remainingDepth: number): void => {
        const lineage = storage.getSummaryLineage(summaryId);
        if (lineage.events.length > 0) {
          for (const event of lineage.events) ordered.push({ kind: "event", event });
          return;
        }
        for (const child of lineage.children) {
          // Superseded children (written by same-level absorption, §9b) remain in storage
          // and carry their own lineage — include them so the full absorbed history is
          // reachable. summaryHeader annotates them " · superseded" for clarity.
          if (remainingDepth > 1) {
            walk(child.id, remainingDepth - 1);
          } else if (includeMessages && child.level === 1) {
            walk(child.id, 1); // leaf → raw events
          } else {
            ordered.push({ kind: "summary", summary: child });
          }
        }
      };
      walk(id, depth);

      // Hydrate all events in one batch (captions / reply context / link previews), exactly
      // as search_messages does, so expanded raw messages match in-context fidelity.
      const rawEvents = ordered.filter((i): i is { kind: "event"; event: CanonicalChatEvent } => i.kind === "event");
      const hydratedById = new Map<string, CanonicalChatEvent>();
      for (const ev of hydrateEvents(storage, rawEvents.map((i) => i.event))) {
        hydratedById.set(ev.id, ev);
      }

      // Render in traversal order under the token cap. Always include at least the first
      // item (so a single oversized constituent still returns something); once adding the
      // next item would exceed the cap, STOP — keeping strict traversal order — and count
      // it plus everything after it as omitted (the tool then advises drilling a specific
      // child). A "skip-but-keep-scanning" packer would admit a later, smaller item over
      // an earlier dropped one, breaking the order the bot expects.
      const childBlocks: string[] = [];
      const messageBlocks: string[] = [];
      const childrenOut: Array<{ id: string; level: number; earliestTimestamp: number; latestTimestamp: number; eventCount: number; status: string }> = [];
      let estimatedTokens = 0;
      let omitted = 0;
      for (let i = 0; i < ordered.length; i++) {
        const item = ordered[i]!;
        const block =
          item.kind === "summary"
            ? `${summaryHeader(item.summary)}\n${item.summary.content}`
            : renderCompactMessage(hydratedById.get(item.event.id) ?? item.event);
        const cost = estimateTokens(block);
        const have = childBlocks.length + messageBlocks.length;
        if (have > 0 && estimatedTokens + cost > tokenCap) {
          omitted = ordered.length - i; // this item and everything after it
          break;
        }
        estimatedTokens += cost;
        if (item.kind === "summary") {
          childBlocks.push(block);
          childrenOut.push({
            id: item.summary.id,
            level: item.summary.level,
            earliestTimestamp: item.summary.earliestTimestamp,
            latestTimestamp: item.summary.latestTimestamp,
            eventCount: item.summary.eventCount,
            status: item.summary.status,
          });
        } else {
          messageBlocks.push(block);
        }
      }

      const truncated = omitted > 0;
      const sections: string[] = [];
      if (childBlocks.length > 0) {
        sections.push(`Finer summaries (${childBlocks.length}) — expand any further by its id:\n\n${childBlocks.join("\n\n")}`);
      }
      if (messageBlocks.length > 0) {
        sections.push(`Raw messages (${messageBlocks.length}):\n\n${messageBlocks.join("\n")}`);
      }

      let text: string;
      if (sections.length === 0) {
        // Should not happen for a valid summary, but be explicit.
        text = `Summary ${id} (L${root.level}) has no expandable constituents.`;
      } else {
        // Two distinct over-budget signals that never co-occur:
        //  - truncation note (#3): items were dropped (truncated/omitted > 0). When child
        //    summaries are present, advise drilling a specific one by id; when the output is
        //    pure raw messages (no child blocks), that advice is unactionable — point at
        //    token_cap / read_messages instead.
        //  - oversized-first note (#4): nothing was dropped (truncated:false/omitted:0) but the
        //    single forced-first constituent alone blew the cap, so estimatedTokens > tokenCap.
        let overflowNote = "";
        if (truncated) {
          overflowNote =
            childBlocks.length === 0
              ? `\n\n(Output cap reached — ${omitted} more constituent(s) omitted. Raise token_cap, or narrow the window with read_messages.)`
              : `\n\n(Output cap reached — ${omitted} more constituent(s) omitted. Expand a specific child by id, or raise token_cap.)`;
        } else if (estimatedTokens > tokenCap) {
          overflowNote = `\n\n(Single constituent exceeds token_cap; shown in full.)`;
        }
        text =
          `Expanded summary ${id} (L${root.level})${depthNote}, depth ${depth}:\n\n` +
          `${sections.join("\n\n")}${overflowNote}\n\n(~${estimatedTokens} tokens)`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          id,
          level: root.level,
          depth,
          includeMessages,
          estimatedTokens,
          truncated,
          omitted,
          children: childrenOut,
          messageCount: messageBlocks.length,
        },
      };
    },
  };
}
