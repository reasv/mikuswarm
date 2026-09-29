import { nanoid } from "nanoid";
import { unlink } from "node:fs/promises";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import type { MediaAssetRow, LinkPreviewRow, ReplyContextRow, Storage } from "../storage/index.js";
import type { EnrichmentCapabilities, EnrichmentResult, ReplyTargetSummary } from "./types.js";
import type { FetchClient } from "./fetch-client.js";
import { saveMediaToWorkspace, moveFileToWorkspace, generateTempDownloadPath } from "./media.js";
import type { AttachmentStore } from "./attachment-store.js";
import { extractLinkedMediaUrls } from "./linked-media.js";
import { detectCharacterCard } from "./card-detect.js";
import { channelIdFromTimelineKey } from "../storage/timeline-key.js";
import type { FxTwitterClient } from "../fxtwitter/client.js";
import type { FxApiPhoto, FxApiTweet, FxTwitterConfig, XMediaSlot, XTweetPayload } from "../fxtwitter/types.js";
import { FX_TWITTER_SOURCE_KIND } from "../fxtwitter/types.js";
import { buildTweetNode, renderFlatDescription } from "../fxtwitter/format.js";
import { extractXStatusUrls, stripXStatusUrls, type XStatusRef } from "../fxtwitter/url.js";
import { DirectLinkPreviewClient } from "./link-preview-client.js";
import path from "node:path";
import type { YouTubeEnrichmentConfig } from "../youtube/config.js";
import { YOUTUBE_SOURCE_KIND, formatDuration, type YouTubePreviewPayload } from "../youtube/payload.js";
import { extractYouTubeUrls, type YouTubeVideoUrlMatch } from "../youtube/url.js";
import { probe, transcript } from "../youtube/ytdlp.js";
import type { YotsubaClient } from "../yotsuba/client.js";
import {
  YOTSUBA_SOURCE_KIND,
  safeYotsubaExt,
  safeYotsubaTim,
  type ResolvedYotsubaConfig,
  type YotsubaPreviewPayload,
  type YotsubaPostNode,
  type ApiPost,
  type YotsubaRef,
} from "../yotsuba/types.js";
import {
  extractYotsubaRefs,
  stripYotsubaUrls,
} from "../yotsuba/url.js";
import { convertComment } from "../yotsuba/markup.js";
import { boardLabel, ftsDescription } from "../yotsuba/format.js";
import { buildStoryboard } from "../media/storyboard.js";

export interface EnrichmentLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface EnrichmentWorkerOptions {
  storage: Storage;
  capabilities: EnrichmentCapabilities;
  fetchClient: FetchClient;
  /**
   * Resolved workspace root for this event's owning agent. `null` means the
   * account is no longer in config (§4.3 unresolvable): all workspace writes
   * (attachment downloads, preview-media saves, linked-media downloads) are
   * skipped with a warning already emitted by the pool; pure-DB operations
   * (link-preview metadata rows, reply-context text) still proceed.
   */
  workspaceRoot: string | null;
  /**
   * Account-scoped subdirectory inside `msg-attach/` (spec MULTI-AGENT-SUPPORT
   * §7.4). In agents mode this is `"<provider>.<accountKey>"` so downloads land
   * in `<agentRoot>/msg-attach/<provider>.<accountKey>/filename`. Absent in
   * legacy mode — files go in the flat `msg-attach/` dir, byte-identical to
   * pre-Phase-3 behaviour.
   */
  attachSubdir?: string;
  maxPreviewsPerMessage: number;
  downloadSizeLimit?: number;
  /**
   * X.com enrichment via the FxTwitter API (ARCHITECTURE.md §7a). When set, X
   * status URLs are partitioned away from the Synapse preview path and
   * enriched here; when unset, all URLs ride the Synapse path (legacy
   * behavior, also what most tests exercise).
   */
  fxtwitter?: { client: FxTwitterClient; config: FxTwitterConfig };
  /**
   * YouTube T1 enrichment (ARCHITECTURE.md §7e). When set and the subsystem is
   * available, recognized YouTube URLs are partitioned away from the generic
   * preview path for caption-eligible events and enriched here (probe +
   * transcript + optional thumbnail). Ineligible events' YouTube URLs fall
   * through to the generic preview path unchanged. Unset = legacy behavior.
   */
  youtube?: {
    config: YouTubeEnrichmentConfig;
    /**
     * Mirror of `caption_all || caption_assistant_messages` from captioning
     * config: when true, `role = 'assistant'` events are also eligible for
     * YouTube enrichment (mirrors the captionEligible predicate exactly).
     */
    captionAssistant: boolean;
  };
  /**
   * Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d).
   * When present and ready, downloaded files are integrated via the store
   * (hardlinks, dedup). Absent or not-ready = byte-identical pre-Phase-5d behaviour.
   */
  store?: AttachmentStore;
  /**
   * Yotsuba (4chan) T1 enrichment (ARCHITECTURE.md §7f). When set and enabled,
   * recognized 4chan URLs are partitioned away from the generic preview path and
   * enriched here (one fetch per ref, headline-file download, stored capture).
   * Unset = 4chan URLs ride the Synapse path (no structured enrichment).
   */
  yotsuba?: {
    client: YotsubaClient;
    config: ResolvedYotsubaConfig;
    /**
     * Mirror of `caption_all` from captioning config: when true, headline files
     * get caption_status "pending" regardless of event role.
     */
    captionAll: boolean;
    /**
     * Mirror of `caption_assistant_messages` from captioning config: when true,
     * assistant messages' headline files get caption_status "pending".
     */
    captionAssistant: boolean;
  };
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

  /**
   * Raw YouTube video URLs seen by the YouTube enrichment partition (message +
   * reply bodies). `processLinkedMedia` excludes these (they were already
   * partitioned into the YouTube stage and must not be double-counted as
   * generic linked media).
   */
  private readonly ytUrlExclusions = new Set<string>();

  /**
   * Raw 4chan URL matches seen by the yotsuba enrichment partition (message +
   * reply bodies). `processLinkedMedia` excludes these (already partitioned).
   */
  private readonly yotsubaUrlExclusions = new Set<string>();

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

    // Workspace availability gate (spec MULTI-AGENT-SUPPORT §4.3): when the
    // account is unresolvable (workspace is null), all file downloads are
    // skipped. Pure-DB operations (link-preview metadata, reply-context text)
    // still proceed so the event is fully enriched on the indexable side.
    const hasWorkspace = this.options.workspaceRoot !== null;

    // Download gate: each attachment decides its own path based on what the
    // attachment carries (remoteUrl → FetchClient.downloadUrl; neither +
    // roomId → Matrix RPC; neither → skip). No longer gated on roomId at
    // this level — Discord events with remoteUrl attachments can download
    // even when the timeline key doesn't carry a classic room/channel id.
    const downloadPromise = hasWorkspace
      ? this.downloadAttachments(event, roomId ?? null, result)
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
        const absPath = path.join(this.options.workspaceRoot!, asset.local_path);
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
    const yotsubaPreviewIds = new Set(
      result.linkPreviews
        .filter((lp) => lp.source_kind === YOTSUBA_SOURCE_KIND)
        .map((lp) => lp.id),
    );
    const isBackfetch = this.options.storage.isBackfetchEvent(event.id);
    const captionableTypes = ["image", "video", "audio"];
    for (const asset of result.mediaAssets) {
      // Yotsuba assets manage their own caption_status (deferred until upgrade, or
      // pending when captionImmediately fired at enrichment time).
      if (asset.link_preview_id && yotsubaPreviewIds.has(asset.link_preview_id)) continue;
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
    roomId: string | null,
    result: EnrichmentResult,
  ): Promise<void> {
    const attachments = event.attachments ?? [];
    if (attachments.length === 0) return;

    const downloads = attachments.map(async (attachment, index) => {
      // Per-attachment routing:
      //   remoteUrl present → channel-neutral FetchClient.downloadUrl (Discord CDN path)
      //   roomId present    → Matrix RPC downloadMedia
      //   neither           → skip (no download path available; no row created)
      const hasRemoteUrl = Boolean(attachment.remoteUrl);
      const hasRoomId = Boolean(roomId);
      if (!hasRemoteUrl && !hasRoomId) return; // skip as today

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

      const tempPath = generateTempDownloadPath(this.options.workspaceRoot!);
      try {
        if (hasRemoteUrl) {
          // Discord / remote-URL path: download from the CDN URL directly.
          const downloaded = await this.options.fetchClient.downloadUrl({
            url: attachment.remoteUrl!,
            outputPath: tempPath,
            sizeLimit: this.options.downloadSizeLimit,
          });
          const saved = await moveFileToWorkspace({
            sourcePath: tempPath,
            workspaceRoot: this.options.workspaceRoot!,
            originalFilename: attachment.filename,
            contentType: downloaded.contentType ?? attachment.mimeType,
            attachSubdir: this.options.attachSubdir,
            store: this.options.store,
          });
          asset.local_path = saved.localPath;
          asset.content_hash = saved.contentHash;
          asset.size_bytes = downloaded.sizeBytes;
          asset.mime_type = downloaded.contentType ?? attachment.mimeType ?? null;
          if (downloaded.contentType) asset.media_type = inferMediaType(downloaded.contentType);
          asset.download_status = "complete";
        } else {
          // Matrix RPC path: the native client resolves the mxc:// URL.
          const downloaded = await this.options.capabilities.downloadMedia({
            roomId: roomId!,
            eventId: event.externalId ?? event.id,
            outputPath: tempPath,
            sizeLimit: this.options.downloadSizeLimit,
          });
          const saved = await moveFileToWorkspace({
            sourcePath: tempPath,
            workspaceRoot: this.options.workspaceRoot!,
            originalFilename: downloaded.filename ?? attachment.filename,
            contentType: downloaded.contentType ?? attachment.mimeType,
            attachSubdir: this.options.attachSubdir,
            store: this.options.store,
          });
          asset.local_path = saved.localPath;
          asset.content_hash = saved.contentHash;
          asset.size_bytes = downloaded.sizeBytes;
          asset.mime_type = downloaded.contentType ?? attachment.mimeType ?? null;
          asset.media_type = downloaded.kind || attachment.mediaType;
          asset.download_status = "complete";
          if (downloaded.filename) asset.original_filename = downloaded.filename;
        }
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
      const summary = await this.lookupReplyTarget(event, roomId, replyToId);
      if (!summary) {
        // Every source came up empty (provider says unrepresentable — redacted,
        // non-message, … — or, without a provider lookup, neither the ingest
        // snapshot nor our stored copy knows the target). Stub it so the
        // renderer can say "unavailable", and say why in the log.
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

      // Only download reply attachments when the workspace is available (§4.3).
      if (summary.attachments && summary.attachments.length > 0 && this.options.workspaceRoot !== null) {
        await this.downloadReplyAttachments(event.id, roomId, summary, result);
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

  /**
   * Resolve the replied-to message into a {@link ReplyTargetSummary}.
   *
   * 1. **Provider lookup** (`capabilities.messageSummary`) when the provider
   *    implements one — authoritative: its answer (including `null`) is final
   *    and no fallback runs. Matrix lives here; the native summary applies the
   *    reply-fallback stripping and UTD handling of §6 that a stored copy could
   *    not reproduce. The one exception is an edited target: the provider
   *    returns the original event, so the stored post-edit body replaces its
   *    body (`Storage.getEditedBody`).
   * 2. **Ingest-time snapshot** (`event.replyTo`) when it carries a body or
   *    attachments. Providers whose payload includes the referenced message
   *    (Discord `referenced_message`) populate this at normalization, and it is
   *    refreshed on every reply — so it reflects edits and carries re-signed
   *    CDN URLs, which our stored copy may not. A sender-only stub (author
   *    known, empty body, no attachments — what Discord builds on a message
   *    cache miss) does not count as resolved.
   * 3. **Stored copy** (`timeline_events` by provider / external id / timeline
   *    key) — the target was ingested earlier on this timeline even though the
   *    provider could not quote it now.
   *
   * `null` when all applicable sources come up empty.
   */
  private async lookupReplyTarget(
    event: CanonicalChatEvent,
    roomId: string,
    replyToId: string,
  ): Promise<ReplyTargetSummary | null> {
    const messageSummary = this.options.capabilities.messageSummary;
    if (messageSummary) {
      const summary = await messageSummary.call(this.options.capabilities, { roomId, eventId: replyToId });
      // A provider lookup by id returns the original event (a Matrix edit is a
      // separate event that never rewrites its target); our stored copy carries
      // the latest applied edit, so it wins for the body.
      const editedBody = summary
        ? this.options.storage.getEditedBody(event.timelineKey, replyToId)
        : undefined;
      return summary && editedBody !== undefined ? { ...summary, body: editedBody } : summary;
    }

    const snapshot = event.replyTo;
    if (snapshot && (snapshot.body || (snapshot.attachments?.length ?? 0) > 0)) {
      return {
        eventId: replyToId,
        sender: snapshot.sender?.id ?? "",
        senderName: snapshot.sender?.displayName ?? snapshot.sender?.username,
        body: snapshot.body ?? "",
        attachments: summaryAttachments(snapshot.attachments),
        timestamp: isoTimestamp(snapshot.timestamp),
      };
    }

    const stored = this.options.storage.getTimelineEventByExternalId(
      event.provider,
      replyToId,
      event.timelineKey,
    );
    if (stored) {
      return {
        eventId: replyToId,
        sender: stored.sender.id,
        senderName: stored.sender.displayName ?? stored.sender.username,
        body: stored.body,
        attachments: summaryAttachments(stored.attachments),
        timestamp: isoTimestamp(stored.timestamp),
      };
    }

    return null;
  }

  /**
   * Download all attachments from a replied-to message summary. Loops over
   * every element of `summary.attachments` (fixing the audit finding that only
   * index 0 was ever downloaded). For each attachment:
   *   - `remoteUrl` present → channel-neutral FetchClient.downloadUrl (Discord CDN)
   *   - otherwise           → Matrix RPC downloadMedia (roomId is non-null here;
   *                           this method is only called from the roomId-gated path)
   *
   * Matrix caps maxAttachmentsPerMessage=1, so the single-element loop is
   * byte-identical to the old single-attachment path (same asset id, same fields).
   */
  private async downloadReplyAttachments(
    eventId: string,
    roomId: string,
    summary: ReplyTargetSummary,
    result: EnrichmentResult,
  ): Promise<void> {
    const attachments = summary.attachments ?? [];

    await Promise.allSettled(
      attachments.map(async (attachment, index) => {
        const asset: MediaAssetRow = {
          id: `${eventId}:reply_attach:${index}`,
          event_id: eventId,
          role: "reply_attachment",
          source_index: index,
          media_type: attachment.mediaType,
          original_filename: attachment.filename ?? summary.body,
          download_status: "pending",
          caption_status: "pending",
          created_at: Date.now(),
        };

        const tempPath = generateTempDownloadPath(this.options.workspaceRoot!);
        try {
          if (attachment.remoteUrl) {
            // Discord / remote-URL path
            const downloaded = await this.options.fetchClient.downloadUrl({
              url: attachment.remoteUrl,
              outputPath: tempPath,
              sizeLimit: this.options.downloadSizeLimit,
            });
            const saved = await moveFileToWorkspace({
              sourcePath: tempPath,
              workspaceRoot: this.options.workspaceRoot!,
              originalFilename: attachment.filename,
              contentType: downloaded.contentType ?? attachment.mimeType,
              attachSubdir: this.options.attachSubdir,
              store: this.options.store,
            });
            asset.local_path = saved.localPath;
            asset.content_hash = saved.contentHash;
            asset.size_bytes = downloaded.sizeBytes;
            asset.mime_type = downloaded.contentType ?? attachment.mimeType ?? null;
            if (downloaded.contentType) asset.media_type = inferMediaType(downloaded.contentType);
            asset.download_status = "complete";
          } else {
            // Matrix RPC path
            const downloaded = await this.options.capabilities.downloadMedia({
              roomId,
              eventId: summary.eventId,
              outputPath: tempPath,
              sizeLimit: this.options.downloadSizeLimit,
            });
            const saved = await moveFileToWorkspace({
              sourcePath: tempPath,
              workspaceRoot: this.options.workspaceRoot!,
              originalFilename: downloaded.filename ?? attachment.filename ?? summary.body,
              contentType: downloaded.contentType,
              attachSubdir: this.options.attachSubdir,
              store: this.options.store,
            });
            asset.local_path = saved.localPath;
            asset.content_hash = saved.contentHash;
            asset.size_bytes = downloaded.sizeBytes;
            asset.mime_type = downloaded.contentType ?? null;
            asset.media_type = downloaded.kind || attachment.mediaType;
            asset.download_status = "complete";
            if (downloaded.filename) asset.original_filename = downloaded.filename;
          }
        } catch (error) {
          await unlink(tempPath).catch(() => {});
          asset.download_status = "failed";
          asset.download_error = error instanceof Error ? error.message : String(error);
        }

        result.mediaAssets.push(asset);
      }),
    );
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
    let filteredBody = bodyText;
    if (fx) {
      xRefs = extractXStatusUrls(bodyText, fx.config.statusHosts);
      if (xRefs.length > 0) {
        filteredBody = stripXStatusUrls(bodyText, fx.config.statusHosts);
        for (const ref of xRefs) this.xUrlExclusions.add(ref.rawUrl);
      }
      if (!fx.config.enabled) xRefs = [];
    }

    // Partition (ARCHITECTURE.md §7e): YouTube URLs for eligible events go to
    // the YouTube enrichment stage. Eligibility mirrors the captioning predicate
    // (trigger_group_id IS NOT NULL / is_backfetch / role=assistant when
    // captionAssistant) evaluated with a fresh DB read so setTriggerGroup() is
    // visible even when it was called after the event was initially loaded.
    // enrich_all=true bypasses the gate. Ineligible events' YouTube URLs fall
    // through to the generic Synapse path unchanged (no strip, no parked upgrade).
    const yt = this.options.youtube;
    let ytRefs: YouTubeVideoUrlMatch[] = [];
    if (yt && yt.config.enabled) {
      const allYtRefs = extractYouTubeUrls(filteredBody);
      if (allYtRefs.length > 0) {
        // Eligibility check (fresh DB read for trigger_group_id).
        const isEligible = this._isYouTubeEligible(eventId, yt);
        if (isEligible) {
          ytRefs = allYtRefs;
          // Strip eligible YouTube URLs from filteredBody so Synapse never
          // produces a bare og-card for them.
          for (const ref of ytRefs) {
            filteredBody = filteredBody.replace(ref.rawUrl, "");
            this.ytUrlExclusions.add(ref.rawUrl);
          }
        }
        // Ineligible: leave YouTube URLs in filteredBody → generic Synapse path.
      }
    }

    // Partition (ARCHITECTURE.md §7f): Yotsuba (4chan) URL refs are stripped
    // from filteredBody and enriched here when the yotsuba subsystem is enabled.
    // No eligibility gate: every message body with 4chan links is enriched.
    const yot = this.options.yotsuba;
    let yotsubaRefs: YotsubaRef[] = [];
    if (yot && yot.config.enrichment.enabled) {
      const allYotRefs = extractYotsubaRefs(filteredBody, yot.config.extraHosts, yot.config.siteBase);
      if (allYotRefs.length > 0) {
        yotsubaRefs = allYotRefs;
        filteredBody = stripYotsubaUrls(filteredBody, yot.config.extraHosts);
        for (const ref of yotsubaRefs) this.yotsubaUrlExclusions.add(ref.rawUrl);
      }
    }

    type PreviewSources = Array<{
      url: string;
      sourceKind: string;
      siteName?: string;
      title?: string;
      description?: string;
    }>;
    type PreviewMedia = Array<{
      sourceUrl: string;
      filename?: string;
      contentType?: string;
      dataBase64: string;
    }>;
    let sources: PreviewSources = [];
    let textBlocks: string[] = [];
    let previewMedia: PreviewMedia = [];
    if (filteredBody.includes("http")) {
      if (this.options.capabilities.resolveLinkPreviews) {
        // Provider path (Matrix: Synapse /_matrix/media/v3/preview_url).
        try {
          const previewResult = await this.options.capabilities.resolveLinkPreviews({
            bodyText: filteredBody,
            includeImages: true,
            maxBytes: 256_000,
          });
          sources = previewResult.sources;
          textBlocks = previewResult.textBlocks;
          previewMedia = previewResult.media;
        } catch {
          // Provider preview failure is non-fatal (must not sink the FxTwitter stage).
        }
      } else {
        // Direct-HTTP fallback: scrape og:/twitter: meta tags.
        // Ingest-time discord_embed previews take precedence per URL — skip those.
        const ingestUrls = new Set(this.options.storage.getIngestLinkPreviewUrls(eventId));
        try {
          const directClient = new DirectLinkPreviewClient(this.options.fetchClient);
          const directResults = await directClient.resolve({
            bodyText: filteredBody,
            maxPreviews: this.options.maxPreviewsPerMessage,
            excludeUrls: ingestUrls,
          });
          sources = directResults.map((r) => ({
            url: r.url,
            sourceKind: r.sourceKind,
            siteName: r.siteName,
            title: r.title,
            description: r.description,
          }));
        } catch {
          // Direct scrape failure is non-fatal.
        }
      }
    }

    // Shared cap across all kinds, allocated by order of first appearance in
    // the body. A Synapse source whose URL isn't literally in the body
    // (normalized by the scraper) sorts last rather than being dropped.
    const maxPreviews = this.options.maxPreviewsPerMessage;
    type Candidate =
      | { kind: "x"; order: number; ref: XStatusRef }
      | { kind: "yt"; order: number; ref: YouTubeVideoUrlMatch }
      | { kind: "yotsuba"; order: number; ref: YotsubaRef }
      | { kind: "synapse"; order: number; sourceIndex: number };
    const candidates: Candidate[] = [
      ...xRefs.map((ref) => ({ kind: "x" as const, order: ref.bodyIndex, ref })),
      ...ytRefs.map((ref) => ({ kind: "yt" as const, order: ref.bodyIndex, ref })),
      ...yotsubaRefs.map((ref) => ({ kind: "yotsuba" as const, order: ref.bodyIndex, ref })),
      ...sources.map((source, sourceIndex) => {
        const at = bodyText.indexOf(source.url);
        return { kind: "synapse" as const, order: at >= 0 ? at : Number.MAX_SAFE_INTEGER, sourceIndex };
      }),
    ]
      .sort((a, b) => a.order - b.order)
      .slice(0, maxPreviews);

    const now = Date.now();
    const fxTasks: Promise<void>[] = [];
    const ytTasks: Promise<void>[] = [];
    const yotsubaTasks: Promise<void>[] = [];
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
      } else if (candidate.kind === "x") {
        fxTasks.push(this.enrichXStatus(candidate.ref, context, eventId, i, result));
      } else if (candidate.kind === "yt") {
        ytTasks.push(this.enrichYouTubeVideo(candidate.ref, context, eventId, i, result));
      } else {
        yotsubaTasks.push(this.enrichYotsubaRef(candidate.ref, context, eventId, i, result));
      }
    }

    const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";
    const urlToPreviewId = new Map<string, string>();
    for (const lp of result.linkPreviews) {
      if (lp.event_id === eventId && lp.context === context) {
        urlToPreviewId.set(lp.url, lp.id);
      }
    }

    for (const media of previewMedia) {
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

      // Skip saving preview media when workspace is unavailable (§4.3).
      if (this.options.workspaceRoot !== null) {
        try {
          const saved = await saveMediaToWorkspace({
            data,
            workspaceRoot: this.options.workspaceRoot,
            originalFilename: media.filename,
            contentType: media.contentType,
            attachSubdir: this.options.attachSubdir,
            store: this.options.store,
          });
          asset.local_path = saved.localPath;
          asset.content_hash = saved.contentHash;
          asset.download_status = "complete";
          asset.size_bytes = data.byteLength;
        } catch (error) {
          asset.download_status = "failed";
          asset.download_error = error instanceof Error ? error.message : String(error);
        }
        result.mediaAssets.push(asset);
      }
    }

    await Promise.allSettled([...fxTasks, ...ytTasks, ...yotsubaTasks]);
  }

  /**
   * Evaluate whether an event qualifies for YouTube enrichment (ARCHITECTURE.md §7e).
   *
   * Uses a fresh DB read for `trigger_group_id` to avoid a race with
   * `setTriggerGroup()`, which may be called after the event was initially
   * loaded by the enrichment pool.
   *
   * Predicate:
   *   enrich_all=true  → always eligible
   *   trigger_group_id IS NOT NULL → trigger-group message
   *   is_backfetch=1   → promoted backfetch event
   *   role='assistant' AND captionAssistant → assistant message
   */
  private _isYouTubeEligible(
    eventId: string,
    yt: NonNullable<EnrichmentWorkerOptions["youtube"]>,
  ): boolean {
    if (yt.config.enrichAll) return true;
    // Safe to read `trigger_group_id` here even though `setTriggerGroup` is
    // called after `notifyNewEvent` in `handleInbound`: the enrichment poll
    // runs in a `setTimeout(0)` macrotask, while `setTriggerGroup` commits via
    // `queueMicrotask` (storage drainQueue) — microtasks always drain before
    // the next macrotask. Reordering those two call sites would reintroduce
    // the race; this read relies on that call order being preserved.
    const fields = this.options.storage.getEventCaptionEligibilityFields(eventId);
    if (!fields) return false;
    if (fields.triggerGroupId !== null) return true;
    if (fields.isBackfetch) return true;
    if (yt.captionAssistant && fields.role === "assistant") return true;
    return false;
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
   * YouTube enrichment stage for one recognized YouTube video URL
   * (ARCHITECTURE.md §7e / spec §5).
   *
   * 1. probe() + transcript() (transcript failure non-fatal → kind "none").
   * 2. Build YouTubePreviewPayload and persist one link_previews row:
   *    source_kind "youtube", title, description = channel + duration line,
   *    payload_json = full structured payload.
   * 3. When thumbnail=true and probe yields a thumbnailUrl, download via
   *    FetchClient and store as a preview_media asset (caption_status "pending").
   * 4. probe/network failure → fetch_status "failed" row (never throws, mirrors
   *    the FxTwitter failure policy).
   */
  private async enrichYouTubeVideo(
    ref: YouTubeVideoUrlMatch,
    context: "message" | "reply",
    eventId: string,
    previewIndex: number,
    result: EnrichmentResult,
  ): Promise<void> {
    const ytCfg = this.options.youtube!.config;
    const now = Date.now();
    const previewId = nanoid();
    const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";

    // The canonical URL for the stored row is the watch URL (normalized form).
    const canonicalUrl = `https://www.youtube.com/watch?v=${ref.videoId}`;

    // ── Probe ────────────────────────────────────────────────────────────────
    let meta: Awaited<ReturnType<typeof probe>>;
    try {
      meta = await probe(ref.videoId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("enrichment_youtube_probe_failed", {
        eventId,
        videoId: ref.videoId,
        error: message,
      });
      result.linkPreviews.push({
        id: previewId,
        event_id: eventId,
        context,
        url: canonicalUrl,
        site_name: "YouTube",
        source_kind: YOUTUBE_SOURCE_KIND,
        preview_index: previewIndex,
        fetched_at: now,
        fetch_status: "failed",
        error: message,
        created_at: now,
      });
      return;
    }

    // ── Transcript (non-fatal) ───────────────────────────────────────────────
    let txResult: Awaited<ReturnType<typeof transcript>>;
    try {
      txResult = await transcript(ref.videoId, undefined, meta);
    } catch {
      txResult = { text: "", lang: "", kind: "none" };
    }

    // ── Build payload ────────────────────────────────────────────────────────
    const transcriptHead =
      txResult.text.length > 0
        ? txResult.text.slice(0, ytCfg.transcriptHeadChars)
        : undefined;

    const payload: YouTubePreviewPayload = {
      v: 1,
      videoId: ref.videoId,
      title: meta.title,
      channel: meta.channel,
      durationSeconds: meta.duration,
      uploadDate: meta.uploadDate,
      viewCount: meta.viewCount,
      chapters: meta.chapters.map((ch) => ({
        title: ch.title,
        startTime: ch.startTime,
      })),
      transcriptHead,
      transcriptLang: txResult.lang || undefined,
      transcriptKind: txResult.kind,
    };

    // ── description = "ChannelName · M:SS" (flat fallback + compact tier) ────
    const durationStr =
      meta.duration !== undefined ? formatDuration(meta.duration) : undefined;
    const descParts: string[] = [];
    if (meta.channel) descParts.push(meta.channel);
    if (durationStr) descParts.push(durationStr);
    const description = descParts.length > 0 ? descParts.join(" · ") : null;

    result.linkPreviews.push({
      id: previewId,
      event_id: eventId,
      context,
      url: canonicalUrl,
      title: meta.title ?? null,
      description,
      site_name: "YouTube",
      source_kind: YOUTUBE_SOURCE_KIND,
      preview_index: previewIndex,
      fetched_at: Date.now(),
      fetch_status: "complete",
      payload_json: JSON.stringify(payload),
      created_at: now,
    });

    // ── Thumbnail (optional, §5 D) ───────────────────────────────────────────
    if (ytCfg.thumbnail && meta.thumbnailUrl && this.options.workspaceRoot !== null) {
      await this.downloadYouTubeThumbnail(
        meta.thumbnailUrl,
        eventId,
        previewId,
        mediaRole,
        result,
      );
    }
  }

  /**
   * Download the YouTube thumbnail via the shared FetchClient and store as a
   * preview_media asset with caption_status "pending" (parity with the Synapse
   * og:image path — the existing caption worker picks it up under existing
   * captioning gates).
   */
  private async downloadYouTubeThumbnail(
    thumbnailUrl: string,
    eventId: string,
    previewId: string,
    role: string,
    result: EnrichmentResult,
  ): Promise<void> {
    const asset: MediaAssetRow = {
      id: nanoid(),
      event_id: eventId,
      role,
      link_preview_id: previewId,
      media_type: "image",
      original_filename: "thumbnail.jpg",
      download_status: "pending",
      caption_status: "pending",
      created_at: Date.now(),
    };

    let fetchedPath: string | undefined;
    try {
      const fetched = await this.options.fetchClient.fetch(thumbnailUrl);
      fetchedPath = fetched.path;
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        await unlink(fetched.path).catch(() => {});
        fetchedPath = undefined;
        asset.download_status = "failed";
        asset.download_error = `HTTP ${fetched.statusCode}`;
      } else {
        const saved = await moveFileToWorkspace({
          sourcePath: fetched.path,
          workspaceRoot: this.options.workspaceRoot!,
          originalFilename: "thumbnail.jpg",
          contentType: fetched.contentType ?? "image/jpeg",
          attachSubdir: this.options.attachSubdir,
          store: this.options.store,
        });
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.content_hash = saved.contentHash;
        asset.mime_type = fetched.contentType ?? "image/jpeg";
        asset.size_bytes = fetched.sizeBytes;
        asset.download_status = "complete";
        asset.media_type = inferMediaType(fetched.contentType) || "image";
      }
    } catch (error) {
      if (fetchedPath) await unlink(fetchedPath).catch(() => {});
      asset.download_status = "failed";
      asset.download_error = error instanceof Error ? error.message : String(error);
    }

    result.mediaAssets.push(asset);
  }

  // ---------------------------------------------------------------------------
  // Yotsuba (4chan) enrichment stage (ARCHITECTURE.md §7f)
  // ---------------------------------------------------------------------------

  /**
   * Enrich one recognized 4chan URL ref. Stores one `link_previews` row with
   * `source_kind = "yotsuba"` and downloads the headline post's file. Makes
   * one API call (thread or board page 1), or zero when the reply context
   * reuses an already-stored capture.
   *
   * Failure policy: 404 → "gone" row; other failure → bare URL row. Neither
   * triggers the event-level retry machinery (same as FxTwitter policy).
   */
  private async enrichYotsubaRef(
    ref: YotsubaRef,
    context: "message" | "reply",
    eventId: string,
    previewIndex: number,
    result: EnrichmentResult,
  ): Promise<void> {
    const yot = this.options.yotsuba!;
    const { client, config: cfg } = yot;
    const now = Date.now();
    const previewId = nanoid();
    const mediaRole = context === "message" ? "preview_media" : "reply_preview_media";
    const canonicalUrl = ref.canonicalUrl;

    // Determine caption status for files created in this enrichment step.
    // Headline files follow normal captioning rules; all other yotsuba files
    // created here start as "deferred" (upgraded later by the trigger upgrade).
    const captionFields = this.options.storage.getEventCaptionEligibilityFields(eventId);
    const captionImmediately =
      yot.captionAll ||
      (yot.captionAssistant && captionFields?.role === "assistant");

    // Reply context reuse: if another event already has a yotsuba row for this
    // URL, copy its payload and reference its already-downloaded files rather
    // than making another API call.
    if (context === "reply") {
      const eventRow = this.options.storage.getTimelineEventById(eventId);
      const existing = this.options.storage.getYotsubaPreviewByUrl(canonicalUrl, eventRow?.timelineKey);
      if (existing) {
        const copiedRow: LinkPreviewRow = {
          ...existing.row,
          id: previewId,
          event_id: eventId,
          context,
          preview_index: previewIndex,
          created_at: now,
        };
        result.linkPreviews.push(copiedRow);
        // Reference existing assets with new rows for the new event/preview.
        for (const asset of existing.assets) {
          result.mediaAssets.push({
            ...asset,
            id: nanoid(),
            event_id: eventId,
            role: mediaRole,
            link_preview_id: previewId,
            // Keep existing caption_status but apply immediacy rule to the copy.
            caption_status: captionImmediately ? "pending" : asset.caption_status,
            created_at: now,
            updated_at: now,
          });
        }
        return;
      }
    }

    if (ref.kind === "board") {
      await this.enrichYotsubaBoardRef(ref, context, eventId, previewIndex, result, previewId, now, client, cfg);
      return;
    }

    // Thread ref (kind === "thread")
    await this.enrichYotsubaThreadRef(
      ref, context, eventId, previewIndex, result, previewId, now,
      client, cfg, mediaRole, captionImmediately,
    );
  }

  private async enrichYotsubaBoardRef(
    ref: YotsubaRef & { kind: "board" },
    context: "message" | "reply",
    eventId: string,
    previewIndex: number,
    result: EnrichmentResult,
    previewId: string,
    now: number,
    client: YotsubaClient,
    cfg: ResolvedYotsubaConfig,
  ): Promise<void> {
    const board = ref.board;
    // Fetch board list for title/worksafe (24 h cached).
    const [boardsResult, pageResult] = await Promise.allSettled([
      client.boards("background"),
      client.page(board, 1, "background"),
    ]);
    const boardEntry = boardsResult.status === "fulfilled"
      ? boardsResult.value.body.find((b) => b.board === board)
      : undefined;
    const boardTitle = boardEntry?.title;
    const worksafe = boardEntry?.ws_board === 1;

    if (pageResult.status === "rejected") {
      const err = pageResult.reason as { status?: number };
      if (err?.status === 404) {
        // Board doesn't exist (or not accessible).
        result.linkPreviews.push({
          id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
          site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
          preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
          error: "gone", created_at: now,
        });
        return;
      }
      // Other failure → bare row.
      const msg = pageResult.reason instanceof Error ? pageResult.reason.message : String(pageResult.reason);
      this.options.logger.warn("enrichment_yotsuba_failed", { eventId, url: ref.canonicalUrl, error: msg });
      result.linkPreviews.push({
        id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
        site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
        preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
        error: msg, created_at: now,
      });
      return;
    }

    const page = pageResult.value.body;
    const maxThreads = cfg.preview.boardThreads;
    const threads: YotsubaPreviewPayload["threads"] = [];
    for (const threadContainer of page.threads ?? []) {
      for (const post of threadContainer.posts ?? []) {
        // Only use OP posts (resto = 0) and skip stickies.
        if ((post.resto ?? 0) !== 0) continue;
        if (post.sticky === 1) continue;
        if (threads.length >= maxThreads) break;
        const { text } = convertComment(post.com ?? "");
        const subject = post.sub?.trim() || undefined;
        const opExcerpt = !subject
          ? buildOpExcerpt(text, cfg.preview.opExcerptWords)
          : undefined;
        threads.push({
          no: post.no!,
          subject,
          opExcerpt,
          replies: post.replies ?? 0,
          files: (post.images ?? 0) + (post.tim ? 1 : 0),
          time: (post.time ?? 0) * 1000,
        });
        if (threads.length >= maxThreads) break;
      }
      if (threads.length >= maxThreads) break;
    }

    const payload: YotsubaPreviewPayload = {
      v: 1,
      kind: "board",
      board,
      boardTitle,
      worksafe,
      asOf: now,
      threads,
    };

    const label = boardLabel(board, boardTitle);
    result.linkPreviews.push({
      id: previewId,
      event_id: eventId,
      context,
      url: ref.canonicalUrl,
      title: `/${board}/ - ${boardTitle ?? board}`,
      description: `/${board}/ board: ${threads.length} threads`,
      site_name: "4chan",
      source_kind: YOTSUBA_SOURCE_KIND,
      preview_index: previewIndex,
      fetched_at: now,
      fetch_status: "complete",
      payload_json: JSON.stringify(payload),
      created_at: now,
    });
    void label; // used in rendering
  }

  private async enrichYotsubaThreadRef(
    ref: YotsubaRef & { kind: "thread" },
    context: "message" | "reply",
    eventId: string,
    previewIndex: number,
    result: EnrichmentResult,
    previewId: string,
    now: number,
    client: YotsubaClient,
    cfg: ResolvedYotsubaConfig,
    mediaRole: "preview_media" | "reply_preview_media",
    captionImmediately: boolean,
  ): Promise<void> {
    const board = ref.board;
    const threadNo = ref.threadNo;
    const linkedPostNo = ref.postNo;

    // Fetch board list and thread in parallel.
    const [boardsResult, threadResult] = await Promise.allSettled([
      client.boards("background"),
      client.thread(board, threadNo, "background"),
    ]);
    const boardEntry = boardsResult.status === "fulfilled"
      ? boardsResult.value.body.find((b) => b.board === board)
      : undefined;
    const boardTitle = boardEntry?.title;
    const worksafe = boardEntry?.ws_board === 1;
    const canDownloadFiles =
      cfg.enrichment.mediaBoards === "all" || worksafe;

    // Thread fetch failed?
    if (threadResult.status === "rejected") {
      const err = threadResult.reason as { status?: number };
      const isGone = err?.status === 404;
      if (isGone) {
        result.linkPreviews.push({
          id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
          title: `/${board}/`, site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
          preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
          error: "gone", created_at: now,
        });
        return;
      }
      const msg = threadResult.reason instanceof Error ? threadResult.reason.message : String(threadResult.reason);
      this.options.logger.warn("enrichment_yotsuba_failed", { eventId, url: ref.canonicalUrl, error: msg });
      result.linkPreviews.push({
        id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
        site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
        preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
        error: msg, created_at: now,
      });
      return;
    }

    // Thread 404 (null result means 404, null from .thread() method).
    if (threadResult.value === null) {
      result.linkPreviews.push({
        id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
        title: `/${board}/`, site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
        preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
        error: "gone", created_at: now,
      });
      return;
    }

    const apiThread = threadResult.value.body;
    const posts = apiThread.posts ?? [];
    if (posts.length === 0) {
      result.linkPreviews.push({
        id: previewId, event_id: eventId, context, url: ref.canonicalUrl,
        site_name: "4chan", source_kind: YOTSUBA_SOURCE_KIND,
        preview_index: previewIndex, fetched_at: now, fetch_status: "failed",
        error: "empty thread", created_at: now,
      });
      return;
    }

    const op = posts[0];
    const opNo = op.no!;
    const subject = op.sub?.trim() || undefined;
    const { text: opText } = convertComment(op.com ?? "");
    const opExcerpt = buildOpExcerpt(opText, cfg.preview.opExcerptWords);
    const postCount = (op.replies ?? 0) + 1;
    const fileCount = (op.images ?? 0) + (op.tim ? 1 : 0);
    const posters = op.unique_ips;

    const status: string[] = [];
    if (op.sticky === 1) status.push("sticky");
    if (op.closed === 1) status.push("closed");
    if (op.archived === 1) status.push("archived");
    if (op.bumplimit === 1) status.push("bump limit");
    if (op.imagelimit === 1) status.push("image limit");

    // Build capture nodes.
    const captureNodes: YotsubaPostNode[] = [];
    const captureNos = new Set<number>();

    // Find the headline post.
    let headlinePost: ApiPost = op;
    let headlineNo = opNo;
    let linkedMissing: number | undefined;

    if (linkedPostNo != null && linkedPostNo !== opNo) {
      const found = posts.find((p) => p.no === linkedPostNo);
      if (found) {
        headlinePost = found;
        headlineNo = linkedPostNo;
      } else {
        // Post not found in thread → degrade to thread link.
        linkedMissing = linkedPostNo;
      }
    }

    // Add headline post (role "op" when it IS the OP, "linked" for a specific post link).
    const headlineIdx = posts.findIndex((p) => p.no === headlineNo);
    const headlineRole: YotsubaPostNode["role"] = headlineNo === opNo ? "op" : "linked";
    captureNodes.push(apiPostToNode(headlinePost, headlineIdx, headlineRole));
    captureNos.add(headlineNo);

    if (linkedMissing == null && headlineNo === opNo) {
      // Thread link: latest replies first, then posts they answer.
      const nonOpPosts = posts.slice(1);
      const latestCount = cfg.preview.latestReplies;
      const latestPosts = nonOpPosts.slice(-latestCount);

      // Add latest replies first (so they get 'latest' role).
      for (const p of latestPosts) {
        if (!captureNos.has(p.no!)) {
          const idx = posts.findIndex((pp) => pp.no === p.no);
          captureNodes.push(apiPostToNode(p, idx, "latest"));
          captureNos.add(p.no!);
        }
      }

      // Now collect replied-to candidates (posts cited by latest replies,
      // excluding OP and already-captured posts — including the latest replies).
      const answeredNos = new Set<number>();
      for (const lp of latestPosts) {
        const { quotes } = convertComment(lp.com ?? "");
        for (const qno of quotes) {
          if (!captureNos.has(qno) && !answeredNos.has(qno)) {
            answeredNos.add(qno);
          }
        }
      }

      // Add replied-to candidates (newest first, up to repliedToMax).
      const repliedToCandidates = posts
        .filter((p) => p.no != null && answeredNos.has(p.no!))
        .sort((a, b) => (b.no ?? 0) - (a.no ?? 0))
        .slice(0, cfg.preview.repliedToMax);

      for (const p of repliedToCandidates) {
        if (!captureNos.has(p.no!)) {
          const idx = posts.findIndex((pp) => pp.no === p.no);
          captureNodes.push(apiPostToNode(p, idx, "replied_to"));
          captureNos.add(p.no!);
        }
      }
    } else if (linkedMissing == null && headlineNo !== opNo) {
      // Post link: posts the linked post answers + first N replies.
      const { quotes: headlineQuotes } = convertComment(headlinePost.com ?? "");

      // Posts the linked post answers (replied-to, newest first).
      const repliedToCandidates = posts
        .filter((p) => p.no != null && headlineQuotes.includes(p.no!) && p.no !== headlineNo)
        .sort((a, b) => (b.no ?? 0) - (a.no ?? 0))
        .slice(0, cfg.preview.repliedToMax);

      for (const p of repliedToCandidates) {
        if (!captureNos.has(p.no!)) {
          const idx = posts.findIndex((pp) => pp.no === p.no);
          captureNodes.push(apiPostToNode(p, idx, "replied_to"));
          captureNos.add(p.no!);
        }
      }

      // First N replies to the linked post.
      const headlineBacklinks = posts
        .filter((p) => {
          if (!p.com) return false;
          const { quotes } = convertComment(p.com);
          return quotes.includes(headlineNo);
        })
        .slice(0, cfg.preview.repliesMax);

      for (const p of headlineBacklinks) {
        if (!captureNos.has(p.no!)) {
          const idx = posts.findIndex((pp) => pp.no === p.no);
          captureNodes.push(apiPostToNode(p, idx, "reply"));
          captureNos.add(p.no!);
        }
      }
    }

    // Sort nodes by thread index for the capture.
    captureNodes.sort((a, b) => a.index - b.index);

    // Reply counts (backlinks) from the full thread: how many posts quote each
    // captured post, and which ones (the renderer's "[N replies: …]" line).
    {
      const capturedNos = new Set(captureNodes.map((n) => n.no));
      const backlinks = new Map<number, number[]>();
      for (const p of posts) {
        if (p.no == null || !p.com) continue;
        const { quotes } = convertComment(p.com);
        for (const q of new Set(quotes)) {
          if (!capturedNos.has(q) || q === p.no) continue;
          let arr = backlinks.get(q);
          if (!arr) { arr = []; backlinks.set(q, arr); }
          arr.push(p.no);
        }
      }
      for (const node of captureNodes) {
        const nos = backlinks.get(node.no) ?? [];
        node.replies = nos.length;
        if (nos.length > 0) node.replyNos = nos;
      }
    }

    // Compute filesBefore for each captured node: count of files in posts
    // at indices 0..(node.index - 1) in the full thread.
    {
      // Build a prefix sum of file counts over the full thread.
      const filePrefixSum: number[] = new Array(posts.length + 1).fill(0);
      for (let i = 0; i < posts.length; i++) {
        filePrefixSum[i + 1] = filePrefixSum[i]! + (posts[i]!.tim ? 1 : 0);
      }
      for (const node of captureNodes) {
        node.filesBefore = filePrefixSum[node.index] ?? 0;
      }
    }

    // Build payload (before file download).
    const payload: YotsubaPreviewPayload = {
      v: 1,
      kind: "thread",
      board,
      boardTitle,
      worksafe,
      asOf: now,
      threadNo,
      subject,
      ambientChars: cfg.preview.ambientChars,
      opExcerpt: !subject ? opExcerpt : (linkedMissing != null || headlineNo !== opNo ? opExcerpt : undefined),
      postCount,
      fileCount,
      posters,
      status: status.length > 0 ? status : undefined,
      linkedNo: linkedMissing == null && linkedPostNo != null && linkedPostNo !== opNo ? linkedPostNo : undefined,
      linkedMissing,
      headlineNo,
      posts: captureNodes,
    };

    // Build the title and description for FTS.
    const titleLabel = subject ?? opExcerpt ?? `thread ${threadNo}`;
    const headlineText = captureNodes.find((n) => n.no === headlineNo)?.text ?? "";
    const title = `/${board}/ - ${titleLabel}`;
    const description = ftsDescription({
      subject,
      opExcerpt: !subject ? opExcerpt : undefined,
      headlineText,
      maxChars: 500,
    });

    // Download headline post's file (if any, if workspace available, if allowed).
    if (headlinePost.tim && this.options.workspaceRoot !== null && canDownloadFiles) {
      const file = headlinePost;
      const ext = (file.ext ?? "").toLowerCase();
      const isPdf = ext === ".pdf";
      const isVideo = ext === ".webm" || ext === ".mp4";
      const isAnimated = ext === ".gif";
      const tim = file.tim!;

      // For PDF: download the thumbnail (page 1 preview).
      // For video/animated: download original + build storyboard.
      // For image: download original.
      if (isPdf) {
        await this.downloadYotsubaFile({
          board, tim, ext: "s.jpg", mediaType: "image",
          mimeType: "image/jpeg", eventId, previewId,
          mediaRole, captionStatus: captionImmediately ? "pending" : "deferred",
          result, headlinePost, cfg,
          storeInPayload: (assetId) => {
            const headlineNode = payload.posts?.find((n) => n.no === headlineNo);
            if (headlineNode?.file) headlineNode.file.assetId = assetId;
          },
        });
      } else if (isVideo || isAnimated) {
        // Download original as video asset.
        const originalAsset = await this.downloadYotsubaFile({
          board, tim, ext: file.ext!, mediaType: "video",
          mimeType: inferMimeTypeFromExt(ext), eventId, previewId,
          mediaRole, captionStatus: captionImmediately ? "pending" : "deferred",
          result, headlinePost, cfg,
          storeInPayload: (assetId) => {
            const headlineNode = payload.posts?.find((n) => n.no === headlineNo);
            if (headlineNode?.file) headlineNode.file.assetId = assetId;
          },
        });
        // Attempt storyboard from the original file.
        if (originalAsset?.local_path) {
          const absPath = originalAsset.local_path.startsWith("/")
            ? originalAsset.local_path
            : path.join(this.options.workspaceRoot, originalAsset.local_path);
          let storyboardBuilt = false;
          try {
            const storyboard = await buildStoryboard(absPath);
            if (storyboard) {
              const saved = await moveFileToWorkspace({
                sourcePath: storyboard.path,
                workspaceRoot: this.options.workspaceRoot,
                originalFilename: `storyboard_${tim}.jpg`,
                contentType: "image/jpeg",
                attachSubdir: this.options.attachSubdir,
                store: this.options.store,
              });
              const sbAsset: MediaAssetRow = {
                id: nanoid(),
                event_id: eventId,
                role: mediaRole,
                link_preview_id: previewId,
                local_path: saved.localPath,
                content_hash: saved.contentHash,
                mime_type: "image/jpeg",
                media_type: "image",
                size_bytes: undefined,
                caption_status: "deferred",  // storyboard never captioned
                download_status: "complete",
                created_at: now,
              };
              result.mediaAssets.push(sbAsset);
              const headlineNode = payload.posts?.find((n) => n.no === headlineNo);
              if (headlineNode?.file) headlineNode.file.storyboardAssetId = sbAsset.id;
              storyboardBuilt = true;
            }
          } catch {
            // storyboard failure — fall through to thumbnail fallback
          }
          if (!storyboardBuilt) {
            // Download 4chan thumbnail as storyboard fallback.
            await this.downloadYotsubaFile({
              board, tim, ext: "s.jpg", mediaType: "image",
              mimeType: "image/jpeg", eventId, previewId,
              mediaRole, captionStatus: "deferred",
              result, headlinePost, cfg,
              storeInPayload: (assetId) => {
                const headlineNode = payload.posts?.find((n) => n.no === headlineNo);
                if (headlineNode?.file) headlineNode.file.storyboardAssetId = assetId;
              },
            });
          }
        }
      } else {
        // Regular image.
        await this.downloadYotsubaFile({
          board, tim, ext: file.ext!, mediaType: "image",
          mimeType: inferMimeTypeFromExt(ext), eventId, previewId,
          mediaRole, captionStatus: captionImmediately ? "pending" : "deferred",
          result, headlinePost, cfg,
          storeInPayload: (assetId) => {
            const headlineNode = payload.posts?.find((n) => n.no === headlineNo);
            if (headlineNode?.file) headlineNode.file.assetId = assetId;
          },
        });
      }
    }

    result.linkPreviews.push({
      id: previewId,
      event_id: eventId,
      context,
      url: ref.canonicalUrl,
      title,
      description,
      site_name: "4chan",
      source_kind: YOTSUBA_SOURCE_KIND,
      preview_index: previewIndex,
      fetched_at: now,
      fetch_status: "complete",
      payload_json: JSON.stringify(payload),
      created_at: now,
    });
  }

  /**
   * Download one yotsuba file via the media lane and move it to workspace.
   * Returns the created MediaAssetRow, or undefined on failure (failure is
   * logged but non-fatal). The row is pushed to `result.mediaAssets`.
   */
  private async downloadYotsubaFile(opts: {
    board: string;
    tim: number;
    ext: string;         // includes leading dot, OR "s.jpg" for thumbnail
    mediaType: string;
    mimeType?: string;
    eventId: string;
    previewId: string;
    mediaRole: string;
    captionStatus: string;
    result: EnrichmentResult;
    headlinePost: ApiPost;
    cfg: ResolvedYotsubaConfig;
    storeInPayload: (assetId: string) => void;
  }): Promise<MediaAssetRow | undefined> {
    const { board, tim, ext, mediaType, mimeType, eventId, previewId, mediaRole, captionStatus, result, cfg } = opts;
    const fileRef = ext === "s.jpg" ? `${tim}s.jpg` : `${tim}${ext}`;
    const now = Date.now();
    const asset: MediaAssetRow = {
      id: nanoid(),
      event_id: eventId,
      role: mediaRole,
      link_preview_id: previewId,
      media_type: mediaType,
      mime_type: mimeType ?? null,
      download_status: "pending",
      caption_status: captionStatus,
      original_filename: `${tim}${ext === "s.jpg" ? "s.jpg" : ext}`,
      created_at: now,
    };

    let fetchedPath: string | undefined;
    try {
      // Use the client's fetchFilePath method via the options yotsuba client.
      const yotClient = this.options.yotsuba!.client;
      const fetched = await yotClient.fetchFilePath(board, fileRef, "background");
      fetchedPath = fetched.path;
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        await unlink(fetched.path).catch(() => {});
        fetchedPath = undefined;
        asset.download_status = "failed";
        asset.download_error = `HTTP ${fetched.statusCode}`;
      } else {
        const saved = await moveFileToWorkspace({
          sourcePath: fetched.path,
          workspaceRoot: this.options.workspaceRoot!,
          originalFilename: fileRef,
          contentType: fetched.contentType ?? mimeType,
          attachSubdir: this.options.attachSubdir,
          store: this.options.store,
        });
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.content_hash = saved.contentHash;
        asset.mime_type = fetched.contentType ?? mimeType ?? null;
        asset.size_bytes = fetched.sizeBytes;
        asset.download_status = "complete";
        if (fetched.contentType) {
          asset.media_type = inferMediaType(fetched.contentType);
        }
        opts.storeInPayload(asset.id);
      }
    } catch (error) {
      if (fetchedPath) await unlink(fetchedPath).catch(() => {});
      asset.download_status = "failed";
      asset.download_error = error instanceof Error ? error.message : String(error);
    }

    result.mediaAssets.push(asset);
    return asset.download_status === "complete" ? asset : undefined;
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
    // No media downloads when workspace is unavailable (§4.3).
    if (this.options.workspaceRoot === null) return [];
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
          workspaceRoot: this.options.workspaceRoot!,
          originalFilename: urlFilename(url),
          contentType: fetched.contentType,
          attachSubdir: this.options.attachSubdir,
          store: this.options.store,
        });
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.content_hash = saved.contentHash;
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
    // Workspace is required for file writes; skip entirely when unavailable (§4.3).
    if (this.options.workspaceRoot === null) return;

    // Persisted preview URLs plus the raw X/YouTube/yotsuba URL matches (preview
    // rows store CANONICAL URLs, which may differ from the body text).
    const previewUrls = new Set([
      ...result.linkPreviews.map((lp) => lp.url),
      ...this.xUrlExclusions,
      ...this.ytUrlExclusions,
      ...this.yotsubaUrlExclusions,
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
          workspaceRoot: this.options.workspaceRoot!,
          originalFilename: urlFilename(url),
          contentType: fetched.contentType,
          attachSubdir: this.options.attachSubdir,
          store: this.options.store,
        });
        fetchedPath = undefined;
        asset.local_path = saved.localPath;
        asset.content_hash = saved.contentHash;
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

/**
 * Map canonical `AttachmentMeta`s (ingest snapshot or stored event) onto the
 * neutral summary attachment shape used by the reply-attachment download loop.
 */
function summaryAttachments(
  attachments: AttachmentMeta[] | undefined,
): ReplyTargetSummary["attachments"] {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    mediaType: a.mediaType,
    filename: a.filename,
    mimeType: a.mimeType,
    remoteUrl: a.remoteUrl,
  }));
}

/** Epoch-ms → ISO-8601; an absent/invalid timestamp yields "" (parses as NaN → null timestamp). */
function isoTimestamp(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
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

// ---------------------------------------------------------------------------
// Yotsuba helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to at most `wordLimit` words, appending "…" when truncated.
 */
function buildOpExcerpt(text: string, wordLimit: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return words.slice(0, wordLimit).join(" ") + "…";
}

/**
 * Convert a raw `ApiPost` + thread position to a `YotsubaPostNode`. Uses
 * `convertComment` from the markup module to turn the HTML comment into plain
 * text, quotes, and dead/cross quote sets.
 */
function apiPostToNode(
  post: import("../yotsuba/types.js").ApiPost,
  index: number,
  role: import("../yotsuba/types.js").YotsubaPostNode["role"],
): import("../yotsuba/types.js").YotsubaPostNode {
  const { text, quotes, deadQuotes, crossQuotes } = convertComment(post.com ?? "");
  const node: import("../yotsuba/types.js").YotsubaPostNode = {
    no: post.no!,
    index,
    role,
    time: (post.time ?? 0) * 1000,
    text,
    quotes,
    replies: 0,  // backlink count not known at capture time
  };
  if (post.name && post.name !== "Anonymous") node.name = post.name;
  if (post.trip) node.trip = post.trip;
  if (post.id) node.posterId = post.id;
  if (post.capcode) node.capcode = post.capcode;
  const flag = post.country_name ?? post.flag_name;
  if (flag) node.flag = flag;
  if (deadQuotes && deadQuotes.length > 0) node.deadQuotes = deadQuotes;
  if (crossQuotes && crossQuotes.length > 0) node.crossQuotes = crossQuotes;
  const safeTim = safeYotsubaTim(post.tim);
  const safeExt = safeYotsubaExt(post.ext);
  if (safeTim && safeExt) {
    node.file = {
      name: post.filename ?? String(safeTim),
      ext: safeExt,
      w: post.w,
      h: post.h,
      bytes: post.fsize,
      spoiler: post.spoiler === 1,
      deleted: post.filedeleted === 1,
      tim: safeTim,
    };
  }
  return node;
}

/**
 * Infer a MIME type from a 4chan file extension (includes leading dot).
 * Returns `undefined` for unknown/unsupported types.
 */
function inferMimeTypeFromExt(ext: string): string | undefined {
  const e = ext.toLowerCase();
  switch (e) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

