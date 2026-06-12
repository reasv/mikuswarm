/**
 * X status URL detection & canonicalization (spec/FXTWITTER-ENRICHMENT.md §2;
 * spec/X-URL-NORMALIZATION-AND-COMPACT-MEDIA.md §2). Recognizes status URLs on
 * X/Twitter hosts plus the mirror/share domains people paste for better
 * previews (FxTwitter, vxtwitter, and friends). Canonical form for
 * persistence/dedup: `https://x.com/{screen_name|i}/status/{id}`.
 *
 * Hosts are matched as BASE domains with subdomain tolerance (`isStatusHost`):
 * `www.`, `mobile.`, `m.`, `d.`, `g.`, … of any listed base all match for free,
 * while `notfxtwitter.com` / `evilx.com` / `x.com.evil.com` do not.
 */

/**
 * Recognized base domains. The deployment can extend this at runtime via
 * `fxtwitter.extra_status_hosts` (threaded in as the `bases` argument); the
 * defaults below ship the long-lived members of the ecosystem.
 */
export const STATUS_BASE_HOSTS: readonly string[] = [
  "x.com",
  "twitter.com",
  // FixTweet / FxTwitter share domains.
  "fxtwitter.com",
  "fixupx.com",
  "fixvx.com",
  "twittpr.com",
  "pxtwitter.com", // legacy FxTwitter domain, still in the wild
  // FixTweet joke aliases (same path structure; used in chat).
  "girlcockx.com",
  "stupidpenisx.com",
  "cunnyx.com",
  // vxtwitter family.
  "vxtwitter.com",
];

/**
 * True when `hostname` is one of `bases` or a subdomain of one. The leading-dot
 * suffix check (`.endsWith("." + base)`) accepts arbitrary subdomains without
 * false-positiving on lookalike registrations.
 */
function isStatusHost(hostname: string, bases: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return bases.some((base) => h === base || h.endsWith("." + base));
}

// Path forms: /:screen_name/status/:id, /i/status/:id, /i/web/status/:id.
// The id must be all-digits; trailing segments (/photo/1, /video/2) are
// tolerated and ignored.
const STATUS_PATH = /^\/(?:i\/web|i|([A-Za-z0-9_]{1,20}))\/status(?:es)?\/(\d+)(?:\/|$)/;

// Mirrors the enrichment-layer URL regex (src/enrichment/linked-media.ts).
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

export interface XStatusRef {
  /** The raw URL text as matched in the body. */
  rawUrl: string;
  /** Char offset of the first occurrence in the body (extract only). */
  bodyIndex: number;
  statusId: string;
  /** Lowercased, without "@"; undefined for /i/status/ forms. */
  screenName?: string;
  /** `https://x.com/{screenName|i}/status/{id}` */
  canonicalUrl: string;
}

/** Parse one URL (or bare numeric status id) into a status reference, or null. */
export function parseXStatusUrl(
  input: string,
  bases: readonly string[] = STATUS_BASE_HOSTS,
): Omit<XStatusRef, "bodyIndex"> | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return {
      rawUrl: trimmed,
      statusId: trimmed,
      canonicalUrl: `https://x.com/i/status/${trimmed}`,
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!isStatusHost(url.hostname, bases)) return null;
  const match = STATUS_PATH.exec(url.pathname);
  if (!match) return null;
  const screenName = match[1]?.toLowerCase();
  const statusId = match[2];
  return {
    rawUrl: trimmed,
    statusId,
    screenName,
    canonicalUrl: `https://x.com/${screenName ?? "i"}/status/${statusId}`,
  };
}

/**
 * Extract X status URLs from a message body, deduped by status id (first
 * occurrence wins), in order of first appearance.
 */
export function extractXStatusUrls(
  bodyText: string,
  bases: readonly string[] = STATUS_BASE_HOSTS,
): XStatusRef[] {
  const results: XStatusRef[] = [];
  const seenIds = new Set<string>();
  for (const match of bodyText.matchAll(URL_REGEX)) {
    const parsed = parseXStatusUrl(match[0], bases);
    if (!parsed) continue;
    if (seenIds.has(parsed.statusId)) continue;
    seenIds.add(parsed.statusId);
    results.push({ ...parsed, bodyIndex: match.index ?? 0 });
  }
  return results;
}

/**
 * Strip every occurrence of recognized X status URLs from a body copy, so the
 * Synapse `/preview_url` capability (which parses the body itself) never
 * produces the bare og-card for them. Strips ALL matches of each status id,
 * not just the deduped first occurrence.
 */
export function stripXStatusUrls(
  bodyText: string,
  bases: readonly string[] = STATUS_BASE_HOSTS,
): string {
  return bodyText.replace(URL_REGEX, (raw) => (parseXStatusUrl(raw, bases) ? "" : raw));
}
