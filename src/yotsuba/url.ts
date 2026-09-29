/**
 * Yotsuba (4chan) URL recognition and canonicalization.
 * (spec/YOTSUBA-SUPPORT.md §4.1)
 *
 * Recognizes thread, post, and board links on the 4chan family of hosts, plus
 * any `extra_hosts` configured at runtime. Canonical form for persistence/dedup:
 *   thread: `https://boards.4chan.org/{b}/thread/{no}[#p{postNo}]`
 *   board:  `https://boards.4chan.org/{b}/`
 *
 * Host matching uses the `isYotsubaHost` helper (same pattern as `isStatusHost`
 * in src/fxtwitter/url.ts): base-domain matching with subdomain tolerance and
 * lookalike rejection.
 */

import type { YotsubaRef, YotsubaThreadRef, YotsubaBoardRef } from "./types.js";

/** Omit distributed over a union so that type narrowing on `kind` still works. */
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type ParsedYotsubaRef = DistOmit<YotsubaRef, "bodyIndex">;

// ---------------------------------------------------------------------------
// Host recognition
// ---------------------------------------------------------------------------

/**
 * The canonical 4chan site domains. `boards.4channel.org` is the legacy SFW
 * domain still pasted widely. `4chan.org` and `www.4chan.org` are redirect
 * entry points. All are recognized.
 */
export const YOTSUBA_BASE_HOSTS: readonly string[] = [
  "boards.4chan.org",
  "boards.4channel.org",
  "4chan.org",
  "www.4chan.org",
];

/**
 * True when `hostname` is one of `bases` or a subdomain of one. The leading-dot
 * suffix check (`.endsWith("." + base)`) accepts arbitrary subdomains without
 * false-positiving on lookalike registrations (e.g. `evil4chan.org` is rejected;
 * `i.4chan.org` would be accepted, but file links are not refs so it never fires).
 */
export function isYotsubaHost(
  hostname: string,
  extras: readonly string[] = [],
): boolean {
  const h = hostname.toLowerCase();
  const all: readonly string[] = [...YOTSUBA_BASE_HOSTS, ...extras];
  return all.some((base) => h === base || h.endsWith("." + base));
}

// ---------------------------------------------------------------------------
// Path patterns
// ---------------------------------------------------------------------------

// Board code: 1–10 lowercase alphanumerics (4chan convention).
const BOARD_RE = /^[a-z0-9]{1,10}$/;

// Thread path: /{b}/thread/{no}[/{slug}][#p{post}|#q{post}]
// The optional fragment is parsed separately.
const THREAD_PATH_RE = /^\/([a-z0-9]{1,10})\/thread\/(\d+)(?:\/[^/]*)?(?:#[pq](\d+))?$/;

// Board path: /{b}/ | /{b}/catalog | /{b}/{digit} (page N)
const BOARD_PATH_RE = /^\/([a-z0-9]{1,10})(?:\/(?:catalog|\d+)?\/?)?$/;

// URL regex used to scan body text.
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single URL string (or a bare thread/post number, `>>123`,
 * `>>>/b/123`) into a YotsubaRef, or return null if not recognized.
 *
 * @param input    The raw URL or shorthand form.
 * @param extras   Additional base domains to accept (from `extra_hosts`).
 * @param siteBase Canonical site root (default `https://boards.4chan.org`).
 */
export function parseYotsubaUrl(
  input: string,
  extras: readonly string[] = [],
  siteBase = "https://boards.4chan.org",
): ParsedYotsubaRef | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!isYotsubaHost(url.hostname, extras)) return null;

  // Try thread path first.
  const threadMatch = THREAD_PATH_RE.exec(url.pathname + (url.hash || ""));
  if (threadMatch) {
    const board = threadMatch[1];
    const threadNo = parseInt(threadMatch[2], 10);
    const postNoStr = threadMatch[3];
    const postNo = postNoStr ? parseInt(postNoStr, 10) : undefined;
    // A #p anchor equal to the thread number is a plain thread ref.
    const effectivePost = postNo === threadNo ? undefined : postNo;
    const canonical = `${siteBase}/${board}/thread/${threadNo}` +
      (effectivePost != null ? `#p${effectivePost}` : "");
    return {
      kind: "thread",
      board,
      threadNo,
      postNo: effectivePost,
      canonicalUrl: canonical,
      rawUrl: trimmed,
    } satisfies DistOmit<YotsubaThreadRef, "bodyIndex">;
  }

  // Try board path.
  const boardMatch = BOARD_PATH_RE.exec(url.pathname);
  if (boardMatch && BOARD_RE.test(boardMatch[1])) {
    const board = boardMatch[1];
    const canonical = `${siteBase}/${board}/`;
    return {
      kind: "board",
      board,
      canonicalUrl: canonical,
      rawUrl: trimmed,
    } satisfies DistOmit<YotsubaBoardRef, "bodyIndex">;
  }

  return null;
}

/**
 * Parse tool-input forms for a thread or post reference. Accepts:
 *  - A full URL
 *  - A bare thread number (string or number)
 *  - `>>123` or `>>>/g/123` notation
 *  - `/g/`, `g`, `/g` board codes (for board-only inputs)
 *
 * Returns `{ board?, threadNo?, postNo? }` for the caller to use as needed.
 * Returns null when the input is completely unrecognizable.
 */
export interface ParsedToolInput {
  board?: string;
  threadNo?: number;
  postNo?: number;
  /** True when the input was `>>>/b/N` notation (no thread context). */
  isCrossQuote?: boolean;
}

export function parseToolInput(
  input: string,
  extras: readonly string[] = [],
  siteBase = "https://boards.4chan.org",
): ParsedToolInput | null {
  const s = input.trim();
  if (!s) return null;

  // Full URL?
  try {
    const ref = parseYotsubaUrl(s, extras, siteBase);
    if (ref) {
      if (ref.kind === "thread") return { board: ref.board, threadNo: ref.threadNo, postNo: ref.postNo };
      if (ref.kind === "board") return { board: ref.board };
    }
  } catch {
    // not a URL
  }

  // >>>/b/123 form?
  const crossQuote = /^>>>\/([a-z0-9]{1,10})\/(\d+)$/.exec(s);
  if (crossQuote) {
    return { board: crossQuote[1], postNo: parseInt(crossQuote[2], 10), isCrossQuote: true };
  }

  // >>123 (local) — bare number with >> prefix
  const localQuote = /^>>(\d+)$/.exec(s);
  if (localQuote) {
    return { threadNo: parseInt(localQuote[1], 10) };
  }

  // Bare number (thread or post)
  if (/^\d+$/.test(s)) {
    return { threadNo: parseInt(s, 10) };
  }

  // Board code: /g/, g, /g
  const boardForm = /^\/?([a-z0-9]{1,10})\/?$/.exec(s);
  if (boardForm && BOARD_RE.test(boardForm[1])) {
    return { board: boardForm[1] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

/**
 * Extract all recognized 4chan refs from a message body, deduped by
 * `(board, threadNo, postNo)` (first occurrence wins), in order of first
 * appearance.
 */
export function extractYotsubaRefs(
  bodyText: string,
  extras: readonly string[] = [],
  siteBase = "https://boards.4chan.org",
): YotsubaRef[] {
  const results: YotsubaRef[] = [];
  const seen = new Set<string>();
  for (const match of bodyText.matchAll(URL_REGEX)) {
    const raw = match[0];
    const parsed = parseYotsubaUrl(raw, extras, siteBase);
    if (!parsed) continue;
    const key =
      parsed.kind === "thread"
        ? `thread:${parsed.board}:${parsed.threadNo}:${parsed.postNo ?? ""}`
        : `board:${parsed.board}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...parsed, bodyIndex: match.index ?? 0 });
  }
  return results;
}

/**
 * Strip every recognized 4chan URL from a body copy (all occurrences, not just
 * the deduped first), so the generic Synapse preview path never produces a bare
 * og-card for them. Mirrors `stripXStatusUrls` from `src/fxtwitter/url.ts`.
 */
export function stripYotsubaUrls(
  bodyText: string,
  extras: readonly string[] = [],
): string {
  return bodyText.replace(URL_REGEX, (raw) =>
    parseYotsubaUrl(raw, extras) ? "" : raw,
  );
}

// ---------------------------------------------------------------------------
// Dedup key (for partition dedup in the enrichment worker)
// ---------------------------------------------------------------------------

/** Stable dedup key for a ref. */
export function yotsubaRefKey(ref: YotsubaRef): string {
  if (ref.kind === "thread") {
    return `thread:${ref.board}:${ref.threadNo}:${ref.postNo ?? ""}`;
  }
  return `board:${ref.board}`;
}
