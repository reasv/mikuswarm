/**
 * `youtube_fetch` — YouTube video metadata + transcript tool (T2), with optional
 * workspace file download (§6a).
 *
 * Document mode (default):
 *   Returns a windowed text document: header (title, channel, upload date,
 *   duration, views), bounded description, chapter list with timestamps, and
 *   the full folded transcript with [m:ss] markers. The document is bounded at
 *   [youtube.tool].max_total_chars and returned as the [offset, offset+max_chars)
 *   window with the standard truncation trailer and details { totalChars,
 *   nextOffset, truncated } — identical mechanics to x_fetch.
 *
 * Download mode (download: "video"|"audio"):
 *   Downloads the media file into
 *   downloads/youtube/{videoId}/{slug}[-<start>-<end>].{mp4|m4a} and returns a
 *   metadata header + one line per saved file with workspace-relative path and
 *   byte count.
 *
 * Registered only when [youtube].enabled AND yt-dlp binary probe passed.
 * (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §6 + §6a)
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { YouTubeToolConfig } from "../youtube/config.js";
import { parseYouTubeUrl } from "../youtube/url.js";
import {
  probe,
  transcript,
  download,
  type YouTubeProbeMetadata,
} from "../youtube/ytdlp.js";
import {
  formatDuration,
  formatUploadDate,
  formatChapterTimestamp,
} from "../youtube/payload.js";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { escapeXml, escapeAttr } from "../context/xml.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical 11-character YouTube video id pattern. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Cap on the description included in the document. Keeps the document
 * focused — video descriptions can be arbitrarily long (links, hashtags,
 * chapter lists repeated, etc.) and their tail is rarely useful.
 */
const DESCRIPTION_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface YoutubeFetchToolContext {
  workspaceRoot: string;
  config: YouTubeToolConfig;
}

// ---------------------------------------------------------------------------
// Internal param type
// ---------------------------------------------------------------------------

interface YoutubeFetchParams {
  url: string;
  offset?: number;
  max_chars?: number;
  transcript_lang?: string;
  download?: "video" | "audio";
  max_height?: number;
  clip_start?: number;
  clip_duration?: number;
}

// ---------------------------------------------------------------------------
// URL / id parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YouTube URL or a bare 11-character video id.
 * Returns { videoId, startSec? } or null if unrecognized.
 *
 * Bare ids are accepted here (unlike parseYouTubeUrl which requires a URL
 * with host context), matching the x_fetch convention of accepting bare ids.
 */
export function parseYouTubeRef(
  input: string,
): { videoId: string; startSec?: number } | null {
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) {
    return { videoId: trimmed };
  }
  return parseYouTubeUrl(trimmed);
}

// ---------------------------------------------------------------------------
// Document building
// ---------------------------------------------------------------------------

/**
 * Build the canonical youtube_fetch text document.
 *
 * Layout:
 *   Header (trusted): title, channel, uploaded, duration, views
 *   Description (untrusted, bounded): XML-escaped in an untrusted envelope
 *   Chapters (trusted structure, escaped titles)
 *   Transcript (untrusted): XML-escaped in an untrusted envelope
 *   Media hint trailer (trusted)
 *
 * Bounded at maxTotalChars (hard slice — the window may cut mid-envelope, but
 * that's acceptable since the model will see the truncation trailer and paginate).
 */
export function buildYoutubeFetchDocument(
  meta: YouTubeProbeMetadata,
  transcriptText: string,
  transcriptLang: string,
  transcriptKind: "manual" | "auto" | "none",
  maxTotalChars: number,
): string {
  const lines: string[] = [];

  // ── Header (trusted) ──────────────────────────────────────────────────────
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.channel) lines.push(`Channel: ${meta.channel}`);
  if (meta.uploadDate) {
    const formatted = formatUploadDate(meta.uploadDate);
    if (formatted) lines.push(`Uploaded: ${formatted}`);
  }
  if (meta.duration != null) lines.push(`Duration: ${formatDuration(meta.duration)}`);
  if (meta.viewCount != null) lines.push(`Views: ${meta.viewCount.toLocaleString("en-US")}`);
  lines.push("");

  // ── Description (external, untrusted) ─────────────────────────────────────
  if (meta.description && meta.description.trim()) {
    const raw = meta.description;
    const bounded =
      raw.length > DESCRIPTION_MAX_CHARS
        ? `${raw.slice(0, DESCRIPTION_MAX_CHARS)}\n[description truncated — showing first ${DESCRIPTION_MAX_CHARS} characters]`
        : raw;
    lines.push("Description:");
    lines.push(
      `<untrusted_youtube_fetch source="description" video_id="${escapeAttr(meta.id)}">`,
    );
    lines.push(escapeXml(bounded));
    lines.push("</untrusted_youtube_fetch>");
    lines.push("");
  }

  // ── Chapters (trusted structure, escaped titles) ──────────────────────────
  if (meta.chapters.length > 0) {
    lines.push("Chapters:");
    for (const ch of meta.chapters) {
      lines.push(`${formatChapterTimestamp(ch.startTime)} ${escapeXml(ch.title)}`);
    }
    lines.push("");
  }

  // ── Transcript (external, untrusted) ──────────────────────────────────────
  if (transcriptKind === "none" || !transcriptText.trim()) {
    lines.push("Transcript: none available");
  } else {
    const langAttr = transcriptLang ? ` lang="${escapeAttr(transcriptLang)}"` : "";
    const kindAttr = ` kind="${escapeAttr(transcriptKind)}"`;
    lines.push(`Transcript (${transcriptLang || "unknown"}, ${transcriptKind}):`);
    lines.push(
      `<untrusted_youtube_fetch source="transcript"${langAttr}${kindAttr} video_id="${escapeAttr(meta.id)}">`,
    );
    lines.push(escapeXml(transcriptText));
    lines.push("</untrusted_youtube_fetch>");
  }

  lines.push("");
  lines.push("To watch a segment, call `media` with this URL and `start_time`.");

  let doc = lines.join("\n");
  if (doc.length > maxTotalChars) {
    doc = doc.slice(0, maxTotalChars);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// t= timestamp → document offset
// ---------------------------------------------------------------------------

/**
 * Scan the assembled document for [M:SS] timestamp markers and return the
 * character offset of the one whose video time is nearest to targetSec.
 *
 * Returns 0 when no markers are found (safe default: open at the top).
 *
 * Note: foldJson3Transcript emits `[M:SS]` where M is TOTAL minutes (not
 * hours:minutes), so 90 minutes appears as `[90:00]`, not `[1:30:00]`.
 */
export function findNearestMarkerOffset(doc: string, targetSec: number): number {
  const MARKER_RE = /\[(\d+):(\d{2})\]/g;
  let bestOffset = 0;
  let bestDelta = Infinity;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = MARKER_RE.exec(doc)) !== null) {
    const markerSec = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    const delta = Math.abs(markerSec - targetSec);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestOffset = match.index;
    }
  }
  return bestOffset;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a video title into a filesystem-safe slug suitable for use as a
 * download filename stem.
 *
 * Rules:
 *  - Replace any character that is not alphanumeric, dot, or ASCII hyphen with
 *    a hyphen. This handles Unicode, emoji, slashes, colons, question marks, etc.
 *  - Collapse runs of hyphens produced by the above.
 *  - Strip dots that follow a hyphen or start the string (avoids `..` and hidden
 *    files; a trailing dot is stripped by the leading/trailing hyphen strip below
 *    since it becomes a trailing hyphen after the replace).
 *  - Strip leading/trailing hyphens.
 *  - Limit to 80 characters.
 *  - Fall back to "video" when all characters were stripped.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^A-Za-z0-9.-]+/g, "-") // non-safe chars → hyphen
    .replace(/(^|-)\.+/g, "$1") // dots after hyphen or at start → remove
    .replace(/-{2,}/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
  return (slug.slice(0, 80) || "video");
}

/**
 * Find a non-conflicting path for a new file in dir.
 *
 * Probes filename, filename-1.ext, filename-2.ext, … up to 100 attempts.
 * This is a stat-based check (TOCTOU-vulnerable) which is acceptable for
 * workspace downloads where the file is created by yt-dlp. The resolved path
 * is passed directly to yt-dlp as the output target.
 */
async function findExclusivePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let suffix = 0; suffix <= 100; suffix++) {
    const candidate = path.join(
      dir,
      suffix === 0 ? filename : `${stem}-${suffix}${ext}`,
    );
    try {
      await fs.access(candidate);
      // File exists — try next suffix.
    } catch {
      // File does not exist — use this name.
      return candidate;
    }
  }
  throw new Error(`Could not find a free filename for ${filename} after 100 attempts.`);
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export function createYoutubeFetchTool(context: YoutubeFetchToolContext): AgentTool {
  const { config } = context;
  return {
    name: "youtube_fetch",
    label: "YouTube fetch",
    description:
      "Read a YouTube video's metadata and full timestamped transcript, or download the video/audio into the workspace. " +
      "Accepts any YouTube URL (youtube.com/watch, youtu.be, /shorts/, /live/, /embed/) or a bare 11-character video id. " +
      "Document mode (default): returns title, channel, upload date, duration, description, chapters, and the full transcript " +
      "windowed by offset/max_chars — paginate long videos with repeated calls. " +
      "Download mode (download: \"video\"|\"audio\"): saves an mp4 or m4a into the workspace; " +
      "useful for send_message, media analysis, or sandbox processing.",
    parameters: Type.Object({
      url: Type.String({
        description:
          "YouTube URL (any recognized form) or bare 11-character video id.",
      }),
      offset: Type.Optional(
        Type.Integer({
          description:
            "Character offset into the assembled document (default 0). " +
            "When the source URL carries t=/start=, the window auto-opens at that transcript position " +
            "unless offset is explicitly supplied.",
          minimum: 0,
        }),
      ),
      max_chars: Type.Optional(
        Type.Integer({
          description: `Max characters returned in this call (default ${config.defaultMaxChars}, cap ${config.maxCharsLimit}).`,
          minimum: 1,
          maximum: config.maxCharsLimit,
        }),
      ),
      transcript_lang: Type.Optional(
        Type.String({
          description:
            'Preferred BCP-47 language code for the transcript (e.g. "en", "ja"). Defaults to the video\'s original/default track.',
        }),
      ),
      download: Type.Optional(
        Type.Union(
          [Type.Literal("video"), Type.Literal("audio")],
          {
            description:
              'Switch to download mode: "video" saves an mp4 file, "audio" saves an m4a (best audio track). No transcript document is returned in download mode.',
          },
        ),
      ),
      max_height: Type.Optional(
        Type.Integer({
          description: `Download mode: maximum video height in pixels (default and cap: ${config.downloadMaxHeight}). Values above the cap are clamped, not rejected.`,
          minimum: 1,
        }),
      ),
      clip_start: Type.Optional(
        Type.Integer({
          description:
            "Download mode: start offset of the clip in seconds. " +
            "Defaults to 0 (beginning of video) when clip_duration is provided; " +
            "omit both to download the full video.",
          minimum: 0,
        }),
      ),
      clip_duration: Type.Optional(
        Type.Integer({
          description:
            "Download mode: duration of the clip in seconds (omit = to end of video). " +
            "When provided without clip_start, the clip begins at 0.",
          minimum: 1,
        }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as YoutubeFetchParams;

      // ── Resolve video reference ────────────────────────────────────────────
      const ref = parseYouTubeRef(params.url);
      if (!ref) {
        throw new Error(
          "Not a recognizable YouTube URL or video id. " +
            "Pass a youtube.com/watch, youtu.be, /shorts/, /live/, or /embed/ URL, " +
            "or a bare 11-character video id.",
        );
      }
      const { videoId, startSec: urlStartSec } = ref;

      // ── Probe (always required) ────────────────────────────────────────────
      const meta = await probe(videoId);

      // ── Live / upcoming refusal ────────────────────────────────────────────
      // Refuse active live streams and scheduled premieres only. A post_live
      // stream that has ended and become a VOD is allowed through (yt-dlp can
      // probe and download it normally).
      if (
        meta.isLive ||
        meta.liveStatus === "is_live" ||
        meta.liveStatus === "upcoming"
      ) {
        const kind =
          meta.liveStatus === "upcoming" ? "scheduled premiere" : "live stream";
        throw new Error(
          `This video is a ${kind} — live and upcoming content cannot be fetched via youtube_fetch. ` +
            "Try again after the stream ends.",
        );
      }

      // ── Download mode ──────────────────────────────────────────────────────
      if (params.download === "video" || params.download === "audio") {
        return executeDownload(context, videoId, meta, params);
      }

      // ── Document mode ──────────────────────────────────────────────────────
      const transcriptResult = await transcript(videoId, params.transcript_lang, meta);

      const doc = buildYoutubeFetchDocument(
        meta,
        transcriptResult.text,
        transcriptResult.lang,
        transcriptResult.kind,
        config.maxTotalChars,
      );

      // Effective offset: explicit param wins; otherwise t= anchor when present.
      let offset: number;
      if (params.offset !== undefined) {
        offset = Math.min(Math.max(params.offset, 0), doc.length);
      } else if (urlStartSec !== undefined && urlStartSec > 0) {
        offset = findNearestMarkerOffset(doc, urlStartSec);
      } else {
        offset = 0;
      }

      const maxChars = Math.min(
        params.max_chars ?? config.defaultMaxChars,
        config.maxCharsLimit,
      );
      const totalChars = doc.length;
      const windowEnd = Math.min(offset + maxChars, totalChars);
      const truncated = windowEnd < totalChars;
      let windowText = doc.slice(offset, windowEnd);
      if (truncated) windowText += `\n[truncated — continue with offset=${windowEnd}]`;

      return {
        content: [{ type: "text" as const, text: windowText }],
        details: {
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          totalChars,
          nextOffset: truncated ? windowEnd : null,
          truncated,
          transcriptKind: transcriptResult.kind,
          transcriptLang: transcriptResult.lang || null,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Download mode execution
// ---------------------------------------------------------------------------

async function executeDownload(
  context: YoutubeFetchToolContext,
  videoId: string,
  meta: YouTubeProbeMetadata,
  params: YoutubeFetchParams,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const { config, workspaceRoot } = context;
  const isAudio = params.download === "audio";
  const ext = isAudio ? "m4a" : "mp4";

  // When clip_duration is provided without clip_start, default clip_start to 0
  // so the agent's request "give me the first 30 seconds" works as expected.
  // Both being absent means no clipping (whole video).
  const clipStart =
    params.clip_start ?? (params.clip_duration != null ? 0 : undefined);

  // Clamp max_height to the configured cap (never error — spec §6a).
  const maxHeight = isAudio
    ? undefined
    : Math.min(
        params.max_height ?? config.downloadMaxHeight,
        config.downloadMaxHeight,
      );

  // Build the output filename.
  const titleSlug = slugifyTitle(meta.title ?? videoId);
  let clipSuffix = "";
  if (clipStart != null) {
    clipSuffix =
      params.clip_duration != null
        ? `-${clipStart}-${clipStart + params.clip_duration}`
        : `-${clipStart}`;
  }
  const filename = `${titleSlug}${clipSuffix}.${ext}`;

  // Create the destination directory.
  const dir = resolveWorkspacePath(
    workspaceRoot,
    path.posix.join("downloads/youtube", videoId),
  );
  await fs.mkdir(dir, { recursive: true });

  // Find a non-conflicting output path.
  const outPath = await findExclusivePath(dir, filename);

  // Invoke the yt-dlp download wrapper.
  try {
    await download(videoId, {
      audioOnly: isAudio,
      maxHeight,
      startSec: clipStart,
      durationSec: params.clip_duration,
      outPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Rewrite yt-dlp's filesize error with actionable suggestions.
    if (/filesize|too large/i.test(msg)) {
      throw new Error(
        `Download aborted: the file exceeds the configured size limit. ` +
          `Try one of: (1) lower max_height (e.g. 480 or 360), ` +
          `(2) use download: "audio" for audio-only, ` +
          `or (3) add clip_start and clip_duration to fetch a shorter segment.`,
      );
    }
    throw err;
  }

  // Stat the output file for byte count.
  let sizeBytes: number | null = null;
  try {
    const stat = await fs.stat(outPath);
    sizeBytes = stat.size;
  } catch {
    // Non-fatal: reported as null.
  }

  const relPath = workspaceRelative(workspaceRoot, outPath);

  // Build the response text.
  const lines: string[] = [];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.channel) lines.push(`Channel: ${meta.channel}`);
  if (meta.uploadDate) {
    const formatted = formatUploadDate(meta.uploadDate);
    if (formatted) lines.push(`Uploaded: ${formatted}`);
  }
  if (meta.duration != null) lines.push(`Duration: ${formatDuration(meta.duration)}`);
  lines.push("");
  lines.push("Downloads:");

  const infoParts: string[] = [`  ${relPath}`];
  if (sizeBytes != null) infoParts.push(`(${sizeBytes.toLocaleString("en-US")} bytes)`);
  if (isAudio) {
    infoParts.push("audio only, m4a");
  } else {
    infoParts.push(`video mp4${maxHeight != null ? `, up to ${maxHeight}p` : ""}`);
  }
  if (clipStart != null) {
    const clipDesc =
      params.clip_duration != null
        ? `clip ${clipStart}s–${clipStart + params.clip_duration}s`
        : `clip from ${clipStart}s`;
    infoParts.push(clipDesc);
  }
  lines.push(infoParts.join("  "));

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      path: relPath,
      sizeBytes,
    },
  };
}
