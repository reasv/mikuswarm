import type { InboundChatEvent } from "../types.js";
import { channelIdFromTimelineKey, timelineKindOf } from "../storage/timeline-key.js";
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

/**
 * Return true when the timeline key identifies a DM channel. Uses the shared
 * grammar parser (spec DISCORD-SUPPORT-DESIGN §4.2) so the `:dm:` kind segment
 * is read positionally — not by substring search — which is correct for both
 * Matrix and future Discord keys. Falls back to `false` for malformed keys.
 */
export function isDmTimeline(timelineKey: string): boolean {
  return timelineKindOf(timelineKey) === "dm";
}

/**
 * Extract the channel id from a timeline key (callers fall back / log rather than
 * surfacing a garbage id on a malformed key → `undefined`). Delegates to the
 * shared grammar leaf in `src/storage/timeline-key.ts` so this and the storage-
 * side `room_id` denormalization use ONE parser and cannot drift; see that module
 * for the key grammar.
 *
 * For Matrix this is the room id (`!local:server`); for future providers it is the
 * provider-native channel id.
 */
export function roomIdFromTimelineKey(timelineKey: string): string | undefined {
  return channelIdFromTimelineKey(timelineKey);
}

/**
 * Resolve the channel type for routing, preferring `inbound.channelType` when the
 * normalizer has set it, and falling back to key parsing otherwise. Spec
 * DISCORD-SUPPORT-DESIGN §4.3: "Routing prefers the field when present and falls
 * back to `timelineKindOf(key)` for stored keys."
 *
 * - Returns `"dm"` only when the channel type is unambiguously a DM.
 * - Returns `"group"` for both group channels and threads (collapsed), since the
 *   caller ("dm or not?") does not distinguish threads from rooms.
 * - Safe default: malformed / absent keys fall through to `"group"`.
 */
export function channelTypeOf(inbound: InboundChatEvent): "dm" | "group" {
  if (inbound.channelType) {
    return inbound.channelType === "dm" ? "dm" : "group";
  }
  return timelineKindOf(inbound.timelineKey) === "dm" ? "dm" : "group";
}
