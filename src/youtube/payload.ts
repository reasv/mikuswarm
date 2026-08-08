/**
 * YouTube T1 enrichment payload types and helpers.
 *
 * The payload stored in `link_previews.payload_json` for `source_kind =
 * "youtube"` rows. Consumed by the rich renderer (§7e) and the hydration layer.
 */

/**
 * `link_previews.source_kind` value for YouTube-enriched link previews.
 */
export const YOUTUBE_SOURCE_KIND = "youtube";

/** One chapter entry in the YouTube preview payload. */
export interface YouTubePreviewChapter {
  title: string;
  /** Chapter start time in whole seconds. */
  startTime: number;
}

/**
 * Structured payload stored in `link_previews.payload_json` for a YouTube
 * enriched preview (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §5).
 */
export interface YouTubePreviewPayload {
  /** Schema version — always 1 in v1. */
  v: 1;
  videoId: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
  /** ISO 8601 date (YYYYMMDD from yt-dlp, stored as-is). */
  uploadDate?: string;
  viewCount?: number;
  chapters: YouTubePreviewChapter[];
  /** First `transcript_head_chars` characters of the folded transcript. */
  transcriptHead?: string;
  /** BCP-47 language code of the selected transcript track. */
  transcriptLang?: string;
  /** Whether the transcript came from a manual track, auto-generated, or was unavailable. */
  transcriptKind: "manual" | "auto" | "none";
}

/**
 * Parse the `payload_json` column for a YouTube link preview.
 * Returns null on missing, invalid, or wrong-version JSON.
 */
export function parseYouTubePreviewPayload(
  json: string | null | undefined,
): YouTubePreviewPayload | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as YouTubePreviewPayload;
    if (parsed?.v !== 1 || typeof parsed.videoId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Format a duration in seconds as M:SS (< 1 hour) or H:MM:SS (>= 1 hour).
 *
 * Examples:
 *   formatDuration(47 * 60 + 12)  → "47:12"
 *   formatDuration(3600 + 2 * 60 + 34)  → "1:02:34"
 */
export function formatDuration(totalSeconds: number): string {
  const sec = Math.floor(Math.abs(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a chapter start time as a bracketed timestamp marker.
 * Uses H:MM:SS when hours ≥ 1, otherwise M:SS.
 *
 * Examples:
 *   formatChapterTimestamp(330)   → "[5:30]"
 *   formatChapterTimestamp(3754)  → "[1:02:34]"
 */
export function formatChapterTimestamp(totalSeconds: number): string {
  return `[${formatDuration(totalSeconds)}]`;
}

/**
 * Reformat yt-dlp's `upload_date` (compact YYYYMMDD) to ISO 8601 YYYY-MM-DD.
 * Returns the input unchanged if it doesn't match the 8-digit compact form.
 */
export function formatUploadDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}
