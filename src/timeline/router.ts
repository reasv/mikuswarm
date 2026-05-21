import type { InboundChatEvent } from "../types.js";
import { TimelineStore } from "./store.js";

export interface RoutedTimelineEvent {
  timelineKey: string;
  inbound: InboundChatEvent;
  duplicate: boolean;
}

export class TimelineRouter {
  constructor(private readonly store: TimelineStore) {}

  async route(inbound: InboundChatEvent): Promise<RoutedTimelineEvent> {
    const existing = this.store.getById(inbound.event.id);
    if (!existing) {
      await this.store.append(inbound.event);
      return { timelineKey: inbound.timelineKey, inbound, duplicate: false };
    }

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
