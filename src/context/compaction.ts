import type { AppConfig } from "../config/index.js";
import type { TimelineCompactionState } from "../storage/index.js";
import type { CanonicalChatEvent, ChatRole } from "../types.js";
import type { ReactionLine } from "./reactions.js";
import { estimateTokens } from "./tokens.js";
import type { ContextTurn } from "./turns.js";

export interface TieredTurn extends ContextTurn {
  tier: "compact" | "rich" | "mixed";
  tokenEstimate: number;
}

export interface CompactionResult {
  turns: TieredTurn[];
  compactTokens: number;
  richTokens: number;
  compactedMessageIds: string[];
  droppedMessageIds: string[];
  /** Compact-tier events, oldest first, with per-event compact token estimates. */
  compactEvents: Array<{ id: string; timestamp: number; compactTokens: number }>;
  state?: TimelineCompactionState;
  stateChanged: boolean;
}

export interface CompactTimelineOptions {
  timelineKey: string;
  state?: TimelineCompactionState;
  now?: number;
  /**
   * View B reaction lines (ARCHITECTURE.md §9f) to interleave into the rich-tier
   * turn stream. They do NOT influence the compact/rich boundary (reaction lines
   * are tiny — useless as a token-budget signal); only those whose timestamp
   * falls within the rich tier's time span are injected, at their chronological
   * position, merged into adjacent user turns.
   */
  reactionLines?: ReactionLine[];
  /**
   * View B horizon as a rich-tier message count: 0 (default) = the whole rich
   * tier (horizon = oldest rich event); >0 = only the last N rich messages, so
   * the horizon is the Nth-from-last rich event's timestamp. Past the horizon a
   * reaction exists only as a View A count.
   */
  discreteHorizonMessages?: number;
  /**
   * View B horizon for NON-self (inter-user) reaction lines, applied independently
   * of {@link discreteHorizonMessages} so cross-user reactions can be clamped to a
   * tighter recent-message window than the bot-directed lines (§9f asymmetric
   * horizon). Same units (0 = whole rich tier; >0 = last N rich messages). When
   * undefined, non-self lines fall back to {@link discreteHorizonMessages}.
   */
  discreteOtherHorizonMessages?: number;
}

/** A renderable unit fed to {@link buildTieredTurns}: a real event or a synthetic line. */
type TurnUnit = {
  role: ChatRole;
  tier: "compact" | "rich";
  content: string;
  tokenEstimate: number;
  timestamp: number;
  /** Present for real events; absent for synthetic reaction lines. */
  messageId?: string;
};

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

  const compactUnits: TurnUnit[] = compacted.map((item) => ({
    role: item.event.role,
    tier: "compact",
    content: item.compactContent,
    tokenEstimate: item.compactTokens,
    timestamp: item.event.timestamp,
    messageId: item.event.id,
  }));
  const richEventUnits: TurnUnit[] = rich.map((item) => ({
    role: item.event.role,
    tier: "rich",
    content: item.richContent,
    tokenEstimate: item.richTokens,
    timestamp: item.event.timestamp,
    messageId: item.event.id,
  }));
  // Inject only reaction lines within the rich tier's time span (§8 horizon).
  // discreteHorizonMessages tightens it to the last N rich messages (0 = whole
  // tier). Non-self (inter-user) lines use their own, typically tighter, horizon
  // (§9f asymmetric horizon); when unset they inherit the self horizon.
  const selfHorizon = computeReactionHorizon(rich, options.discreteHorizonMessages ?? 0);
  const otherHorizon = computeReactionHorizon(
    rich,
    options.discreteOtherHorizonMessages ?? options.discreteHorizonMessages ?? 0,
  );
  const reactionUnits: TurnUnit[] = (options.reactionLines ?? [])
    .filter((line) => line.timestamp >= (line.self ? selfHorizon : otherHorizon))
    .map((line) => ({
      role: "user" as ChatRole,
      tier: "rich" as const,
      content: line.content,
      tokenEstimate: estimateTokens(line.content),
      timestamp: line.timestamp,
    }));
  // Merge reaction lines into the rich region by timestamp; at equal timestamps a
  // reaction sorts AFTER the message (a reaction can't predate its target). Real
  // events already arrive in chronological order, and V8's sort is stable.
  const richUnits = [...richEventUnits, ...reactionUnits].sort(
    (a, b) => a.timestamp - b.timestamp || rankUnit(a) - rankUnit(b),
  );
  const reactionTokens = reactionUnits.reduce((sum, u) => sum + u.tokenEstimate, 0);

  return {
    turns: buildTieredTurns([...compactUnits, ...richUnits]),
    compactTokens,
    richTokens: richTokens + reactionTokens,
    compactedMessageIds: compacted
      .map((item) => item.event.id)
      .filter((id) => !originallyCompacted.has(id)),
    droppedMessageIds: dropped
      .map((item) => item.event.id)
      .filter((id) => !originallyDropped.has(id)),
    compactEvents: compacted.map((item) => ({
      id: item.event.id,
      timestamp: item.event.timestamp,
      compactTokens: item.compactTokens,
    })),
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

/** Rank for sort tiebreak: real events (with a messageId) precede synthetic lines. */
function rankUnit(unit: TurnUnit): number {
  return unit.messageId ? 0 : 1;
}

/**
 * The View B inclusion horizon: a reaction line renders only if its timestamp is
 * >= this value. `n <= 0` (or n covering the whole tier) → the oldest rich event;
 * `n > 0` → the Nth-from-last rich event, restricting lines to the last N rich
 * messages' time span. With no rich tier, nothing can interleave (+Infinity).
 */
function computeReactionHorizon(rich: PreparedEvent[], n: number): number {
  if (rich.length === 0) return Number.POSITIVE_INFINITY;
  if (n <= 0 || n >= rich.length) return rich[0]!.event.timestamp;
  return rich[rich.length - n]!.event.timestamp;
}

function buildTieredTurns(units: TurnUnit[]): TieredTurn[] {
  const turns: TieredTurn[] = [];
  for (const unit of units) {
    const previous = turns.at(-1);
    if (previous && previous.role === unit.role) {
      if (unit.messageId) previous.messageIds.push(unit.messageId);
      previous.content = `${previous.content}\n\n---\n\n${unit.content}`;
      previous.timestamp = unit.timestamp;
      previous.tokenEstimate += unit.tokenEstimate + estimateTokens("\n\n---\n\n");
      if (previous.tier !== unit.tier) previous.tier = "mixed";
    } else {
      turns.push({
        role: unit.role,
        tier: unit.tier,
        messageIds: unit.messageId ? [unit.messageId] : [],
        content: unit.content,
        timestamp: unit.timestamp,
        tokenEstimate: unit.tokenEstimate,
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
