import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * Authorize a request against the optional bearer token (spec §8). When no token
 * is configured, every request is allowed (localhost operator console).
 *
 * The token is accepted via EITHER the `Authorization: Bearer <t>` header OR a
 * `?token=<t>` query param. The query form exists because the browser
 * `EventSource` API (used for the SSE stream endpoint) cannot set request
 * headers — see the SSE-vs-WebSockets rationale in ARCHITECTURE.md.
 */
export function isAuthorized(
  req: IncomingMessage,
  url: URL,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;

  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    if (safeEqual(header.slice("Bearer ".length), expectedToken)) return true;
  }

  const queryToken = url.searchParams.get("token");
  if (queryToken && safeEqual(queryToken, expectedToken)) return true;

  return false;
}

/** Constant-time string compare. Differing lengths are an immediate mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
