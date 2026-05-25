import { createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

export interface FetchClientOptions {
  maxConcurrency: number;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface FetchOptions {
  maxBytes?: number;
  outputPath?: string;
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

  constructor(private readonly options: FetchClientOptions) {}

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
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "MikuAgent/1.0" },
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
    } finally {
      this.active--;
      this.processQueue();
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
