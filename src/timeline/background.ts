import type { CaptionResult, CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "./store.js";

export type Captioner = (event: CanonicalChatEvent) => Promise<CaptionResult[]>;

export interface BackgroundProcessingOptions {
  captioner?: Captioner;
  nonTriggerTimeoutMs?: number;
}

export class BackgroundProcessor {
  constructor(
    private readonly store: TimelineStore,
    private readonly options: BackgroundProcessingOptions = {},
  ) {}

  async prepareTriggerEvent(event: CanonicalChatEvent): Promise<CanonicalChatEvent> {
    if (!event.attachments?.length || !this.options.captioner) return event;
    const captions = await this.options.captioner(event);
    const updated = { ...event, generatedCaptions: captions };
    await this.store.enrich(event.id, () => updated);
    return updated;
  }

  processNonTriggerEvent(event: CanonicalChatEvent): void {
    if (!event.attachments?.length || !this.options.captioner) return;
    const timeoutMs = this.options.nonTriggerTimeoutMs ?? 2_000;
    void Promise.race([
      this.options.captioner(event),
      new Promise<CaptionResult[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]).then(async (captions) => {
      if (captions.length === 0) return;
      await this.store.enrich(event.id, (current) => ({
        ...current,
        generatedCaptions: captions,
      }));
    });
  }
}

