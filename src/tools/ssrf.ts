import { lookup } from "node:dns/promises";
import net from "node:net";
import { acquireHttpSlot, hostOf, noteHttpResponse } from "./http-limiter.js";

/**
 * WHATWG redirect statuses the manual loop follows. Other 3xx (300, 304, 305,
 * 306) are NOT redirects to follow — e.g. a 304 answers a conditional request —
 * and are returned to the caller like any final response.
 */
const REDIRECT_FOLLOW_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Statuses whose responses carry no body per the fetch spec. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// =============================================================================
// App-layer egress guard (defense-in-depth SSRF protection).
//
// This is the single home for the application-layer SSRF guard. Every
// caller-supplied outbound fetch routes through `guardedFetch` (directly, or via
// `FetchClient`), so the redirect-revalidation loop and the
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
  /** HTTP method; defaults to GET. */
  method?: string;
  /** Request body (e.g. a JSON string for a POST). */
  body?: BodyInit;
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
 * private/metadata host. Capped at `maxHops` redirects. The manual loop mirrors
 * WHATWG fetch redirect semantics (what undici's native `redirect: "follow"`
 * does): on a cross-origin hop (scheme+host+port, compared hop-by-hop against the
 * previous URL) it strips credential headers (`authorization`,
 * `proxy-authorization`, `cookie`, `host` — undici's exact strip list) so a
 * redirect cannot exfiltrate a caller's credentials to a third-party host; and a
 * 303 (or a 301/302 answering a POST) is followed as a bodyless GET with the
 * body-describing headers dropped — only 307/308 preserve method + body.
 *
 * Guard DISABLED: validates only scheme/credentials, then issues one native
 * `redirect: "follow"` fetch (no DNS, no per-hop revalidation) — the network
 * firewall is the boundary, and undici applies the same redirect semantics
 * natively.
 *
 * Returns the final non-redirect `Response` so callers stream the body as usual.
 *
 * Every call also passes through the per-host HTTP limiter (`http-limiter.ts`):
 * it acquires a per-host admission slot (bounded by the per-host + global caps and
 * any active backoff) before the request and records the response status so a
 * 429/503 from a host backs off all subsequent callers to that host. In the
 * guard-enabled loop the slot follows the chain: when a hop lands on a different
 * host, the previous host's slot is released and a slot on the hop host is
 * acquired (gating on THAT host's backoff) before the hop is fetched — so a
 * backed-off host is not reachable via redirects and per-host concurrency counts
 * the host actually being hit. In the guard-disabled path the (single) final
 * response's status is recorded against the final URL (`response.url`), not the
 * original one, for the same reason. This is the single egress chokepoint, so the
 * limiter applies whether or not the SSRF address guard is enabled.
 *
 * The FINAL response's slot is NOT released when headers arrive: it is tied to
 * body settlement (close/error/cancel — see {@link tieReleaseToBodySettlement}),
 * so the per-host/global caps bound the whole socket phase of a download, not
 * just time-to-first-byte. Followed redirect responses still release eagerly at
 * the host swap (their bodies are cancelled before the hop). Callers must
 * therefore consume or cancel the body of every returned response — all in-repo
 * callers do; as a backstop the slot is also released when the caller's `signal`
 * aborts (the underlying body is dead at that point anyway).
 */
export async function guardedFetch(url: string, options: GuardedFetchOptions = {}): Promise<Response> {
  if (!egressGuardEnabled) {
    const release = await acquireHttpSlot(url, options.signal);
    try {
      await assertPublicHttpUrl(url);
      const response = await globalThis.fetch(
        url,
        buildInit(options, "follow", options.method, options.body, withDefaultUserAgent(options.headers)),
      );
      // Native "follow" lands on the final URL; attribute the status to the host
      // that actually produced it, not the original one.
      noteHttpResponse(response.url || url, response.status, response.headers.get("retry-after"));
      return tieReleaseToBodySettlement(response, release, options.signal);
    } catch (error) {
      release();
      throw error;
    }
  }
  const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS;
  let current = url;
  let currentHost = hostOf(current);
  let method = options.method;
  let body = options.body;
  const headers = withDefaultUserAgent(options.headers);
  // Per-host slot accounting across the chain: exactly one slot is held at a time;
  // it is released either when the chain moves to a different host (swap below),
  // when the final response's body settles (wrapper on the return path), or in
  // the `catch` on failure. Releases are idempotent, so the abort/error paths
  // (acquire rejection mid-swap, fetch failure mid-chain) can never double-count.
  let release = await acquireHttpSlot(current, options.signal);
  try {
    for (let hop = 0; ; hop++) {
      if (hop > maxHops) throw new Error("Too many redirects.");
      await assertPublicHttpUrl(current);
      const response = await globalThis.fetch(current, buildInit(options, "manual", method, body, headers));
      noteHttpResponse(current, response.status, response.headers.get("retry-after"));
      if (!REDIRECT_FOLLOW_STATUSES.has(response.status)) {
        return tieReleaseToBodySettlement(response, release, options.signal);
      }
      const location = response.headers.get("location");
      if (!location) {
        // Don't leak the response socket on the error path.
        await response.body?.cancel().catch(() => {});
        throw new Error(`Redirect ${response.status} missing location header.`);
      }
      // Discard the redirect response body before following the next hop.
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, current).toString();

      // WHATWG fetch redirect semantics: a 303 — or a 301/302 answering a POST —
      // is followed as a bodyless GET; only 307/308 preserve method + body.
      const effectiveMethod = (method ?? "GET").toUpperCase();
      if (
        (response.status === 303 && effectiveMethod !== "GET" && effectiveMethod !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && effectiveMethod === "POST")
      ) {
        method = "GET";
        body = undefined;
        deleteHeaders(headers, REQUEST_BODY_HEADERS);
      }
      // Cross-origin hop (vs the PREVIOUS url, not the first): strip credential
      // headers, mirroring undici's native redirect handling.
      if (new URL(current).origin !== new URL(next).origin) {
        deleteHeaders(headers, CROSS_ORIGIN_STRIPPED_HEADERS);
      }
      // Hop host change: release the previous host's slot and gate on the hop
      // host's backoff/caps before fetching it.
      const nextHost = hostOf(next);
      if (nextHost !== currentHost) {
        release();
        release = await acquireHttpSlot(next, options.signal);
        currentHost = nextHost;
      }
      current = next;
    }
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Tie a per-host limiter slot's release to the settlement of `response`'s body,
 * so the slot is held for the whole streaming phase (caps bound sockets, not
 * just TTFB — spec §8.2/§9.5). Release fires when the body closes (fully read),
 * errors, or is cancelled; immediately when there is no body to stream. As a
 * backstop it also fires when `signal` aborts — an abort kills the underlying
 * body whether or not anyone is reading, so an abandoned response behind a
 * caller's timeout controller can't hold the slot. `release` is idempotent.
 */
function tieReleaseToBodySettlement(response: Response, release: () => void, signal?: AbortSignal): Response {
  const body = response.body;
  if (!body || NULL_BODY_STATUSES.has(response.status)) {
    // Nothing to stream (or a null-body status from a stub): settle now.
    void body?.cancel().catch(() => {});
    release();
    return response;
  }
  const reader = body.getReader();
  const releaseAndUnhook = () => {
    signal?.removeEventListener("abort", releaseAndUnhook);
    release();
  };
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseAndUnhook();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        releaseAndUnhook();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseAndUnhook();
      await reader.cancel(reason).catch(() => {});
    },
  });
  const wrappedResponse = new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // The Response constructor can't carry these; preserve what callers read.
  Object.defineProperty(wrappedResponse, "url", { value: response.url });
  Object.defineProperty(wrappedResponse, "redirected", { value: response.redirected });
  signal?.addEventListener("abort", releaseAndUnhook, { once: true });
  return wrappedResponse;
}

/**
 * Credential-bearing headers stripped on a cross-origin redirect hop. This is
 * undici's exact list for native `redirect: "follow"` (the WHATWG spec mandates
 * `authorization`; undici additionally strips `proxy-authorization`, `cookie`,
 * and `host`, and we mirror it so guard-on and guard-off behave identically).
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "proxy-authorization", "cookie", "host"];

/** Body-describing headers dropped when a redirect converts the request to GET. */
const REQUEST_BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];

function deleteHeaders(headers: Record<string, string>, names: readonly string[]): void {
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase())) delete headers[key];
  }
}

function buildInit(
  options: GuardedFetchOptions,
  redirect: RequestRedirect,
  method: string | undefined,
  body: BodyInit | undefined,
  headers: Record<string, string>,
): RequestInit {
  return {
    signal: options.signal,
    redirect,
    ...(method ? { method } : {}),
    ...(body !== undefined ? { body } : {}),
    // Default a User-Agent only when the caller didn't supply one (case-insensitive),
    // so a tool's own User-Agent isn't duplicated under a different-case key.
    headers,
    // Node's native fetch is built on undici and accepts a dispatcher at runtime,
    // but the type is not in the lib.dom Request init.
    ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
  } as RequestInit;
}

function withDefaultUserAgent(headers: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...headers };
  const hasUserAgent = Object.keys(merged).some((key) => key.toLowerCase() === "user-agent");
  if (!hasUserAgent) merged["User-Agent"] = "MikuAgent/1.0";
  return merged;
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
