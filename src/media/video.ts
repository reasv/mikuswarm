import { stat, unlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { VideoProcessingOptions, ProcessedMedia } from "./types.js";
import { MediaCache, hashFile } from "./cache.js";

type FfmpegCommand = (input?: string) => import("fluent-ffmpeg").FfmpegCommand;

let cachedFfmpeg: FfmpegCommand | null | undefined;
let ffmpegWarned = false;
let ffmpegLastFailure = 0;
const FFMPEG_RETRY_INTERVAL_MS = 60_000;
const FFMPEG_DEFAULT_TIMEOUT_MS = 600_000;
const cacheInstances = new Map<string, MediaCache>();

function getCache(cachePath: string): MediaCache {
  let cache = cacheInstances.get(cachePath);
  if (!cache) {
    cache = new MediaCache(cachePath);
    cacheInstances.set(cachePath, cache);
  }
  return cache;
}

export async function processVideoForInference(
  inputPath: string,
  options: VideoProcessingOptions,
): Promise<ProcessedMedia> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg is not available — cannot process video");
  }

  const probe = await probeMedia(ffmpeg, inputPath);
  if (probe.duration <= 0) {
    throw new Error("Could not determine media duration");
  }
  const totalDuration = probe.duration;
  const startTime = options.startTime ?? 0;
  const effectiveDuration = Math.min(
    options.maxDurationSeconds,
    Math.max(0, totalDuration - startTime),
  );
  if (effectiveDuration <= 0) {
    throw new Error(`start_time (${startTime}s) is at or beyond media duration (${totalDuration}s)`);
  }
  const truncated = (totalDuration - startTime) > options.maxDurationSeconds;

  const shouldCacheFull = totalDuration <= options.maxDurationSeconds * 2;

  if (shouldCacheFull) {
    const cache = getCache(options.cachePath);
    await cache.init();

    const cacheKey = `res=${options.maxResolution},gpu=${options.gpuAcceleration},preset=${options.x264Preset}`;
    const fileHash = await hashFile(inputPath, cacheKey);
    let convertedPath = await cache.get(fileHash);

    if (!convertedPath) {
      const tempEncoded = await encodeVideo(ffmpeg, inputPath, probe, options);
      convertedPath = await cache.put(fileHash, tempEncoded);
      await unlink(tempEncoded).catch(() => {});
      await cache.evictIfNeeded(options.cacheMaxBytes, options.cacheTargetBytes);
    }

    const segmentPath = join(tmpdir(), `miku-vid-seg-${randomBytes(8).toString("hex")}.mp4`);

    try {
      if (startTime > 0 || truncated) {
        await extractSegment(ffmpeg, convertedPath, segmentPath, startTime, effectiveDuration, options.timeoutMs);
      } else {
        await copyFile(convertedPath, segmentPath);
      }

      const segmentStat = await stat(segmentPath);
      if (segmentStat.size > options.maxBytes) {
        await unlink(segmentPath).catch(() => {});
        const reducedPath = await reencodeWithBitrate(ffmpeg, convertedPath, segmentPath, startTime, effectiveDuration, options.maxBytes, options.x264Preset, options.timeoutMs);
        const reducedStat = await stat(reducedPath);
        if (reducedStat.size > options.maxBytes) {
          console.warn(`[media] video re-encode still exceeds maxBytes: ${reducedStat.size} > ${options.maxBytes}`);
        }
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
    } catch (error) {
      await unlink(segmentPath).catch(() => {});
      throw error;
    }
  } else {
    const segmentPath = join(tmpdir(), `miku-vid-seg-${randomBytes(8).toString("hex")}.mp4`);
    try {
      await encodeVideoSegment(ffmpeg, inputPath, probe, options, startTime, effectiveDuration, segmentPath);

      const segmentStat = await stat(segmentPath);
      if (segmentStat.size > options.maxBytes) {
        await unlink(segmentPath).catch(() => {});
        const reducedPath = join(tmpdir(), `miku-vid-seg-${randomBytes(8).toString("hex")}.mp4`);
        try {
          await reencodeWithBitrate(ffmpeg, inputPath, reducedPath, startTime, effectiveDuration, options.maxBytes, options.x264Preset, options.timeoutMs);
        } catch (error) {
          await unlink(reducedPath).catch(() => {});
          throw error;
        }
        const reducedStat = await stat(reducedPath);
        if (reducedStat.size > options.maxBytes) {
          console.warn(`[media] video re-encode still exceeds maxBytes: ${reducedStat.size} > ${options.maxBytes}`);
        }
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
    } catch (error) {
      await unlink(segmentPath).catch(() => {});
      throw error;
    }
  }
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
  const preset = encoder === "libx264" ? ["-preset", options.x264Preset] : [];

  const timeout = options.timeoutMs ?? FFMPEG_DEFAULT_TIMEOUT_MS;
  try {
    await runFfmpeg(ffmpeg, inputPath, outPath, [
      "-c:v", encoder,
      ...preset,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-vf", scaleFilter,
      "-c:a", "aac",
      "-b:a", "128k",
    ], undefined, timeout);
    return outPath;
  } catch (error) {
    if (options.gpuAcceleration) {
      console.warn(`[media] GPU encoder failed, falling back to libx264: ${error instanceof Error ? error.message : error}`);
      await unlink(outPath).catch(() => {});
      await runFfmpeg(ffmpeg, inputPath, outPath, [
        "-c:v", "libx264",
        "-preset", options.x264Preset,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-vf", scaleFilter,
        "-c:a", "aac",
        "-b:a", "128k",
      ], undefined, timeout);
      return outPath;
    }
    throw error;
  }
}

async function encodeVideoSegment(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  probe: ProbeResult,
  options: VideoProcessingOptions,
  startTime: number,
  duration: number,
  outputPath: string,
): Promise<void> {
  const shortSide = Math.min(probe.width, probe.height);
  const needsScale = shortSide > options.maxResolution && shortSide > 0;

  const scaleFilter = needsScale
    ? probe.height <= probe.width
      ? `scale=-2:${options.maxResolution}`
      : `scale=${options.maxResolution}:-2`
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  const encoder = options.gpuAcceleration ? "h264_nvenc" : "libx264";
  const preset = encoder === "libx264" ? ["-preset", options.x264Preset] : [];

  const timeout = options.timeoutMs ?? FFMPEG_DEFAULT_TIMEOUT_MS;
  try {
    await runFfmpeg(ffmpeg, inputPath, outputPath, [
      "-t", String(duration),
      "-c:v", encoder,
      ...preset,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-vf", scaleFilter,
      "-c:a", "aac",
      "-b:a", "128k",
    ], startTime, timeout);
  } catch (error) {
    if (options.gpuAcceleration) {
      console.warn(`[media] GPU encoder failed, falling back to libx264: ${error instanceof Error ? error.message : error}`);
      await unlink(outputPath).catch(() => {});
      await runFfmpeg(ffmpeg, inputPath, outputPath, [
        "-t", String(duration),
        "-c:v", "libx264",
        "-preset", options.x264Preset,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-vf", scaleFilter,
        "-c:a", "aac",
        "-b:a", "128k",
      ], startTime, timeout);
    } else {
      throw error;
    }
  }
}

async function extractSegment(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  timeoutMs?: number,
): Promise<void> {
  await runFfmpeg(ffmpeg, inputPath, outputPath, [
    "-t", String(duration),
    "-c", "copy",
    "-movflags", "+faststart",
  ], startTime, timeoutMs ?? FFMPEG_DEFAULT_TIMEOUT_MS);
}

async function reencodeWithBitrate(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  maxBytes: number,
  x264Preset: string,
  timeoutMs?: number,
): Promise<string> {
  const targetBitrate = Math.floor((maxBytes * 8) / duration * 0.9);
  const videoBitrate = Math.max(100_000, targetBitrate - 128_000);

  await runFfmpeg(ffmpeg, inputPath, outputPath, [
    "-t", String(duration),
    "-c:v", "libx264",
    "-preset", x264Preset,
    "-b:v", String(videoBitrate),
    "-maxrate", String(Math.floor(videoBitrate * 1.5)),
    "-bufsize", String(videoBitrate * 2),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
  ], startTime, timeoutMs ?? FFMPEG_DEFAULT_TIMEOUT_MS);
  return outputPath;
}

function runFfmpeg(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  outputOptions: string[],
  seekInput?: number,
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cmd = ffmpeg(inputPath);
    if (seekInput != null && seekInput > 0) {
      cmd = (cmd as unknown as { seekInput(t: number): typeof cmd }).seekInput(seekInput);
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            (cmd as unknown as { kill(signal: string): void }).kill("SIGKILL");
            reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs)
      : undefined;
    cmd
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("end", () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(); } })
      .on("error", (err: Error) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(err); } })
      .run();
  });
}

async function loadFfmpeg(): Promise<FfmpegCommand | null> {
  if (cachedFfmpeg) return cachedFfmpeg;
  if (cachedFfmpeg === null && Date.now() - ffmpegLastFailure < FFMPEG_RETRY_INTERVAL_MS) {
    return null;
  }
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
      console.error("[media] ffmpeg not available — video processing disabled (will retry periodically)");
    }
    cachedFfmpeg = null;
    ffmpegLastFailure = Date.now();
    return null;
  }
}

export { probeMedia, loadFfmpeg };
