import type { AppConfig } from "../config/index.js";
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
}

export function compactTurns(
  richTurns: ContextTurn[],
  compactRenderer: (event: CanonicalChatEvent) => string,
  eventById: Map<string, CanonicalChatEvent>,
  config: AppConfig["context"]["tiers"],
): CompactionResult {
  let rich: TieredTurn[] = richTurns.map((turn) => ({
    ...turn,
    tier: "rich",
    tokenEstimate: estimateTokens(turn.content),
  }));
  let compact: TieredTurn[] = [];
  const compactedMessageIds: string[] = [];
  const droppedMessageIds: string[] = [];

  if (sumTokens(rich) > config.rich_max_tokens && rich.length > 1) {
    do {
      moveBoundaryUnit(rich, compact, eventById, compactRenderer, compactedMessageIds);
    } while (sumTokens(rich) > config.rich_target_tokens && rich.length > 1);
  }

  if (sumTokens(compact) > config.compact_max_tokens && compact.length > 1) {
    do {
      const dropped = compact.shift();
      if (!dropped) break;
      droppedMessageIds.push(...dropped.messageIds);
    } while (sumTokens(compact) > config.compact_target_tokens && compact.length > 1);
  }

  return {
    turns: [...compact, ...rich],
    compactTokens: sumTokens(compact),
    richTokens: sumTokens(rich),
    compactedMessageIds,
    droppedMessageIds,
  };
}

function sumTokens(turns: TieredTurn[]): number {
  return turns.reduce((sum, turn) => sum + turn.tokenEstimate, 0);
}

function moveBoundaryUnit(
  rich: TieredTurn[],
  compact: TieredTurn[],
  eventById: Map<string, CanonicalChatEvent>,
  compactRenderer: (event: CanonicalChatEvent) => string,
  compactedMessageIds: string[],
): void {
  const first = rich.shift();
  if (!first) return;
  pushCompact(first, compact, eventById, compactRenderer, compactedMessageIds);

  if (first.role === "user" && rich[0]?.role === "assistant") {
    pushCompact(rich.shift()!, compact, eventById, compactRenderer, compactedMessageIds);
  }
}

function pushCompact(
  turn: TieredTurn,
  compact: TieredTurn[],
  eventById: Map<string, CanonicalChatEvent>,
  compactRenderer: (event: CanonicalChatEvent) => string,
  compactedMessageIds: string[],
): void {
  const compactContent = turn.messageIds
    .map((id) => eventById.get(id))
    .filter((event): event is CanonicalChatEvent => Boolean(event))
    .map(compactRenderer)
    .join("\n");
  compact.push({
    ...turn,
    tier: "compact",
    content: compactContent,
    tokenEstimate: estimateTokens(compactContent),
  });
  compactedMessageIds.push(...turn.messageIds);
}
