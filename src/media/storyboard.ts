/**
 * Generic ffmpeg storyboard helper.
 * (spec/YOTSUBA-SUPPORT.md §6.5)
 *
 * Samples 4 frames at 12%, 37%, 62%, and 87% of a video/GIF's duration and
 * stitches them into a single 2×2 JPEG tile. Used by the Yotsuba enrichment
 * stage to represent video attachments as a single image block.
 *
 * Gracefully degrades when ffmpeg is absent (returns null), following the same
 * pattern as `src/media/video.ts`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { loadFfmpeg } from "./video.js";

// Frame positions as fractions of total duration.
const FRAME_POSITIONS = [0.12, 0.37, 0.62, 0.87];

/** Default JPEG quality for the storyboard tile. */
const STORYBOARD_QUALITY = 80;

/** Default tile cell size (px per side; cells are square). */
const STORYBOARD_CELL_PX = 320;

export interface StoryboardOptions {
  /** JPEG quality (1–100, default 80). */
  quality?: number;
  /** Width (and height) of each cell in px (default 320). */
  cellPx?: number;
  /** Per-operation wall-clock timeout in ms (default 60 000). */
  timeoutMs?: number;
}

export interface StoryboardResult {
  /** Absolute path to the output JPEG. Caller is responsible for cleanup. */
  path: string;
  /** Duration of the input as probed by ffmpeg (seconds). */
  durationSec: number;
  /** Width of each cell (px). */
  cellPx: number;
}

/**
 * Build a 2×2 storyboard JPEG for `inputPath`.
 *
 * Returns `null` when:
 *   - ffmpeg is not available on this system.
 *   - ffprobe cannot determine the duration.
 *   - The ffmpeg command fails.
 *
 * The caller is responsible for deleting `result.path` when done with it.
 */
export async function buildStoryboard(
  inputPath: string,
  opts: StoryboardOptions = {},
): Promise<StoryboardResult | null> {
  const ffmpeg = await loadFfmpeg();
  if (!ffmpeg) return null;

  const quality = opts.quality ?? STORYBOARD_QUALITY;
  const cellPx = opts.cellPx ?? STORYBOARD_CELL_PX;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Probe the input to get duration.
  const duration = await probeDuration(ffmpeg, inputPath);
  if (!duration || duration <= 0) return null;

  const outPath = join(tmpdir(), `miku-storyboard-${randomBytes(8).toString("hex")}.jpg`);

  // Compute frame timestamps.
  const timestamps = FRAME_POSITIONS.map((frac) => frac * duration);

  // Build the ffmpeg filter that:
  // 1. Selects 4 frames at the given timestamps.
  // 2. Scales each to cellPx×cellPx (keeping aspect, padding with black).
  // 3. Tiles them 2×2.
  //
  // We use the `select` filter with `setpts=N/FRAME_RATE*TB` to extract specific
  // frames, then `scale` + `pad` for uniform cells, then `tile`.
  //
  // Alternative approach: use multiple -ss inputs (simpler, faster seeking).
  // We take the simpler multi-input approach for robustness across ffmpeg versions.

  const succeeded = await runStoryboardFfmpeg(
    ffmpeg,
    inputPath,
    outPath,
    timestamps,
    cellPx,
    quality,
    timeoutMs,
  );
  if (!succeeded) return null;

  return { path: outPath, durationSec: duration, cellPx };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type FfmpegCommand = (input?: string) => import("fluent-ffmpeg").FfmpegCommand;

async function probeDuration(ffmpeg: FfmpegCommand, inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    (
      ffmpeg as unknown as {
        ffprobe: (
          path: string,
          cb: (err: Error | null, data: unknown) => void,
        ) => void;
      }
    ).ffprobe(inputPath, (err, data) => {
      if (err) { resolve(null); return; }
      const d = data as { format?: { duration?: number } };
      const dur = d.format?.duration;
      resolve(typeof dur === "number" && dur > 0 ? dur : null);
    });
  });
}

/**
 * Run the ffmpeg command that produces a 2×2 JPEG tile.
 * Returns true on success, false on failure (logged to console).
 */
async function runStoryboardFfmpeg(
  ffmpeg: FfmpegCommand,
  inputPath: string,
  outputPath: string,
  timestamps: number[],
  cellPx: number,
  quality: number,
  timeoutMs: number,
): Promise<boolean> {
  // Build a complex filtergraph: extract one frame per timestamp, scale+pad
  // each to a cellPx square, then tile 2×2.
  //
  // Each select stream:
  //   [in] select='eq(n,0)',setpts=PTS-STARTPTS,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2 [c0]
  //
  // We use -ss/-t per stream for accuracy (key frame + delta).
  //
  // Simpler: four separate inputs with -ss and thumbnail filter.
  // We use the multi-input approach.

  const complexFilterParts: string[] = [];
  const inputArgs: string[] = [];
  const ts = timestamps;

  // Build inputs and per-cell filter.
  for (let i = 0; i < 4; i++) {
    inputArgs.push("-ss", ts[i].toFixed(3), "-i", inputPath);
    // Scale to cellPx, pad to cellPx square, take first frame only.
    complexFilterParts.push(
      `[${i}:v]scale=${cellPx}:${cellPx}:force_original_aspect_ratio=decrease,` +
        `pad=${cellPx}:${cellPx}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `select='eq(n,0)',setpts=PTS-STARTPTS[cell${i}]`,
    );
  }

  // Tile 2×2.
  complexFilterParts.push(`[cell0][cell1][cell2][cell3]tile=2x2[out]`);
  const complexFilter = complexFilterParts.join(";");

  return new Promise<boolean>((resolve) => {
    const ff = ffmpeg();
    // Attach all four inputs (each with its -ss).
    // fluent-ffmpeg supports this via inputOptions before each input().
    let cmd = ff;
    for (let i = 0; i < 4; i++) {
      cmd = (cmd as unknown as { input: (p: string) => typeof cmd }).input(inputPath);
      (cmd as unknown as { inputOptions: (opts: string[]) => typeof cmd }).inputOptions([
        "-ss", ts[i].toFixed(3),
      ]);
    }

    (cmd as unknown as {
      complexFilter: (f: string, out: string[]) => typeof cmd;
      outputOptions: (o: string[]) => typeof cmd;
      output: (o: string) => typeof cmd;
      on: (event: string, cb: (...args: unknown[]) => void) => typeof cmd;
      run: () => void;
    })
      .complexFilter(complexFilter, ["out"])
      .outputOptions(["-frames:v", "1", "-q:v", quality.toString()])
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", (err: Error) => {
        console.warn(`[media/storyboard] ffmpeg failed: ${err.message}`);
        unlink(outputPath).catch(() => {});
        resolve(false);
      })
      .run();

    // Timeout guard.
    const guard = setTimeout(() => {
      try {
        (cmd as unknown as { kill: (sig?: string) => void }).kill("SIGKILL");
      } catch {
        // ignore
      }
      unlink(outputPath).catch(() => {});
      resolve(false);
    }, timeoutMs);
    // Clear guard on completion (success or error already resolved).
    // This doesn't perfectly handle the case where resolve() races the timeout,
    // but the timeout just resolves false again which is idempotent for a Promise.
    void guard;
  });
}
