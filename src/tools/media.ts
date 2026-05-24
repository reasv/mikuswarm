import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import type { ConcurrencyLimitedInferenceClient } from "../captioning/inference-client.js";
import type { MediaModality } from "../captioning/describe.js";

export interface MediaToolContext {
  workspaceRoot: string;
  clients: Map<MediaModality, ConcurrencyLimitedInferenceClient>;
  defaultPrompts: Map<MediaModality, string>;
  modelHasVision: boolean;
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
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { prompt?: string; media?: string; media_items?: string[] };

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
        try {
          const loaded = await loadMedia(context.workspaceRoot, source);
          const modality = inferModality(loaded.mimeType, source);
          const client = context.clients.get(modality);
          if (!client) {
            results.push(`[${source}]\nError: no inference client configured for ${modality}`);
            continue;
          }
          const prompt = args.prompt ?? context.defaultPrompts.get(modality) ?? "Describe this media.";
          const result = await client.caption({
            data: loaded.data,
            mimeType: loaded.mimeType,
            filename: source,
            prompt,
          });
          const label = unique.length > 1 ? `[${source}]\n` : "";
          results.push(`${label}${result.caption}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push(`[${source}]\nError: ${msg}`);
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
  data: Buffer;
  mimeType: string;
}

const MAX_FETCH_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_MEDIA_PREFIXES = ["image/", "video/", "audio/"];

async function loadMedia(workspaceRoot: string, source: string): Promise<LoadedMedia> {
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch media: HTTP ${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";

    if (!ALLOWED_MEDIA_PREFIXES.some((p) => mimeType.startsWith(p)) && mimeType !== "application/octet-stream") {
      throw new Error(`URL returned non-media content-type: ${mimeType}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_BYTES) {
      throw new Error(`Media too large: Content-Length ${contentLength} exceeds ${MAX_FETCH_BYTES} byte limit`);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Failed to read response body");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_FETCH_BYTES) {
        reader.cancel();
        throw new Error(`Media too large: exceeded ${MAX_FETCH_BYTES} byte limit during download`);
      }
      chunks.push(value);
    }

    return { data: Buffer.concat(chunks), mimeType };
  }

  const absolute = resolveWorkspacePath(workspaceRoot, source);
  const data = await readFile(absolute);
  const mimeType = mimeFromExtension(source);
  return { data, mimeType };
}

function inferModality(mimeType: string, source: string): MediaModality {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = source.split(".").pop()?.toLowerCase();
  if (ext && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "tiff"].includes(ext)) return "image";
  if (ext && ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  if (ext && ["mp3", "ogg", "wav", "flac", "aac", "m4a", "opus", "wma"].includes(ext)) return "audio";
  return "image";
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
