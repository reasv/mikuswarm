import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import type { ImageProcessingOptions, ProcessedMedia } from "./types.js";

export async function processImageForInference(
  inputPath: string,
  options: ImageProcessingOptions,
): Promise<ProcessedMedia> {
  const metadata = await sharp(inputPath).metadata();
  const origWidth = metadata.width ?? 1;
  const origHeight = metadata.height ?? 1;

  const { width, height } = computeTargetDimensions(origWidth, origHeight, options);

  const useMozjpeg = options.mozjpeg;
  const result = await compressToFit(inputPath, width, height, options.maxBytes, useMozjpeg);
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

  const fallback = await sharp(inputPath)
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
  inputPath: string,
  targetWidth: number,
  targetHeight: number,
  maxBytes: number,
  mozjpeg: boolean,
): Promise<Buffer | undefined> {
  let width = targetWidth;
  let height = targetHeight;

  for (;;) {
    for (const quality of [82, 72, 62, 52, 42, 35]) {
      const output = await sharp(inputPath)
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
