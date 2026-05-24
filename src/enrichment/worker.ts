import { nanoid } from "nanoid";
import { unlink } from "node:fs/promises";
import type { CanonicalChatEvent } from "../types.js";
import type { MediaAssetRow, LinkPreviewRow, ReplyContextRow, Storage } from "../storage/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "./types.js";
import type { ConcurrencyLimitedFetchClient } from "./fetch-client.js";
import { saveMediaToWorkspace, moveFileToWorkspace, generateTempDownloadPath } from "./media.js";
import { extractLinkedMediaUrls } from "./linked-media.js";
import { detectCharacterCard } from "./card-detect.js";
import path from "node:path";

export interface EnrichmentWorkerOptions {
  storage: Storage;
  capabilities: EnrichmentCapabilities;
  fetchClient: ConcurrencyLimitedFetchClient;
  workspaceRoot: string;
  maxPreviewsPerMessage: number;
  downloadSizeLimit?: number;
}

export class EnrichmentWorker {
  constructor(private readonly options: EnrichmentWorkerOptions) {}

  async process(event: CanonicalChatEvent): Promise<void> {
    const roomId = this.extractRoomId(event);
    const result: EnrichmentResult = {
      mediaAssets: [],
      linkPreviews: [],
      replyContext: null,
    };

    const downloadPromise = this.downloadAttachments(event, roomId, result);
    const replyPromise = this.resolveReplyContext(event, roomId, result);
    const messagePreviewPromise = this.fetchLinkPreviews(
      event.body, "message", event.id, result,
    );

    await Promise.allSettled([downloadPromise, replyPromise, messagePreviewPromise]);

    const replyBodyPromises: Promise<void>[] = [];
    if (result.replyContext?.body) {
      replyBodyPromises.push(
        this.fetchLinkPreviews(result.replyContext.body, "reply", event.id, result),
      );
      replyBodyPromises.push(
        this.processLinkedMedia(result.replyContext.body, "reply_linked_media", event.id, result),
      );
    }
    const bodyLinkedPromise = this.processLinkedMedia(
      event.body, "linked_media", event.id, result,
    );
    await Promise.allSettled([...replyBodyPromises, bodyLinkedPromise]);

    for (const asset of result.mediaAssets) {
      if (asset.media_type === "image" && asset.local_path && asset.download_status === "complete") {
        const absPath = path.join(this.options.workspaceRoot, asset.local_path);
        const detection = await detectCharacterCard(absPath);
        if (detection) {
          asset.detected_content = detection.detected;
          asset.detected_metadata_json = detection.cardName
            ? JSON.stringify({ cardName: detection.cardName })
            : null;
        }
      }
    }

    const captionableTypes = ["image", "video", "audio"];
    for (const asset of result.mediaAssets) {
      if (captionableTypes.includes(asset.media_type) && asset.download_status === "complete") {
        asset.caption_status = "pending";
      } else {
        asset.caption_status = "skipped";
      }
    }

    await this.options.storage.persistEnrichmentResults(event.id, result);
  }

  private extractRoomId(event: CanonicalChatEvent): string {
    const parts = event.timelineKey.split(":");
    if (parts[0] === "matrix" && parts.length >= 4) {
      return parts[3];
    }
    return parts[2] ?? "";
  }

  private async downloadAttachments(
    event: CanonicalChatEvent,
    roomId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    const attachments = event.attachments ?? [];
    if (attachments.length === 0) return;

    const downloads = attachments.map(async (attachment, index) => {
      const asset: MediaAssetRow = {
        id: `${event.id}:attach:${index}`,
        event_id: event.id,
        role: "attachment",
        source_index: index,
        media_type: attachment.mediaType,
        mime_type: attachment.mimeType ?? null,
        size_bytes: attachment.sizeBytes ?? null,
        original_filename: attachment.filename ?? null,
        download_status: "pending",
        caption_status: "pending",
        created_at: Date.now(),
      };

      try {
        const tempPath = generateTempDownloadPath(this.options.workspaceRoot);
        const downloaded = await this.options.capabilities.downloadMedia({
          roomId,
          eventId: event.externalId ?? event.id,
          outputPath: tempPath,
          sizeLimit: this.options.downloadSizeLimit,
        });
        const saved = await moveFileToWorkspace({
          sourcePath: tempPath,
          workspaceRoot: this.options.workspaceRoot,
          originalFilename: downloaded.filename ?? attachment.filename,
          contentType: downloaded.contentType ?? attachment.mimeType,
        });
        asset.local_path = saved.localPath;
        asset.size_bytes = downloaded.sizeBytes;
        asset.mime_type = downloaded.contentType ?? attachment.mimeType ?? null;
        asset.media_type = downloaded.kind || attachment.mediaType;
        asset.download_status = "complete";
        if (downloaded.filename) asset.original_filename = downloaded.filename;
      } catch (error) {
        asset.download_status = "failed";
        asset.download_error = error instanceof Error ? error.message : String(error);
      }

      result.mediaAssets.push(asset);
    });

    await Promise.allSettled(downloads);
  }

  private async resolveReplyContext(
    event: CanonicalChatEvent,
    roomId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    const replyToId = event.replyTo?.externalId;
    if (!replyToId) return;

    try {
      const summary = await this.options.capabilities.messageSummary({
        roomId,
        eventId: replyToId,
      });
      if (!summary) {
        result.replyContext = {
          event_id: event.id,
          reply_external_id: replyToId,
          created_at: Date.now(),
        };
        return;
      }

      const timestamp = Date.parse(summary.timestamp);
      result.replyContext = {
        event_id: event.id,
        reply_external_id: summary.eventId,
        sender_id: summary.sender,
        sender_display_name: summary.senderName ?? null,
        body: summary.body,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        created_at: Date.now(),
      };

      if (summary.msgtype && isMediaMsgtype(summary.msgtype)) {
        await this.downloadReplyAttachment(event.id, roomId, summary, result);
      }
    } catch {
      result.replyContext = {
        event_id: event.id,
        reply_external_id: replyToId,
        created_at: Date.now(),
      };
    }
  }

  private async downloadReplyAttachment(
    eventId: string,
    roomId: string,
    summary: { eventId: string; body: string; msgtype?: string },
    result: EnrichmentResult,
  ): Promise<void> {
    const mediaType = mediaTypeForMsgtype(summary.msgtype);
    if (!mediaType) return;

    const asset: MediaAssetRow = {
      id: `${eventId}:reply_attach:0`,
      event_id: eventId,
      role: "reply_attachment",
      source_index: 0,
      media_type: mediaType,
      original_filename: summary.body,
      download_status: "pending",
      caption_status: "pending",
      created_at: Date.now(),
    };

    try {
      const tempPath = generateTempDownloadPath(this.options.workspaceRoot);
      const downloaded = await this.options.capabilities.downloadMedia({
        roomId,
        eventId: summary.eventId,
        outputPath: tempPath,
        sizeLimit: this.options.downloadSizeLimit,
      });
      const saved = await moveFileToWorkspace({
        sourcePath: tempPath,
        workspaceRoot: this.options.workspaceRoot,
        originalFilename: downloaded.filename ?? summary.body,
        contentType: downloaded.contentType,
      });
      asset.local_path = saved.localPath;
      asset.size_bytes = downloaded.sizeBytes;
      asset.mime_type = downloaded.contentType ?? null;
      asset.media_type = downloaded.kind || mediaType;
      asset.download_status = "complete";
    } catch (error) {
      asset.download_status = "failed";
      asset.download_error = error instanceof Error ? error.message : String(error);
    }

    result.mediaAssets.push(asset);
  }

  private async fetchLinkPreviews(
    bodyText: string,
    context: "message" | "reply",
    eventId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    if (!bodyText.includes("http")) return;

    try {
      const previewResult = await this.options.capabilities.resolveLinkPreviews({
        bodyText,
        includeImages: true,
        maxBytes: 256_000,
      });

      const maxPreviews = this.options.maxPreviewsPerMessage;
      const sources = previewResult.sources.slice(0, maxPreviews);
      const now = Date.now();

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const previewId = nanoid();
        const preview: LinkPreviewRow = {
          id: previewId,
          event_id: eventId,
          context,
          url: source.url,
          title: source.title ?? null,
          description: source.description ?? previewResult.textBlocks[i] ?? null,
          site_name: source.siteName ?? null,
          source_kind: source.sourceKind ?? null,
          preview_index: i,
          fetched_at: now,
          fetch_status: "complete",
          created_at: now,
        };
        result.linkPreviews.push(preview);
      }

      const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";
      const urlToPreviewId = new Map<string, string>();
      for (const lp of result.linkPreviews) {
        if (lp.event_id === eventId && lp.context === context) {
          urlToPreviewId.set(lp.url, lp.id);
        }
      }

      for (const media of previewResult.media) {
        const data = Buffer.from(media.dataBase64, "base64");
        const asset: MediaAssetRow = {
          id: nanoid(),
          event_id: eventId,
          role: mediaRole,
          link_preview_id: urlToPreviewId.get(media.sourceUrl) ?? null,
          media_type: inferMediaType(media.contentType),
          mime_type: media.contentType ?? null,
          original_filename: media.filename ?? null,
          download_status: "pending",
          caption_status: "pending",
          created_at: now,
        };

        try {
          const saved = await saveMediaToWorkspace({
            data,
            workspaceRoot: this.options.workspaceRoot,
            originalFilename: media.filename,
            contentType: media.contentType,
          });
          asset.local_path = saved.localPath;
          asset.download_status = "complete";
          asset.size_bytes = data.byteLength;
        } catch (error) {
          asset.download_status = "failed";
          asset.download_error = error instanceof Error ? error.message : String(error);
        }

        result.mediaAssets.push(asset);
      }
    } catch {
      // link preview failure is non-fatal
    }
  }

  private async processLinkedMedia(
    bodyText: string,
    role: "linked_media" | "reply_linked_media",
    eventId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    const previewUrls = new Set(result.linkPreviews.map((lp) => lp.url));
    const urls = extractLinkedMediaUrls(bodyText, previewUrls);
    if (urls.length === 0) return;

    const downloads = urls.map(async (url, index) => {
      const asset: MediaAssetRow = {
        id: nanoid(),
        event_id: eventId,
        role,
        source_index: index,
        media_type: inferMediaTypeFromUrl(url),
        download_status: "pending",
        caption_status: "pending",
        created_at: Date.now(),
      };

      try {
        const fetched = await this.options.fetchClient.fetch(url);
        if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
          await unlink(fetched.path).catch(() => {});
          asset.download_status = "failed";
          asset.download_error = `HTTP ${fetched.statusCode}`;
          result.mediaAssets.push(asset);
          return;
        }
        const saved = await moveFileToWorkspace({
          sourcePath: fetched.path,
          workspaceRoot: this.options.workspaceRoot,
          originalFilename: urlFilename(url),
          contentType: fetched.contentType,
        });
        asset.local_path = saved.localPath;
        asset.mime_type = fetched.contentType ?? null;
        asset.download_status = "complete";
        asset.size_bytes = fetched.sizeBytes;
        if (fetched.contentType) {
          asset.media_type = inferMediaType(fetched.contentType);
        }
      } catch (error) {
        asset.download_status = "failed";
        asset.download_error = error instanceof Error ? error.message : String(error);
      }

      result.mediaAssets.push(asset);
    });

    await Promise.allSettled(downloads);
  }
}

function isMediaMsgtype(msgtype: string): boolean {
  return ["m.image", "m.video", "m.audio", "m.file"].includes(msgtype);
}

function mediaTypeForMsgtype(msgtype?: string): string | undefined {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.video") return "video";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.file") return "file";
  return undefined;
}

function inferMediaType(contentType?: string): string {
  if (!contentType) return "file";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function inferMediaTypeFromUrl(url: string): string {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (!ext) return "file";
    if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
    if (["mp4", "webm", "mov"].includes(ext)) return "video";
    if (["mp3", "ogg", "wav", "flac"].includes(ext)) return "audio";
  } catch { /* ignore */ }
  return "file";
}

function urlFilename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const basename = pathname.split("/").pop();
    return basename || undefined;
  } catch {
    return undefined;
  }
}

