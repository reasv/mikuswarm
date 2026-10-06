/**
 * Soft refusals of mechanical jobs (spec REFUSAL-HANDLING §5.2.3–4, §8.1,
 * §8.4 "Mechanical jobs"): an internal task's artifact (a caption, a summary
 * or diary draft, a session record) or its failed rollout is judged before the
 * job commits or re-runs it. A judged refusal that a `soft = "redo"` rule
 * matches discards the output and reruns the job on the rule's next entry
 * (tries and `@same` as for sessions); every entry spent = no output. No rule,
 * no refusal: the job does exactly what it did before (commit, or today's
 * same-model semantic redo).
 *
 * One instance per job (one refusal point): its walk spans the reruns.
 */
import type { Logger } from "../observability/logger.js";
import type { RefusalPin } from "../storage/database.js";
import type {
  BackgroundAct,
  BackgroundArtifact,
  BackgroundChecks,
  BackgroundRollout,
  GateVerdict,
} from "../checks/gate.js";
import type { FiredCheck } from "../checks/evaluator.js";
import type { RefusalRule } from "../checks/types.js";
import { RefusalRuleWalk, matchRefusalRule, refusalRulesForSession, ruleAdmitsIgnoringFromModels } from "./rules.js";
import type { SessionRefusalHandle } from "./session.js";

/** What a job does with its output after the check. */
export type JobRefusalDecision =
  | { action: "accept" }
  /** Discard and rerun pinned to `pin.model`. */
  | { action: "rerun"; pin: RefusalPin; checkCode: string }
  /** Every entry refused: no output, no re-run. */
  | { action: "exhausted"; rule: string; checkCode: string };

export interface JobSoftRefusalOptions {
  checks: BackgroundChecks;
  rules: readonly RefusalRule[];
  /** Internal site: summarize | condense | diary | caption | record_turn. */
  site: string;
  agent: string | null;
  /** A rule entry can serve now (exists, healthy, in budget). */
  usable: (model: string) => boolean;
  /** Chain members of a model (an entry's own fallback served for it); default just the model. */
  chainOf?: (model: string) => string[];
  logger?: Logger;
  now?: () => number;
}

/** A job's soft-refusal walk over the refusal rules of its site. */
export class JobSoftRefusalRedo {
  private walk: RefusalRuleWalk | undefined;

  constructor(private readonly options: JobSoftRefusalOptions) {}

  /**
   * Whether holding the job's output for a verdict is worth it: some
   * `soft = "redo"` rule admits the site and agent (spec §6.3 applied to jobs).
   * When false the job keeps the fire-and-forget observe checks.
   */
  get active(): boolean {
    return refusalRulesForSession(this.options.rules, {
      site: this.options.site,
      agent: this.options.agent,
      tasks: null,
    }).some((rule) => rule.soft === "redo");
  }

  /** Judge an artifact (waits for the verdict) and decide. Never rejects. */
  async artifact(input: Omit<BackgroundArtifact, "act">): Promise<JobRefusalDecision> {
    return this.judge((act) => this.options.checks.artifact({ ...input, act }), input.servedModel);
  }

  /** Judge a failed rollout (waits for the verdict) and decide. Never rejects. */
  async rollout(input: Omit<BackgroundRollout, "act">): Promise<JobRefusalDecision> {
    return this.judge((act) => this.options.checks.rollout({ ...input, act }), input.servedModel);
  }

  private async judge(
    run: (act: (verdict: GateVerdict, opts: { late: boolean }) => BackgroundAct | undefined) => Promise<unknown>,
    servedModel: string | undefined,
  ): Promise<JobRefusalDecision> {
    let decision: JobRefusalDecision = { action: "accept" };
    try {
      await run((verdict, { late }) => {
        const taken = this.decide(verdict, late, servedModel);
        decision = taken.decision;
        return taken.act;
      });
    } catch (error) {
      this.options.logger?.warn("job_refusal_check_failed", {
        site: this.options.site,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return decision;
  }

  private decide(
    verdict: GateVerdict,
    late: boolean,
    servedModel: string | undefined,
  ): { decision: JobRefusalDecision; act?: BackgroundAct } {
    const { site, agent } = this.options;
    // Past the deadline only pattern hits act (as at a send).
    const fired = strongest(
      verdict.fired.filter((f) => f.kind === "refusal" && f.remedy === "redo" && (!late || f.method === "pattern")),
    );
    if (!fired) return { decision: { action: "accept" } };
    const scope = {
      site, agent, tasks: null, reason: fired.reason ?? "unclear",
      detectedReasons: verdict.fired.filter((f) => f.kind === "refusal").map((f) => f.reason ?? "unclear"),
      kind: "soft" as const,
    };
    const chainOf = this.options.chainOf ?? ((model: string) => [model]);
    // The model the walk handed out refused again: the same rule continues.
    const continuing =
      this.walk?.last !== undefined &&
      servedModel !== undefined &&
      chainOf(this.walk.last).includes(servedModel) &&
      ruleAdmitsIgnoringFromModels(this.walk.rule, scope);
    const rule = continuing ? this.walk!.rule : matchRefusalRule(this.options.rules, { ...scope, fromModel: servedModel });
    if (!rule) return { decision: { action: "accept" } };
    if (!continuing) this.walk = new RefusalRuleWalk(rule, servedModel ?? "");
    const next = this.walk!.next(
      (candidate) => {
        try {
          return candidate.length > 0 && this.options.usable(candidate);
        } catch {
          return false;
        }
      },
      (candidate) => this.options.logger?.info("refusal_rule_entry_skipped", { site, rule: rule.name, model: candidate }),
    );
    const base = { site, checkCode: fired.code, reason: fired.reason, method: fired.method, rule: rule.name, fromModel: servedModel };
    if (next === undefined) {
      this.options.logger?.warn("job_refusal_exhausted", base);
      return {
        decision: { action: "exhausted", rule: rule.name, checkCode: fired.code },
        act: { consequence: "withheld", refusal: { code: fired.code, outcome: "exhausted_no_output", ruleName: rule.name } },
      };
    }
    this.options.logger?.info("job_refusal_redo", { ...base, toModel: next });
    return {
      decision: {
        action: "rerun",
        pin: { rule: rule.name, model: next, at: (this.options.now ?? Date.now)() },
        checkCode: fired.code,
      },
      act: { consequence: "redo", refusal: { code: fired.code, outcome: "redo", ruleName: rule.name, toModel: next } },
    };
  }
}

function strongest(fired: readonly FiredCheck[]): FiredCheck | undefined {
  let best: FiredCheck | undefined;
  for (const f of fired) if (!best || (f.probability ?? 0) > (best.probability ?? 0)) best = f;
  return best;
}

/**
 * A session-bound artifact's soft refusal (the session record, spec §5.2.3)
 * through the session's own refusal handle: its site (`record_turn` while the
 * turn runs), tasks, walk and sticky pin. `rerun` = the handle pinned the rule's
 * next try (the turn is run again on it); `exhausted` = no output.
 */
export function decideSessionArtifactRefusal(
  handle: Pick<SessionRefusalHandle, "matchRule" | "advance" | "servingModel" | "site">,
  verdict: GateVerdict,
  late: boolean,
  logger?: Logger,
): { decision: "accept" | "rerun" | "exhausted"; act?: BackgroundAct } {
  const fired = strongest(
    verdict.fired.filter((f) => f.kind === "refusal" && f.remedy === "redo" && (!late || f.method === "pattern")),
  );
  if (!fired) return { decision: "accept" };
  const fromModel = handle.servingModel();
  const rule = handle.matchRule({
        reason: fired.reason ?? "unclear",
        detectedReasons: verdict.fired.filter((f) => f.kind === "refusal").map((f) => f.reason ?? "unclear"),
        kind: "soft", fromModel,
      });
  if (!rule) return { decision: "accept" };
  const next = handle.advance(rule, fromModel ?? "");
  const base = { site: handle.site, checkCode: fired.code, rule: rule.name, fromModel };
  if (next === undefined) {
    logger?.warn("job_refusal_exhausted", base);
    return {
      decision: "exhausted",
      act: { consequence: "withheld", refusal: { code: fired.code, outcome: "exhausted_no_output", ruleName: rule.name } },
    };
  }
  logger?.info("job_refusal_redo", { ...base, toModel: next });
  return {
    decision: "rerun",
    act: { consequence: "redo", refusal: { code: fired.code, outcome: "redo", ruleName: rule.name, toModel: next } },
  };
}
