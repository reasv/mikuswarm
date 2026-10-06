import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { guardedFetch } from "./ssrf.js";
import { isYotsubaHost } from "../yotsuba/url.js";

const WEB_FETCH_SECURITY_NOTE =
  "When the egress guard is enabled, blocks localhost/private IPs before each request and redirect. DNS is not pinned, so this is defense-in-depth rather than a complete SSRF sandbox; the network firewall is the real boundary.";

/**
 * Per-request wall-clock timeout. web_fetch runs inside a LIVE agent session, so
 * without this a slow host — or one sitting in the per-host limiter's backoff —
 * would block the session indefinitely. Same 30s default as the other direct
 * guardedFetch callers (send_message media, set_profile avatars, danbooru JSON).
 */
const WEB_FETCH_TIMEOUT_MS = 30_000;

export interface WebRequestOptions {
  /** Injectable guarded transport for deterministic tests. */
  fetchImpl?: typeof guardedFetch;
  timeoutMs?: number;
}
export interface WebFetchToolOptions extends WebRequestOptions {
  /** When true, append a hint for recognized 4chan URLs suggesting the yotsuba tool. */
  yotsubaEnabled?: boolean;
  /** Extra hostnames to treat as 4chan (passed to isYotsubaHost). */
  yotsubaExtraHosts?: readonly string[];
}

export function createWebFetchTool(opts: WebFetchToolOptions = {}): AgentTool {
  return {
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a URL and return readable markdown-like text.",
    parameters: Type.Object({
      url: Type.String(),
      max_chars: Type.Optional(Type.Number({ minimum: 1, maximum: 200_000 })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const args = params as { url: string; max_chars?: number };
      const url = normalizeHttpUrl(args.url);
      const { raw, contentType, status } = await readWebResponse(url, opts, signal, "Fetch");
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      const maxChars = args.max_chars ?? 50_000;
      let outputText = text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
      if (opts.yotsubaEnabled) {
        try {
          const parsed = new URL(url);
          if (isYotsubaHost(parsed.hostname, opts.yotsubaExtraHosts)) {
            outputText += "\n[This is a 4chan URL. Use the yotsuba tool for richer browsing with reply chains, file views, and pagination.]";
          }
        } catch { /* invalid URL — ignore */ }
      }
      return {
        content: [{ type: "text", text: outputText }],
        details: {
          url,
          status,
          contentType,
          truncated: text.length > maxChars,
          securityNote: WEB_FETCH_SECURITY_NOTE,
        },
      };
    },
  };
}

export function createWebSearchTool(opts: WebRequestOptions = {}): AgentTool {
  return {
    name: "web_search",
    label: "Search web",
    description: "Search the web through DuckDuckGo's HTML endpoint and return result links.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const args = params as { query: string; limit?: number };
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", args.query);
      const { raw: html } = await readWebResponse(url.toString(), opts, signal, "Search");
      if (/<(?:form|div|section)[^>]+(?:id|class)=["'][^"']*(?:anomaly-modal|challenge-form|captcha-container)[^"']*["']|<form[^>]+action=["'][^"']*\/(?:anomaly|challenge)\.js(?:\?[^"']*)?["']/i.test(html)) {
        throw new Error("Search blocked by DuckDuckGo's bot check. Use another available search tool or browser.");
      }
      const parsed = parseDuckDuckGoResults(html);
      const noResults = /class=["'][^"']*(?:no-results|result--no-result)|No results found/i.test(html);
      if (!parsed.length && !noResults) {
        throw new Error("Search response could not be parsed as results. Use another available search tool or browser.");
      }
      const results = parsed.slice(0, args.limit ?? 5);
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join("\n\n")
              : "No search results found.",
          },
        ],
        details: {
          query: args.query,
          results,
        },
      };
    },
  };
}

/** Bounds admission, headers, and body reading; always cancels unfinished bodies. */
async function readWebResponse(url: string, opts: WebRequestOptions, caller: AbortSignal | undefined, operation: string) {
  const timeoutMs = opts.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  if (caller?.aborted) onCallerAbort();
  const timer = setTimeout(() => controller.abort(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let complete = false;
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  try {
    controller.signal.throwIfAborted();
    const pending = (opts.fetchImpl ?? guardedFetch)(url, { signal: controller.signal, headers: { "user-agent": "mikuswarm/0.1" } });
    // Even a transport that settles after cancellation must not abandon its body.
    void pending.then((late) => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    response = await bounded(pending);
    if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) for (;;) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error(`${operation} response exceeds the 4 MiB size limit`);
      chunks.push(value);
    }
    complete = true;
    return { raw: Buffer.concat(chunks).toString("utf8"), contentType: response.headers.get("content-type") ?? "", status: response.status };
  } finally {
    clearTimeout(timer); caller?.removeEventListener("abort", onCallerAbort);
    if (!complete) {
      if (reader) void reader.cancel().catch(() => {});
      else void response?.body?.cancel().catch(() => {});
      // Release guarded transport's admission slot even if cancellation hangs.
      controller.abort();
    }
    if (reader) reader.releaseLock();
  }
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return url.toString();
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function parseDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result /g).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const snippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    results.push({
      title: htmlToText(link[2] ?? ""),
      url: decodeDuckDuckGoUrl(decodeHtml(link[1] ?? "")),
      snippet: snippet ? htmlToText(snippet[1] ?? "") : "",
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return value;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
