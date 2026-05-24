import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { loadFfmpeg } from "../media/video.js";

export async function isAnimatedImage(filePath: string): Promise<boolean> {
  try {
    const metadata = await sharp(filePath).metadata();
    return (metadata.pages ?? 1) > 1;
  } catch {
    return false;
  }
}

export interface ConversionResult {
  path: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

export async function convertAnimatedToVideo(filePath: string): Promise<ConversionResult | null> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) return null;

  const outPath = join(tmpdir(), `miku-animated-${randomBytes(8).toString("hex")}.mp4`);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(filePath)
        .outputOptions([
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          "-an",
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        ])
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    return {
      path: outPath,
      mimeType: "video/mp4",
      cleanup: async () => { await unlink(outPath).catch(() => {}); },
    };
  } catch {
    await unlink(outPath).catch(() => {});
    return null;
  }
}

export async function extractFirstFrame(filePath: string): Promise<Buffer> {
  return sharp(filePath, { page: 0 })
    .jpeg({ quality: 85 })
    .toBuffer();
}
