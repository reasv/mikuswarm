import type { InboundChatEvent } from "../types.js";
import { TimelineStore } from "./store.js";

export interface RoutedTimelineEvent {
  timelineKey: string;
  inbound: InboundChatEvent;
  duplicate: boolean;
}

export class TimelineRouter {
  constructor(private readonly store: TimelineStore) {}

  async route(inbound: InboundChatEvent, enrichmentStatus?: string): Promise<RoutedTimelineEvent> {
    const routed = await this.store.appendIfMissing(inbound.event, enrichmentStatus);
    if (!routed.duplicate) {
      return { timelineKey: inbound.timelineKey, inbound, duplicate: false };
    }

    const existing = routed.event;
    if (inbound.trigger && !existing.trigger) {
      await this.store.enrich(inbound.event.id, (event) => ({
        ...event,
        trigger: inbound.trigger,
      }));
    }

    return { timelineKey: inbound.timelineKey, inbound, duplicate: true };
  }
}

export function isDmTimeline(timelineKey: string): boolean {
  return timelineKey.includes(":dm:");
}
