// =============================================================================
// Per-session live (tentative) event bus — spec LLM-FAILURE-HANDLING §4.2.
//
// Layer-0 buffers every LLM attempt and forwards events only on a clean
// terminal `done` (the §4.1 commit point), so the authoritative agent-event
// stream no longer carries tokens as they arrive. The maintainer still wants
// to SEE tokens stream in the console, so the factory wires the Layer-0
// observability tap to this bus and the console SSE merges it with the
// existing agent-event stream — marked TENTATIVE (event kinds distinct from
// the authoritative `message_update`s). Nothing from this bus is persisted;
// payloads pass the same externalize/redact pipeline as all SSE writes (the
// SSE layer owns that).
// =============================================================================

/** A tap event published for one session. Attempt numbers are 1-based. */
export type SessionLiveEvent =
  | {
      /** A raw per-attempt LLM stream event, NOT yet committed (tentative). */
      type: "tentative_event";
      attempt: number;
      /** The raw AssistantMessageEvent (opaque here; redacted at the SSE edge). */
      event: unknown;
    }
  | {
      /** A (possibly partial) attempt was discarded; the request is retrying. */
      type: "attempt_discarded";
      attempt: number;
      reason: string;
    };

type Listener = (event: SessionLiveEvent) => void;

/**
 * Synchronous in-process fan-out, keyed by session id. Publishing is
 * best-effort and observe-only: listener exceptions are swallowed so a console
 * subscriber can never affect the run (mirroring the tap contract in
 * `withRequestRetry`). Sessions with no subscribers cost one Map lookup.
 */
export class SessionLiveEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(sessionId: string, event: SessionLiveEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        /* observe-only */
      }
    }
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }
}
