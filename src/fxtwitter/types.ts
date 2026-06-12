/**
 * FxTwitter enrichment types (ARCHITECTURE.md §7a "X.com enrichment via
 * FxTwitter"; spec/FXTWITTER-ENRICHMENT.md). Pure TS — no Matrix/native
 * imports. Two families live here:
 *
 *  - tolerant FxTwitter API response shapes (every field optional, unknown
 *    fields ignored — the upstream schema evolves), and
 *  - the persisted `link_previews.payload_json` payload the rich renderer
 *    consumes.
 */

import { STATUS_BASE_HOSTS } from "./url.js";

/**
 * `link_previews.source_kind` value for FxTwitter-enriched X status previews.
 * Owned by the TS enrichment layer — the old Matrix-layer
 * `MatrixLinkPreviewSourceKind` member was dead code from the ported system
 * (the native FxTwitter path never ran in production).
 */
export const FX_TWITTER_SOURCE_KIND = "fx_twitter";

// ---------------------------------------------------------------------------
// FxTwitter API response (tolerant)
// ---------------------------------------------------------------------------

export interface FxApiPhoto {
  url?: string;
  width?: number;
  height?: number;
  altText?: string;
}

export interface FxApiVideo {
  /** Direct mp4 URL — the actual video file. */
  url?: string;
  thumbnail_url?: string;
  duration?: number;
  format?: string;
  /** Distinguishes a real video from a GIF (both ship as mp4). */
  type?: string;
}

export interface FxApiMosaic {
  formats?: { jpeg?: string; webp?: string };
}

export interface FxApiPollChoice {
  label?: string;
  count?: number;
  percentage?: number;
}

export interface FxApiPoll {
  choices?: FxApiPollChoice[];
  total_votes?: number;
  ends_at?: string;
}

export interface FxApiAuthor {
  name?: string;
  screen_name?: string;
}

export interface FxApiTweet {
  id?: string;
  url?: string;
  text?: string;
  /** Unix seconds. */
  created_timestamp?: number;
  author?: FxApiAuthor;
  replies?: number;
  retweets?: number;
  likes?: number;
  views?: number;
  poll?: FxApiPoll;
  community_note?: string;
  media?: {
    photos?: FxApiPhoto[];
    videos?: FxApiVideo[];
    mosaic?: FxApiMosaic;
  };
  /** Quote tweet — same shape, rendered one level deep. */
  quote?: FxApiTweet;
}

export interface FxApiResponse {
  code?: number;
  message?: string;
  tweet?: FxApiTweet;
}

// ---------------------------------------------------------------------------
// Persisted payload (`link_previews.payload_json`)
// ---------------------------------------------------------------------------

export interface XTweetPayload {
  v: 1;
  tweet: XTweetNode;
}

export interface XTweetNode {
  id: string;
  url?: string;
  authorName?: string;
  /** Without "@". */
  authorHandle?: string;
  /** Rendered with the agent timezone at build time. */
  createdAtMs?: number;
  /** Possibly truncated (max_text_chars). */
  text?: string;
  /** → renderer appends the x_fetch hint. */
  textTruncated?: boolean;
  stats?: { replies?: number; retweets?: number; likes?: number; views?: number };
  poll?: {
    choices: Array<{ label: string; percentage?: number; count?: number }>;
    totalVotes?: number;
    endsAt?: string;
  };
  /** Truncated like text. */
  communityNote?: string;
  communityNoteTruncated?: boolean;
  media?: XMediaSlot[];
  /** One level only. */
  quote?: XTweetNode;
}

export interface XMediaSlot {
  /** The `media_assets.id` this slot maps to. */
  assetId: string;
  kind: "photo" | "mosaic" | "video" | "gif" | "video_thumbnail";
  /** 1-based position within the node's media. */
  index?: number;
  /** Mosaic: how many photos it collages. */
  photoCount?: number;
  /** Photo alt text (mosaic: joined per-photo alts). */
  altText?: string;
  durationSeconds?: number;
}

/** Parse a persisted `payload_json` column; null on any malformation. */
export function parseXTweetPayload(json: string | null | undefined): XTweetPayload | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as XTweetPayload;
    if (parsed && parsed.v === 1 && parsed.tweet && typeof parsed.tweet.id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolved configuration ([fxtwitter] — see src/config/schema.ts)
// ---------------------------------------------------------------------------

export interface FxTwitterToolConfig {
  enabled: boolean;
  defaultMaxChars: number;
  maxCharsLimit: number;
  maxTotalChars: number;
  maxViewBlocks: number;
}

export interface FxTwitterConfig {
  enabled: boolean;
  apiBase: string;
  fetchTimeoutMs: number;
  maxTextChars: number;
  preferMosaic: boolean;
  maxVideosPerTweet: number;
  /**
   * Base domains recognized as X status hosts: the built-in `STATUS_BASE_HOSTS`
   * plus any `extra_status_hosts`. Passed to the url helpers by the enrichment
   * worker and the `x_fetch` tool.
   */
  statusHosts: readonly string[];
  tool: FxTwitterToolConfig;
}

export function resolveFxTwitterConfig(raw?: {
  enabled?: boolean;
  api_base?: string;
  fetch_timeout_ms?: number;
  max_text_chars?: number;
  prefer_mosaic?: boolean;
  max_videos_per_tweet?: number;
  extra_status_hosts?: string[];
  tool?: {
    enabled?: boolean;
    default_max_chars?: number;
    max_chars_limit?: number;
    max_total_chars?: number;
    max_view_blocks?: number;
  };
}): FxTwitterConfig {
  return {
    enabled: raw?.enabled ?? true,
    apiBase: (raw?.api_base ?? "https://api.fxtwitter.com").replace(/\/+$/, ""),
    fetchTimeoutMs: raw?.fetch_timeout_ms ?? 15_000,
    maxTextChars: raw?.max_text_chars ?? 2000,
    preferMosaic: raw?.prefer_mosaic ?? true,
    maxVideosPerTweet: raw?.max_videos_per_tweet ?? 4,
    statusHosts: resolveStatusHosts(raw?.extra_status_hosts),
    tool: {
      enabled: raw?.tool?.enabled ?? true,
      defaultMaxChars: raw?.tool?.default_max_chars ?? 4000,
      maxCharsLimit: raw?.tool?.max_chars_limit ?? 16_000,
      maxTotalChars: raw?.tool?.max_total_chars ?? 32_768,
      maxViewBlocks: raw?.tool?.max_view_blocks ?? 4,
    },
  };
}

/**
 * Merge the deployment's `extra_status_hosts` into the built-in base set,
 * lowercased and deduped (order: built-ins first, then extras).
 */
function resolveStatusHosts(extra?: string[]): readonly string[] {
  if (!extra || extra.length === 0) return STATUS_BASE_HOSTS;
  const seen = new Set(STATUS_BASE_HOSTS);
  const merged = [...STATUS_BASE_HOSTS];
  for (const raw of extra) {
    const host = raw.trim().toLowerCase();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    merged.push(host);
  }
  return merged;
}
