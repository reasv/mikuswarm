import type { LlmErrorClass } from "./request-retry.js";
import type { PriorityClass } from "./scheduler.js";

// =============================================================================
// In-memory LLM request ring (spec LLM-FAILURE-HANDLING §9.2).
//
// Records every settled Layer-0 attempt for the console's `GET
// /api/llm-requests`. Deliberately NOT durable: the LLM gateway holds the
// authoritative request/response log upstream; this ring adds only what
// the gateway cannot see — session/priority attribution, admission wait, attempt
// numbering, and failures that never reached the wire (admission aborts,
// empty streams).
// =============================================================================

export interface LlmRequestRecord {
  /** Epoch ms the attempt settled. */
  ts: number;
  sessionId?: string;
  sessionType?: string;
  group?: string;
  /**
   * Wire id of the REQUESTED (head) model descriptor — unchanged from before;
   * kept for backward compat with ring consumers that pre-date served-model
   * attribution. Under transparent fallback this is the head, not the member
   * that actually served the attempt.
   */
  model: string;
  /**
   * Logical id (config block name) of the REQUESTED model for this attempt
   * (head or per-user selected). Absent when the retry context is not wired
   * (callers that construct the retry context without wiring the getter; no
   * current production caller omits it).
   */
  requestedModel?: string;
  /**
   * Logical id (config block name) of the chain member that ACTUALLY served
   * this attempt (from `buildModelFallback`'s `onResolve`). Absent for
   * attempts that never dispatched a wire call (budget-violation pre-flight,
   * admission-wait exhaustion before any dispatch) or when the getter is not
   * wired. When present and different from `requestedModel`, the attempt ran
   * on a fallback member rather than the requested head.
   */
  servedModel?: string;
  priority?: PriorityClass;
  /** 1-based attempt number within its Layer-0 retry loop. */
  attempt: number;
  /** Admission-queue wait of this attempt (ms), when a scheduler was in play. */
  admissionWaitMs?: number;
  /** Wall-clock from attempt start to settle (incl. admission wait). */
  durationMs: number;
  outcome: "done" | "error" | "aborted";
  status?: number;
  class?: LlmErrorClass;
  errorMessage?: string;
  /**
   * Usage of the committed response (spec TOKEN-USAGE-TRACKING §3.2). Present on
   * `done` outcomes, on failed attempts whose stream reported usage, and on an
   * attempt the caller aborted on the wire (with {@link estimated}); absent
   * otherwise (stub zeros, so absence means "not billed" rather than a
   * misleading 0). `cost` is `usage.cost.total` (USD).
   */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
  /**
   * True when {@link usage} is an estimate: the caller aborted the attempt on
   * the wire, so the output (and, without a reported usage, the input) was
   * estimated (ARCHITECTURE.md §8b "Aborted requests").
   */
  estimated?: boolean;
}

export const DEFAULT_LLM_REQUEST_RING_SIZE = 500;

/** Fixed-capacity ring; `list()` returns newest-first. */
export class LlmRequestRing {
  private readonly entries: LlmRequestRecord[];
  private next = 0;
  private filled = false;

  constructor(private readonly capacity: number = DEFAULT_LLM_REQUEST_RING_SIZE) {
    this.entries = new Array(Math.max(1, Math.floor(capacity)));
  }

  record(entry: LlmRequestRecord): void {
    this.entries[this.next] = entry;
    this.next = (this.next + 1) % this.entries.length;
    if (this.next === 0) this.filled = true;
  }

  /** Newest-first. */
  list(): LlmRequestRecord[] {
    const out: LlmRequestRecord[] = [];
    const size = this.filled ? this.entries.length : this.next;
    for (let i = 0; i < size; i++) {
      const idx = (this.next - 1 - i + this.entries.length) % this.entries.length;
      out.push(this.entries[idx]!);
    }
    return out;
  }
}
