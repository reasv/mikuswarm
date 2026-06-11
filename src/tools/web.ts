import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { guardedFetch } from "./ssrf.js";

const WEB_FETCH_SECURITY_NOTE =
  "When the egress guard is enabled, blocks localhost/private IPs before each request and redirect. DNS is not pinned, so this is defense-in-depth rather than a complete SSRF sandbox; the network firewall is the real boundary.";

/**
 * Per-request wall-clock timeout. web_fetch runs inside a LIVE agent session, so
 * without this a slow host — or one sitting in the per-host limiter's backoff —
 * would block the session indefinitely. Same 30s default as the other direct
 * guardedFetch callers (send_message media, set_profile avatars, danbooru JSON).
 */
const WEB_FETCH_TIMEOUT_MS = 30_000;

export function createWebFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a URL and return readable markdown-like text.",
    parameters: Type.Object({
      url: Type.String(),
      max_chars: Type.Optional(Type.Number({ minimum: 1, maximum: 200_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { url: string; max_chars?: number };
      const url = normalizeHttpUrl(args.url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
      let contentType: string;
      let raw: string;
      let status: number;
      try {
        const response = await guardedFetch(url, {
          signal: controller.signal,
          headers: { "user-agent": "mikuswarm/0.1" },
        });
        if (!response.ok) {
          // Settle the body so the per-host limiter slot is freed promptly.
          await response.body?.cancel().catch(() => {});
          throw new Error(`Fetch failed with HTTP ${response.status}`);
        }
        contentType = response.headers.get("content-type") ?? "";
        status = response.status;
        raw = await response.text();
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") {
          throw new Error(`Fetch timed out after ${WEB_FETCH_TIMEOUT_MS}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      const maxChars = args.max_chars ?? 50_000;
      return {
        content: [{ type: "text", text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text }],
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

export function createWebSearchTool(): AgentTool {
  return {
    name: "web_search",
    label: "Search web",
    description: "Search the web through DuckDuckGo's HTML endpoint and return result links.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { query: string; limit?: number };
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", args.query);
      const response = await fetch(url, { headers: { "user-agent": "mikuswarm/0.1" } });
      if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);
      const html = await response.text();
      const results = parseDuckDuckGoResults(html).slice(0, args.limit ?? 5);
      if (html.trim() && results.length === 0) {
        console.warn(JSON.stringify({
          level: "warn",
          component: "mikuswarm.web_search",
          message: "duckduckgo_parse_returned_no_results",
          time: new Date().toISOString(),
          query: args.query,
          responseBytes: Buffer.byteLength(html),
        }));
      }
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join("\n\n")
              : "No search results parsed.",
          },
        ],
        details: {
          query: args.query,
          results,
          warning: html.trim() && results.length === 0 ? "DuckDuckGo HTML parsing returned no results." : undefined,
        },
      };
    },
  };
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
