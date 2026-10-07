/**
 * Request progress (ARCHITECTURE.md §8 "Late input"): where the agent's
 * in-flight LLM request is, for the abort rule of a redo or an abort-and-
 * interject. A request aborted before its first stream event has not written
 * its prompt to the provider's cache and may be billed anyway, so the caller
 * waits for that event (or the request's end) before aborting, unless the
 * request is still queued for scheduler admission and nothing was sent.
 *
 * Fed by the factory: {@link withRequestProgress} wraps the session's stream fn
 * (begin / end of a request), the Layer-0 attempt tap reports the first raw
 * event of an attempt ({@link RequestProgress.noteAttemptEvent}), and the
 * admission wait reports that the request left the scheduler queue.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";

export type RequestPhase =
  /** No request in flight. */
  | "idle"
  /** Called, still waiting for scheduler admission: nothing was sent. */
  | "queued"
  /** Sent (admitted), no stream event yet. */
  | "awaiting_first_event"
  /** At least one stream event arrived. */
  | "streaming";

export class RequestProgress {
  private inFlight = 0;
  private admitted = false;
  private firstEvent = false;
  private waiters = new Set<() => void>();
  /** Set when the session has no scheduler: a request counts as sent at once. */
  constructor(private readonly admissionTracked = true) {}

  get phase(): RequestPhase {
    if (this.inFlight === 0) return "idle";
    if (this.firstEvent) return "streaming";
    if (this.admissionTracked && !this.admitted) return "queued";
    return "awaiting_first_event";
  }

  /** A request started (the stream fn was called). */
  begin(): void {
    this.inFlight += 1;
    this.admitted = false;
    this.firstEvent = false;
  }

  /** The request was admitted by the scheduler (about to be sent). */
  noteAdmitted(): void {
    this.admitted = true;
  }

  /** A raw stream event of the current attempt arrived. */
  noteAttemptEvent(): void {
    if (this.firstEvent) return;
    this.firstEvent = true;
    this.admitted = true;
    this.wake();
  }

  /** The request settled (its outer stream ended). */
  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) {
      this.admitted = false;
      this.firstEvent = false;
    }
    this.wake();
  }

  /**
   * Resolves once the in-flight request produced its first event or ended, or
   * after `timeoutMs`. Immediately when no request is waiting for its first event.
   */
  waitForFirstEventOrEnd(timeoutMs: number): Promise<void> {
    if (this.phase !== "awaiting_first_event") return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.phase === "awaiting_first_event") return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Wrap a stream fn so every call is tracked as one request of `progress`. */
export function withRequestProgress(fn: StreamFn, progress: () => RequestProgress | undefined): StreamFn {
  return (async (model: unknown, context: unknown, options: unknown) => {
    const tracker = progress();
    tracker?.begin();
    let stream;
    try {
      stream = await (fn as (...args: unknown[]) => unknown)(model, context, options);
    } catch (error) {
      tracker?.end();
      throw error;
    }
    const result = (stream as { result?: () => Promise<unknown> }).result;
    if (tracker && typeof result === "function") {
      result.call(stream).then(
        () => tracker.end(),
        () => tracker.end(),
      );
    } else {
      tracker?.end();
    }
    return stream;
  }) as unknown as StreamFn;
}
