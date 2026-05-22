import type { AppConfig } from "../config/index.js";
import type { TimelineCompactionState } from "../storage/index.js";
import type { CanonicalChatEvent } from "../types.js";
import { estimateTokens } from "./tokens.js";
import type { ContextTurn } from "./turns.js";

export interface TieredTurn extends ContextTurn {
  tier: "compact" | "rich";
  tokenEstimate: number;
}

export interface CompactionResult {
  turns: TieredTurn[];
  compactTokens: number;
  richTokens: number;
  compactedMessageIds: string[];
  droppedMessageIds: string[];
  state?: TimelineCompactionState;
  stateChanged: boolean;
}

export interface CompactTimelineOptions {
  timelineKey: string;
  state?: TimelineCompactionState;
  now?: number;
}

type PreparedEvent = {
  event: CanonicalChatEvent;
  richContent: string;
  richTokens: number;
  compactContent: string;
  compactTokens: number;
};

export function compactTimelineEvents(
  events: CanonicalChatEvent[],
  richRenderer: (event: CanonicalChatEvent) => string,
  compactRenderer: (event: CanonicalChatEvent) => string,
  config: AppConfig["context"]["tiers"],
  options: CompactTimelineOptions,
): CompactionResult {
  const prepared = events.map((event) => {
    const richContent = richRenderer(event);
    const compactContent = compactRenderer(event);
    return {
      event,
      richContent,
      richTokens: estimateTokens(richContent),
      compactContent,
      compactTokens: estimateTokens(compactContent),
    };
  });
  const initial = resolveBoundaryIndexes(prepared, options.state);
  let compactStartIndex = initial.compactStartIndex;
  let richStartIndex = initial.richStartIndex;
  let compactTokens = sumCompactTokens(prepared, compactStartIndex, richStartIndex);
  let richTokens = sumRichTokens(prepared, richStartIndex);
  const originallyCompacted = new Set(
    prepared.slice(compactStartIndex, richStartIndex).map((item) => item.event.id),
  );
  const originallyDropped = new Set(prepared.slice(0, compactStartIndex).map((item) => item.event.id));

  if (richTokens > config.rich_max_tokens && richStartIndex < prepared.length - 1) {
    do {
      const moved = prepared[richStartIndex];
      if (!moved) break;
      richTokens -= moved.richTokens;
      compactTokens += moved.compactTokens;
      richStartIndex += 1;
    } while (richTokens > config.rich_target_tokens && richStartIndex < prepared.length - 1);
  }

  if (compactTokens > config.compact_max_tokens && compactStartIndex < richStartIndex - 1) {
    do {
      const dropped = prepared[compactStartIndex];
      if (!dropped) break;
      compactTokens -= dropped.compactTokens;
      compactStartIndex += 1;
    } while (compactTokens > config.compact_target_tokens && compactStartIndex < richStartIndex - 1);
  }

  const compacted = prepared.slice(compactStartIndex, richStartIndex);
  const rich = prepared.slice(richStartIndex);
  const dropped = prepared.slice(0, compactStartIndex);
  const nextState = buildState(
    options.timelineKey,
    prepared,
    compactStartIndex,
    richStartIndex,
    options.state,
    options.now,
  );
  const stateChanged =
    initial.invalid ||
    nextState.compactStartEventId !== (options.state?.compactStartEventId ?? null) ||
    nextState.richStartEventId !== (options.state?.richStartEventId ?? null);

  return {
    turns: buildTieredTurns([
      ...compacted.map((item) => ({ item, tier: "compact" as const })),
      ...rich.map((item) => ({ item, tier: "rich" as const })),
    ]),
    compactTokens,
    richTokens,
    compactedMessageIds: compacted
      .map((item) => item.event.id)
      .filter((id) => !originallyCompacted.has(id)),
    droppedMessageIds: dropped
      .map((item) => item.event.id)
      .filter((id) => !originallyDropped.has(id)),
    state: stateChanged || options.state ? nextState : undefined,
    stateChanged,
  };
}

function resolveBoundaryIndexes(
  events: PreparedEvent[],
  state?: TimelineCompactionState,
): { compactStartIndex: number; richStartIndex: number; invalid: boolean } {
  if (events.length === 0 || !state) {
    return { compactStartIndex: 0, richStartIndex: 0, invalid: false };
  }

  const indexById = new Map(events.map((item, index) => [item.event.id, index]));
  const compactStartIndex = state.compactStartEventId
    ? indexById.get(state.compactStartEventId)
    : 0;
  const richStartIndex = state.richStartEventId ? indexById.get(state.richStartEventId) : 0;
  if (compactStartIndex === undefined || richStartIndex === undefined) {
    return { compactStartIndex: 0, richStartIndex: 0, invalid: true };
  }
  if (compactStartIndex > richStartIndex) {
    return { compactStartIndex: 0, richStartIndex: 0, invalid: true };
  }
  return { compactStartIndex, richStartIndex, invalid: false };
}

function buildState(
  timelineKey: string,
  events: PreparedEvent[],
  compactStartIndex: number,
  richStartIndex: number,
  previous?: TimelineCompactionState,
  now = Date.now(),
): TimelineCompactionState {
  const compactStartEventId =
    compactStartIndex < richStartIndex ? events[compactStartIndex]?.event.id ?? null : null;
  const richStartEventId = events[richStartIndex]?.event.id ?? null;
  const unchanged =
    previous &&
    previous.compactStartEventId === compactStartEventId &&
    previous.richStartEventId === richStartEventId;
  return {
    schemaVersion: 1,
    timelineKey,
    compactStartEventId,
    richStartEventId,
    updatedAt: unchanged ? previous.updatedAt : now,
  };
}

function buildTieredTurns(
  events: Array<{ item: PreparedEvent; tier: "compact" | "rich" }>,
): TieredTurn[] {
  const turns: TieredTurn[] = [];
  for (const { item, tier } of events) {
    const content = tier === "compact" ? item.compactContent : item.richContent;
    const tokenEstimate = tier === "compact" ? item.compactTokens : item.richTokens;
    const previous = turns.at(-1);
    if (previous && previous.role === item.event.role && previous.tier === tier) {
      previous.messageIds.push(item.event.id);
      previous.content = `${previous.content}\n\n---\n\n${content}`;
      previous.timestamp = item.event.timestamp;
      previous.tokenEstimate += tokenEstimate + estimateTokens("\n\n---\n\n");
    } else {
      turns.push({
        role: item.event.role,
        tier,
        messageIds: [item.event.id],
        content,
        timestamp: item.event.timestamp,
        tokenEstimate,
      });
    }
  }
  return turns;
}

function sumCompactTokens(events: PreparedEvent[], start: number, end: number): number {
  return events.slice(start, end).reduce((sum, item) => sum + item.compactTokens, 0);
}

function sumRichTokens(events: PreparedEvent[], start: number): number {
  return events.slice(start).reduce((sum, item) => sum + item.richTokens, 0);
}
