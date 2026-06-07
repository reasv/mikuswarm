import { createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { ProxyAgent, type Dispatcher } from "undici";
import { assertPublicHttpUrl } from "../tools/ssrf.js";

export interface FetchClientOptions {
  maxConcurrency: number;
  timeoutMs: number;
  maxResponseBytes: number;
  httpProxyUrl?: string;
}

/**
 * Build a ProxyAgent dispatcher from an http(s) proxy URL, or return undefined
 * when no proxy is configured. Exported so other HTTP callers (e.g. the
 * danbooru tool's JSON metadata fetch) can share the same proxy as the
 * binary-fetch path without each one rebuilding the agent.
 */
export function buildProxyDispatcher(httpProxyUrl: string | undefined): Dispatcher | undefined {
  if (!httpProxyUrl) return undefined;
  const trimmed = httpProxyUrl.trim();
  if (trimmed.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("network.http_proxy_url must be a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("network.http_proxy_url must use http or https.");
  }
  return new ProxyAgent(trimmed);
}

export interface FetchOptions {
  maxBytes?: number;
  outputPath?: string;
  /**
   * Opt-in SSRF redirect guard. When set, the fetch uses `redirect: "manual"`
   * and re-validates every redirect `Location` hop with `assertPublicHttpUrl`
   * before following it (capped at {@link MAX_REDIRECT_HOPS}). Callers that feed
   * untrusted, caller-supplied URLs (e.g. image_generate reference images) must
   * enable this so a public URL cannot 302-redirect to a private/metadata host.
   * Off by default to preserve existing behavior for trusted callers.
   */
  ssrfGuard?: boolean;
}

/** Redirect-hop cap for the SSRF guard, mirroring `web.ts` guardedFetch. */
const MAX_REDIRECT_HOPS = 5;

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export class ConcurrencyLimitedFetchClient {
  private active = 0;
  private readonly queue: Array<{
    resolve: (value: FetchResult) => void;
    reject: (reason: unknown) => void;
    url: string;
    options?: FetchOptions;
  }> = [];
  private stopped = false;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: FetchClientOptions) {
    this.dispatcher = buildProxyDispatcher(options.httpProxyUrl);
  }

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    if (this.stopped) throw new Error("FetchClient is stopped");
    if (this.active < this.options.maxConcurrency) {
      return this.doFetch(url, options);
    }
    return new Promise<FetchResult>((resolve, reject) => {
      this.queue.push({ resolve, reject, url, options });
    });
  }

  stop(): void {
    this.stopped = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(new Error("FetchClient stopped"));
    }
  }

  private async doFetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    this.active++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = options?.ssrfGuard
          ? await this.fetchGuarded(url, controller.signal)
          : await globalThis.fetch(url, {
              signal: controller.signal,
              redirect: "follow",
              headers: { "User-Agent": "MikuAgent/1.0" },
              // Node's native fetch is built on undici and accepts a dispatcher
              // here at runtime, but the type is not in the lib.dom Request init.
              ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
            } as RequestInit);

        const limit = options?.maxBytes ?? this.options.maxResponseBytes;
        const outputPath = options?.outputPath ?? join(tmpdir(), `miku-fetch-${randomBytes(8).toString("hex")}`);

        if (!response.body) {
          await writeFile(outputPath, Buffer.alloc(0));
          return {
            path: outputPath,
            sizeBytes: 0,
            contentType: response.headers.get("content-type") ?? undefined,
            finalUrl: response.url,
            statusCode: response.status,
          };
        }

        const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
        let totalBytes = 0;
        const sizeGuard = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            totalBytes += chunk.byteLength;
            if (totalBytes > limit) {
              controller.abort();
              callback(new Error(`Response exceeded ${limit} bytes`));
            } else {
              callback(null, chunk);
            }
          },
        });

        try {
          await pipeline(nodeStream, sizeGuard, createWriteStream(outputPath));
        } catch (error) {
          await unlink(outputPath).catch(() => {});
          throw error;
        }

        return {
          path: outputPath,
          sizeBytes: totalBytes,
          contentType: response.headers.get("content-type") ?? undefined,
          finalUrl: response.url,
          statusCode: response.status,
        };
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      this.active--;
      this.processQueue();
    }
  }

  /**
   * SSRF-guarded fetch: resolves the redirect chain manually, re-validating
   * each `Location` hop with `assertPublicHttpUrl` before following it. The
   * proxy dispatcher, abort signal, and User-Agent match the unguarded path;
   * only the redirect handling differs. Returns the final non-redirect
   * `Response` so the caller can stream its body exactly as before.
   */
  private async fetchGuarded(url: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECT_HOPS) throw new Error("Too many redirects.");
      await assertPublicHttpUrl(current);
      const response = await globalThis.fetch(current, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": "MikuAgent/1.0" },
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit);
      if (!isRedirectStatus(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} missing location header.`);
      // Discard the redirect response body before following the next hop.
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
    }
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.active < this.options.maxConcurrency) {
      const item = this.queue.shift()!;
      this.doFetch(item.url, item.options).then(item.resolve, item.reject);
    }
  }
}

export interface FetchResult {
  path: string;
  sizeBytes: number;
  contentType?: string;
  finalUrl: string;
  statusCode: number;
}
