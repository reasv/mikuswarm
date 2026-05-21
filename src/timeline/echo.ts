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
    return this.store
      .query({ timelineKey: event.timelineKey, limit: 100 })
      .reverse()
      .find(
        (candidate) =>
          candidate.role === "assistant" &&
          candidate.sender.isSelf &&
          !candidate.externalId &&
          candidate.body.trim() === event.body.trim(),
      );
  }
}

