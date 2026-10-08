/**
 * The session's acting gate policy (spec REFUSAL-HANDLING §6.3–§6.4, §8):
 * the refusal half (soft-refusal redo through the refusal rules) composed with
 * an optional revise half ({@link RevisePolicyPart}, style checks). It replaces
 * the observe-only policy of every chat-lane gate; with no rule and no
 * revisable check it behaves exactly like {@link OBSERVE_POLICY}.
 *
 * - **Hold only when a verdict could act** (§6.3): a `redo` refusal check took
 *   part and some `soft = "redo"` rule could match this session now
 *   (`refusal.softRuleCouldMatch()`: site, agent, tasks, serving model), or the
 *   revise part holds. Otherwise the evaluation runs alongside the output.
 * - **Refusal** (§6.4): the strongest fired refusal check with remedy `redo`
 *   whose rule matches (`refusal.matchRule({ kind: "soft" })`) takes the rule's
 *   next try (`refusal.advance`, which pins the model). The output is blocked
 *   and a redo is filed on the session's {@link SessionRedoControl}; the run
 *   stops after the current tool batch (the factory's stop-after-turn hook) and
 *   the runner forks and continues on the pinned model. Refusal wins over any
 *   revise flag. Exhausted (§8.2): `send_last` lets the output through,
 *   `withhold` and `park` block it and file the matching settle request.
 * - **Deadline** (§6.3): a verdict that missed the deadline never blocks on a
 *   judged answer; pattern hits (decided synchronously at the start) still act.
 *
 * One decision per held output, taken when the verdict is recorded (or at the
 * deadline), so the rows' consequence, the `refusal_events` outcome and the
 * action always agree.
 */
import type { SessionRedoControl } from "../agent/redo-signal.js";
import type { Logger } from "../observability/logger.js";
import { exhaustedOutcome, type SessionRefusalHandle } from "../refusals/session.js";
import type { RefusalOutcome } from "../storage/database.js";
import type { CheckConsequence, FiredCheck } from "./evaluator.js";
import { OBSERVE_POLICY, type GateAction, type GateCallInfo, type GatePolicy, type GateVerdict } from "./gate.js";
import type { RevisePolicyPart } from "./policy-parts.js";
import type { CheckDefinition, RefusalRule } from "./types.js";

/** The refusal decision on one held output. */
export type RefusalAct =
  | { kind: "redo"; fired: FiredCheck; rule: RefusalRule; fromModel?: string; toModel: string }
  | { kind: "exhausted"; fired: FiredCheck; rule: RefusalRule; fromModel?: string; outcome: RefusalOutcome };

export interface ActingPolicyDeps {
  /** The session's refusal handle (rules, walk, pin). */
  refusal: SessionRefusalHandle;
  /** The session's redo control (the runner takes the request after the run settles). */
  redoControl: SessionRedoControl;
  /** The revise half (`createRevisePolicyPart`); absent = no revise verdicts. */
  revise?: RevisePolicyPart;
  logger?: Logger;
}

export interface ActingGatePolicy extends GatePolicy {
  /** The refusal decision taken for a held output, if any (tests, logs). */
  refusalAct(info: GateCallInfo): RefusalAct | undefined;
  /**
   * Tool call ids this policy blocked as refusals since the last fork: siblings
   * of one assistant message that were refused too are all removed by the redo.
   */
  blockedRefusals(): ReadonlySet<string>;
  /** Forget {@link blockedRefusals} (after the fork consumed them). */
  clearBlockedRefusals(): void;
}

type ReviseDecision = ReturnType<RevisePolicyPart["decide"]>;

/** The agent-facing text of a blocked refused output (it lives only in the discarded branch). */
export const REFUSAL_BLOCK_MESSAGE =
  "Not sent: this output was judged a refusal; the turn is being redone.";

export function createActingPolicy(deps: ActingPolicyDeps): ActingGatePolicy {
  const { refusal, redoControl, revise, logger } = deps;
  // One refusal decision per held output (null = none applies).
  const refusalActs = new WeakMap<GateCallInfo, RefusalAct | null>();
  // The revise part's decision, taken once (it keeps counters).
  const reviseDecisions = new WeakMap<GateCallInfo, ReviseDecision | null>();
  const blocked = new Set<string>();

  const decideRefusal = (info: GateCallInfo, verdict: GateVerdict, late: boolean): RefusalAct | undefined => {
    if (refusalActs.has(info)) return refusalActs.get(info) ?? undefined;
    let act: RefusalAct | undefined;
    // Past the deadline only pattern hits act; a late judged answer is recorded only.
    const candidates = verdict.fired.filter(
      (f) => f.kind === "refusal" && f.remedy === "redo" && (!late || f.method === "pattern"),
    );
    const fired = strongestOf(candidates);
    if (fired) {
      const fromModel = refusal.servingModel();
      const rule = refusal.matchRule({
        reason: fired.reason ?? "unclear",
        detectedReasons: verdict.fired.filter((f) => f.kind === "refusal").map((f) => f.reason ?? "unclear"),
        kind: "soft", fromModel,
      });
      if (rule) {
        const toModel = refusal.advance(rule, fromModel ?? "");
        act =
          toModel !== undefined
            ? { kind: "redo", fired, rule, toModel, ...(fromModel ? { fromModel } : {}) }
            : {
                kind: "exhausted",
                fired,
                rule,
                outcome: exhaustedOutcome(rule, refusal.site),
                ...(fromModel ? { fromModel } : {}),
              };
      }
    }
    refusalActs.set(info, act ?? null);
    return act;
  };

  /**
   * The refusal decision {@link decideRefusal} would take on an in-time verdict,
   * without advancing the walk: `blocks` (a rule acts and, redo or exhausted,
   * withholds), `maybe` (a `send_last` rule: a redo blocks, its exhaustion lets
   * the output through), `none` (no fired redo refusal, or no rule matches it).
   */
  const previewRefusal = (verdict: GateVerdict): "blocks" | "maybe" | "none" => {
    const fired = strongestOf(verdict.fired.filter((f) => f.kind === "refusal" && f.remedy === "redo"));
    if (!fired) return "none";
    const rule = refusal.matchRule({
      reason: fired.reason ?? "unclear",
      detectedReasons: verdict.fired.filter((f) => f.kind === "refusal").map((f) => f.reason ?? "unclear"),
      kind: "soft",
      fromModel: refusal.servingModel(),
    });
    if (!rule) return "none";
    return exhaustedOutcome(rule, refusal.site) === "exhausted_send_last" ? "maybe" : "blocks";
  };

  const decideRevise = (info: GateCallInfo, verdict: GateVerdict): ReviseDecision | undefined => {
    if (!revise) return undefined;
    if (reviseDecisions.has(info)) return reviseDecisions.get(info) ?? undefined;
    const decision = revise.decide(info, verdict);
    reviseDecisions.set(info, decision);
    return decision;
  };

  const policy: ActingGatePolicy = {
    shouldHold(info, checks) {
      return refusalCouldAct(info, checks, refusal) || (revise?.shouldHold(info, checks) ?? false);
    },

    consequence(info, verdict, opts) {
      // The refusal half decides first; it acts only on a held output.
      const act = opts.held ? decideRefusal(info, verdict, opts.late) : undefined;
      if (act?.kind === "redo") return "redo";
      if (act?.kind === "exhausted") return exhaustedConsequence(info, act.outcome);
      // Revise, held and unheld alike: `sent` after the bounds, `overridden`
      // for an override (the part decides once per call).
      if (verdict.revise.length > 0) {
        const decision = decideRevise(info, verdict);
        if (decision?.consequence) return decision.consequence;
      }
      return OBSERVE_POLICY.consequence(info, verdict, opts);
    },

    refusalOutcome(info, fired) {
      const act = refusalActs.get(info);
      if (!act || act.fired.code !== fired.code) return { outcome: "observed" };
      return act.kind === "redo"
        ? { outcome: "redo", ruleName: act.rule.name, toModel: act.toModel }
        : { outcome: act.outcome, ruleName: act.rule.name };
    },

    act(info, verdict): GateAction {
      // In time, the decision was taken when the verdict was recorded; past the
      // deadline this is the first look (pattern hits only). A verdict judged in
      // time but acted on before it is recorded (a duplicate recheck that missed
      // the deadline, `late: false`) is decided on in full.
      const act = decideRefusal(info, verdict, verdict.late ?? !refusalActs.has(info));
      if (act) return actOnRefusal(info, verdict, act);
      const decision = decideRevise(info, verdict);
      if (decision?.kind === "block") return { kind: "block", message: decision.message };
      return { kind: "proceed" };
    },

    wouldBlock(info, verdict) {
      // Decided already (the verdict was recorded): what was decided.
      if (refusalActs.has(info)) {
        const act = refusalActs.get(info);
        if (act) return act.kind === "redo" || act.outcome !== "exhausted_send_last";
      } else {
        const preview = previewRefusal(verdict);
        if (preview === "blocks") return true;
        // A rule that may still let the last attempt through (send_last): it
        // blocks only while it has a try left, which only advancing can tell.
        if (preview === "maybe") return false;
      }
      return revise?.wouldBlock(info, verdict) ?? false;
    },

    onDelivered() {
      revise?.onDelivered();
    },

    refusalAct: (info) => refusalActs.get(info) ?? undefined,
    blockedRefusals: () => blocked,
    clearBlockedRefusals: () => blocked.clear(),
  };

  function actOnRefusal(info: GateCallInfo, verdict: GateVerdict, act: RefusalAct): GateAction {
    const base = {
      sessionId: info.scope.sessionId,
      site: refusal.site,
      checkpoint: info.checkpoint,
      action: info.action,
      toolCallId: info.toolCallId,
      checkCode: act.fired.code,
      reason: act.fired.reason,
      method: act.fired.method,
      probability: act.fired.probability,
      rule: act.rule.name,
      fromModel: act.fromModel,
    };
    const request = {
      kind: "refusal" as const,
      ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
      checkCode: act.fired.code,
      ...(act.fired.reason ? { reason: act.fired.reason } : {}),
      ...(act.fired.probability !== undefined ? { probability: act.fired.probability } : {}),
      ...(verdict.evaluationIds.length > 0
        ? { decisionEvaluationId: verdict.evaluationIds[0], evaluationIds: [...verdict.evaluationIds] }
        : {}),
      ...(act.fromModel ? { refusedModel: act.fromModel } : {}),
      ruleName: act.rule.name,
    };
    if (act.kind === "redo") {
      logger?.info("soft_refusal_redo_requested", { ...base, toModel: act.toModel });
      redoControl.request({ ...request, toModel: act.toModel });
      if (info.toolCallId) blocked.add(info.toolCallId);
      return { kind: "block", message: REFUSAL_BLOCK_MESSAGE };
    }
    logger?.warn("soft_refusal_exhausted", { ...base, outcome: act.outcome });
    if (act.outcome === "exhausted_send_last") {
      // The last attempt goes out (spec §8.2): withholding makes the bot look dead.
      return { kind: "proceed" };
    }
    redoControl.request({ ...request, exhausted: act.outcome === "exhausted_parked" ? "park" : "withhold" });
    if (info.toolCallId) blocked.add(info.toolCallId);
    return { kind: "block", message: REFUSAL_BLOCK_MESSAGE };
  }

  return policy;
}

/**
 * §6.3: a refusal verdict could act on this output only when a `redo` refusal
 * check took part and a soft rule could match the session now.
 */
export function refusalCouldAct(
  info: GateCallInfo,
  checks: readonly CheckDefinition[],
  refusal: Pick<SessionRefusalHandle, "softRuleCouldMatch">,
): boolean {
  if (info.checkpoint !== "send" && info.checkpoint !== "ending") return false;
  if (!checks.some((check) => check.kind === "refusal" && check.remedy === "redo")) return false;
  return refusal.softRuleCouldMatch();
}

/** The rows' consequence of an exhausted rule: the last attempt is sent (send_last) or nothing is. */
function exhaustedConsequence(info: GateCallInfo, outcome: RefusalOutcome): CheckConsequence {
  if (outcome === "exhausted_send_last") return info.checkpoint === "send" ? "sent" : "observed";
  return "withheld";
}

function strongestOf(fired: readonly FiredCheck[]): FiredCheck | undefined {
  let best: FiredCheck | undefined;
  for (const f of fired) if (!best || (f.probability ?? 0) > (best.probability ?? 0)) best = f;
  return best;
}
