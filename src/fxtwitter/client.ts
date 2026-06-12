import type { Dispatcher } from "undici";
import { guardedFetch } from "../tools/ssrf.js";
import { buildProxyDispatcher } from "../enrichment/fetch-client.js";
import type { FxApiResponse, FxApiTweet } from "./types.js";

/**
 * FxTwitter API client (spec/FXTWITTER-ENRICHMENT.md §3). One instance is
 * shared by the enrichment worker and the `x_fetch` tool. All requests route
 * through `guardedFetch` (SSRF guard, per-host admission, unconditional
 * 429/503 backoff) with the shared proxy dispatcher and a per-request timeout.
 */

const FXTWITTER_USER_AGENT = "MikuAgent/0.1 (mikuswarm)";

/**
 * Response-body byte cap for the JSON status endpoint. A tweet payload is a
 * few KB; 4 MiB leaves generous headroom while refusing pathological bodies.
 */
const FXTWITTER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface FxTwitterClientOptions {
  /** API base, no trailing slash (default https://api.fxtwitter.com). */
  apiBase: string;
  timeoutMs: number;
  httpProxyUrl?: string;
}

export class FxTwitterClient {
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: FxTwitterClientOptions) {
    this.dispatcher = buildProxyDispatcher(options.httpProxyUrl);
  }

  /**
   * Fetch one tweet. Throws on any failure (HTTP non-2xx, envelope
   * `code != 200`, timeout, parse error) with FxTwitter's `message` when
   * available. Parsing is tolerant — every field optional, unknowns ignored.
   */
  async fetchStatus(statusId: string, screenName?: string): Promise<FxApiTweet> {
    const path = screenName ? `/${screenName}/status/${statusId}` : `/status/${statusId}`;
    const url = `${this.options.apiBase}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await guardedFetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": FXTWITTER_USER_AGENT,
        },
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      clearTimeout(timeout);
      if ((error as { name?: string })?.name === "AbortError") {
        throw new Error(`FxTwitter request timed out after ${this.options.timeoutMs}ms`);
      }
      throw error;
    }
    try {
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > FXTWITTER_MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`FxTwitter response too large: ${declared} bytes`);
      }
      const text = await this.readBounded(response, controller);
      let parsed: FxApiResponse;
      try {
        parsed = JSON.parse(text) as FxApiResponse;
      } catch {
        throw new Error(`FxTwitter returned non-JSON (HTTP ${response.status})`);
      }
      // The envelope is authoritative: anything but code 200 (or HTTP non-2xx)
      // is a fetch failure with FxTwitter's message as the error.
      if (!response.ok || parsed.code !== 200) {
        const detail = parsed.message ? `: ${parsed.message}` : "";
        throw new Error(`FxTwitter error (HTTP ${response.status}, code ${parsed.code ?? "?"})${detail}`);
      }
      if (!parsed.tweet) {
        throw new Error("FxTwitter response missing tweet body");
      }
      return parsed.tweet;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBounded(response: Response, controller: AbortController): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > FXTWITTER_MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new Error(`FxTwitter response exceeded ${FXTWITTER_MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
}
