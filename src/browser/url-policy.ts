// Tool-layer URL/scheme policy (spec §5.5). http/https only; reject file://,
// chrome://, data:, javascript:, about:, blob:, etc. This is defense-in-depth on
// top of the network-layer RFC1918 block (docker/browser-egress-rules.sh), which
// remains the real SSRF boundary — redirects are followed by the browser but
// still land on IPs the network layer filters.

import { BrowserError } from "./errors.js";

export function assertBrowserUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("bad_url", `Not a valid absolute URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError(
      "bad_url",
      `Only http/https URLs are allowed (got "${url.protocol}"). Schemes like file:, chrome:, data:, and javascript: are blocked.`,
    );
  }
  return url.toString();
}
