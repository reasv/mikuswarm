/**
 * YouTube video URL detection and parsing (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §4).
 *
 * Recognized forms (http/https, with/without www./m./music.):
 *   youtube.com/watch?v=<id>   (+ t=/start= → startSec)
 *   youtu.be/<id>              (+ t=)
 *   youtube.com/shorts/<id>
 *   youtube.com/live/<id>
 *   youtube.com/embed/<id>
 *
 * <id> is the canonical 11-char [A-Za-z0-9_-] video id.
 * Everything else (channel, playlist, search, @handles) → null.
 *
 * startSec parsing: YouTube uses both plain-integer seconds (`t=NNN`) and the
 * compact `t=1h2m3s` / `t=2m30s` / `t=45s` form. Both are parsed. The `start=`
 * alias is also recognized (used by some embeds). Fractional seconds are
 * truncated to integers (YouTube's own player does the same).
 */

/** Base domains recognized as YouTube hosts (no subdomains yet). */
const YOUTUBE_BASE_HOSTS: readonly string[] = ["youtube.com", "youtu.be"];

/**
 * True when `hostname` is one of the base YouTube hosts or a recognized
 * subdomain (`www.`, `m.`, `music.`). Intentionally restrictive: we only
 * admit well-known subdomain prefixes rather than arbitrary subdomains, because
 * YouTube does not publish arbitrary subdomains as canonical playback URLs.
 */
function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Exact match.
  if (YOUTUBE_BASE_HOSTS.includes(h)) return true;
  // Recognized subdomain prefixes.
  for (const base of YOUTUBE_BASE_HOSTS) {
    if (h === `www.${base}` || h === `m.${base}` || h === `music.${base}`) {
      return true;
    }
  }
  return false;
}

/** True for the short-link host (youtu.be), which uses a different path form. */
function isShortHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "youtu.be" || h === "www.youtu.be" || h === "m.youtu.be";
}

/**
 * Canonical 11-character YouTube video id: [A-Za-z0-9_-]{11}, exactly.
 * YouTube's own IDs are always 11 Base64url characters.
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Parse a `t=` or `start=` query parameter into whole seconds.
 *
 * Supported forms:
 *   - Plain integer: `t=123`  → 123
 *   - Compact HMS:   `t=1h2m3s` / `t=2m30s` / `t=45s`  (any subset of h/m/s)
 *
 * Returns undefined when the value is absent or unparseable.
 */
function parseStartSec(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  // Plain integer seconds.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  }

  // Compact HMS form: optional Nh, optional Nm, optional Ns.
  // Examples: 1h2m3s, 2m30s, 45s, 1h30m, 2h (bare hours without 'h' suffix
  // are not a YouTube form and are rejected here; plain integers above handle them).
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
  if (hms && trimmed.length > 0 && trimmed !== "") {
    // At least one component must be present and non-empty.
    if (!hms[1] && !hms[2] && !hms[3]) return undefined;
    const h = Number(hms[1] ?? 0);
    const m = Number(hms[2] ?? 0);
    const s = Number(hms[3] ?? 0);
    const total = h * 3600 + m * 60 + s;
    return Number.isFinite(total) && total >= 0 ? Math.floor(total) : undefined;
  }

  return undefined;
}

export interface YouTubeVideoRef {
  /** Canonical 11-character YouTube video id. */
  videoId: string;
  /** Start time in whole seconds, from t=/start= params. Undefined when absent. */
  startSec?: number;
}

/**
 * Parse a URL string into a YouTube video reference, or return null.
 *
 * Accepts http/https only. Does not accept bare video ids (unlike the X status
 * URL parser which accepts bare status ids) — YouTube video ids overlap too many
 * other tokens to be safely recognized without a host context.
 */
export function parseYouTubeUrl(input: string): YouTubeVideoRef | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!isYouTubeHost(url.hostname)) return null;

  let videoId: string | null = null;

  if (isShortHost(url.hostname)) {
    // youtu.be/<id>
    // Path is /<videoId> with optional trailing segments or query string.
    const parts = url.pathname.split("/").filter(Boolean);
    videoId = parts[0] ?? null;
  } else {
    // youtube.com paths.
    const path = url.pathname;

    if (path.startsWith("/watch")) {
      videoId = url.searchParams.get("v");
    } else {
      // /shorts/<id>, /live/<id>, /embed/<id>
      const m = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(path);
      videoId = m?.[1] ?? null;
    }
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;

  const tParam = url.searchParams.get("t") ?? url.searchParams.get("start");
  const startSec = parseStartSec(tParam);

  return startSec !== undefined ? { videoId, startSec } : { videoId };
}

/** URL regex mirrors the FxTwitter enrichment layer pattern. */
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

/**
 * Extract all recognized YouTube video URLs from a body string, deduped by
 * video id (first occurrence wins), in order of first appearance.
 */
export interface YouTubeVideoUrlMatch extends YouTubeVideoRef {
  rawUrl: string;
  bodyIndex: number;
}

export function extractYouTubeUrls(bodyText: string): YouTubeVideoUrlMatch[] {
  const results: YouTubeVideoUrlMatch[] = [];
  const seenIds = new Set<string>();
  for (const match of bodyText.matchAll(URL_REGEX)) {
    const parsed = parseYouTubeUrl(match[0]);
    if (!parsed) continue;
    if (seenIds.has(parsed.videoId)) continue;
    seenIds.add(parsed.videoId);
    results.push({ ...parsed, rawUrl: match[0], bodyIndex: match.index ?? 0 });
  }
  return results;
}
