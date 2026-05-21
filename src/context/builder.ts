import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { compactTurns } from "./compaction.js";
import { renderCompactMessage, renderRichMessage } from "./renderer.js";
import { estimateTokens } from "./tokens.js";
import { buildTurns, type RenderedMessage } from "./turns.js";

export interface ContextMessage {
  type: "system" | "chatEvent" | "runtimeInstructions";
  role: "user" | "assistant" | "system";
  content: string;
  tier?: "compact" | "rich" | "runtime" | "system";
  tokenEstimate: number;
  imageBlocks?: ImageBlock[];
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
    const events = this.store.query({ timelineKey: options.timelineKey, limit: 1000 });
    const eventById = new Map(events.map((event) => [event.id, event]));
    const rendered: RenderedMessage[] = events.map((event) => ({
      id: event.id,
      role: event.role,
      content: renderRichMessage(event),
    }));
    const turns = buildTurns(rendered);
    const compacted = compactTurns(
      turns,
      renderCompactMessage,
      eventById,
      this.config.context.tiers,
    );
    const chatMessages: ContextMessage[] = compacted.turns.map((turn) => ({
      type: "chatEvent",
      role: turn.role,
      content: turn.content,
      tier: turn.tier,
      tokenEstimate: turn.tokenEstimate,
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
    const images = (trigger.attachments ?? []).filter(
      (attachment) => attachment.mediaType === "image" && attachment.localPath,
    );
    const blocks: ImageBlock[] = [];
    for (const attachment of images) {
      const input = await readFile(attachment.localPath!);
      const output = await sharp(input)
        .resize({
          width: this.config.context.images.max_width,
          height: this.config.context.images.max_height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer();
      blocks.push({
        eventId: trigger.id,
        attachmentId: attachment.id,
        mediaType: "image/jpeg",
        dataBase64: output.toString("base64"),
      });
    }
    return blocks;
  }
}

function renderRuntimeInstructions(options: BuildContextOptions): string {
  const sessions = options.activeSessions
    .map(
      (session) =>
        `<session id="${session.id}" started="${new Date(session.createdAt).toISOString()}" triggered_by="${escapeXml(session.trigger.event.body.slice(0, 160))}"/>`,
    )
    .join("\n");
  return `<runtime>
Current time: ${(options.now ?? new Date()).toISOString()}
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
