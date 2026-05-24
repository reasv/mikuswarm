import { stat, unlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AudioProcessingOptions, ProcessedMedia } from "./types.js";
import { loadFfmpeg, probeMedia } from "./video.js";

export async function processAudioForInference(
  inputPath: string,
  options: AudioProcessingOptions,
): Promise<ProcessedMedia> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg is not available — cannot process audio");
  }

  const probe = await probeMedia(ffmpeg, inputPath);
  const totalDuration = probe.duration;
  const startTime = options.startTime ?? 0;
  const effectiveDuration = Math.min(
    options.maxDurationSeconds,
    Math.max(0, totalDuration - startTime),
  );
  const truncated = (totalDuration - startTime) > options.maxDurationSeconds;

  const outPath = join(tmpdir(), `miku-audio-${randomBytes(8).toString("hex")}.m4a`);

  const targetBitrate = computeBitrate(effectiveDuration, options.maxBytes);

  await runAudioEncode(ffmpeg, inputPath, outPath, startTime, effectiveDuration, targetBitrate);

  const outStat = await stat(outPath);
  if (outStat.size > options.maxBytes) {
    await unlink(outPath).catch(() => {});
    const reducedBitrate = computeBitrate(effectiveDuration, options.maxBytes * 0.85);
    await runAudioEncode(ffmpeg, inputPath, outPath, startTime, effectiveDuration, reducedBitrate);
  }

  const finalStat = await stat(outPath);
  return {
    path: outPath,
    mimeType: "audio/mp4",
    sizeBytes: finalStat.size,
    truncated,
    processedRange: [startTime, startTime + effectiveDuration],
    totalDuration,
  };
}

function computeBitrate(durationSeconds: number, maxBytes: number): number {
  return Math.max(32_000, Math.floor((maxBytes * 8) / durationSeconds * 0.9));
}

function runAudioEncode(
  ffmpeg: (input?: string) => import("fluent-ffmpeg").FfmpegCommand,
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  bitrate: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-ss", String(startTime),
        "-t", String(duration),
        "-c:a", "aac",
        "-b:a", String(bitrate),
        "-vn",
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}
