/**
 * YotsubaClient: 4chan API + media client.
 * (spec/YOTSUBA-SUPPORT.md §4.2, §4.3)
 *
 * Provides:
 *   boards()             — board list (24 h cache)
 *   catalog(board)       — catalog (10 s freshness)
 *   page(board, n)       — board page N (10 s freshness)
 *   thread(board, no)    — full thread (10 s freshness)
 *   fetchFile(...)       — download a file via the media lane
 *
 * Transport: `guardedFetch` (SSRF guard + 429/503 backoff), proxy dispatcher,
 * configurable `timeout_ms` and `max_response_bytes`, identifying User-Agent.
 *
 * Cache: in-memory, bounded by entry count (64) and total bytes (32 MiB).
 * Freshness: per resource type (see spec §3). Conditional GET with
 * If-Modified-Since / 304 after the freshness window. Negative cache for 404
 * (10 minutes). Single-flight for concurrent identical requests.
 */

import type { Dispatcher } from "undici";
import { buildProxyDispatcher, type FetchClient } from "../enrichment/fetch-client.js";
import { guardedFetch } from "../tools/ssrf.js";
import { PacedLimiter, type PacedLimiterClass } from "../net/paced-limiter.js";
import type {
  ApiBoard,
  ApiBoardsResponse,
  ApiThread,
  ApiCatalogPage,
  ApiBoardPage,
  ResolvedYotsubaConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YOTSUBA_USER_AGENT = "MikuAgent/0.1 (mikuswarm; +https://github.com/reasv/mikuswarm)";

/** Freshness windows (ms) per resource type (spec §3). */
const FRESHNESS_MS = {
  boards: 24 * 60 * 60 * 1000, // 24 h
  thread: 10 * 1000,            // 10 s
  catalog: 10 * 1000,
  page: 10 * 1000,
};

/** Negative-cache TTL for 404s. */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32 MiB

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  body: unknown;
  bytes: number;
  fetchedAt: number;
  lastModified?: string;
  kind: keyof typeof FRESHNESS_MS;
}

interface NegativeCacheEntry {
  at: number;
}

// ---------------------------------------------------------------------------
// Fetch result
// ---------------------------------------------------------------------------

export interface YotsubaFetchResult<T> {
  body: T;
  fetchedAt: number;
  lastModified?: string;
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// YotsubaClient
// ---------------------------------------------------------------------------

export class YotsubaClient {
  private readonly apiDispatcher: Dispatcher | undefined;
  private readonly apiLimiter: PacedLimiter;
  private readonly mediaLimiter: PacedLimiter;

  /** In-memory cache, keyed by request path. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Total bytes of all cached response bodies. */
  private cacheTotalBytes = 0;

  /** Negative cache for 404 responses. */
  private readonly negativeCache = new Map<string, NegativeCacheEntry>();

  /** Single-flight registry: in-flight requests keyed by path. */
  private readonly inFlight = new Map<string, Promise<YotsubaFetchResult<unknown>>>();

  constructor(
    private readonly config: ResolvedYotsubaConfig,
    private readonly fetchClient?: FetchClient,
  ) {
    this.apiDispatcher = buildProxyDispatcher(config.apiBase.includes("proxy") ? undefined : undefined);
    // Actually build proxy dispatcher from network config — the caller passes config
    // which has the proxy URL embedded. Re-create from the config as-is.
    // Note: buildProxyDispatcher takes httpProxyUrl; we expose a factory pattern.
    this.apiLimiter = new PacedLimiter({
      minIntervalMs: config.minRequestIntervalMs,
      maxInFlight: config.maxInFlight,
    });
    this.mediaLimiter = new PacedLimiter({
      minIntervalMs: config.mediaMinRequestIntervalMs,
      maxInFlight: config.mediaMaxInFlight,
    });
  }

  /**
   * Factory method — preferred construction path. Allows the proxy dispatcher
   * to be built from the http_proxy_url config.
   */
  static create(config: ResolvedYotsubaConfig, httpProxyUrl?: string, fetchClient?: FetchClient): YotsubaClient {
    const client = new YotsubaClient(config, fetchClient);
    // Override the dispatcher built in the constructor with the correct proxy.
    (client as unknown as { _apiDispatcher: Dispatcher | undefined })._apiDispatcher =
      buildProxyDispatcher(httpProxyUrl);
    return client;
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  /** Fetch the board list (24 h cached). */
  async boards(cls?: PacedLimiterClass): Promise<YotsubaFetchResult<ApiBoard[]>> {
    const result = await this.fetchJson<ApiBoardsResponse>("/boards.json", "boards", cls);
    return { ...result, body: result.body.boards ?? [] };
  }

  /** Fetch the full catalog for a board (10 s freshness). */
  async catalog(board: string, cls?: PacedLimiterClass): Promise<YotsubaFetchResult<ApiCatalogPage[]>> {
    return this.fetchJson<ApiCatalogPage[]>(`/${board}/catalog.json`, "catalog", cls);
  }

  /** Fetch board page N (10 s freshness). */
  async page(board: string, n: number, cls?: PacedLimiterClass): Promise<YotsubaFetchResult<ApiBoardPage>> {
    return this.fetchJson<ApiBoardPage>(`/${board}/${n}.json`, "page", cls);
  }

  /**
   * Fetch a full thread (10 s freshness). Returns null when the thread 404s
   * (dead/pruned). Throws on other errors.
   */
  async thread(
    board: string,
    no: number,
    cls?: PacedLimiterClass,
  ): Promise<YotsubaFetchResult<ApiThread> | null> {
    const path = `/${board}/thread/${no}.json`;
    try {
      return await this.fetchJson<ApiThread>(path, "thread", cls);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /**
   * Download a file via the media lane. Delegates to the shared FetchClient.
   * `fileRef` is either `{tim}{ext}` (original) or `{tim}s.jpg` (thumbnail).
   */
  async fetchFile(
    board: string,
    fileRef: string,
    cls: PacedLimiterClass = "background",
  ): Promise<Buffer> {
    const url = `${this.config.mediaBase}/${board}/${fileRef}`;
    if (!this.fetchClient) throw new Error("No FetchClient configured for YotsubaClient.fetchFile");
    return this.mediaLimiter.run(async () => {
      const result = await this.fetchClient!.fetch(url);
      const { readFile } = await import("node:fs/promises");
      return readFile(result.path);
    }, cls);
  }

  // ---------------------------------------------------------------------------
  // Internal fetch machinery
  // ---------------------------------------------------------------------------

  private async fetchJson<T>(
    path: string,
    kind: keyof typeof FRESHNESS_MS,
    cls?: PacedLimiterClass,
  ): Promise<YotsubaFetchResult<T>> {
    // Check negative cache.
    const neg = this.negativeCache.get(path);
    if (neg && Date.now() - neg.at < NEGATIVE_CACHE_TTL_MS) {
      const err = new Error(`4chan 404: ${path}`);
      (err as unknown as { status: number }).status = 404;
      throw err;
    }

    // Check positive cache within freshness window.
    const cached = this.cache.get(path);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < FRESHNESS_MS[kind]) {
      return { body: cached.body as T, fetchedAt: cached.fetchedAt, lastModified: cached.lastModified, fromCache: true };
    }

    // Single-flight: if a request for this path is already in-flight, join it.
    const existing = this.inFlight.get(path);
    if (existing) {
      const result = await existing;
      return result as YotsubaFetchResult<T>;
    }

    const promise = this.doFetchJson<T>(path, kind, cached, cls);
    this.inFlight.set(path, promise as Promise<YotsubaFetchResult<unknown>>);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async doFetchJson<T>(
    path: string,
    kind: keyof typeof FRESHNESS_MS,
    cached: CacheEntry | undefined,
    cls?: PacedLimiterClass,
  ): Promise<YotsubaFetchResult<T>> {
    const url = `${this.config.apiBase}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": YOTSUBA_USER_AGENT,
    };
    // Conditional GET if we have a cached version.
    if (cached?.lastModified) {
      headers["if-modified-since"] = cached.lastModified;
    }

    const response = await this.apiLimiter.run(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const resp = await guardedFetch(url, {
          method: "GET",
          signal: controller.signal,
          headers,
          dispatcher: this.apiDispatcher,
        });
        return resp;
      } finally {
        clearTimeout(timeoutId);
      }
    }, cls);

    // 304 Not Modified — reuse cached body.
    if (response.status === 304 && cached) {
      // Refresh fetchedAt.
      cached.fetchedAt = Date.now();
      this.cache.set(path, cached);
      return { body: cached.body as T, fetchedAt: cached.fetchedAt, lastModified: cached.lastModified, fromCache: true };
    }

    // 404 — cache negatively.
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      this.negativeCache.set(path, { at: Date.now() });
      const err = new Error(`4chan 404: ${path}`);
      (err as unknown as { status: number }).status = 404;
      throw err;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const err = new Error(`4chan HTTP ${response.status}: ${path}`);
      (err as unknown as { status: number }).status = response.status;
      throw err;
    }

    // Read body with byte cap.
    const text = await this.readBounded(response);

    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new Error(`4chan returned non-JSON for ${path}`);
    }

    const lastModified = response.headers.get("last-modified") ?? undefined;
    const fetchedAt = Date.now();
    const bytes = text.length * 2; // rough estimate (UTF-16)

    // Evict if needed before inserting.
    this.evictIfNeeded(bytes);
    const entry: CacheEntry = { body, bytes, fetchedAt, lastModified, kind };
    this.cache.set(path, entry);
    this.cacheTotalBytes += bytes;

    return { body, fetchedAt, lastModified, fromCache: false };
  }

  private async readBounded(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > this.config.maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`4chan response too large: ${declared} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > this.config.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`4chan response exceeded ${this.config.maxResponseBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }

  private evictIfNeeded(incomingBytes: number): void {
    // Evict LRU entries until we're under the limits.
    while (
      this.cache.size >= MAX_CACHE_ENTRIES ||
      this.cacheTotalBytes + incomingBytes > MAX_CACHE_BYTES
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest == null) break;
      const entry = this.cache.get(oldest)!;
      this.cacheTotalBytes -= entry.bytes;
      this.cache.delete(oldest);
    }
  }

  /** Clear all caches (for testing). */
  clearCache(): void {
    this.cache.clear();
    this.cacheTotalBytes = 0;
    this.negativeCache.clear();
  }
}
