import type { ServerResponse } from "node:http";
import { redactSecrets } from "../../config/index.js";

/**
 * Serialize `body` to JSON, run it through the secret-redaction pass (same util
 * the context dumps and logs use), and send it. Redaction on the way out is a
 * hard guarantee of the spec (§8): no registered secret reaches the console.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = redactSecrets(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json);
}

/**
 * A JSON error envelope: `{ error: { status, message, ...details } }`.
 *
 * Every error response across the server shares this single shape so the BFF and
 * console can branch on `error.status` (the HTTP status) and surface
 * `error.message` (human-readable) uniformly. The optional `details` lets a route
 * attach structured, route-specific fields *inside* the same envelope rather than
 * hanging sibling keys off the top level (which would collide conceptually with
 * `error.status` and break the one-shape invariant). Pick non-colliding field
 * names for `details` — e.g. the abort 409 carries `sessionId` and `sessionStatus`
 * (NOT a bare `status`, which would shadow the HTTP `error.status`).
 */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { status, message, ...details } });
}
