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

/**
 * Extract the Matrix room id from a timeline key. Keys are shaped
 * `matrix:<account>:room:<roomId>[:thread:<root>]` or
 * `matrix:<account>:dm:<roomId>`. A Matrix room id (`!local:server`) itself
 * contains a colon, so this captures everything between the `room:`/`dm:` marker
 * and an optional `:thread:` suffix rather than splitting on every colon. The
 * `room|dm` kind segment is validated, so a malformed key returns `undefined`
 * (callers fall back / log rather than surfacing a garbage room id).
 */
export function roomIdFromTimelineKey(timelineKey: string): string | undefined {
  const match = timelineKey.match(/^matrix:[^:]+:(?:room|dm):(.+?)(?::thread:.+)?$/);
  const roomId = match?.[1];
  return roomId && roomId.length > 0 ? roomId : undefined;
}
