import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import type { ImageProcessingOptions, ProcessedMedia } from "./types.js";

/**
 * Cap on pixels sharp will materialize for any single decode. 25 MP is large
 * enough for any reasonable photo/screenshot/diagram but small enough to keep
 * worst-case allocation bounded across the iterative compression loop.
 *
 * Specifically relevant for SVG input: librsvg honors `limitInputPixels`, so a
 * crafted `<viewBox="0 0 16000 16000">` does not balloon into a ~1 GP raster.
 * Sharp's own default (`Math.pow(0x3FFF, 2)` ≈ 268 MP) only catches truly
 * extreme inputs.
 *
 * Shared with `src/tools/read-image.ts` so the SVG rasterization budget is
 * uniform across captioning and the `read_image` tool.
 */
export const SVG_MAX_INPUT_PIXELS = 25_000_000;

export async function processImageForInference(
  inputPath: string,
  options: ImageProcessingOptions,
): Promise<ProcessedMedia> {
  // Read the file into a buffer up front and pass the buffer (not the path)
  // to every sharp call. This is intentional: when sharp receives a file path
  // for an SVG, librsvg uses the file's location as a base URI and the
  // sibling rule allows `<image xlink:href="other.png"/>` to load another
  // file in the same directory (e.g. another attachment in `msg-attach/`).
  // Buffer mode has no base URI, so librsvg blocks every scheme except
  // `data:`, closing that exfiltration channel. The single read also
  // replaces what was previously three independent reads of the same file.
  const buffer = await readFile(inputPath);

  const metadata = await sharp(buffer, { limitInputPixels: SVG_MAX_INPUT_PIXELS }).metadata();
  const origWidth = metadata.width ?? 1;
  const origHeight = metadata.height ?? 1;

  const { width, height } = computeTargetDimensions(origWidth, origHeight, options);

  const useMozjpeg = options.mozjpeg;
  const result = await compressToFit(buffer, width, height, options.maxBytes, useMozjpeg);
  if (result) {
    const tmpPath = join(tmpdir(), `miku-img-${randomBytes(8).toString("hex")}.jpg`);
    await writeFile(tmpPath, result);
    return {
      path: tmpPath,
      mimeType: "image/jpeg",
      sizeBytes: result.byteLength,
      truncated: false,
    };
  }

  const fallback = await sharp(buffer, { limitInputPixels: SVG_MAX_INPUT_PIXELS })
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 60, mozjpeg: useMozjpeg })
    .toBuffer();
  const tmpPath = join(tmpdir(), `miku-img-${randomBytes(8).toString("hex")}.jpg`);
  await writeFile(tmpPath, fallback);
  return {
    path: tmpPath,
    mimeType: "image/jpeg",
    sizeBytes: fallback.byteLength,
    truncated: false,
  };
}

export function computeTargetDimensions(
  origWidth: number,
  origHeight: number,
  options: ImageProcessingOptions,
): { width: number; height: number } {
  const origPixels = origWidth * origHeight;
  let width = origWidth;
  let height = origHeight;

  if (origPixels > options.maxTotalPixels) {
    const scale = Math.sqrt(options.maxTotalPixels / origPixels);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const shortestSide = Math.min(width, height);
  if (shortestSide < options.minShortestSide && Math.min(origWidth, origHeight) >= options.minShortestSide) {
    const boostScale = options.minShortestSide / shortestSide;
    width = Math.round(width * boostScale);
    height = Math.round(height * boostScale);

    if (width * height > options.maxTotalPixelsHard) {
      const clampScale = Math.sqrt(options.maxTotalPixelsHard / (width * height));
      width = Math.round(width * clampScale);
      height = Math.round(height * clampScale);
    }
  }

  return { width: Math.max(width, 1), height: Math.max(height, 1) };
}

async function compressToFit(
  input: Buffer,
  targetWidth: number,
  targetHeight: number,
  maxBytes: number,
  mozjpeg: boolean,
): Promise<Buffer | undefined> {
  let width = targetWidth;
  let height = targetHeight;

  for (;;) {
    for (const quality of [82, 72, 62, 52, 42, 35]) {
      const output = await sharp(input, { limitInputPixels: SVG_MAX_INPUT_PIXELS })
        .resize({
          width: Math.round(width),
          height: Math.round(height),
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg })
        .toBuffer();
      if (output.byteLength <= maxBytes) {
        return output;
      }
    }
    if (width <= 1 || height <= 1) break;
    width *= 0.75;
    height *= 0.75;
    width = Math.max(width, 1);
    height = Math.max(height, 1);
  }

  return undefined;
}

export async function cleanupProcessedImage(result: ProcessedMedia): Promise<void> {
  await unlink(result.path).catch(() => {});
}
