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

/** A JSON error envelope: `{ error: { status, message } }`. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { status, message } });
}
