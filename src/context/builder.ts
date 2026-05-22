import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { compactTimelineEvents } from "./compaction.js";
import { renderCompactMessage, renderRichMessage } from "./renderer.js";
import { estimateTokens } from "./tokens.js";

export interface ContextMessage {
  type: "system" | "chatEvent" | "runtimeInstructions";
  role: "user" | "assistant" | "system";
  content: string;
  tier?: "compact" | "rich" | "runtime" | "system";
  tokenEstimate: number;
  imageBlocks?: ImageBlock[];
  timestamp?: number;
}

export interface ImageBlock {
  eventId: string;
  attachmentId: string;
  mediaType: string;
  dataBase64: string;
}

export interface BuildContextOptions {
  timelineKey: string;
  trigger: CanonicalChatEvent;
  activeSessions: AgentSessionRecord[];
  now?: Date;
}

export interface BuiltContext {
  messages: ContextMessage[];
  tokenEstimate: number;
  compactTokens: number;
  richTokens: number;
  imageBlocks: ImageBlock[];
}

export class ContextBuilder {
  constructor(
    private readonly store: TimelineStore,
    private readonly config: AppConfig,
  ) {}

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const compactionState = this.store.getCompactionState(options.timelineKey);
    const events = this.store.queryForContext(options.timelineKey, compactionState);
    const compacted = compactTimelineEvents(
      events,
      renderRichMessage,
      renderCompactMessage,
      this.config.context.tiers,
      {
        timelineKey: options.timelineKey,
        state: compactionState,
      },
    );
    if (compacted.stateChanged && compacted.state) {
      await this.store.saveCompactionState(compacted.state);
    }
    const chatMessages: ContextMessage[] = compacted.turns.map((turn) => ({
      type: "chatEvent",
      role: turn.role,
      content: turn.content,
      tier: turn.tier,
      tokenEstimate: turn.tokenEstimate,
      timestamp: turn.timestamp,
    }));
    const runtime = renderRuntimeInstructions(options);
    const imageBlocks = await this.selectImageBlocks(options.trigger);
    const messages: ContextMessage[] = [
      {
        type: "system",
        role: "system",
        content: this.config.agent.system.prompt,
        tier: "system",
        tokenEstimate: estimateTokens(this.config.agent.system.prompt),
      },
      ...chatMessages,
      {
        type: "runtimeInstructions",
        role: "user",
        content: runtime,
        tier: "runtime",
        tokenEstimate: estimateTokens(runtime),
        imageBlocks,
      },
    ];
    return {
      messages,
      tokenEstimate: messages.reduce((sum, message) => sum + message.tokenEstimate, 0),
      compactTokens: compacted.compactTokens,
      richTokens: compacted.richTokens,
      imageBlocks,
    };
  }

  private async selectImageBlocks(trigger: CanonicalChatEvent): Promise<ImageBlock[]> {
    const multimodal = this.config.models.default?.multimodal ?? false;
    if (!multimodal) return [];
    const images = this.selectImageAttachments(trigger);
    const blocks: ImageBlock[] = [];
    for (const { eventId, attachment } of images) {
      const input = await readFile(attachment.localPath!);
      const output = await encodeImageForContext(input, {
        maxWidth: this.config.context.images.max_width,
        maxHeight: this.config.context.images.max_height,
        maxBytes: this.config.context.images.max_bytes,
      }).catch(() => undefined);
      if (!output) continue;
      blocks.push({
        eventId,
        attachmentId: attachment.id,
        mediaType: "image/jpeg",
        dataBase64: output.toString("base64"),
      });
    }
    return blocks;
  }

  private selectImageAttachments(
    trigger: CanonicalChatEvent,
  ): Array<{ eventId: string; attachment: NonNullable<CanonicalChatEvent["attachments"]>[number] }> {
    const triggerImages = imageAttachments(trigger).map((attachment) => ({ eventId: trigger.id, attachment }));
    if (triggerImages.length > 0) return triggerImages;

    const replyImages = (trigger.replyTo?.attachments ?? [])
      .filter((attachment) => attachment.mediaType === "image" && attachment.localPath)
      .map((attachment) => ({ eventId: trigger.replyTo?.externalId ?? trigger.id, attachment }));
    if (replyImages.length > 0) return replyImages;

    for (const eventId of trigger.trigger?.groupedEventIds ?? []) {
      if (eventId === trigger.id) continue;
      const event = this.store.getById(eventId);
      const groupedImages = event ? imageAttachments(event).map((attachment) => ({ eventId: event.id, attachment })) : [];
      if (groupedImages.length > 0) return groupedImages;
    }

    const lookback = this.store
      .query({
        timelineKey: trigger.timelineKey,
        toTimestamp: trigger.timestamp,
        fromTimestamp: trigger.timestamp - Math.max(5_000, this.config.matrix.trigger_hold_ms * 2),
        limit: 50,
      })
      .reverse()
      .find(
        (event) =>
          event.id !== trigger.id &&
          event.sender.id === trigger.sender.id &&
          imageAttachments(event).length > 0,
      );
    return lookback ? imageAttachments(lookback).map((attachment) => ({ eventId: lookback.id, attachment })) : [];
  }
}

export interface ImageEncodingOptions {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}

export async function encodeImageForContext(
  input: Buffer,
  options: ImageEncodingOptions,
): Promise<Buffer | undefined> {
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(input).metadata();
  let width = Math.min(metadata.width ?? options.maxWidth, options.maxWidth);
  let height = Math.min(metadata.height ?? options.maxHeight, options.maxHeight);
  let best: Buffer | undefined;

  for (;;) {
    for (const quality of [82, 72, 62, 52, 42, 35]) {
      const output = await sharp(input)
        .resize({
          width: Math.round(width),
          height: Math.round(height),
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      best = output;
      if (output.byteLength <= options.maxBytes) return output;
    }
    if (width <= 64 || height <= 64) break;
    width *= 0.75;
    height *= 0.75;
    width = Math.max(width, 64);
    height = Math.max(height, 64);
  }

  if (!best) {
    throw new Error("Unable to encode image for context");
  }
  return best.byteLength <= options.maxBytes ? best : undefined;
}

function imageAttachments(event: CanonicalChatEvent): NonNullable<CanonicalChatEvent["attachments"]> {
  return (event.attachments ?? []).filter((attachment) => attachment.mediaType === "image" && attachment.localPath);
}

function renderRuntimeInstructions(options: BuildContextOptions): string {
  const sessions = options.activeSessions
    .map(
      (session) =>
        `<session id="${session.id}" started="${new Date(session.createdAt).toISOString()}" triggered_by="${escapeXml(session.trigger.event.body.slice(0, 160))}"/>`,
    )
    .join("\n");
  return `<runtime>
Current time: ${(options.now ?? new Date(options.trigger.timestamp)).toISOString()}
Current timeline: ${escapeXml(options.timelineKey)}
Trigger event: ${escapeXml(options.trigger.id)}

<active_sessions>
${sessions}
</active_sessions>
</runtime>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
