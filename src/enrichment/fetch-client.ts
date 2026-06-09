import { createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { ProxyAgent, type Dispatcher } from "undici";
import { guardedFetch } from "../tools/ssrf.js";

export interface FetchClientOptions {
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
}

/**
 * Streams a caller/external-supplied asset URL to disk under per-request timeout
 * and response-size caps, routing the shared HTTP proxy dispatcher.
 *
 * It does NOT cap concurrency: cross-domain/per-host admission and the
 * unconditional 429/503 backoff now live at the `guardedFetch` chokepoint
 * (`src/tools/ssrf.ts` + `src/tools/http-limiter.ts`, spec Design D). This client
 * keeps only its orthogonal concerns — byte-size caps, proxy dispatcher, and the
 * stream-to-disk pipeline.
 */
export class FetchClient {
  private stopped = false;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: FetchClientOptions) {
    this.dispatcher = buildProxyDispatcher(options.httpProxyUrl);
  }

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    if (this.stopped) throw new Error("FetchClient is stopped");
    return this.doFetch(url, options);
  }

  stop(): void {
    this.stopped = true;
  }

  private async doFetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      // All fetch-client callers pull caller/external-supplied asset URLs, so
      // the egress guard always applies here (it self-gates on the global
      // `network.ssrf_guard` switch). The dispatcher carries the shared proxy;
      // per-host admission + backoff are enforced inside guardedFetch.
      const response = await guardedFetch(url, {
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });

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
  }
}

export interface FetchResult {
  path: string;
  sizeBytes: number;
  contentType?: string;
  finalUrl: string;
  statusCode: number;
}
