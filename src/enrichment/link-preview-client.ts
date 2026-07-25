import { readFile, unlink } from "node:fs/promises";
import type { FetchClient } from "./fetch-client.js";

/**
 * source_kind for previews scraped by the direct-HTTP og:/twitter: fallback.
 * Populated by {@link DirectLinkPreviewClient}; used when
 * `EnrichmentCapabilities.resolveLinkPreviews` is absent (`linkPreviews: "none"`).
 */
export const DIRECT_SCRAPE_SOURCE_KIND = "direct_scrape";

/**
 * source_kind for previews populated at ingest from Discord embeds (Phase 7).
 * These rows take precedence over direct-scrape results per URL; enrichment
 * workers skip URLs already covered by a discord_embed row.
 */
export const DISCORD_EMBED_SOURCE_KIND = "discord_embed";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function extractUrls(bodyText: string): string[] {
  return [...new Set(
    (bodyText.match(URL_REGEX) ?? []).map(stripTrailingPunctuation),
  )];
}

/** Strip trailing punctuation that commonly attaches to URLs in plain text. */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]>]+$/, "");
}

/** Escape special characters for use in a literal regex segment. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decode the most common HTML entities found in meta-tag content attributes.
 */
function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Extract the content of an HTML `<meta>` tag by one or more property/name
 * keys (tried in order, first match wins). Handles both attribute orderings:
 * `property="og:x" content="val"` and `content="val" property="og:x"`.
 */
function extractMetaContent(html: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const ek = escapeRegExp(key);
    // property/name before content
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${ek}["'][^>]+content=["']([^"'<>]{1,2000})["']`,
      "i",
    );
    const m1 = re1.exec(html);
    if (m1) return htmlDecode(m1[1].trim());
    // content before property/name
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"'<>]{1,2000})["'][^>]+(?:property|name)=["']${ek}["']`,
      "i",
    );
    const m2 = re2.exec(html);
    if (m2) return htmlDecode(m2[1].trim());
  }
  return undefined;
}

export interface DirectLinkPreviewResult {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  sourceKind: typeof DIRECT_SCRAPE_SOURCE_KIND;
}

/**
 * Link preview scraper that extracts og:/twitter: meta tags via plain HTTP
 * fetch (no JS rendering). Used as the framework-level fallback when
 * `EnrichmentCapabilities.resolveLinkPreviews` is absent (`linkPreviews: "none"`).
 *
 * Reuses `FetchClient` for SSRF guard, size cap, retry, and proxy. Returns a
 * preview for each URL where at least a title or description could be scraped.
 * Errors per URL are swallowed (non-fatal, same policy as Synapse preview failures).
 */
export class DirectLinkPreviewClient {
  constructor(
    private readonly fetchClient: FetchClient,
    /** Max response bytes to read per URL; defaults to 128 KB. */
    private readonly maxResponseBytes = 128_000,
  ) {}

  /**
   * Extract HTTP/HTTPS URLs from body text and scrape og:/twitter: meta tags
   * for each. Skips URLs present in `excludeUrls` (e.g. ingest-time
   * discord_embed previews take precedence per URL). Returns only URLs where
   * at least a title or description was found.
   */
  async resolve(params: {
    bodyText: string;
    maxPreviews: number;
    excludeUrls?: Set<string>;
  }): Promise<DirectLinkPreviewResult[]> {
    const urls = extractUrls(params.bodyText)
      .filter((u) => !params.excludeUrls?.has(u))
      .slice(0, params.maxPreviews);
    if (urls.length === 0) return [];

    const results = await Promise.allSettled(urls.map((url) => this.scrapeUrl(url)));
    return results
      .filter((r): r is PromiseFulfilledResult<DirectLinkPreviewResult | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((r): r is DirectLinkPreviewResult => r !== null);
  }

  /**
   * Fetch one URL and scrape og:/twitter: meta tags from the HTML response.
   * Returns null on network failure, non-2xx status, non-HTML content type,
   * or when no title or description could be found.
   */
  private async scrapeUrl(url: string): Promise<DirectLinkPreviewResult | null> {
    let filePath: string | undefined;
    try {
      const result = await this.fetchClient.fetch(url, { maxBytes: this.maxResponseBytes });
      filePath = result.path;

      if (result.statusCode < 200 || result.statusCode >= 300) return null;

      // Only scrape HTML responses; skip images, binary downloads, etc.
      const ct = (result.contentType ?? "").toLowerCase();
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;

      const html = await readFile(filePath, "utf8").catch(() => null);
      if (!html) return null;

      const title = extractMetaContent(html, "og:title", "twitter:title");
      const description = extractMetaContent(html, "og:description", "twitter:description");
      const siteName = extractMetaContent(html, "og:site_name");

      // Only emit a row if there's something useful.
      if (!title && !description) return null;

      return { url, title, description, siteName, sourceKind: DIRECT_SCRAPE_SOURCE_KIND };
    } catch {
      return null;
    } finally {
      if (filePath) await unlink(filePath).catch(() => {});
    }
  }
}
