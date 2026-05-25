import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AudioProcessingOptions, ProcessedMedia } from "./types.js";
import { loadFfmpeg, probeMedia } from "./video.js";

const FFMPEG_DEFAULT_TIMEOUT_MS = 600_000;

export async function processAudioForInference(
  inputPath: string,
  options: AudioProcessingOptions,
): Promise<ProcessedMedia> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg is not available — cannot process audio");
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

  const outPath = join(tmpdir(), `miku-audio-${randomBytes(8).toString("hex")}.m4a`);
  const timeout = options.timeoutMs ?? FFMPEG_DEFAULT_TIMEOUT_MS;

  try {
    const targetBitrate = computeBitrate(effectiveDuration, options.maxBytes);
    await runAudioEncode(ffmpeg, inputPath, outPath, startTime, effectiveDuration, targetBitrate, timeout);

    const outStat = await stat(outPath);
    if (outStat.size > options.maxBytes) {
      await unlink(outPath).catch(() => {});
      const reducedBitrate = computeBitrate(effectiveDuration, options.maxBytes * 0.85);
      await runAudioEncode(ffmpeg, inputPath, outPath, startTime, effectiveDuration, reducedBitrate, timeout);
    }

    const finalStat = await stat(outPath);
    if (finalStat.size > options.maxBytes) {
      console.warn(`[media] audio re-encode still exceeds maxBytes: ${finalStat.size} > ${options.maxBytes}`);
    }
    return {
      path: outPath,
      mimeType: "audio/mp4",
      sizeBytes: finalStat.size,
      truncated,
      processedRange: [startTime, startTime + effectiveDuration],
      totalDuration,
    };
  } catch (error) {
    await unlink(outPath).catch(() => {});
    throw error;
  }
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
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cmd = ffmpeg(inputPath);
    if (startTime > 0) {
      cmd = (cmd as unknown as { seekInput(t: number): typeof cmd }).seekInput(startTime);
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        (cmd as unknown as { kill(signal: string): void }).kill("SIGKILL");
        reject(new Error(`ffmpeg audio encode timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    cmd
      .outputOptions([
        "-t", String(duration),
        "-c:a", "aac",
        "-b:a", String(bitrate),
        "-vn",
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } })
      .on("error", (err: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } })
      .run();
  });
}
