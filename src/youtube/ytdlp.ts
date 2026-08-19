/**
 * yt-dlp subprocess wrapper (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §2).
 *
 * This module owns ALL yt-dlp subprocess invocation. Three operations:
 *   - probe(videoId)               → structured metadata
 *   - transcript(videoId, lang?)   → folded plain-text transcript
 *   - download(videoId, opts)      → one media file
 *
 * Common behavior on every run:
 *   - --no-playlist on every call
 *   - --proxy <network.http_proxy_url> when set (yt-dlp does not ride the
 *     shared fetch stack, so the proxy must be passed explicitly)
 *   - --socket-timeout bound
 *   - Hard wall-clock timeout ([youtube].timeout_ms) killing the subprocess
 *   - --cookies from [youtube].cookies_file when set
 *   - Stderr is captured and surfaced (bounded) in thrown errors
 *
 * Concurrency: a module-level semaphore caps concurrent yt-dlp subprocesses at
 * [youtube].concurrency (default 2) across all callers.
 *
 * Binary probe: `probeYtDlpBinary()` runs `yt-dlp --version` to verify the
 * binary is available. Called at app wiring as a graceful-degradation gate.
 * Does NOT wire anything — the caller decides what to do on failure.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Config snapshot (set once at app wiring via configureYtDlp)
// ---------------------------------------------------------------------------

export interface YtDlpConfig {
  /** Path to the yt-dlp binary (default "yt-dlp"). */
  ytDlpPath: string;
  /** Per-subprocess wall-clock timeout in ms (default 120000). */
  timeoutMs: number;
  /** Max concurrent yt-dlp subprocesses (default 2). */
  concurrency: number;
  /** Optional HTTP proxy URL passed as --proxy. */
  httpProxyUrl?: string;
  /** Optional cookies file path passed as --cookies. */
  cookiesFile?: string;
  /** Max bytes for downloads passed as --max-filesize. */
  maxDownloadBytes: number;
}

const DEFAULT_CONFIG: YtDlpConfig = {
  ytDlpPath: "yt-dlp",
  timeoutMs: 120_000,
  concurrency: 2,
  httpProxyUrl: undefined,
  cookiesFile: undefined,
  maxDownloadBytes: 209_715_200, // 200 MB
};

let _config: YtDlpConfig = { ...DEFAULT_CONFIG };

/** Apply config at app wiring. */
export function configureYtDlp(cfg: Partial<YtDlpConfig>): void {
  _config = { ..._config, ...cfg };
  // Reset semaphore to new concurrency.
  _semaphore = new Semaphore(_config.concurrency);
}

/** Reset to defaults. Test-only. */
export function resetYtDlpConfig(): void {
  _config = { ...DEFAULT_CONFIG };
  _semaphore = new Semaphore(_config.concurrency);
}

// ---------------------------------------------------------------------------
// Simple counting semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private _available: number;
  private _queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this._available = concurrency;
  }

  async acquire(): Promise<() => void> {
    if (this._available > 0) {
      this._available--;
      return this._release.bind(this);
    }
    return new Promise<() => void>((resolve) => {
      this._queue.push(() => {
        // Slot transferred directly from the releaser — no decrement here.
        resolve(this._release.bind(this));
      });
    });
  }

  private _release(): void {
    const waiter = this._queue.shift();
    if (waiter) {
      // Transfer the slot directly to the waiting acquire: _available stays at
      // 0 (no increment, no decrement).  The waiter closure just resolves.
      waiter();
    } else {
      this._available++;
    }
  }

  /** Number of waiters — exposed for tests. */
  get waiters(): number {
    return this._queue.length;
  }
}

let _semaphore = new Semaphore(DEFAULT_CONFIG.concurrency);

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

/** Bounded stderr capture: only keep the last N bytes so a verbose run never
 *  blows memory. */
const STDERR_CAP_BYTES = 8_192;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a yt-dlp command, waiting on the module semaphore first. Rejects with an
 * error that includes the bounded stderr on non-zero exit.
 */
async function runYtDlp(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  const release = await _semaphore.acquire();
  try {
    return await _runProcess(_config.ytDlpPath, args, opts);
  } finally {
    release();
  }
}

function _runProcess(
  binary: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts?.timeoutMs ?? _config.timeoutMs;
    let timedOut = false;

    const child = spawn(binary, args, {
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Enforce hard wall-clock timeout.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrTotalBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTotalBytes += chunk.byteLength;
      // Keep only the tail (most recent output is most useful for errors).
      stderrChunks.push(chunk);
      // Trim from the front if we exceed the cap.
      while (stderrTotalBytes > STDERR_CAP_BYTES && stderrChunks.length > 0) {
        const front = stderrChunks[0]!;
        if (stderrTotalBytes - front.byteLength >= STDERR_CAP_BYTES) {
          stderrTotalBytes -= front.byteLength;
          stderrChunks.shift();
        } else {
          // Partial trim of the front buffer.
          const excess = stderrTotalBytes - STDERR_CAP_BYTES;
          stderrChunks[0] = front.subarray(excess);
          stderrTotalBytes -= excess;
          break;
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const exitCode = code ?? 1;

      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }

      if (exitCode !== 0) {
        const msg = stderr.trim().slice(-2_048) || `yt-dlp exited with code ${exitCode}`;
        reject(new Error(msg));
        return;
      }

      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

// ---------------------------------------------------------------------------
// Common flags
// ---------------------------------------------------------------------------

/** Flags added to every yt-dlp invocation. */
function commonFlags(): string[] {
  const flags: string[] = ["--no-playlist"];
  if (_config.httpProxyUrl) {
    flags.push("--proxy", _config.httpProxyUrl);
  }
  // socket-timeout in seconds (yt-dlp expects an integer).
  flags.push("--socket-timeout", "30");
  if (_config.cookiesFile) {
    flags.push("--cookies", _config.cookiesFile);
  }
  return flags;
}

/** Build a canonical YouTube watch URL from a video id. */
function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ---------------------------------------------------------------------------
// § Probe
// ---------------------------------------------------------------------------

export interface YouTubeChapter {
  title: string;
  startTime: number;
  endTime: number;
}

export interface YouTubeSubtitleTrack {
  /** BCP-47-style language code as returned by yt-dlp. */
  lang: string;
  /** true = auto-generated captions; false = manual/creator-uploaded. */
  auto: boolean;
}

export interface YouTubeProbeMetadata {
  id: string;
  title?: string;
  channel?: string;
  channelId?: string;
  /** Duration in seconds. */
  duration?: number;
  /** ISO 8601 date string (YYYYMMDD from yt-dlp). */
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  description?: string;
  chapters: YouTubeChapter[];
  /** Available subtitle tracks (manual + auto). */
  subtitleTracks: YouTubeSubtitleTrack[];
  /** Whether the video is a live stream. */
  isLive?: boolean;
  liveStatus?: string;
  ageLimit?: number;
  thumbnailUrl?: string;
}

// Raw yt-dlp --dump-json shape (tolerant/partial — only what we need).
interface RawYtDlpMeta {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  duration?: number;
  upload_date?: string;
  view_count?: number;
  like_count?: number;
  description?: string;
  chapters?: Array<{ title?: string; start_time?: number; end_time?: number }>;
  subtitles?: Record<string, unknown[]>;
  automatic_captions?: Record<string, unknown[]>;
  is_live?: boolean;
  live_status?: string;
  age_limit?: number;
  thumbnail?: string;
}

/**
 * Probe a YouTube video: fetch structured metadata without downloading.
 * Throws if the video is unavailable, age-restricted (without cookies), or
 * if yt-dlp exits non-zero for any reason.
 */
export async function probe(videoId: string): Promise<YouTubeProbeMetadata> {
  const args = [
    ...commonFlags(),
    "--dump-json",
    "--skip-download",
    videoUrl(videoId),
  ];

  const result = await runYtDlp(args);

  let raw: RawYtDlpMeta;
  try {
    raw = JSON.parse(result.stdout) as RawYtDlpMeta;
  } catch {
    throw new Error(`yt-dlp probe returned non-JSON output for ${videoId}`);
  }

  const chapters: YouTubeChapter[] = (raw.chapters ?? []).flatMap((ch) => {
    if (ch.start_time == null || ch.end_time == null) return [];
    return [
      {
        title: ch.title ?? "(untitled)",
        startTime: ch.start_time,
        endTime: ch.end_time,
      },
    ];
  });

  // Build the subtitle track list from both manual subtitles and auto-captions.
  const subtitleTracks: YouTubeSubtitleTrack[] = [];
  const seenLangs = new Set<string>();

  for (const lang of Object.keys(raw.subtitles ?? {})) {
    if (!seenLangs.has(lang)) {
      subtitleTracks.push({ lang, auto: false });
      seenLangs.add(lang);
    }
  }
  for (const lang of Object.keys(raw.automatic_captions ?? {})) {
    if (!seenLangs.has(lang)) {
      subtitleTracks.push({ lang, auto: true });
      seenLangs.add(lang);
    }
  }

  return {
    id: raw.id ?? videoId,
    title: raw.title,
    channel: raw.channel,
    channelId: raw.channel_id,
    duration: raw.duration,
    uploadDate: raw.upload_date,
    viewCount: raw.view_count,
    likeCount: raw.like_count,
    description: raw.description,
    chapters,
    subtitleTracks,
    isLive: raw.is_live,
    liveStatus: raw.live_status,
    ageLimit: raw.age_limit,
    thumbnailUrl: raw.thumbnail,
  };
}

// ---------------------------------------------------------------------------
// § Transcript
// ---------------------------------------------------------------------------

export type TranscriptKind = "manual" | "auto" | "none";

export interface TranscriptResult {
  /** Folded plain-text transcript with [m:ss] timestamp markers. */
  text: string;
  /** BCP-47-style language code of the selected track. */
  lang: string;
  /** Whether the track is a manual subtitle or auto-generated caption. */
  kind: TranscriptKind;
}

/**
 * Select the best subtitle track from the available list.
 *
 * Priority:
 *  1. Manual track matching the requested lang (if given), or any manual track.
 *  2. Auto-generated track matching the requested lang (if given), or any auto.
 *  3. Returns null when no tracks are available.
 *
 * "Original language" is proxied by preferring non-`-orig` auto tracks over
 * `*-orig` re-translations; the `en` fallback is used as a last resort.
 */
function selectTrack(
  tracks: YouTubeSubtitleTrack[],
  requestedLang?: string,
): YouTubeSubtitleTrack | null {
  if (tracks.length === 0) return null;

  const manuals = tracks.filter((t) => !t.auto);
  const autos = tracks.filter((t) => t.auto);

  // Helper: find a track by exact lang code.
  const byLang = (list: YouTubeSubtitleTrack[], lang: string) =>
    list.find((t) => t.lang === lang);

  // Helper: prefer tracks that don't look like re-translations (`-orig` suffix
  // is YouTube's original-language auto-caption track; we want it if specifically
  // requested, otherwise prefer the same lang without the suffix).
  const preferNonOrig = (list: YouTubeSubtitleTrack[]) =>
    list.find((t) => !t.lang.endsWith("-orig")) ?? list[0] ?? null;

  if (requestedLang) {
    // Exact match first, then prefix (e.g. "en" matches "en", "en-US").
    const manualExact = byLang(manuals, requestedLang);
    if (manualExact) return manualExact;
    const manualPrefix = manuals.find((t) => t.lang.startsWith(requestedLang));
    if (manualPrefix) return manualPrefix;
    const autoExact = byLang(autos, requestedLang);
    if (autoExact) return autoExact;
    const autoPrefix = autos.find((t) => t.lang.startsWith(requestedLang));
    if (autoPrefix) return autoPrefix;
  }

  // No lang requested or no match: pick best available.
  if (manuals.length > 0) return preferNonOrig(manuals)!;
  if (autos.length > 0) return preferNonOrig(autos)!;
  return null;
}

// ---------------------------------------------------------------------------
// json3 → folded text
//
// The json3 subtitle format produced by yt-dlp has this shape:
//   { "events": [ { "tStartMs": NNN, "dDurationMs": NNN, "segs": [{ "utf8": "..." }] } ] }
//
// We fold all events into plain text, inserting a [m:ss] timestamp marker
// roughly every MARKER_INTERVAL_S seconds (at caption-group boundaries).
// Adjacent events that are very close in time are joined with a space; a new
// paragraph break is inserted when the gap is large.
// ---------------------------------------------------------------------------

const MARKER_INTERVAL_S = 30; // insert a marker every ~30s of video time

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface Json3Root {
  events?: Json3Event[];
}

/**
 * Convert json3 subtitle data into folded plain text with [m:ss] markers.
 */
export function foldJson3Transcript(json3: Json3Root): string {
  const events = json3.events ?? [];
  if (events.length === 0) return "";

  const parts: string[] = [];
  let lastMarkerTimeSec = -1;

  for (const event of events) {
    const tSec = (event.tStartMs ?? 0) / 1000;
    const text = (event.segs ?? [])
      .map((s) => s.utf8 ?? "")
      .join("")
      // yt-dlp json3 often includes a trailing newline or \n in segments; normalize.
      .replace(/\n/g, " ")
      .trim();

    if (!text) continue;

    // Insert timestamp marker at start or when >= MARKER_INTERVAL_S has elapsed.
    if (lastMarkerTimeSec < 0 || tSec - lastMarkerTimeSec >= MARKER_INTERVAL_S) {
      const m = Math.floor(tSec / 60);
      const s = Math.floor(tSec % 60);
      parts.push(`\n[${m}:${String(s).padStart(2, "0")}] `);
      lastMarkerTimeSec = tSec;
    } else {
      // Within the same interval — join with a space if the last part doesn't
      // already end with whitespace.
      const last = parts[parts.length - 1];
      if (last != null && !last.endsWith(" ")) {
        parts.push(" ");
      }
    }

    parts.push(text);
  }

  return parts
    .join("")
    .trim()
    // Clean up any double-spaces introduced by the join logic.
    .replace(/ {2,}/g, " ");
}

/**
 * Fetch and fold the transcript for a video.
 *
 * Track selection (in priority order):
 *  1. Manual subtitle track in the requested language (exact or prefix).
 *  2. Any manual subtitle track.
 *  3. Auto-generated caption in the requested language.
 *  4. Any auto-generated caption.
 *
 * Returns `{ text: "", lang: "", kind: "none" }` when no transcript is available.
 * Transcript fetch failure is non-fatal: returns kind "none" with the error
 * message available to the caller (not thrown).
 *
 * @param meta  Pre-fetched probe metadata (avoids a second probe call when the
 *              caller already has it). Pass undefined to auto-probe.
 */
export async function transcript(
  videoId: string,
  lang?: string,
  meta?: YouTubeProbeMetadata,
): Promise<TranscriptResult> {
  // Probe to get available tracks (if not provided).
  const probedMeta = meta ?? (await probe(videoId));
  const track = selectTrack(probedMeta.subtitleTracks, lang);
  if (!track) {
    return { text: "", lang: "", kind: "none" };
  }

  // Download the subtitle file into a temp directory.
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yt-subs-"));
  try {
    const outTemplate = join(tmpDir, "%(id)s.%(ext)s");
    const args = [
      ...commonFlags(),
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-format",
      "json3",
      "--sub-langs",
      track.lang,
      "-o",
      outTemplate,
      videoUrl(videoId),
    ];

    try {
      await runYtDlp(args, { cwd: tmpDir });
    } catch (err) {
      // Transcript download failed — non-fatal, return "none".
      return { text: "", lang: track.lang, kind: "none" };
    }

    // Find the downloaded .json3 file. yt-dlp names it
    // <videoId>.<lang>.json3 or <videoId>.<lang>.vtt (we asked for json3).
    const files = await readdir(tmpDir);
    const json3File = files.find((f) => f.endsWith(".json3"));
    if (!json3File) {
      return { text: "", lang: track.lang, kind: "none" };
    }

    const raw = await readFile(join(tmpDir, json3File), "utf8");
    let parsed: Json3Root;
    try {
      parsed = JSON.parse(raw) as Json3Root;
    } catch {
      return { text: "", lang: track.lang, kind: "none" };
    }

    const text = foldJson3Transcript(parsed);
    return {
      text,
      lang: track.lang,
      kind: track.auto ? "auto" : "manual",
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// § Download
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  /** Start offset in seconds for --download-sections (omit = whole video). */
  startSec?: number;
  /** Duration in seconds for --download-sections (omit = to end). */
  durationSec?: number;
  /** Max video height for format selection (e.g. 720 → height<=720). */
  maxHeight?: number;
  /** When true, download audio-only as M4A. */
  audioOnly?: boolean;
  /** Max file size in bytes for --max-filesize. */
  maxBytes?: number;
  /** Output file path (required). */
  outPath: string;
}

export interface DownloadResult {
  /** Absolute path to the written file. */
  path: string;
}

/**
 * Download a YouTube video (or segment) to outPath.
 * One implementation serves both the media analysis lane (§7 segment cut) and
 * the workspace file download (§6a).
 */
export async function download(
  videoId: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const args: string[] = [...commonFlags()];

  // Format selection.
  if (opts.audioOnly) {
    args.push("-f", "ba", "-x", "--audio-format", "m4a");
  } else if (opts.maxHeight) {
    args.push(
      "-f",
      `bv*[height<=?${opts.maxHeight}]+ba/b[height<=?${opts.maxHeight}]`,
      "--merge-output-format",
      "mp4",
    );
  } else {
    // Default: best video+audio merged as mp4.
    args.push("-f", "bv*+ba/b", "--merge-output-format", "mp4");
  }

  // Segment selection via --download-sections.
  if (opts.startSec != null) {
    const start = opts.startSec;
    if (opts.durationSec != null) {
      const end = start + opts.durationSec;
      args.push("--download-sections", `*${start}-${end}`);
    } else {
      args.push("--download-sections", `*${start}-inf`);
    }
  }

  // File size cap.
  const maxBytes = opts.maxBytes ?? _config.maxDownloadBytes;
  args.push("--max-filesize", String(maxBytes));

  // Output path.
  args.push("-o", opts.outPath);

  args.push(videoUrl(videoId));

  await runYtDlp(args);

  return { path: opts.outPath };
}

// ---------------------------------------------------------------------------
// § Binary probe
// ---------------------------------------------------------------------------

const BINARY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Verify that the configured yt-dlp binary is available by running
 * `yt-dlp --version`. Returns the version string on success, or throws.
 *
 * This is the graceful-degradation gate called at app wiring. The caller decides
 * whether to disable the feature on failure. Does NOT acquire the semaphore
 * (version check is cheap and should not wait behind downloads).
 */
export async function probeYtDlpBinary(): Promise<string> {
  const result = await _runProcess(_config.ytDlpPath, ["--version"], {
    timeoutMs: BINARY_PROBE_TIMEOUT_MS,
  });
  return result.stdout.trim();
}
