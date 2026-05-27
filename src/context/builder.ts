import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { AttachmentMeta, CanonicalChatEvent, LinkPreviewMeta, ReplyContext } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import type { Storage, MediaAssetRow, LinkPreviewRow, ReplyContextRow } from "../storage/index.js";
import { processImageForInference, cleanupProcessedImage, type ImageProcessingOptions } from "../media/index.js";
import { compactTimelineEvents } from "./compaction.js";
import { renderCompactMessage, renderRichMessage } from "./renderer.js";
import { estimateTokens } from "./tokens.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import { renderSystemPrompt, renderSatelliteBlock } from "../workspace/prompt.js";

export interface ContextMessage {
  type: "system" | "chatEvent" | "triggerGroup";
  role: "user" | "assistant" | "system";
  content: string;
  tier?: "compact" | "rich" | "mixed" | "runtime" | "system" | "trigger";
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
  workspace: WorkspaceContent;
  sessionType?: SessionTypeConfig;
  fallbackPrompt?: string;
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
    const triggerGroupIds = this.resolveTriggerGroupIds(options.trigger);
    const compactionState = this.store.getCompactionState(options.timelineKey);
    let events = this.store.queryForContext(options.timelineKey, compactionState);

    events = this.hydrateEvents(events);

    const timelineEvents = events.filter((e) => !triggerGroupIds.has(e.id));
    const triggerEvents = events.filter((e) => triggerGroupIds.has(e.id));

    const compacted = compactTimelineEvents(
      timelineEvents,
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

    const imageBlocks = await this.selectImageBlocks(options.trigger);
    const imageBlockIds = new Set(imageBlocks.map((b) => b.attachmentId));

    this.markImageBlocks(triggerEvents, imageBlockIds);

    const chatMessages: ContextMessage[] = compacted.turns.map((turn) => ({
      type: "chatEvent",
      role: turn.role,
      content: turn.content,
      tier: turn.tier,
      tokenEstimate: turn.tokenEstimate,
      timestamp: turn.timestamp,
    }));

    // NOTE: System prompt is rendered identically here and in AgentSessionFactory.create().
    // Both are required: the factory's version sets initialState.systemPrompt (used by
    // pi-agent-core on every API call), and this one populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(options.workspace, options.fallbackPrompt);
    const satellite = renderSatelliteBlock(options, options.workspace, options.sessionType);
    const triggerContent = triggerEvents.map(renderRichMessage).join("\n\n---\n\n");
    const finalUserContent = `<system>\n${satellite}\n</system>\n\n${triggerContent}`;

    const messages: ContextMessage[] = [
      {
        type: "system",
        role: "system",
        content: systemPrompt,
        tier: "system",
        tokenEstimate: estimateTokens(systemPrompt),
      },
      ...chatMessages,
      {
        type: "triggerGroup",
        role: "user",
        content: finalUserContent,
        tier: "trigger",
        tokenEstimate: estimateTokens(finalUserContent),
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

  private resolveTriggerGroupIds(trigger: CanonicalChatEvent): Set<string> {
    const ids = new Set<string>();
    ids.add(trigger.id);
    for (const id of trigger.trigger?.groupedEventIds ?? []) {
      ids.add(id);
    }
    return ids;
  }

  private markImageBlocks(events: CanonicalChatEvent[], imageBlockIds: Set<string>): void {
    if (imageBlockIds.size === 0) return;
    for (const event of events) {
      for (const a of event.attachments ?? []) {
        if (imageBlockIds.has(a.id)) a.isImageBlock = true;
      }
      for (const m of event.linkedMedia ?? []) {
        if (imageBlockIds.has(m.id)) m.isImageBlock = true;
      }
      for (const lp of event.linkPreviews ?? []) {
        for (const m of lp.media ?? []) {
          if (imageBlockIds.has(m.id)) m.isImageBlock = true;
        }
      }
      if (event.replyTo) {
        for (const a of event.replyTo.attachments ?? []) {
          if (imageBlockIds.has(a.id)) a.isImageBlock = true;
        }
        for (const m of event.replyTo.linkedMedia ?? []) {
          if (imageBlockIds.has(m.id)) m.isImageBlock = true;
        }
        for (const lp of event.replyTo.linkPreviews ?? []) {
          for (const m of lp.media ?? []) {
            if (imageBlockIds.has(m.id)) m.isImageBlock = true;
          }
        }
      }
    }
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
    const imageOpts: ImageProcessingOptions = {
      maxTotalPixels: this.config.media?.image?.max_total_pixels ?? 921_600,
      maxTotalPixelsHard: this.config.media?.image?.max_total_pixels_hard ?? 1_843_200,
      minShortestSide: this.config.media?.image?.min_shortest_side ?? 480,
      maxBytes: this.config.media?.image?.max_bytes ?? 1_048_576,
      mozjpeg: this.config.media?.image?.mozjpeg ?? true,
    };
    for (const { eventId, attachment } of images) {
      if (!attachment.localPath) continue;
      const absPath = attachment.localPath.startsWith("/")
        ? attachment.localPath
        : path.join(this.config.workspace.root_dir, attachment.localPath);
      try {
        const processed = await processImageForInference(absPath, imageOpts);
        const data = await readFile(processed.path);
        const mimeType = processed.mimeType;
        await cleanupProcessedImage(processed);
        blocks.push({
          eventId,
          attachmentId: attachment.id,
          mediaType: mimeType,
          dataBase64: data.toString("base64"),
        });
      } catch {
        continue;
      }
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

  const linkedMediaAssets = mediaAssets
    .filter((a) => a.role === "linked_media")
    .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0));
  if (linkedMediaAssets.length > 0) {
    merged.linkedMedia = linkedMediaAssets.map(mediaAssetToAttachmentMeta);
  }

  if (replyContext) {
    const replyAttachments = mediaAssets
      .filter((a) => a.role === "reply_attachment")
      .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0));
    const replyLinkedMedia = mediaAssets
      .filter((a) => a.role === "reply_linked_media")
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
      } : undefined,
      body: replyContext.body ?? undefined,
      htmlBody: replyContext.html_body ?? undefined,
      timestamp: replyContext.timestamp ?? undefined,
      attachments: replyAttachments.length > 0 ? replyAttachments.map(mediaAssetToAttachmentMeta) : undefined,
      linkedMedia: replyLinkedMedia.length > 0 ? replyLinkedMedia.map(mediaAssetToAttachmentMeta) : undefined,
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
  const meta: AttachmentMeta = {
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
  if (asset.detected_content) {
    meta.isCharacterCard = true;
    if (asset.detected_metadata_json) {
      try {
        const parsed = JSON.parse(asset.detected_metadata_json);
        if (parsed.cardName) meta.cardName = parsed.cardName;
      } catch { /* ignore */ }
    }
  }
  return meta;
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

function imageAttachments(event: CanonicalChatEvent): NonNullable<CanonicalChatEvent["attachments"]> {
  return (event.attachments ?? []).filter((attachment) => attachment.mediaType === "image" && attachment.localPath);
}

