import type { AppConfig } from "../config/index.js";
import type { InboundChatEvent } from "../types.js";
import { isDmTimeline } from "./router.js";

export interface QueuedTrigger {
  inbound: InboundChatEvent;
  queuedAt: number;
}

export interface TriggerDecision {
  action: "spawn" | "queued" | "ignored";
  inbound?: InboundChatEvent;
  queueLength?: number;
  reason?: string;
}

export class TriggerCoordinator {
  private readonly activeByTimeline = new Map<string, number>();
  private readonly queues = new Map<string, QueuedTrigger[]>();

  constructor(private readonly config: AppConfig["agent"]["sessions"]) {}

  accept(inbound: InboundChatEvent): TriggerDecision {
    if (!inbound.trigger) return { action: "ignored" };
    const limit = this.limitFor(inbound.timelineKey);
    const active = this.activeByTimeline.get(inbound.timelineKey) ?? 0;
    if (active < limit) {
      this.activeByTimeline.set(inbound.timelineKey, active + 1);
      return { action: "spawn", inbound };
    }
    const queue = this.queues.get(inbound.timelineKey) ?? [];
    const maxQueued = this.config.max_queued_per_timeline ?? 10_000;
    if (queue.length >= maxQueued) {
      return { action: "ignored", reason: "queue_full", queueLength: queue.length };
    }
    queue.push({ inbound, queuedAt: Date.now() });
    this.queues.set(inbound.timelineKey, queue);
    return { action: "queued", queueLength: queue.length };
  }

  complete(timelineKey: string): InboundChatEvent | undefined {
    const active = Math.max(0, (this.activeByTimeline.get(timelineKey) ?? 1) - 1);
    this.activeByTimeline.set(timelineKey, active);
    const queue = this.queues.get(timelineKey);
    const next = queue?.shift();
    if (!next) return undefined;
    this.activeByTimeline.set(timelineKey, active + 1);
    return next.inbound;
  }

  activeCount(timelineKey: string): number {
    return this.activeByTimeline.get(timelineKey) ?? 0;
  }

  queuedCount(timelineKey: string): number {
    return this.queues.get(timelineKey)?.length ?? 0;
  }

  clear(): void {
    this.activeByTimeline.clear();
    this.queues.clear();
  }

  private limitFor(timelineKey: string): number {
    return isDmTimeline(timelineKey) ? this.config.max_concurrent_dm : this.config.max_concurrent;
  }
}
