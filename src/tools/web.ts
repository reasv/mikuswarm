import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { lookup } from "node:dns/promises";
import net from "node:net";

const WEB_FETCH_SECURITY_NOTE =
  "Blocks localhost/private IPs before each request and redirect. DNS is not pinned, so this is defense-in-depth rather than a complete SSRF sandbox.";

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
      const response = await guardedFetch(url);
      if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      const maxChars = args.max_chars ?? 50_000;
      return {
        content: [{ type: "text", text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text }],
        details: {
          url,
          status: response.status,
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

async function guardedFetch(url: string, redirects = 0): Promise<Response> {
  if (redirects > 5) throw new Error("Too many redirects.");
  await assertPublicHttpUrl(url);
  const response = await fetch(url, {
    headers: { "user-agent": "mikuswarm/0.1" },
    redirect: "manual",
  });
  if (isRedirect(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect ${response.status} missing location header.`);
    return guardedFetch(new URL(location, url).toString(), redirects + 1);
  }
  return response;
}

async function assertPublicHttpUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("URLs with credentials are not supported.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Local addresses are blocked.");
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Unable to resolve host: ${url.hostname}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new Error(`Local or private address is blocked: ${url.hostname}`);
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeIp(address);
  if (net.isIP(normalized) === 4) return isBlockedIpv4(normalized);
  if (net.isIP(normalized) === 6) return isBlockedIpv6(normalized);
  return true;
}

function normalizeIp(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  const hexMapped = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hexMapped) return address;
  const high = Number.parseInt(hexMapped[1]!, 16);
  const low = Number.parseInt(hexMapped[2]!, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return address;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("ff")
  );
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
