export interface FetchClientOptions {
  maxConcurrency: number;
  timeoutMs: number;
  maxResponseBytes: number;
}

export class ConcurrencyLimitedFetchClient {
  private active = 0;
  private readonly queue: Array<{
    resolve: (value: FetchResult) => void;
    reject: (reason: unknown) => void;
    url: string;
    maxBytes?: number;
  }> = [];
  private stopped = false;

  constructor(private readonly options: FetchClientOptions) {}

  async fetch(url: string, options?: { maxBytes?: number }): Promise<FetchResult> {
    if (this.stopped) throw new Error("FetchClient is stopped");
    if (this.active < this.options.maxConcurrency) {
      return this.doFetch(url, options?.maxBytes);
    }
    return new Promise<FetchResult>((resolve, reject) => {
      this.queue.push({ resolve, reject, url, maxBytes: options?.maxBytes });
    });
  }

  stop(): void {
    this.stopped = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(new Error("FetchClient stopped"));
    }
  }

  private async doFetch(url: string, maxBytes?: number): Promise<FetchResult> {
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
        const limit = maxBytes ?? this.options.maxResponseBytes;
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        if (!response.body) {
          return {
            data: Buffer.alloc(0),
            contentType: response.headers.get("content-type") ?? undefined,
            finalUrl: response.url,
            statusCode: response.status,
          };
        }
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          totalBytes += chunk.byteLength;
          if (totalBytes > limit) {
            controller.abort();
            throw new Error(`Response exceeded ${limit} bytes`);
          }
          chunks.push(chunk);
        }
        return {
          data: Buffer.concat(chunks),
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
      this.doFetch(item.url, item.maxBytes).then(item.resolve, item.reject);
    }
  }
}

export interface FetchResult {
  data: Buffer;
  contentType?: string;
  finalUrl: string;
  statusCode: number;
}
