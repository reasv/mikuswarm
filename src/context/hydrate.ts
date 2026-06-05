import type { AttachmentMeta, CanonicalChatEvent, LinkPreviewMeta } from "../types.js";
import type { LinkPreviewRow, MediaAssetRow, ReplyContextRow, Storage } from "../storage/index.js";

/**
 * Merge the enrichment side-tables (reply context, link previews, media assets +
 * captions) back into a base `CanonicalChatEvent`. The persisted `event_json` carries
 * only the message itself; attachments' captions, resolved reply sender/body, and
 * fetched link-preview metadata live in separate tables and are stitched on at read
 * time. Used by the context builder (§9) and by `search_messages` (§9e) so search hits
 * render with the *same* fidelity as in-context messages.
 */
export function mergeEnrichmentIntoEvent(
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
      sender: replyContext.sender_id
        ? {
            id: replyContext.sender_id,
            displayName: replyContext.sender_display_name ?? undefined,
          }
        : undefined,
      body: replyContext.body ?? undefined,
      htmlBody: replyContext.html_body ?? undefined,
      timestamp: replyContext.timestamp ?? undefined,
      attachments: replyAttachments.length > 0 ? replyAttachments.map(mediaAssetToAttachmentMeta) : undefined,
      linkedMedia: replyLinkedMedia.length > 0 ? replyLinkedMedia.map(mediaAssetToAttachmentMeta) : undefined,
      linkPreviews:
        replyLinkPreviews.length > 0
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

export function mediaAssetToAttachmentMeta(asset: MediaAssetRow): AttachmentMeta {
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
      } catch {
        /* ignore */
      }
    }
  }
  return meta;
}

export function linkPreviewRowToMeta(lp: LinkPreviewRow, allMedia: MediaAssetRow[]): LinkPreviewMeta {
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

/** Storage surface needed to hydrate (just the enrichment-data batch read). */
export type EnrichmentDataSource = Pick<Storage, "getEnrichmentData">;

/**
 * Hydrate a batch of events with their enrichment side-tables in one read. Events with
 * no enrichment are returned as-is. Order is preserved.
 */
export function hydrateEvents(
  storage: EnrichmentDataSource,
  events: CanonicalChatEvent[],
): CanonicalChatEvent[] {
  if (events.length === 0) return events;
  const { replyContexts, linkPreviews, mediaAssets } = storage.getEnrichmentData(events.map((e) => e.id));
  return events.map((event) => {
    const rc = replyContexts.get(event.id);
    const lps = linkPreviews.get(event.id);
    const mas = mediaAssets.get(event.id);
    if (!rc && !lps && !mas) return event;
    return mergeEnrichmentIntoEvent(event, rc ?? null, lps ?? [], mas ?? []);
  });
}
