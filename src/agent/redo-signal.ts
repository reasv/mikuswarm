/**
 * Session redo signal (spec REFUSAL-HANDLING §8.4): a tool cannot rewind the
 * agent loop from inside it, so the gate (or the runner itself) files a redo
 * request here and aborts the run; the runner takes the request after the run
 * settles, forks the session and continues.
 */

export interface RedoRequest {
  kind: "refusal" | "contract";
  /** The gated call (a refusal at a send). */
  toolCallId?: string;
  checkCode?: string;
  reason?: string;
  probability?: number;
  decisionEvaluationId?: number;
  refusedModel?: string;
  ruleName?: string;
}

/** One per session: the gate requests, the runner takes. */
export class SessionRedoControl {
  private pending: RedoRequest | undefined;

  /** File a redo request. The first request wins until it is taken; later ones are dropped. */
  request(r: RedoRequest): void {
    if (this.pending === undefined) this.pending = { ...r };
  }

  /** The pending request, left in place. */
  peek(): RedoRequest | undefined {
    return this.pending;
  }

  /** The pending request, cleared. */
  take(): RedoRequest | undefined {
    const r = this.pending;
    this.pending = undefined;
    return r;
  }
}
