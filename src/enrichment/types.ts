import type { MediaAssetRow, LinkPreviewRow, ReplyContextRow } from "../storage/index.js";

export interface EnrichmentResult {
  mediaAssets: MediaAssetRow[];
  linkPreviews: LinkPreviewRow[];
  replyContext: ReplyContextRow | null;
}

export interface EnrichmentCapabilities {
  downloadMedia(params: { roomId: string; eventId: string; outputPath: string; sizeLimit?: number }): Promise<{
    sizeBytes: number;
    contentType?: string;
    filename?: string;
    kind: string;
  }>;

  /**
   * Fetch a summary of one message for reply-context enrichment.
   *
   * The return shape drops the Matrix-specific `msgtype` field in favour of a
   * neutral `attachments` array so Discord (and future providers) can describe
   * their attachments without synthesising fake Matrix content types.
   * Matrix maps its single `m.image`/`m.video`/etc. msgtype → one element;
   * Discord may carry multiple elements. `remoteUrl` is present only for
   * providers that supply a direct download URL (Discord CDN); it is absent
   * (dead) for Matrix.
   */
  messageSummary(params: { roomId: string; eventId: string }): Promise<{
    eventId: string;
    sender: string;
    senderName?: string;
    body: string;
    /**
     * Attachments on the summarized message. Replaces the old `msgtype` field.
     * Each element carries the neutral `mediaType` (image/video/audio/file).
     * `remoteUrl` is present for Discord attachments (CDN URL); absent for
     * Matrix (which uses the Matrix RPC download path instead).
     */
    attachments?: Array<{
      mediaType: string;
      filename?: string;
      mimeType?: string;
      /** CDN URL for providers that supply it (Discord). Absent for Matrix. */
      remoteUrl?: string;
    }>;
    timestamp: string;
  } | null>;

  /**
   * Resolve link previews for a body text. Optional: when absent, the
   * enrichment worker falls back to {@link DirectLinkPreviewClient} which
   * scrapes og:/twitter: meta tags via plain HTTP. Providers with
   * `linkPreviews: "none"` omit this method.
   */
  resolveLinkPreviews?(params: {
    bodyText: string;
    includeImages: boolean;
    maxBytes: number;
  }): Promise<{
    textBlocks: string[];
    media: Array<{
      sourceUrl: string;
      filename?: string;
      contentType?: string;
      dataBase64: string;
    }>;
    sources: Array<{
      url: string;
      sourceKind: string;
      siteName?: string;
      title?: string;
      description?: string;
    }>;
  }>;

  memberInfo(params: { roomId: string; userId: string }): Promise<{
    displayName?: string;
  }>;
}

export interface EnrichmentConfig {
  worker_count?: number;
  fetch_timeout_ms?: number;
  trigger_wait_timeout_ms?: number;
  max_previews_per_message?: number;
  max_retries?: number;
}
