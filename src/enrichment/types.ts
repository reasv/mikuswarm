import type { MediaAssetRow, LinkPreviewRow, ReplyContextRow } from "../storage/index.js";

export interface EnrichmentResult {
  mediaAssets: MediaAssetRow[];
  linkPreviews: LinkPreviewRow[];
  replyContext: ReplyContextRow | null;
}

/**
 * Provider-neutral description of a replied-to message, as produced by
 * {@link EnrichmentCapabilities.messageSummary} or by the worker's own
 * fallbacks (ingest-time `replyTo` snapshot, stored timeline event).
 */
export interface ReplyTargetSummary {
  eventId: string;
  sender: string;
  senderName?: string;
  body: string;
  /**
   * Attachments on the summarized message. Each element carries the neutral
   * `mediaType` (image/video/audio/file). `remoteUrl` is present for Discord
   * attachments (CDN URL); absent for Matrix (which uses the Matrix RPC
   * download path instead).
   */
  attachments?: Array<{
    mediaType: string;
    filename?: string;
    mimeType?: string;
    /** CDN URL for providers that supply it (Discord). Absent for Matrix. */
    remoteUrl?: string;
  }>;
  /** ISO-8601 timestamp of the target message. */
  timestamp: string;
}

export interface EnrichmentCapabilities {
  downloadMedia(params: { roomId: string; eventId: string; outputPath: string; sizeLimit?: number }): Promise<{
    sizeBytes: number;
    contentType?: string;
    filename?: string;
    kind: string;
  }>;

  /**
   * Fetch a summary of one message for reply-context enrichment via the
   * provider's own lookup (Matrix: the native `messageSummary` RPC).
   *
   * **Optional.** When present it is authoritative: a `null` result means the
   * target is unrepresentable (redacted, non-message, …) and the worker
   * records a body-less stub. Providers whose ingest already carries the
   * referenced message (Discord: `referenced_message` on the gateway payload)
   * omit it; the worker then resolves the target from the event's own
   * `replyTo` snapshot and, failing that, from the stored copy of the target
   * in `timeline_events` — see `EnrichmentWorker.lookupReplyTarget`.
   *
   * The return shape drops the Matrix-specific `msgtype` field in favour of a
   * neutral `attachments` array so Discord (and future providers) can describe
   * their attachments without synthesising fake Matrix content types.
   * Matrix maps its single `m.image`/`m.video`/etc. msgtype → one element;
   * Discord may carry multiple elements. `remoteUrl` is present only for
   * providers that supply a direct download URL (Discord CDN); it is absent
   * (dead) for Matrix.
   */
  messageSummary?(params: { roomId: string; eventId: string }): Promise<ReplyTargetSummary | null>;

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
