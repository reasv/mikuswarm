import { lookup } from "node:dns/promises";
import net from "node:net";

// =============================================================================
// App-layer egress guard (defense-in-depth SSRF protection).
//
// This is the single home for the application-layer SSRF guard. Every
// caller-supplied outbound fetch routes through `guardedFetch` (directly, or via
// `ConcurrencyLimitedFetchClient`), so the redirect-revalidation loop and the
// private-address predicate exist in exactly one place.
//
// The guard is DEFENSE-IN-DEPTH, not the real boundary: DNS is resolved here but
// not pinned, so a resolve-then-connect race is theoretically bypassable. The
// authoritative boundary is the network layer (docker/egress-rules.sh drops
// RFC1918/link-local/loopback on the container bridge). Deployments where that
// firewall is in force can disable this guard with `network.ssrf_guard = false`
// to drop the per-request DNS + redirect-revalidation overhead — see
// ARCHITECTURE.md "Network egress & SSRF".
// =============================================================================

/** Redirect-hop cap for the guard's manual redirect loop. */
const MAX_REDIRECT_HOPS = 5;

let egressGuardEnabled = true;

/**
 * Enable/disable the app-layer address filtering. Called once at startup from
 * `config.network.ssrf_guard` (default true). When disabled, `assertPublicHttpUrl`
 * keeps only the cheap scheme/credential hygiene checks and `guardedFetch` falls
 * back to a single native `redirect: "follow"` fetch — the network firewall is
 * expected to block private egress instead.
 */
export function setEgressGuardEnabled(enabled: boolean): void {
  egressGuardEnabled = enabled;
}

export function isEgressGuardEnabled(): boolean {
  return egressGuardEnabled;
}

/**
 * Validate a caller-supplied URL before fetching it.
 *
 * Always enforces http/https and rejects embedded credentials (input hygiene the
 * tools rely on regardless of the guard). When the guard is enabled, it also
 * resolves the host and rejects any private/loopback/link-local/metadata address.
 */
export async function assertPublicHttpUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  if (url.username || url.password) throw new Error("URLs with credentials are not supported.");
  // Address-level filtering is the part that can be switched off when the network
  // layer already blocks private egress; the checks above are always-on hygiene.
  if (!egressGuardEnabled) return;
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

export interface GuardedFetchOptions {
  signal?: AbortSignal;
  /** Extra request headers (e.g. a tool-specific User-Agent). */
  headers?: Record<string, string>;
  /**
   * undici Dispatcher (e.g. an http(s) ProxyAgent). Typed loosely so this module
   * has no undici dependency; Node's native fetch accepts it at runtime.
   */
  dispatcher?: unknown;
  /** Redirect-hop cap; defaults to {@link MAX_REDIRECT_HOPS}. */
  maxHops?: number;
}

/**
 * The single guarded-fetch primitive shared by every caller-supplied download
 * (web_fetch, the shared fetch client, send_message/set_profile media, image
 * references, …).
 *
 * Guard ENABLED: uses `redirect: "manual"` and re-runs `assertPublicHttpUrl` on
 * every `Location` hop before following it, so a public URL cannot 302 to a
 * private/metadata host. Capped at `maxHops` redirects.
 *
 * Guard DISABLED: validates only scheme/credentials, then issues one native
 * `redirect: "follow"` fetch (no DNS, no per-hop revalidation) — the network
 * firewall is the boundary.
 *
 * Returns the final non-redirect `Response` so callers stream the body as usual.
 */
export async function guardedFetch(url: string, options: GuardedFetchOptions = {}): Promise<Response> {
  if (!egressGuardEnabled) {
    await assertPublicHttpUrl(url);
    return globalThis.fetch(url, buildInit(options, "follow"));
  }
  const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS;
  let current = url;
  for (let hop = 0; ; hop++) {
    if (hop > maxHops) throw new Error("Too many redirects.");
    await assertPublicHttpUrl(current);
    const response = await globalThis.fetch(current, buildInit(options, "manual"));
    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect ${response.status} missing location header.`);
    // Discard the redirect response body before following the next hop.
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
}

function buildInit(options: GuardedFetchOptions, redirect: RequestRedirect): RequestInit {
  return {
    signal: options.signal,
    redirect,
    headers: { "User-Agent": "MikuAgent/1.0", ...options.headers },
    // Node's native fetch is built on undici and accepts a dispatcher at runtime,
    // but the type is not in the lib.dom Request init.
    ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
  } as RequestInit;
}

function isRedirectStatus(status: number): boolean {
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
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a! >= 224
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
