import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface ReadImageToolContext {
  workspaceRoot: string;
  /** Max bytes for the image payload sent to the model (raw, before base64). */
  maxImageBytes: number;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const SUPPORTED_EXT_LIST = Object.keys(MIME_BY_EXT).join(", ");

/**
 * Rasterize an SVG buffer to PNG, downscaling if needed so the result fits under maxBytes.
 * Tries decreasing pixel density values until the output fits, then a final hard-cap resize.
 */
async function rasterizeSvgToPng(buffer: Buffer, maxBytes: number, relPath: string): Promise<Buffer> {
  // Try a sequence of decreasing densities. 144 is a good default for SVGs with CSS units;
  // halving roughly quarters the byte size each step.
  const densities = [144, 96, 72, 48];
  for (const density of densities) {
    let png: Buffer;
    try {
      png = await sharp(buffer, { density }).png().toBuffer();
    } catch (error) {
      // Malformed SVG (or other sharp failure) — surface a clean error rather than
      // leaking sharp's internal libvips message.
      throw new Error(`Failed to rasterize SVG ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (png.byteLength <= maxBytes) return png;
  }
  // Density chain produced output but none fit. Fall back to a fixed-width resize.
  let png: Buffer;
  try {
    png = await sharp(buffer, { density: 96 })
      .resize({ width: 1024, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (error) {
    throw new Error(`Failed to rasterize SVG ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (png.byteLength <= maxBytes) return png;
  throw new Error(
    `Rasterized SVG ${relPath} is ${(png.byteLength / (1024 * 1024)).toFixed(1)}MB after downscaling, exceeds limit ${(maxBytes / (1024 * 1024)).toFixed(1)}MB`,
  );
}

export function createReadImageTool(context: ReadImageToolContext): AgentTool {
  return {
    name: "read_image",
    label: "Read image",
    description:
      `Read an image file from the workspace (${SUPPORTED_EXT_LIST}; .svg is rasterized to PNG before being sent to the model) and attach it directly to your context. ` +
      "Use this instead of `media` when you want to look at the image yourself rather than get a textual caption. " +
      "Workspace paths only — for URLs use `web_fetch` first. " +
      "Images already attached to the current user message are visible without calling any tool. " +
      "Subject to a per-model image-size limit (rejects oversized files; SVG rasterization is downscaled to fit when possible).",
    parameters: Type.Object({
      path: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { path: string };
      const absolute = resolveWorkspacePath(context.workspaceRoot, args.path);
      const relPath = workspaceRelative(context.workspaceRoot, absolute);

      const ext = path.extname(absolute).toLowerCase();
      const declaredMimeType = MIME_BY_EXT[ext];
      if (!declaredMimeType) {
        throw new Error(`Unsupported image format: ${ext || "(no extension)"}. Supported: ${SUPPORTED_EXT_LIST}`);
      }

      const info = await stat(absolute);
      if (!info.isFile()) {
        throw new Error(`Not a regular file: ${relPath}`);
      }
      const maxBytes = context.maxImageBytes;
      if (info.size > maxBytes) {
        throw new Error(
          `Image too large: ${(info.size / (1024 * 1024)).toFixed(1)}MB (limit: ${(maxBytes / (1024 * 1024)).toFixed(1)}MB)`,
        );
      }

      const raw = await readFile(absolute);

      let data: string;
      let mimeType: string;
      if (ext === ".svg") {
        const png = await rasterizeSvgToPng(raw, maxBytes, relPath);
        data = png.toString("base64");
        mimeType = "image/png";
      } else {
        data = raw.toString("base64");
        mimeType = declaredMimeType;
      }

      return {
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data, mimeType },
        ],
        details: { path: relPath, mimeType, sizeBytes: info.size },
      };
    },
  };
}
