import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSecrets } from "../../config/index.js";
import { externalizeImages } from "../../agent/session-capture.js";

const HEARTBEAT_MS = 15_000;

export interface SseStream {
  /** Write a named event whose data is `payload` (redacted, images externalized). */
  send(event: string, payload: unknown): void;
  /** Write a comment line (`: text`) — used for the keep-alive heartbeat. */
  comment(text: string): void;
  /** End the stream and stop the heartbeat. Idempotent. */
  close(): void;
  /** Run `fn` when the client disconnects (or the stream is closed). */
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

/**
 * Open a Server-Sent-Events stream on `res` (spec §8). Sets the streaming
 * headers, emits a periodic heartbeat so idle proxies don't drop the
 * connection, and tears down cleanly when the client disconnects.
 *
 * Every payload passes through `externalizeImages` (so base64 image blocks
 * become refs, never crossing the wire) and `redactSecrets` — identical to the
 * persisted transcript, so the live and historical rollout views match.
 */
export function openSse(req: IncomingMessage, res: ServerResponse): SseStream {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Disable proxy buffering (nginx) so events flush immediately.
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  let closed = false;
  const closeFns: Array<() => void> = [];

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  // Don't keep the process alive solely for an idle SSE heartbeat.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const stream: SseStream = {
    get closed() {
      return closed;
    },
    send(event, payload) {
      if (closed) return;
      const data = redactSecrets(JSON.stringify(externalizeImages(payload)));
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    onClose(fn) {
      closeFns.push(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const fn of closeFns.splice(0)) {
        try {
          fn();
        } catch {
          /* best-effort teardown */
        }
      }
      res.end();
    },
  };

  req.on("close", () => stream.close());
  return stream;
}
