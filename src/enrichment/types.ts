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

  messageSummary(params: { roomId: string; eventId: string }): Promise<{
    eventId: string;
    sender: string;
    senderName?: string;
    body: string;
    msgtype?: string;
    timestamp: string;
  } | null>;

  resolveLinkPreviews(params: {
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
  fetch_concurrency?: number;
  fetch_timeout_ms?: number;
  trigger_wait_timeout_ms?: number;
  max_previews_per_message?: number;
  max_retries?: number;
}
