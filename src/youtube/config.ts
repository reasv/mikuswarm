/**
 * YouTube config resolution (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §9).
 *
 * Mirrors the FxTwitter pattern (src/fxtwitter/types.ts `resolveFxTwitterConfig`):
 * the raw TOML-decoded config is a partial, optional shape; this function
 * applies defaults and returns a fully-resolved, non-optional config object
 * used by every YouTube consumer.
 */

import type { YouTubeRawConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Resolved config types
// ---------------------------------------------------------------------------

export interface YouTubeEnrichmentConfig {
  /** T1 enrichment on/off (default true). */
  enabled: boolean;
  /** Enrich every message, not just caption-eligible ones (default false). */
  enrichAll: boolean;
  /** Chars of transcript head in T1 link preview (default 1000). */
  transcriptHeadChars: number;
  /** Store + caption video thumbnail as preview_media (default true). */
  thumbnail: boolean;
}

export interface YouTubeToolConfig {
  /** Cap on the assembled document (paginated via offset). */
  maxTotalChars: number;
  /** Default chars per returned window. */
  defaultMaxChars: number;
  /** Hard cap per returned window. */
  maxCharsLimit: number;
  /** Default + cap for workspace file downloads (max video height). */
  downloadMaxHeight: number;
}

export interface YouTubeConfig {
  /** Master switch (default true). Effective only when binary probe passes. */
  enabled: boolean;
  /** Path to the yt-dlp binary (default "yt-dlp"). */
  ytDlpPath: string;
  /** Max download size in bytes (default 200 MB). */
  maxDownloadBytes: number;
  /** Max concurrent yt-dlp subprocesses (default 2). */
  concurrency: number;
  /** Per-subprocess wall-clock timeout in ms (default 120000). */
  timeoutMs: number;
  /** Optional cookies file path (--cookies). */
  cookiesFile?: string;
  enrichment: YouTubeEnrichmentConfig;
  tool: YouTubeToolConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ENRICHMENT: YouTubeEnrichmentConfig = {
  enabled: true,
  enrichAll: false,
  transcriptHeadChars: 1000,
  thumbnail: true,
};

const DEFAULT_TOOL: YouTubeToolConfig = {
  maxTotalChars: 32_768,
  defaultMaxChars: 4_000,
  maxCharsLimit: 16_000,
  downloadMaxHeight: 720,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Apply defaults to the raw `[youtube]` config block and return a fully-resolved
 * `YouTubeConfig`. Called at app wiring and in tests; never throws (cross-field
 * validation is the caller's responsibility — app.ts does it immediately after).
 */
export function resolveYouTubeConfig(raw?: YouTubeRawConfig): YouTubeConfig {
  return {
    enabled: raw?.enabled ?? true,
    ytDlpPath: raw?.yt_dlp_path ?? "yt-dlp",
    maxDownloadBytes: raw?.max_download_bytes ?? 209_715_200, // 200 MB
    concurrency: raw?.concurrency ?? 2,
    timeoutMs: raw?.timeout_ms ?? 120_000,
    cookiesFile: raw?.cookies_file,
    enrichment: {
      enabled: raw?.enrichment?.enabled ?? DEFAULT_ENRICHMENT.enabled,
      enrichAll: raw?.enrichment?.enrich_all ?? DEFAULT_ENRICHMENT.enrichAll,
      transcriptHeadChars:
        raw?.enrichment?.transcript_head_chars ?? DEFAULT_ENRICHMENT.transcriptHeadChars,
      thumbnail: raw?.enrichment?.thumbnail ?? DEFAULT_ENRICHMENT.thumbnail,
    },
    tool: {
      maxTotalChars: raw?.tool?.max_total_chars ?? DEFAULT_TOOL.maxTotalChars,
      defaultMaxChars: raw?.tool?.default_max_chars ?? DEFAULT_TOOL.defaultMaxChars,
      maxCharsLimit: raw?.tool?.max_chars_limit ?? DEFAULT_TOOL.maxCharsLimit,
      downloadMaxHeight: raw?.tool?.download_max_height ?? DEFAULT_TOOL.downloadMaxHeight,
    },
  };
}
