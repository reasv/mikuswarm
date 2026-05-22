import type { CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "./store.js";

export class AssistantEchoResolver {
  constructor(private readonly store: TimelineStore) {}

  async ingestOwnEcho(event: CanonicalChatEvent): Promise<"enriched" | "appended"> {
    const existing = this.findLocalAssistantEvent(event);
    if (!existing) {
      await this.store.append(event);
      return "appended";
    }
    await this.store.enrich(existing.id, (current) => ({
      ...current,
      externalId: event.externalId ?? current.externalId,
      timestamp: event.timestamp,
      receivedAt: Math.min(current.receivedAt, event.receivedAt),
    }));
    return "enriched";
  }

  private findLocalAssistantEvent(event: CanonicalChatEvent): CanonicalChatEvent | undefined {
    if (event.externalId) {
      const byExternalId = this.store.getByExternalId(event.provider, event.externalId);
      if (byExternalId?.role === "assistant" && byExternalId.sender.isSelf) return byExternalId;
    }

    const candidates = this.store
      .query({ timelineKey: event.timelineKey, limit: 1000 })
      .reverse()
      .filter((candidate) => candidate.role === "assistant" && candidate.sender.isSelf);

    if (event.externalId) {
      const byExternalId = candidates.find((candidate) => candidate.externalId === event.externalId);
      if (byExternalId) return byExternalId;
    }

    const normalizedBody = normalizeBody(event.body);
    if (!normalizedBody) return undefined;
    const fuzzyMatches = candidates.filter(
      (candidate) =>
        !candidate.externalId &&
        normalizeBody(candidate.body) === normalizedBody &&
        Math.abs(candidate.timestamp - event.timestamp) <= 5 * 60 * 1000,
    );
    return fuzzyMatches.length === 1 ? fuzzyMatches[0] : undefined;
  }
}

function normalizeBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
