import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { AttachmentMeta, CanonicalChatEvent, LinkPreviewMeta, ReplyContext } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import type { Storage, MediaAssetRow, LinkPreviewRow, ReplyContextRow } from "../storage/index.js";
import { compactTimelineEvents } from "./compaction.js";
import { renderCompactMessage, renderRichMessage } from "./renderer.js";
import { estimateTokens } from "./tokens.js";
import { escapeXml } from "./xml.js";

export interface ContextMessage {
  type: "system" | "chatEvent" | "runtimeInstructions";
  role: "user" | "assistant" | "system";
  content: string;
  tier?: "compact" | "rich" | "mixed" | "runtime" | "system";
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
    private readonly storage: Storage,
  ) {}

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const compactionState = this.store.getCompactionState(options.timelineKey);
    let events = this.store.queryForContext(options.timelineKey, compactionState);

    events = this.hydrateEvents(events);

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

  private hydrateEvents(events: CanonicalChatEvent[]): CanonicalChatEvent[] {
    if (events.length === 0) return events;

    const eventIds = events.map((e) => e.id);
    const { replyContexts, linkPreviews, mediaAssets } = this.storage.getEnrichmentData(eventIds);

    return events.map((event) => {
      const rc = replyContexts.get(event.id);
      const lps = linkPreviews.get(event.id);
      const mas = mediaAssets.get(event.id);

      if (!rc && !lps && !mas) return event;
      return mergeEnrichmentIntoEvent(event, rc ?? null, lps ?? [], mas ?? []);
    });
  }

  private async selectImageBlocks(trigger: CanonicalChatEvent): Promise<ImageBlock[]> {
    const multimodal = this.config.models.default?.multimodal ?? false;
    if (!multimodal) return [];
    const images = this.selectImageAttachments(trigger);
    const blocks: ImageBlock[] = [];
    for (const { eventId, attachment } of images) {
      if (!attachment.localPath) continue;
      const absPath = attachment.localPath.startsWith("/")
        ? attachment.localPath
        : path.join(this.config.workspace.root_dir, attachment.localPath);
      const input = await readFile(absPath).catch(() => undefined);
      if (!input) continue;
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
  ): Array<{ eventId: string; attachment: AttachmentMeta }> {
    const triggerGroupAssets = this.storage.getMediaAssetsForTriggerGroup(trigger.id);
    if (triggerGroupAssets.length > 0) {
      return this.applyImagePriorityCascade(trigger.id, triggerGroupAssets);
    }

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

    return [];
  }

  private applyImagePriorityCascade(
    triggerEventId: string,
    assets: MediaAssetRow[],
  ): Array<{ eventId: string; attachment: AttachmentMeta }> {
    const tiers: Array<{ eventMatch: (a: MediaAssetRow) => boolean; roleMatch: (a: MediaAssetRow) => boolean }> = [
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => a.role === "attachment" },
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => a.role === "reply_attachment" },
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => ["preview_media", "linked_media"].includes(a.role) },
      { eventMatch: (a) => a.event_id !== triggerEventId, roleMatch: (a) => a.role === "attachment" },
      { eventMatch: (a) => a.event_id !== triggerEventId, roleMatch: () => true },
    ];

    for (const tier of tiers) {
      const matched = assets.filter((a) => tier.eventMatch(a) && tier.roleMatch(a));
      if (matched.length > 0) {
        return matched.map((a) => ({
          eventId: a.event_id,
          attachment: mediaAssetToAttachmentMeta(a),
        }));
      }
    }

    return [];
  }
}

function mergeEnrichmentIntoEvent(
  event: CanonicalChatEvent,
  replyContext: ReplyContextRow | null,
  linkPreviews: LinkPreviewRow[],
  mediaAssets: MediaAssetRow[],
): CanonicalChatEvent {
  const merged = { ...event };

  const attachmentAssets = mediaAssets
    .filter((a) => a.role === "attachment")
    .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0));
  if (attachmentAssets.length > 0) {
    merged.attachments = attachmentAssets.map(mediaAssetToAttachmentMeta);
  }

  if (replyContext) {
    const replyAttachments = mediaAssets
      .filter((a) => a.role === "reply_attachment")
      .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0));
    const replyLinkPreviews = linkPreviews
      .filter((lp) => lp.context === "reply")
      .sort((a, b) => a.preview_index - b.preview_index);
    const replyPreviewMedia = mediaAssets.filter((a) => a.role === "reply_preview_media");

    merged.replyTo = {
      externalId: replyContext.reply_external_id ?? undefined,
      sender: replyContext.sender_id ? {
        id: replyContext.sender_id,
        displayName: replyContext.sender_display_name ?? undefined,
        username: replyContext.sender_username ?? undefined,
      } : undefined,
      body: replyContext.body ?? undefined,
      htmlBody: replyContext.html_body ?? undefined,
      timestamp: replyContext.timestamp ?? undefined,
      attachments: replyAttachments.length > 0 ? replyAttachments.map(mediaAssetToAttachmentMeta) : undefined,
      linkPreviews: replyLinkPreviews.length > 0
        ? replyLinkPreviews.map((lp) => linkPreviewRowToMeta(lp, replyPreviewMedia))
        : undefined,
    };
  }

  const messageLinkPreviews = linkPreviews
    .filter((lp) => lp.context === "message")
    .sort((a, b) => a.preview_index - b.preview_index);
  if (messageLinkPreviews.length > 0) {
    const previewMedia = mediaAssets.filter((a) => a.role === "preview_media");
    merged.linkPreviews = messageLinkPreviews.map((lp) => linkPreviewRowToMeta(lp, previewMedia));
  }

  return merged;
}

function mediaAssetToAttachmentMeta(asset: MediaAssetRow): AttachmentMeta {
  return {
    id: asset.id,
    filename: asset.original_filename ?? undefined,
    mimeType: asset.mime_type ?? undefined,
    mediaType: asset.media_type as AttachmentMeta["mediaType"],
    sizeBytes: asset.size_bytes ?? undefined,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    localPath: asset.local_path ?? undefined,
    caption: asset.caption ?? undefined,
    processing: {
      downloaded: asset.download_status === "complete",
      captioned: asset.caption_status === "complete",
    },
  };
}

function linkPreviewRowToMeta(lp: LinkPreviewRow, allMedia: MediaAssetRow[]): LinkPreviewMeta {
  const media = allMedia.filter((a) => a.link_preview_id === lp.id);
  return {
    url: lp.url,
    title: lp.title ?? undefined,
    description: lp.description ?? undefined,
    sourceKind: lp.source_kind ?? undefined,
    media: media.length > 0 ? media.map(mediaAssetToAttachmentMeta) : undefined,
    fetchedAt: lp.fetched_at ?? undefined,
  };
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
        `<session id="${session.id}" started="${new Date(session.createdAt).toISOString()}" triggered_by="${escapeXml((session.trigger.event.body ?? "").slice(0, 160))}"/>`,
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
