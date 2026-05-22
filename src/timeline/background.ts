import type { CaptionResult, CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "./store.js";

export type Captioner = (event: CanonicalChatEvent) => Promise<CaptionResult[]>;

export interface BackgroundProcessingOptions {
  captioner?: Captioner;
  nonTriggerTimeoutMs?: number;
  onError?: (error: unknown, context: { eventId: string; phase: "trigger" | "non-trigger" }) => void;
}

export class BackgroundProcessor {
  constructor(
    private readonly store: TimelineStore,
    private readonly options: BackgroundProcessingOptions = {},
  ) {}

  async prepareTriggerEvent(event: CanonicalChatEvent): Promise<CanonicalChatEvent> {
    if (!event.attachments?.length || !this.options.captioner) return event;
    const captions = await this.options.captioner(event);
    const updated = applyCaptions(event, captions);
    await this.store.enrich(event.id, (current) => applyCaptions(current, captions));
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
        ...applyCaptions(current, captions),
      }));
    }).catch((error) => this.options.onError?.(error, { eventId: event.id, phase: "non-trigger" }));
  }
}

function applyCaptions(event: CanonicalChatEvent, captions: CaptionResult[]): CanonicalChatEvent {
  const byAttachment = new Map(captions.map((caption) => [caption.attachmentId, caption]));
  return {
    ...event,
    generatedCaptions: captions,
    attachments: event.attachments?.map((attachment) => {
      const caption = byAttachment.get(attachment.id);
      if (!caption || caption.status !== "complete") return attachment;
      return {
        ...attachment,
        caption: caption.text,
        processing: {
          ...attachment.processing,
          captioned: true,
        },
      };
    }),
  };
}
