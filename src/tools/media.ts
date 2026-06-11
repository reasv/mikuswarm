import { open, unlink } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import type { InferenceClient } from "../captioning/inference-client.js";
import type { MediaModality } from "../captioning/describe.js";
import type { FetchClient } from "../enrichment/fetch-client.js";

export interface MediaToolContext {
  workspaceRoot: string;
  clients: Map<MediaModality, InferenceClient>;
  defaultPrompts: Map<MediaModality, string>;
  modelHasVision: boolean;
  maxFetchBytes: number;
  fetchClient: FetchClient;
}

export function createMediaTool(context: MediaToolContext): AgentTool {
  const description = context.modelHasVision
    ? "Analyze one or more media files (images, videos, audio) with a vision/multimodal model. Use media for a single path/URL, or media_items for multiple (up to 20). Only use this tool when media was NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you."
    : "Analyze one or more media files (images, videos, audio) with the configured multimodal model. Use media for a single path/URL, or media_items for multiple (up to 20). Provide a prompt describing what to analyze.";

  return {
    name: "media",
    label: "Media",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Custom prompt describing what to analyze." })),
      media: Type.Optional(Type.String({ description: "Single media path or URL." })),
      media_items: Type.Optional(Type.Array(Type.String(), { description: "Multiple media paths or URLs (up to 20)." })),
      start_time: Type.Optional(Type.Number({ description: "Start time in seconds for video/audio analysis. Defaults to 0.", minimum: 0 })),
    }),
    execute: async (_toolCallId, params) => {
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
          loaded = await loadMedia(context.workspaceRoot, source, context.maxFetchBytes, context.fetchClient);
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
            startTime: args.start_time,
            context: "tool",
          });
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
}

const ALLOWED_MEDIA_PREFIXES = ["image/", "video/", "audio/"];

async function loadMedia(workspaceRoot: string, source: string, maxFetchBytes: number, fetchClient: FetchClient): Promise<LoadedMedia> {
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
