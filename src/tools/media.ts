import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import type { InferenceClient } from "../captioning/inference-client.js";
import type { MediaModality } from "../captioning/describe.js";
import type { FetchClient } from "../enrichment/fetch-client.js";
import type { ToolUsageRecord } from "./image-gen.js";
import { parseYouTubeUrl } from "../youtube/url.js";
import { probe, download } from "../youtube/ytdlp.js";
import { MediaCache } from "../media/cache.js";

/**
 * YouTube segment download context — present only when [youtube].enabled and the
 * yt-dlp binary probe passed at startup. Absence means YouTube URLs fall through
 * to the existing FetchClient path unchanged.
 */
export interface YoutubeMediaContext {
  /** Max bytes for segment downloads ([youtube].max_download_bytes). */
  maxDownloadBytes: number;
  /** Max video height for format selection (media.video.max_resolution). */
  maxResolution: number;
  /** Max segment duration in seconds (media.video.max_duration_seconds). */
  maxDurationSeconds: number;
  /** Media cache directory path (shared with the video lane's content-hash cache). */
  cachePath: string;
  /** LRU eviction ceiling in bytes (media.video.cache_max_bytes). */
  cacheMaxBytes: number;
  /** LRU eviction target in bytes (media.video.cache_target_bytes). */
  cacheTargetBytes: number;
}

export interface MediaToolContext {
  workspaceRoot: string;
  clients: Map<MediaModality, InferenceClient>;
  defaultPrompts: Map<MediaModality, string>;
  modelHasVision: boolean;
  maxFetchBytes: number;
  fetchClient: FetchClient;
  /** Ambient agent session (ledger attribution). */
  agentSessionId?: string | null;
  /** Durable usage-ledger sink (spec AUXILIARY-USAGE-TRACKING §8.2); also feeds the per-session cost ceiling. */
  recordToolUsage?: (record: ToolUsageRecord) => void;
  /**
   * YouTube subsystem context (spec YOUTUBE-VIDEO-UNDERSTANDING §7 T3).
   * When set, recognized YouTube URLs are routed through yt-dlp segment download
   * instead of FetchClient. Absent → YouTube URLs fall through to FetchClient.
   */
  youtube?: YoutubeMediaContext;
}

export function createMediaTool(context: MediaToolContext): AgentTool {
  const description = context.modelHasVision
    ? "Analyze one or more media files (images, videos, audio) with a vision/multimodal model. Use media for a single path/URL, or media_items for multiple (up to 20). Only use this tool when media was NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you. YouTube URLs are accepted and analyzed segment-wise via start_time."
    : "Analyze one or more media files (images, videos, audio) with the configured multimodal model. Use media for a single path/URL, or media_items for multiple (up to 20). Provide a prompt describing what to analyze. YouTube URLs are accepted and analyzed segment-wise via start_time.";

  return {
    name: "media",
    label: "Media",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): source is already in chat and
    // the caption is regenerable by re-calling media — exempt (see §18).
    resumeWorkExempt: true,
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Custom prompt describing what to analyze." })),
      media: Type.Optional(Type.String({ description: "Single media path or URL." })),
      media_items: Type.Optional(Type.Array(Type.String(), { description: "Multiple media paths or URLs (up to 20)." })),
      start_time: Type.Optional(Type.Number({ description: "Start time in seconds for video/audio analysis. Defaults to 0.", minimum: 0 })),
    }),
    execute: async (toolCallId, params) => {
      const args = params as { prompt?: string; media?: string; media_items?: string[]; start_time?: number };

      const candidates: string[] = [];
      if (args.media) candidates.push(args.media);
      if (args.media_items) candidates.push(...args.media_items);

      const unique = [...new Set(candidates)];
      if (unique.length === 0) {
        return { content: [{ type: "text", text: "Error: provide at least one media path or URL via media or media_items." }], details: {} };
      }
      if (unique.length > 20) {
        return { content: [{ type: "text", text: "Error: maximum 20 items per call." }], details: {} };
      }

      const results: string[] = [];
      for (const source of unique) {
        let loaded: LoadedMedia | undefined;
        try {
          loaded = await loadMedia(context.workspaceRoot, source, context.maxFetchBytes, context.fetchClient, context.youtube, args.start_time);
          const modality = await inferModality(loaded.mimeType, source, loaded.path);
          if (!modality) {
            results.push(`[${source}]\nError: could not determine media type`);
            continue;
          }
          const client = context.clients.get(modality);
          if (!client) {
            results.push(`[${source}]\nError: no inference client configured for ${modality}`);
            continue;
          }
          const prompt = args.prompt ?? context.defaultPrompts.get(modality) ?? "Describe this media.";
          const result = await client.caption({
            filePath: loaded.path,
            mimeType: loaded.mimeType,
            filename: source,
            prompt,
            // For YouTube pre-cut segments, omit start_time (segment already starts at 0)
            // and pass youtubeSegment so the truncation-warning machinery sees the real
            // video position (spec YOUTUBE-VIDEO-UNDERSTANDING §7 T3).
            startTime: loaded.youtubeSegment ? undefined : args.start_time,
            youtubeSegment: loaded.youtubeSegment,
            context: "tool",
          });
          // Caption ledger row (spec AUXILIARY-USAGE-TRACKING §8.2): the
          // InferenceClient already computed usage + cost — one row per
          // captioned item, feeding the per-session cost ceiling (§8d).
          if (result.usage && context.recordToolUsage) {
            try {
              context.recordToolUsage({
                agentSessionId: context.agentSessionId ?? null,
                toolName: "media",
                toolCallId,
                modelId: result.model,
                logicalModelId: result.logicalModelId,
                provider: result.provider,
                usage: result.usage,
                cost: result.cost ?? 0,
                ref: `caption:${source}`,
              });
            } catch {
              /* ledger is observability — never fail the tool */
            }
          }
          const label = unique.length > 1 ? `[${source}]\n` : "";
          results.push(`${label}${result.caption}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push(`[${source}]\nError: ${msg}`);
        } finally {
          if (loaded?.cleanup) await loaded.cleanup();
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n") }],
        details: { mediaCount: unique.length },
      };
    },
  };
}

interface LoadedMedia {
  path: string;
  mimeType: string;
  cleanup?: () => Promise<void>;
  /**
   * YouTube segment metadata — set only for YouTube-routed sources (spec §7 T3).
   * When present, start_time is NOT passed to processVideoForInference (double-seek
   * prevention), and these values override the processedRange/totalDuration/truncated
   * computed from the segment file so the truncation warning reflects the real video.
   */
  youtubeSegment?: {
    processedRange: [number, number];
    totalDuration: number;
    truncated: boolean;
  };
}

const ALLOWED_MEDIA_PREFIXES = ["image/", "video/", "audio/"];

// Module-level cache instance map: mirrors the pattern in src/media/video.ts so
// MediaCache is not reconstructed on every loadYouTubeMedia call.
const ytCacheInstances = new Map<string, MediaCache>();

function getYouTubeCache(cachePath: string): MediaCache {
  let cache = ytCacheInstances.get(cachePath);
  if (!cache) {
    cache = new MediaCache(cachePath);
    ytCacheInstances.set(cachePath, cache);
  }
  return cache;
}

async function loadMedia(
  workspaceRoot: string,
  source: string,
  maxFetchBytes: number,
  fetchClient: FetchClient,
  youtube?: YoutubeMediaContext,
  toolStartTime?: number,
): Promise<LoadedMedia> {
  // YouTube routing branch (spec YOUTUBE-VIDEO-UNDERSTANDING §7 T3):
  // when the URL is a recognized YouTube video URL and the subsystem is available,
  // resolve via yt-dlp segment download instead of FetchClient.
  if (youtube && isUrl(source)) {
    const ytRef = parseYouTubeUrl(source);
    if (ytRef) {
      return await loadYouTubeMedia(ytRef, youtube, toolStartTime);
    }
  }

  if (isUrl(source)) {
    const fetched = await fetchClient.fetch(source, { maxBytes: maxFetchBytes });
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      await unlink(fetched.path).catch(() => {});
      throw new Error(`Failed to fetch media: HTTP ${fetched.statusCode}`);
    }
    const mimeType = fetched.contentType?.split(";")[0]?.trim() ?? "application/octet-stream";
    if (!ALLOWED_MEDIA_PREFIXES.some(p => mimeType.startsWith(p)) && mimeType !== "application/octet-stream") {
      await unlink(fetched.path).catch(() => {});
      throw new Error(`URL returned non-media content-type: ${mimeType}`);
    }
    return {
      path: fetched.path,
      mimeType,
      cleanup: async () => { await unlink(fetched.path).catch(() => {}); },
    };
  }

  const absolute = resolveWorkspacePath(workspaceRoot, source);
  const mimeType = mimeFromExtension(source);
  return { path: absolute, mimeType };
}

/**
 * YouTube segment download + caching (spec YOUTUBE-VIDEO-UNDERSTANDING §7 T3).
 *
 * Downloads one ≤max_duration_seconds segment via yt-dlp (cut at download via
 * --download-sections), caches the raw segment file in the shared MediaCache keyed
 * on (videoId, startSec, durationSec, resolution), and returns the metadata needed
 * to synthesize the correct truncation warning for the full video.
 */
async function loadYouTubeMedia(
  ytRef: { videoId: string; startSec?: number },
  youtube: YoutubeMediaContext,
  toolStartTime?: number,
): Promise<LoadedMedia> {
  const { videoId, startSec: urlStartSec } = ytRef;

  // start_time precedence: tool param ?? URL t= ?? 0
  const startSec = toolStartTime ?? urlStartSec ?? 0;

  // Probe to get totalDuration and live status.
  const meta = await probe(videoId);

  // Refuse live and upcoming content (same policy as youtube_fetch).
  if (meta.isLive || meta.liveStatus === "is_live" || meta.liveStatus === "upcoming") {
    const kind = meta.liveStatus === "upcoming" ? "scheduled premiere" : "live stream";
    throw new Error(
      `Cannot analyze this YouTube video via media: it is a ${kind}. ` +
        "Live and upcoming content cannot be downloaded. Try again after the stream ends.",
    );
  }

  const totalDuration = meta.duration;
  if (!totalDuration || totalDuration <= 0) {
    throw new Error("Could not determine YouTube video duration");
  }

  if (startSec >= totalDuration) {
    throw new Error(
      `start_time (${startSec}s) is at or beyond video duration (${totalDuration}s)`,
    );
  }

  const maxDuration = youtube.maxDurationSeconds;
  const effectiveDuration = Math.min(maxDuration, Math.max(0, totalDuration - startSec));
  // Truncated when more video remains after the segment than we're downloading.
  const truncated = (totalDuration - startSec) > maxDuration;

  // Synthetic cache key: (videoId, startSec, durationSec, resolution).
  // No content hash — source is remote. Must be filename-safe; videoId is
  // [A-Za-z0-9_-]{11}, so underscores and alphanumerics are sufficient.
  const cacheKey = `yt_${videoId}_s${startSec}_d${maxDuration}_r${youtube.maxResolution}`;

  const cache = getYouTubeCache(youtube.cachePath);
  await cache.init();

  const cached = await cache.get(cacheKey);
  if (cached) {
    return {
      path: cached,
      mimeType: "video/mp4",
      youtubeSegment: {
        processedRange: [startSec, startSec + effectiveDuration],
        totalDuration,
        truncated,
      },
    };
  }

  // Cache miss — download the segment to a temp file, then move to the cache.
  const tmpPath = join(tmpdir(), `miku-yt-dl-${randomBytes(8).toString("hex")}.mp4`);
  try {
    await download(videoId, {
      startSec,
      durationSec: maxDuration,
      maxHeight: youtube.maxResolution,
      maxBytes: youtube.maxDownloadBytes,
      outPath: tmpPath,
    });

    const cachedPath = await cache.put(cacheKey, tmpPath);
    await cache.evictIfNeeded(youtube.cacheMaxBytes, youtube.cacheTargetBytes);

    return {
      path: cachedPath,
      mimeType: "video/mp4",
      youtubeSegment: {
        processedRange: [startSec, startSec + effectiveDuration],
        totalDuration,
        truncated,
      },
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

function inferModalityFromMimeOrExt(mimeType: string, source: string): MediaModality | null {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = source.split(".").pop()?.toLowerCase();
  if (ext && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "tiff"].includes(ext)) return "image";
  if (ext && ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  if (ext && ["mp3", "ogg", "wav", "flac", "aac", "m4a", "opus", "wma"].includes(ext)) return "audio";
  return null;
}

async function inferModalityFromMagicBytes(filePath: string): Promise<MediaModality | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);

    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image"; // JPEG
    if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === "PNG") return "image"; // PNG
    if (buf.subarray(0, 4).toString() === "GIF8") return "image"; // GIF
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image"; // WebP
    if (buf.subarray(4, 8).toString() === "ftyp") {
      const brand = buf.subarray(8, 12).toString();
      if (brand === "avif" || brand === "avis") return "image"; // AVIF
      if (brand === "M4A " || brand === "M4B ") return "audio"; // M4A
      return "video"; // MP4/MOV/etc
    }
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "video"; // Matroska/WebM
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "AVI ") return "video"; // AVI
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio"; // MP3 (ID3 tag)
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return "audio"; // MP3 (sync word)
    if (buf.subarray(0, 4).toString() === "OggS") return "audio"; // Ogg
    if (buf.subarray(0, 4).toString() === "fLaC") return "audio"; // FLAC
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WAVE") return "audio"; // WAV

    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function inferModality(mimeType: string, source: string, filePath: string): Promise<MediaModality | null> {
  return inferModalityFromMimeOrExt(mimeType, source) ?? await inferModalityFromMagicBytes(filePath);
}

function mimeFromExtension(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    svg: "image/svg+xml", avif: "image/avif", tiff: "image/tiff",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
    opus: "audio/opus", wma: "audio/x-ms-wma",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
