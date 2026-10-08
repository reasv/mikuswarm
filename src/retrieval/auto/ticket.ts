/**
 * The launch-time plan ticket (ARCHITECTURE.md §9d "Judged retrieval"): the
 * handle a session's context build uses to wait for, cut short, confirm or
 * abandon its auto-retrieval plan. The plan's `memory_retrievals` row is
 * written once, when the build's fate is known: shown when the kickoff
 * carrying the block was sent (`confirm`), aborted when the build was
 * cancelled, redone, failed or ended first (`abandon`).
 */
import { abortedReport, BEST_EFFORT_GRACE_MS } from "./pipeline.js";
import type { MemoryPlanTicket, RetrievalPlan, RetrievalReport } from "./types.js";

export interface PlanTicketOptions {
  plan: Promise<RetrievalPlan | null>;
  waitMs: number;
  /** Aborted by `abandon`: the plan stops. */
  abort: AbortController;
  /** Aborted by `bestEffort`: the plan finishes with what is ready (`PlanInput.finishNow`). */
  finishNow: AbortController;
  /** Store the build's row (the plan was started with `deferRecord`). */
  record: (report: RetrievalReport) => void;
  /** How long `bestEffort` waits for the plan to finish (default {@link BEST_EFFORT_GRACE_MS}). */
  graceMs?: number;
}

export function createPlanTicket(opts: PlanTicketOptions): MemoryPlanTicket {
  let fate: "confirmed" | "abandoned" | undefined;
  const settle = (shown: boolean): void => {
    void opts.plan.then(
      (result) => {
        if (result) opts.record(shown ? result.report : abortedReport(result.report));
      },
      () => undefined,
    );
  };
  return {
    plan: opts.plan,
    waitMs: opts.waitMs,
    async bestEffort() {
      opts.finishNow.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), opts.graceMs ?? BEST_EFFORT_GRACE_MS)));
      try {
        return await Promise.race([opts.plan, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    confirm() {
      if (fate) return;
      fate = "confirmed";
      settle(true);
    },
    abandon() {
      opts.abort.abort();
      if (fate) return;
      fate = "abandoned";
      settle(false);
    },
  };
}
