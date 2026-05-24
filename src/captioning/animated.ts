import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

let ffmpegWarned = false;
let cachedFfmpeg: FfmpegCommand | null | undefined;

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

type FfmpegCommand = (input?: string) => import("fluent-ffmpeg").FfmpegCommand;

async function loadFfmpeg(): Promise<FfmpegCommand | null> {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;

  try {
    const mod = await import("fluent-ffmpeg");
    const ff = (mod.default ?? mod) as unknown as FfmpegCommand;
    await new Promise<void>((resolve, reject) => {
      (ff as unknown as { getAvailableFormats: (cb: (err: Error | null, formats: unknown) => void) => void })
        .getAvailableFormats((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
    });
    cachedFfmpeg = ff;
    return ff;
  } catch {
    if (!ffmpegWarned) {
      ffmpegWarned = true;
      console.error("[captioning] ffmpeg not available — animated images will be captioned as static images");
    }
    cachedFfmpeg = null;
    return null;
  }
}
