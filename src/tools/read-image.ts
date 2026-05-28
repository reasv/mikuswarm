import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { SVG_MAX_INPUT_PIXELS } from "../media/index.js";

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

function isPixelLimitError(error: unknown): boolean {
  // sharp throws an Error whose message includes "Input image exceeds pixel limit"
  // when libvips refuses to allocate the requested raster. There is no typed error
  // class for it, so we substring-match.
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("exceeds pixel limit");
}

/**
 * Rasterize an SVG buffer to PNG, downscaling if needed so the result fits under maxBytes.
 * Tries decreasing pixel density values until the output fits, then a final hard-cap resize.
 */
async function rasterizeSvgToPng(buffer: Buffer, maxBytes: number, relPath: string): Promise<Buffer> {
  // Try a sequence of decreasing densities. 144 is a good default for SVGs with CSS units;
  // halving roughly quarters the byte size each step.
  const densities = [144, 96, 72, 48];
  let pixelLimitHit = false;
  for (const density of densities) {
    let png: Buffer;
    try {
      png = await sharp(buffer, { density, limitInputPixels: SVG_MAX_INPUT_PIXELS }).png().toBuffer();
    } catch (error) {
      if (isPixelLimitError(error)) {
        // This density rendered too many pixels. Try the next (smaller) density
        // rather than failing outright — a lower density may still produce a
        // usable raster. Track that we hit the limit so the fallback clamps too.
        pixelLimitHit = true;
        continue;
      }
      // Malformed SVG (or other sharp failure) — surface a clean error rather than
      // leaking sharp's internal libvips message.
      throw new Error(`Failed to rasterize SVG ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (png.byteLength <= maxBytes) return png;
  }
  // Density chain produced output but none fit. Fall back to a fixed-width resize.
  let png: Buffer;
  try {
    png = await sharp(buffer, { density: 96, limitInputPixels: SVG_MAX_INPUT_PIXELS })
      .resize({ width: 1024, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (error) {
    if (isPixelLimitError(error) || pixelLimitHit) {
      throw new Error(
        `SVG ${relPath} is too complex to rasterize (exceeds ${SVG_MAX_INPUT_PIXELS / 1_000_000}MP pixel budget at every density)`,
      );
    }
    throw new Error(`Failed to rasterize SVG ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (png.byteLength <= maxBytes) return png;
  throw new Error(
    `Rasterized SVG ${relPath} is ${(png.byteLength / (1024 * 1024)).toFixed(1)}MB after downscaling, exceeds limit ${(maxBytes / (1024 * 1024)).toFixed(1)}MB`,
  );
}

/**
 * Identify the actual image format from the first few bytes of the file. Returns
 * the canonical MIME type or `null` if the bytes don't match any supported format.
 *
 * Mirrors `inferModalityFromMagicBytes` in `src/tools/media.ts` but returns the
 * specific image MIME (read_image needs the precise type, not just modality).
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf.subarray(0, 4).toString("ascii") === "GIF8" &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  // SVG: tolerate a UTF-8 BOM and leading whitespace, then look for "<".
  // The presence of "<svg" or "<?xml" both indicate SVG. We don't try to fully
  // validate — sharp/librsvg will reject non-SVG XML on rasterize.
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  if (i < buf.length && buf[i] === 0x3c /* '<' */) {
    const head = buf.subarray(i, Math.min(buf.length, i + 256)).toString("ascii").toLowerCase();
    if (head.startsWith("<svg") || head.includes("<svg")) return "image/svg+xml";
    if (head.startsWith("<?xml")) return "image/svg+xml";
  }
  return null;
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
      // Re-check after readFile: defends against the TOCTOU window between
      // stat() and readFile() where a controlled writer could grow the file.
      // The bound also matters because everything downstream (base64 inflate,
      // SVG rasterize) is sized off this buffer.
      if (raw.byteLength > maxBytes) {
        throw new Error(
          `Image too large: ${(raw.byteLength / (1024 * 1024)).toFixed(1)}MB (limit: ${(maxBytes / (1024 * 1024)).toFixed(1)}MB)`,
        );
      }

      // Sniff the magic bytes and confirm they agree with the extension-derived
      // MIME. Providers (Anthropic, OpenAI, etc.) reject images whose body
      // doesn't match the declared MIME with an opaque error; failing here gives
      // the agent an actionable diagnostic instead.
      const sniffedMimeType = sniffImageMime(raw);
      if (sniffedMimeType === null) {
        throw new Error(
          `Could not determine image format from file contents: ${relPath} (extension claims ${declaredMimeType})`,
        );
      }
      if (sniffedMimeType !== declaredMimeType) {
        throw new Error(
          `Image content does not match extension: ${relPath} has ${declaredMimeType} extension but bytes are ${sniffedMimeType}`,
        );
      }

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
