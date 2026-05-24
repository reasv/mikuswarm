import { stat, unlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { VideoProcessingOptions, ProcessedMedia } from "./types.js";
import { MediaCache, hashFile } from "./cache.js";

type FfmpegCommand = (input?: string) => import("fluent-ffmpeg").FfmpegCommand;

let cachedFfmpeg: FfmpegCommand | null | undefined;
let ffmpegWarned = false;

export async function processVideoForInference(
  inputPath: string,
  options: VideoProcessingOptions,
): Promise<ProcessedMedia> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg is not available — cannot process video");
  }

  const probe = await probeMedia(ffmpeg, inputPath);
  const totalDuration = probe.duration;
  const startTime = options.startTime ?? 0;
  const effectiveDuration = Math.min(
    options.maxDurationSeconds,
    Math.max(0, totalDuration - startTime),
  );
  const truncated = (totalDuration - startTime) > options.maxDurationSeconds;

  const cache = new MediaCache(options.cachePath);
  await cache.init();

  const fileHash = await hashFile(inputPath);
  let convertedPath = await cache.get(fileHash);

  if (!convertedPath) {
    convertedPath = await encodeVideo(ffmpeg, inputPath, probe, options);
    await cache.put(fileHash, convertedPath);
    await unlink(convertedPath).catch(() => {});
    convertedPath = await cache.get(fileHash);
    if (!convertedPath) throw new Error("Cache write failed");
  }

  const segmentPath = join(tmpdir(), `miku-vid-seg-${randomBytes(8).toString("hex")}.mp4`);

  if (startTime > 0 || truncated) {
    await extractSegment(ffmpeg, convertedPath, segmentPath, startTime, effectiveDuration);
  } else {
    await copyFile(convertedPath, segmentPath);
  }

  const segmentStat = await stat(segmentPath);
  if (segmentStat.size > options.maxBytes) {
    await unlink(segmentPath).catch(() => {});
    const reducedPath = await reencodeWithBitrate(ffmpeg, convertedPath, segmentPath, startTime, effectiveDuration, options.maxBytes);
    const reducedStat = await stat(reducedPath);
    return {
      path: reducedPath,
      mimeType: "video/mp4",
      sizeBytes: reducedStat.size,
      truncated,
      processedRange: [startTime, startTime + effectiveDuration],
      totalDuration,
    };
  }

  return {
    path: segmentPath,
    mimeType: "video/mp4",
    sizeBytes: segmentStat.size,
    truncated,
    processedRange: [startTime, startTime + effectiveDuration],
    totalDuration,
  };
}

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
}

function probeMedia(ffmpeg: FfmpegCommand, inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    (ffmpeg as unknown as { ffprobe: (path: string, cb: (err: Error | null, data: unknown) => void) => void })
      .ffprobe(inputPath, (err: Error | null, data: unknown) => {
        if (err) { reject(err); return; }
        const d = data as { format?: { duration?: number }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> };
        const videoStream = d.streams?.find((s) => s.codec_type === "video");
        resolve({
          duration: d.format?.duration ?? 0,
          width: videoStream?.width ?? 0,
          height: videoStream?.height ?? 0,
        });
      });
  });
}

async function encodeVideo(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  probe: ProbeResult,
  options: VideoProcessingOptions,
): Promise<string> {
  const outPath = join(tmpdir(), `miku-vid-enc-${randomBytes(8).toString("hex")}.mp4`);
  const shortSide = Math.min(probe.width, probe.height);
  const needsScale = shortSide > options.maxResolution && shortSide > 0;

  const scaleFilter = needsScale
    ? probe.height <= probe.width
      ? `scale=-2:${options.maxResolution}`
      : `scale=${options.maxResolution}:-2`
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  const encoder = options.gpuAcceleration ? "h264_nvenc" : "libx264";

  try {
    await runFfmpeg(ffmpeg, inputPath, outPath, [
      "-c:v", encoder,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-vf", scaleFilter,
      "-c:a", "aac",
      "-b:a", "128k",
    ]);
    return outPath;
  } catch (error) {
    if (options.gpuAcceleration) {
      await unlink(outPath).catch(() => {});
      await runFfmpeg(ffmpeg, inputPath, outPath, [
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-vf", scaleFilter,
        "-c:a", "aac",
        "-b:a", "128k",
      ]);
      return outPath;
    }
    throw error;
  }
}

async function extractSegment(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
): Promise<void> {
  await runFfmpeg(ffmpeg, inputPath, outputPath, [
    "-ss", String(startTime),
    "-t", String(duration),
    "-c", "copy",
    "-movflags", "+faststart",
  ]);
}

async function reencodeWithBitrate(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  maxBytes: number,
): Promise<string> {
  const targetBitrate = Math.floor((maxBytes * 8) / duration * 0.9);
  const videoBitrate = Math.max(100_000, targetBitrate - 128_000);

  await runFfmpeg(ffmpeg, inputPath, outputPath, [
    "-ss", String(startTime),
    "-t", String(duration),
    "-c:v", "libx264",
    "-b:v", String(videoBitrate),
    "-maxrate", String(Math.floor(videoBitrate * 1.5)),
    "-bufsize", String(videoBitrate * 2),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
  ]);
  return outputPath;
}

function runFfmpeg(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  outputOptions: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

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
      console.error("[media] ffmpeg not available — video processing disabled");
    }
    cachedFfmpeg = null;
    return null;
  }
}

export { probeMedia, loadFfmpeg };
