import { nanoid } from "nanoid";
import { unlink } from "node:fs/promises";
import type { CanonicalChatEvent } from "../types.js";
import type { MediaAssetRow, LinkPreviewRow, ReplyContextRow, Storage } from "../storage/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "./types.js";
import type { FetchClient } from "./fetch-client.js";
import { saveMediaToWorkspace, moveFileToWorkspace, generateTempDownloadPath } from "./media.js";
import { extractLinkedMediaUrls } from "./linked-media.js";
import { detectCharacterCard } from "./card-detect.js";
import { channelIdFromTimelineKey } from "../storage/timeline-key.js";
import type { FxTwitterClient } from "../fxtwitter/client.js";
import type { FxApiPhoto, FxApiTweet, FxTwitterConfig, XMediaSlot, XTweetPayload } from "../fxtwitter/types.js";
import { FX_TWITTER_SOURCE_KIND } from "../fxtwitter/types.js";
import { buildTweetNode, renderFlatDescription } from "../fxtwitter/format.js";
import { extractXStatusUrls, stripXStatusUrls, type XStatusRef } from "../fxtwitter/url.js";
import path from "node:path";

export interface EnrichmentLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface EnrichmentWorkerOptions {
  storage: Storage;
  capabilities: EnrichmentCapabilities;
  fetchClient: FetchClient;
  workspaceRoot: string;
  maxPreviewsPerMessage: number;
  downloadSizeLimit?: number;
  /**
   * X.com enrichment via the FxTwitter API (ARCHITECTURE.md §7a). When set, X
   * status URLs are partitioned away from the Synapse preview path and
   * enriched here; when unset, all URLs ride the Synapse path (legacy
   * behavior, also what most tests exercise).
   */
  fxtwitter?: { client: FxTwitterClient; config: FxTwitterConfig };
  logger: EnrichmentLogger;
}

export class EnrichmentWorker {
  /**
   * Raw X status URL matches seen by the preview partition (message + reply
   * bodies). `processLinkedMedia` excludes these in ADDITION to the persisted
   * preview URLs: the preview rows carry the CANONICAL tweet URL, which need
   * not equal the raw body text (twitter.com forms, query strings, share
   * domains). One worker instance handles exactly one event, so instance
   * state is safe.
   */
  private readonly xUrlExclusions = new Set<string>();

  constructor(private readonly options: EnrichmentWorkerOptions) {}

  async process(event: CanonicalChatEvent): Promise<void> {
    // Use channelIdFromTimelineKey (the shared grammar parser) — never a naive
    // split(":") — because Matrix room ids contain a colon (`!local:server`) and
    // naive splitting truncates the server part, making every room-bound capability
    // call fail with an unknown room.
    const roomId = channelIdFromTimelineKey(event.timelineKey);
    if (!roomId) {
      // Key is present on every canonical event; undefined means malformed.
      this.options.logger.warn("timeline_key.malformed", {
        eventId: event.id,
        timelineKey: event.timelineKey,
        site: "enrichment_worker",
      });
    }
    const result: EnrichmentResult = {
      mediaAssets: [],
      linkPreviews: [],
      replyContext: null,
    };

    const downloadPromise = roomId
      ? this.downloadAttachments(event, roomId, result)
      : Promise.resolve();
    const replyPromise = roomId
      ? this.resolveReplyContext(event, roomId, result)
      : Promise.resolve();
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

    // Captionable, downloaded assets are queued 'pending' — EXCEPT on a backfetched
    // event, where they are 'deferred' (spec MESSAGE-BACKFETCH §7.3): inert until an
    // operator retroactively promotes them, regardless of caption_all. This keeps
    // backfetch captioning opt-in and decoupled from the always-on text indexing.
    const isBackfetch = this.options.storage.isBackfetchEvent(event.id);
    const captionableTypes = ["image", "video", "audio"];
    for (const asset of result.mediaAssets) {
      if (captionableTypes.includes(asset.media_type) && asset.download_status === "complete") {
        asset.caption_status = isBackfetch ? "deferred" : "pending";
      } else {
        asset.caption_status = "skipped";
      }
    }

    await this.options.storage.persistEnrichmentResults(event.id, result);
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

      const tempPath = generateTempDownloadPath(this.options.workspaceRoot);
      try {
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
        await unlink(tempPath).catch(() => {});
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
        // Target genuinely unrepresentable (redacted, non-message, …) — stub it
        // so the renderer can say "unavailable", and say why in the log.
        this.options.logger.warn("enrichment_reply_target_missing", {
          eventId: event.id,
          replyToId,
          roomId,
        });
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
    } catch (error) {
      // Degrade to a stub (external_id only) but never silently: an unlogged
      // failure here renders as an empty <reply_to> with no trace of why.
      this.options.logger.error("enrichment_reply_resolution_failed", {
        eventId: event.id,
        replyToId,
        roomId,
        error: error instanceof Error ? error.message : String(error),
      });
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

    const tempPath = generateTempDownloadPath(this.options.workspaceRoot);
    try {
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
      await unlink(tempPath).catch(() => {});
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

    // Partition (ARCHITECTURE.md §7a): X status URLs go to the FxTwitter
    // stage; everything else rides the Synapse capability, called with a body
    // copy from which the X URLs have been STRIPPED so Synapse never produces
    // the bare og-card for them. There is deliberately no Synapse fallback for
    // X URLs — the Synapse result for X is noise, not signal — so when the
    // FxTwitter stage is disabled, X URLs are not previewed at all.
    const fx = this.options.fxtwitter;
    let xRefs: XStatusRef[] = [];
    let synapseBody = bodyText;
    if (fx) {
      xRefs = extractXStatusUrls(bodyText, fx.config.statusHosts);
      if (xRefs.length > 0) {
        synapseBody = stripXStatusUrls(bodyText, fx.config.statusHosts);
        for (const ref of xRefs) this.xUrlExclusions.add(ref.rawUrl);
      }
      if (!fx.config.enabled) xRefs = [];
    }

    let sources: Awaited<ReturnType<EnrichmentCapabilities["resolveLinkPreviews"]>>["sources"] = [];
    let textBlocks: string[] = [];
    let synapseMedia: Awaited<ReturnType<EnrichmentCapabilities["resolveLinkPreviews"]>>["media"] = [];
    if (synapseBody.includes("http")) {
      try {
        const previewResult = await this.options.capabilities.resolveLinkPreviews({
          bodyText: synapseBody,
          includeImages: true,
          maxBytes: 256_000,
        });
        sources = previewResult.sources;
        textBlocks = previewResult.textBlocks;
        synapseMedia = previewResult.media;
      } catch {
        // Synapse preview failure is non-fatal (and must not sink the FxTwitter stage).
      }
    }

    // Shared cap across both kinds, allocated by order of first appearance in
    // the body. A Synapse source whose URL isn't literally in the body
    // (normalized by the scraper) sorts last rather than being dropped.
    const maxPreviews = this.options.maxPreviewsPerMessage;
    type Candidate =
      | { kind: "x"; order: number; ref: XStatusRef }
      | { kind: "synapse"; order: number; sourceIndex: number };
    const candidates: Candidate[] = [
      ...xRefs.map((ref) => ({ kind: "x" as const, order: ref.bodyIndex, ref })),
      ...sources.map((source, sourceIndex) => {
        const at = bodyText.indexOf(source.url);
        return { kind: "synapse" as const, order: at >= 0 ? at : Number.MAX_SAFE_INTEGER, sourceIndex };
      }),
    ]
      .sort((a, b) => a.order - b.order)
      .slice(0, maxPreviews);

    const now = Date.now();
    const fxTasks: Promise<void>[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (candidate.kind === "synapse") {
        const source = sources[candidate.sourceIndex];
        const preview: LinkPreviewRow = {
          id: nanoid(),
          event_id: eventId,
          context,
          url: source.url,
          title: source.title ?? null,
          description: source.description ?? textBlocks[candidate.sourceIndex] ?? null,
          site_name: source.siteName ?? null,
          source_kind: source.sourceKind ?? null,
          preview_index: i,
          fetched_at: now,
          fetch_status: "complete",
          created_at: now,
        };
        result.linkPreviews.push(preview);
      } else {
        fxTasks.push(this.enrichXStatus(candidate.ref, context, eventId, i, result));
      }
    }

    const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";
    const urlToPreviewId = new Map<string, string>();
    for (const lp of result.linkPreviews) {
      if (lp.event_id === eventId && lp.context === context) {
        urlToPreviewId.set(lp.url, lp.id);
      }
    }

    for (const media of synapseMedia) {
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

    await Promise.allSettled(fxTasks);
  }

  /**
   * FxTwitter stage for one X status URL (ARCHITECTURE.md §7a): fetch the
   * tweet, build the structured payload (tweet + quote one level deep),
   * download its media into `media_assets`, and persist one `link_previews`
   * row whose `description` is the flat rendering (the compact-tier fallback
   * AND the chat-search FTS source) and whose `payload_json` feeds the rich
   * renderer. A fetch failure records a failed row — never the event-level
   * retry machinery, same policy as the swallowed Synapse preview failures.
   */
  private async enrichXStatus(
    ref: XStatusRef,
    context: "message" | "reply",
    eventId: string,
    previewIndex: number,
    result: EnrichmentResult,
  ): Promise<void> {
    const fx = this.options.fxtwitter!;
    const now = Date.now();
    const previewId = nanoid();

    let tweet: FxApiTweet;
    try {
      tweet = await fx.client.fetchStatus(ref.statusId, ref.screenName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("enrichment_fxtwitter_failed", {
        eventId,
        url: ref.canonicalUrl,
        error: message,
      });
      result.linkPreviews.push({
        id: previewId,
        event_id: eventId,
        context,
        url: ref.canonicalUrl,
        site_name: "X",
        source_kind: FX_TWITTER_SOURCE_KIND,
        preview_index: previewIndex,
        fetched_at: now,
        fetch_status: "failed",
        error: message,
        created_at: now,
      });
      return;
    }

    const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";
    const payloadTweet = buildTweetNode(tweet, fx.config.maxTextChars);
    const mainSlots = await this.downloadXNodeMedia(tweet, eventId, previewId, mediaRole, result);
    if (mainSlots.length > 0) payloadTweet.media = mainSlots;
    if (tweet.quote && payloadTweet.quote) {
      const quoteSlots = await this.downloadXNodeMedia(tweet.quote, eventId, previewId, mediaRole, result);
      if (quoteSlots.length > 0) payloadTweet.quote.media = quoteSlots;
    }
    const payload: XTweetPayload = { v: 1, tweet: payloadTweet };

    const authorName = tweet.author?.name;
    const screenName = tweet.author?.screen_name;
    const title = screenName
      ? `${authorName ?? screenName} (@${screenName})`
      : authorName ?? null;

    result.linkPreviews.push({
      id: previewId,
      event_id: eventId,
      context,
      url: ref.canonicalUrl,
      title,
      description: renderFlatDescription(payload),
      site_name: "X",
      source_kind: FX_TWITTER_SOURCE_KIND,
      preview_index: previewIndex,
      fetched_at: Date.now(),
      fetch_status: "complete",
      payload_json: JSON.stringify(payload),
      created_at: now,
    });
  }

  /**
   * Media rules per tweet node, main and quote alike (§7a): one photo
   * downloads as-is; two or more collapse into the mosaic collage (one image
   * asset = one caption covering the set) unless `prefer_mosaic` is off or the
   * mosaic URL is absent, in which case each photo is its own positionally
   * indexed slot. Videos and GIFs download the direct mp4 (up to
   * `max_videos_per_tweet` per node); an oversize/failed video falls back to
   * its thumbnail frame so the model at least sees something. All byte caps
   * ride the global `media.download_size_limit` via FetchClient.
   */
  private async downloadXNodeMedia(
    node: FxApiTweet,
    eventId: string,
    previewId: string,
    role: string,
    result: EnrichmentResult,
  ): Promise<XMediaSlot[]> {
    const fxConfig = this.options.fxtwitter!.config;
    const slots: XMediaSlot[] = [];
    const photos = (node.media?.photos ?? []).filter((p): p is FxApiPhoto & { url: string } => Boolean(p.url));
    const videos = (node.media?.videos ?? [])
      .filter((v) => Boolean(v.url))
      .slice(0, fxConfig.maxVideosPerTweet);
    const mosaicUrl = node.media?.mosaic?.formats?.jpeg;

    if (photos.length === 1) {
      const asset = await this.downloadXAsset(photos[0].url, "image", eventId, previewId, role, result);
      slots.push({ assetId: asset.id, kind: "photo", index: 1, altText: photos[0].altText });
    } else if (photos.length >= 2) {
      if (fxConfig.preferMosaic && mosaicUrl) {
        const joinedAlt = photos.map((p) => p.altText).filter(Boolean).join(" / ");
        const asset = await this.downloadXAsset(mosaicUrl, "image", eventId, previewId, role, result);
        slots.push({
          assetId: asset.id,
          kind: "mosaic",
          photoCount: photos.length,
          altText: joinedAlt.length > 0 ? joinedAlt : undefined,
        });
      } else {
        for (let i = 0; i < photos.length; i++) {
          const asset = await this.downloadXAsset(photos[i].url, "image", eventId, previewId, role, result);
          slots.push({ assetId: asset.id, kind: "photo", index: i + 1, altText: photos[i].altText });
        }
      }
    }

    for (const video of videos) {
      const kind = video.type === "gif" ? "gif" : "video";
      const asset = await this.downloadXAsset(video.url!, "video", eventId, previewId, role, result, {
        deferPush: true,
      });
      if (asset.download_status === "complete") {
        result.mediaAssets.push(asset);
        slots.push({ assetId: asset.id, kind, durationSeconds: video.duration });
        continue;
      }
      // Oversize/failed mp4: fall back to the thumbnail frame as an image
      // asset so the model at least sees something; the renderer labels it.
      if (video.thumbnail_url) {
        const thumb = await this.downloadXAsset(video.thumbnail_url, "image", eventId, previewId, role, result, {
          deferPush: true,
        });
        if (thumb.download_status === "complete") {
          thumb.download_error = asset.download_error ?? null;
          result.mediaAssets.push(thumb);
          slots.push({ assetId: thumb.id, kind: "video_thumbnail", durationSeconds: video.duration });
          continue;
        }
      }
      // No usable fallback: keep the failed video asset so the slot stays
      // visible with `download_error` carrying the reason.
      result.mediaAssets.push(asset);
      slots.push({ assetId: asset.id, kind, durationSeconds: video.duration });
    }

    return slots;
  }

  private async downloadXAsset(
    url: string,
    mediaType: "image" | "video",
    eventId: string,
    previewId: string,
    role: string,
    result: EnrichmentResult,
    opts?: { deferPush?: boolean },
  ): Promise<MediaAssetRow> {
    const asset: MediaAssetRow = {
      id: nanoid(),
      event_id: eventId,
      role,
      link_preview_id: previewId,
      media_type: mediaType,
      original_filename: urlFilename(url) ?? null,
      download_status: "pending",
      caption_status: "pending",
      created_at: Date.now(),
    };

    let fetchedPath: string | undefined;
    try {
      const fetched = await this.options.fetchClient.fetch(url);
      fetchedPath = fetched.path;
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        await unlink(fetched.path).catch(() => {});
        fetchedPath = undefined;
        asset.download_status = "failed";
        asset.download_error = `HTTP ${fetched.statusCode}`;
      } else {
        const saved = await moveFileToWorkspace({
          sourcePath: fetched.path,
          workspaceRoot: this.options.workspaceRoot,
          originalFilename: urlFilename(url),
          contentType: fetched.contentType,
        });
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.mime_type = fetched.contentType ?? null;
        asset.size_bytes = fetched.sizeBytes;
        asset.download_status = "complete";
        if (fetched.contentType) {
          asset.media_type = inferMediaType(fetched.contentType);
        }
      }
    } catch (error) {
      if (fetchedPath) await unlink(fetchedPath).catch(() => {});
      asset.download_status = "failed";
      asset.download_error = error instanceof Error ? error.message : String(error);
    }

    if (!opts?.deferPush) result.mediaAssets.push(asset);
    return asset;
  }

  private async processLinkedMedia(
    bodyText: string,
    role: "linked_media" | "reply_linked_media",
    eventId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    // Persisted preview URLs plus the raw X status matches (X preview rows
    // store the CANONICAL URL, which may differ from the body text).
    const previewUrls = new Set([
      ...result.linkPreviews.map((lp) => lp.url),
      ...this.xUrlExclusions,
    ]);
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

      let fetchedPath: string | undefined;
      try {
        const fetched = await this.options.fetchClient.fetch(url);
        fetchedPath = fetched.path;
        if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
          await unlink(fetched.path).catch(() => {});
          fetchedPath = undefined;
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
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.mime_type = fetched.contentType ?? null;
        asset.download_status = "complete";
        asset.size_bytes = fetched.sizeBytes;
        if (fetched.contentType) {
          asset.media_type = inferMediaType(fetched.contentType);
        }
      } catch (error) {
        if (fetchedPath) await unlink(fetchedPath).catch(() => {});
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

