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

  while (sumTokens(rich) > config.rich_max_tokens && rich.length > 1) {
    const turn = rich.shift();
    if (!turn) break;
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
    while (sumTokens(rich) > config.rich_target_tokens && rich.length > 1) {
      const extra = rich.shift();
      if (!extra) break;
      const extraContent = extra.messageIds
        .map((id) => eventById.get(id))
        .filter((event): event is CanonicalChatEvent => Boolean(event))
        .map(compactRenderer)
        .join("\n");
      compact.push({
        ...extra,
        tier: "compact",
        content: extraContent,
        tokenEstimate: estimateTokens(extraContent),
      });
      compactedMessageIds.push(...extra.messageIds);
    }
  }

  while (sumTokens(compact) > config.compact_max_tokens && compact.length > 1) {
    const dropped = compact.shift();
    if (!dropped) break;
    droppedMessageIds.push(...dropped.messageIds);
    while (sumTokens(compact) > config.compact_target_tokens && compact.length > 1) {
      const extra = compact.shift();
      if (!extra) break;
      droppedMessageIds.push(...extra.messageIds);
    }
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

