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
  /**
   * Retry attempts on a *transient* network failure (connection reset/refused,
   * connect/socket timeout, transient DNS, or a bare undici `fetch failed`).
   * Total tries = `maxRetries + 1`. Deterministic failures — size-cap overflow,
   * SSRF/scheme rejection, per-attempt timeout abort, non-2xx status — are NOT
   * retried. Default 2.
   */
  maxRetries?: number;
  /** Base backoff between transient retries (ms); grows linearly per attempt. Default 250. */
  retryBaseDelayMs?: number;
}

/**
 * undici surfaces low-level connection failures either as a Node system error
 * with one of these codes, or as `TypeError: fetch failed` carrying the real
 * reason on `.cause`. All are connection-phase and safe to retry for an
 * idempotent GET. (`ENOTFOUND` is deliberately excluded — a hard DNS miss won't
 * heal in a few hundred ms; `EAI_AGAIN`, the *transient* resolver failure, is
 * included.)
 */
const TRANSIENT_FETCH_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classify a thrown fetch error: returns a short transient-reason code when the
 * failure is worth retrying, or `undefined` when it is deterministic (don't
 * retry). A caller-/timeout-driven `AbortError` is treated as non-transient.
 */
function transientFetchErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ((error as { name?: string }).name === "AbortError") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && TRANSIENT_FETCH_CODES.has(direct)) return direct;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  if (typeof causeCode === "string" && TRANSIENT_FETCH_CODES.has(causeCode)) return causeCode;
  // A bare `TypeError: fetch failed` from undici is a connection-phase failure
  // even when the cause code isn't one we enumerate — retry it.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return typeof causeCode === "string" ? causeCode : "fetch_failed";
  }
  return undefined;
}

/**
 * Replace undici's opaque `TypeError: fetch failed` with a message that names
 * the underlying cause (e.g. `fetch failed (ECONNRESET)`), keeping the original
 * as `cause`. Non-`fetch failed` errors pass through unchanged so existing
 * messages (size cap, SSRF, HTTP status) are preserved verbatim.
 */
function clarifyFetchError(error: unknown): Error {
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    const cause = (error as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    const causeMessage =
      cause && typeof cause === "object" ? (cause as { message?: unknown }).message : undefined;
    const detail =
      typeof causeCode === "string"
        ? causeCode
        : typeof causeMessage === "string"
          ? causeMessage
          : "network error";
    return new Error(`fetch failed (${detail})`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: FetchClientOptions) {
    this.dispatcher = buildProxyDispatcher(options.httpProxyUrl);
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
  }

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    if (this.stopped) throw new Error("FetchClient is stopped");
    // Each doFetch attempt is self-contained — it streams to a fresh temp file
    // and unlinks any partial output on failure — so retrying the whole attempt
    // is clean. Retries cover only transient connection-phase failures (the GET
    // is idempotent); a deterministic error is rethrown on the first try.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.doFetch(url, options);
      } catch (error) {
        const transient = transientFetchErrorCode(error);
        if (transient === undefined || this.stopped || attempt >= this.maxRetries) {
          throw clarifyFetchError(error);
        }
        await delay(this.retryBaseDelayMs * (attempt + 1));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Channel-neutral URL download: fetch a remote URL to a caller-supplied
   * output path, enforcing the same SSRF guard, size cap, retry, and proxy as
   * {@link fetch}. Throws on non-2xx status after deleting the partial file.
   * Use this for Discord CDN attachments (via `AttachmentMeta.remoteUrl`) and
   * other cases where the download URL is known up front.
   */
  async downloadUrl(params: {
    url: string;
    outputPath: string;
    sizeLimit?: number;
  }): Promise<{ sizeBytes: number; contentType?: string }> {
    const result = await this.fetch(params.url, {
      outputPath: params.outputPath,
      maxBytes: params.sizeLimit,
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      await unlink(result.path).catch(() => {});
      throw new Error(`HTTP ${result.statusCode}`);
    }
    return { sizeBytes: result.sizeBytes, contentType: result.contentType };
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
