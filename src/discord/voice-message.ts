/**
 * Discord voice message encoding utilities (spec §12.4).
 *
 * Discord's voice message format requires:
 *   - Ogg/Opus audio (Discord enforces Opus codec)
 *   - Single attachment, message flag IS_VOICE_MESSAGE (8192), empty text content
 *   - Attachment metadata: `duration_secs` (float) and `waveform` (base64)
 *
 * The waveform is a Uint8Array of ≤256 bytes where each byte is a normalized
 * peak amplitude sample (0–255) downsampled from the full PCM track.
 *
 * Pipeline (two ffmpeg passes, both run sequentially):
 *   Pass 1: transcode input → ogg/opus for sending (written to temp file).
 *   Pass 2: decode input → raw s16le PCM mono 48 kHz → waveform computation.
 */

import { readFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadFfmpeg, probeMedia } from "../media/video.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of peak samples in the waveform sent to Discord (≤ 256). */
export const WAVEFORM_SAMPLE_COUNT = 256;
/** Maximum voice message duration that Discord accepts (10 minutes). */
const MAX_VOICE_DURATION_SECS = 600;
/** Per-ffmpeg-pass timeout (10 minutes). */
const FFMPEG_TIMEOUT_MS = 600_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceMessageEncodeResult {
  /** Absolute path to the encoded ogg/opus file. Caller must delete after send. */
  outputPath: string;
  /** Duration in seconds (from probing the input). */
  durationSecs: number;
  /** Base64-encoded waveform (≤256 bytes). */
  waveformBase64: string;
}

// ── Main encode function ──────────────────────────────────────────────────────

/**
 * Transcode `inputPath` to ogg/opus and compute a waveform.
 *
 * Returns VoiceMessageEncodeResult. The caller must delete `outputPath` after
 * the attachment has been sent to Discord.
 *
 * @throws When ffmpeg is unavailable or the input cannot be decoded.
 */
export async function encodeVoiceMessage(inputPath: string): Promise<VoiceMessageEncodeResult> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg is not available — cannot encode voice message");
  }

  // Probe duration.
  const probe = await probeMedia(ffmpeg, inputPath);
  if (probe.duration <= 0) {
    throw new Error("Could not determine audio duration for voice message");
  }
  const durationSecs = Math.min(probe.duration, MAX_VOICE_DURATION_SECS);

  const outputPath = join(tmpdir(), `miku-voice-${randomBytes(8).toString("hex")}.ogg`);
  const pcmPath = join(tmpdir(), `miku-voice-pcm-${randomBytes(8).toString("hex")}.raw`);

  try {
    // Pass 1: encode to ogg/opus
    await runFfmpegToFile(ffmpeg, inputPath, outputPath, [
      "-t", String(durationSecs),
      "-c:a", "libopus",
      "-b:a", "48k",
      "-vn",
    ], FFMPEG_TIMEOUT_MS);

    // Pass 2: decode to raw s16le mono PCM for waveform.
    // On any failure here, also unlink the ogg file written by Pass 1 — the
    // caller never sees outputPath (we throw before returning it) so it cannot
    // clean it up itself.
    try {
      await runFfmpegToFile(ffmpeg, inputPath, pcmPath, [
        "-t", String(durationSecs),
        "-ac", "1",
        "-ar", "48000",
        "-f", "s16le",
        "-vn",
      ], FFMPEG_TIMEOUT_MS);

      const pcmBytes = await readFile(pcmPath);
      const waveformBase64 = computeWaveformBase64(pcmBytes, WAVEFORM_SAMPLE_COUNT);

      return { outputPath, durationSecs, waveformBase64 };
    } catch (err) {
      await unlink(outputPath).catch(() => {});
      throw err;
    }
  } finally {
    await unlink(pcmPath).catch(() => {});
  }
}

// ── Pure waveform computation ─────────────────────────────────────────────────

/**
 * Compute a downsampled peak-amplitude waveform from raw s16le PCM samples.
 *
 * Algorithm:
 *   1. Divide the sample buffer into `targetSamples` equal-width chunks.
 *   2. For each chunk, find the peak absolute sample value.
 *   3. Normalize all peaks so the global maximum maps to 255.
 *
 * Returns a Buffer of `targetSamples` bytes (each 0–255).
 *
 * Pure function — exported for unit testing without ffmpeg.
 *
 * @param pcmBytes - Raw signed 16-bit little-endian mono PCM samples.
 * @param targetSamples - Number of output waveform bytes (≤ 256).
 */
export function computeWaveform(pcmBytes: Buffer, targetSamples: number): Buffer {
  const clampedTarget = Math.max(1, Math.min(targetSamples, 256));
  if (pcmBytes.length === 0) {
    return Buffer.alloc(clampedTarget, 0);
  }

  // Interpret bytes as signed 16-bit LE samples.
  const totalSamples = Math.floor(pcmBytes.length / 2);
  if (totalSamples === 0) {
    return Buffer.alloc(clampedTarget, 0);
  }

  const count = Math.min(clampedTarget, totalSamples);
  const rawPeaks = new Float64Array(count); // absolute peak per chunk (0–32767)
  let globalMax = 0;

  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * totalSamples) / count);
    const end = Math.floor(((i + 1) * totalSamples) / count);
    let peak = 0;
    for (let j = start; j < end; j++) {
      // Read s16le sample: byteOffset j*2 + 1 is the high byte
      const lo = pcmBytes[j * 2]!;
      const hi = pcmBytes[j * 2 + 1]!;
      let val = (hi << 8) | lo;
      // Sign-extend 16-bit to JS number
      if (val >= 0x8000) val -= 0x10000;
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
    }
    rawPeaks[i] = peak;
    if (peak > globalMax) globalMax = peak;
  }

  const result = Buffer.allocUnsafe(count);
  if (globalMax === 0) {
    result.fill(0);
  } else {
    for (let i = 0; i < count; i++) {
      result[i] = Math.round((rawPeaks[i]! / globalMax) * 255);
    }
  }
  return result;
}

/** Compute waveform and return as a base64 string. */
export function computeWaveformBase64(pcmBytes: Buffer, targetSamples: number): string {
  return computeWaveform(pcmBytes, targetSamples).toString("base64");
}

// ── ffmpeg helper ─────────────────────────────────────────────────────────────

/** Run ffmpeg with the given output options, writing to a file path. */
function runFfmpegToFile(
  ffmpeg: (input?: string) => import("fluent-ffmpeg").FfmpegCommand,
  inputPath: string,
  outputPath: string,
  outputOptions: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cmd = ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on("end", () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      })
      .on("error", (err: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        (cmd as unknown as { kill(signal: string): void }).kill("SIGKILL");
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    cmd.run();
  });
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────

/** Delete the temporary ogg file after it has been sent to Discord. */
export async function cleanupVoiceFile(outputPath: string): Promise<void> {
  await unlink(outputPath).catch(() => {});
}

/** Returns true if the output file from encodeVoiceMessage still exists. */
export async function voiceFileExists(outputPath: string): Promise<boolean> {
  try { await stat(outputPath); return true; } catch { return false; }
}
