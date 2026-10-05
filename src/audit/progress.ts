/**
 * The offline audit's backlog count (spec REFUSAL-HANDLING §10.2): how many
 * settled sessions each backlog stage has audited and how many are left, for the
 * console. Counted by the worker in the background, a bounded keyset chunk of
 * `agent_sessions` per step with a yield between chunks, every few minutes; the
 * console reads the last finished count, so no request ever scans history.
 */
import type { AuditBacklogProgress } from "../behaviour/types.js";
import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { AuditKnobs } from "./config.js";

/** Sessions per counting chunk (one short read each). */
export const AUDIT_PROGRESS_CHUNK = 2000;
/** Gap between full counts. */
export const AUDIT_PROGRESS_INTERVAL_MS = 5 * 60_000;

export interface AuditProgressCounterOptions {
  storage: Storage;
  /** The audits some agent runs (the queue's pending condition). */
  audits(): string[];
  excludeSessionTypes: readonly string[];
  knobs(): Pick<AuditKnobs, "settleMs" | "backlogMaxAgeMs">;
  now(): number;
  /** The backlog stage the worker walks now (null when idle). */
  current(): string | null;
  logger?: Logger;
  intervalMs?: number;
  chunk?: number;
}

export class AuditProgressCounter {
  private last: Omit<AuditBacklogProgress, "current"> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private counting: Promise<void> | undefined;

  constructor(private readonly options: AuditProgressCounterOptions) {}

  /** The last finished count with the worker's current stage; null before the first one. */
  snapshot(): AuditBacklogProgress | null {
    return this.last ? { ...this.last, current: this.options.current() } : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.countOnce().finally(() => this.schedule(this.options.intervalMs ?? AUDIT_PROGRESS_INTERVAL_MS));
    }, ms);
    this.timer.unref?.();
  }

  /** One full count (chunked, yielding between chunks). Exposed for tests. */
  countOnce(): Promise<void> {
    this.counting ??= this.count().finally(() => {
      this.counting = undefined;
    });
    return this.counting;
  }

  private async count(): Promise<void> {
    const audits = this.options.audits();
    if (audits.length === 0) {
      this.last = null;
      return;
    }
    try {
      const now = this.options.now();
      const knobs = this.options.knobs();
      const totals = {
        sessions: 0,
        priority: 0,
        done: Object.fromEntries(audits.map((a) => [a, 0])) as Record<string, number>,
        priorityDone: Object.fromEntries(audits.map((a) => [a, 0])) as Record<string, number>,
      };
      let after: { createdAt: number; id: string } | undefined;
      do {
        const chunk = this.options.storage.auditProgressChunk({
          audits,
          excludeSessionTypes: this.options.excludeSessionTypes,
          settledBefore: now - knobs.settleMs,
          ...(knobs.backlogMaxAgeMs > 0 ? { minCreatedAt: now - knobs.backlogMaxAgeMs } : {}),
          ...(after ? { after } : {}),
          limit: this.options.chunk ?? AUDIT_PROGRESS_CHUNK,
        });
        for (const row of chunk.rows) {
          if (!row.eligible) continue;
          totals.sessions += 1;
          if (row.priority) totals.priority += 1;
          for (const a of audits) {
            if (!row.done[a]) continue;
            totals.done[a]! += 1;
            if (row.priority) totals.priorityDone[a]! += 1;
          }
        }
        after = chunk.next ?? undefined;
        // Yield between chunks: the count never holds the main thread for long.
        if (after) await new Promise<void>((resolve) => setImmediate(resolve));
      } while (after && !this.stopped);
      if (this.stopped) return;
      const stages: AuditBacklogProgress["stages"] = [];
      if (audits.includes("send_contract")) {
        stages.push({
          id: "contract",
          label: "send-contract classification (sessions with nudges or a no_reply ending)",
          done: totals.priorityDone["send_contract"]!,
          remaining: totals.priority - totals.priorityDone["send_contract"]!,
        });
      }
      if (audits.includes("refusal")) {
        stages.push({
          id: "priority_checks",
          label: "refusal checks, sessions with nudges or a no_reply ending",
          done: totals.priorityDone["refusal"]!,
          remaining: totals.priority - totals.priorityDone["refusal"]!,
        });
        stages.push({
          id: "rest",
          label: "refusal checks, every other session",
          done: totals.done["refusal"]! - totals.priorityDone["refusal"]!,
          remaining: totals.sessions - totals.priority - (totals.done["refusal"]! - totals.priorityDone["refusal"]!),
        });
      } else if (audits.includes("send_contract")) {
        stages.push({
          id: "rest",
          label: "send-contract classification, every other session",
          done: totals.done["send_contract"]! - totals.priorityDone["send_contract"]!,
          remaining:
            totals.sessions - totals.priority - (totals.done["send_contract"]! - totals.priorityDone["send_contract"]!),
        });
      }
      this.last = { countedAt: this.options.now(), sessions: totals.sessions, prioritySessions: totals.priority, stages };
    } catch (error) {
      this.options.logger?.warn("audit_progress_count_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
