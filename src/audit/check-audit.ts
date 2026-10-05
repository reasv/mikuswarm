/**
 * The check pass of the offline audit (spec REFUSAL-HANDLING §10.2): the judged
 * checks of the catalogue (default: the refusal and contract kinds) over a
 * completed session's sends and endings, so per-model rates exist from day one
 * and every live session the gate did not judge is judged later.
 *
 * Results are written exactly like the live gate's: anchored
 * `decision_evaluations` rows (`point = 'checks'`, consequence `observed`, the
 * evaluation's `decision_group` prefixed `audit:`) and a `refusal_events` row
 * (kind `soft`, outcome `observed`) per fired refusal check, so the model
 * behaviour rollups and the incident log count them with no special case.
 *
 * An output the gate already judged (a `model` row at the same anchor) is
 * skipped; one with only pattern rows is judged without patterns (its hits are
 * already recorded).
 */
import type { CheckEvaluator, CheckScope } from "../checks/evaluator.js";
import type { StateMessage } from "../checks/state.js";
import type { CheckKind } from "../checks/types.js";
import type { DecisionEvaluationRow } from "../storage/index.js";
import type { AuditCheckItem } from "./transcript.js";

/** Fallback reasons that leave an output for a later pass (the chain may come back). */
export const RETRYABLE_REASONS = new Set(["budget", "unavailable", "timeout", "error", "aborted", "payee_budget"]);

/** The audit check pass's result for one session. */
export interface CheckAuditResult {
  /** True when some output fell back for a retryable reason (nothing recorded for it). */
  deferred: boolean;
  /** The first retryable fallback reason. */
  reason?: string;
  verdict: {
    items: number;
    judged: number;
    skippedLive: number;
    deferred: number;
    fired: Record<string, number>;
  };
  costUsd: number;
  /** The decision member that served the last judged call. */
  modelId?: string;
}

/** Existing check rows at an output's anchor: judged by a model, or only pattern hits. */
function existingAt(rows: readonly DecisionEvaluationRow[], item: AuditCheckItem): { judged: boolean; patterns: boolean } {
  let judged = false;
  let patterns = false;
  for (const r of rows) {
    if (r.point !== "checks" || r.checkpoint !== item.checkpoint || (r.branch_no ?? 0) !== 0) continue;
    const same = item.toolCallId !== undefined
      ? r.tool_call_id === item.toolCallId
      : r.tool_call_id === null && r.attempt_no === (item.attemptNo ?? null);
    if (!same) continue;
    if (r.source === "pattern") patterns = true;
    else if (r.source === "model") judged = true;
  }
  return { judged, patterns };
}

export async function auditSessionChecks(params: {
  evaluator: CheckEvaluator;
  scope: CheckScope;
  items: readonly AuditCheckItem[];
  existing: readonly DecisionEvaluationRow[];
  kinds: readonly CheckKind[];
  request: StateMessage[];
  recent: StateMessage[];
}): Promise<CheckAuditResult> {
  const { evaluator, scope, items, existing, kinds } = params;
  const result: CheckAuditResult = {
    deferred: false,
    verdict: { items: items.length, judged: 0, skippedLive: 0, deferred: 0, fired: {} },
    costUsd: 0,
  };
  for (const item of items) {
    const live = existingAt(existing, item);
    if (live.judged) {
      result.verdict.skippedLive += 1;
      continue;
    }
    const evaluation = evaluator.start(
      scope,
      {
        context: {
          checkpoint: item.checkpoint,
          request: params.request,
          recent: params.recent,
          action: item.action,
          ...(item.nudges !== undefined ? { nudges: item.nudges } : {}),
          ...(item.firstAttempt ? { firstAttempt: item.firstAttempt } : {}),
        },
        sources: item.sources,
        ...(item.servedModel ? { servedModel: item.servedModel } : {}),
        ...(item.wireModel ? { wireModel: item.wireModel } : {}),
      },
      {
        checkpoint: item.checkpoint,
        branchNo: 0,
        ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
        ...(item.attemptNo !== undefined ? { attemptNo: item.attemptNo } : {}),
      },
      { patterns: !live.patterns, kinds },
    );
    const outcome = await evaluation.done;
    for (const call of evaluation.calls) {
      result.costUsd += call.row.costUsd ?? 0;
      if (call.row.servedModel) result.modelId = call.row.servedModel;
    }
    if (outcome.unjudgedReason && RETRYABLE_REASONS.has(outcome.unjudgedReason)) {
      // Nothing recorded: the output is judged on a later pass.
      evaluation.cancel();
      result.deferred = true;
      result.reason ??= outcome.unjudgedReason;
      result.verdict.deferred += 1;
      continue;
    }
    await evaluator.record(evaluation, { consequence: "observed", late: false, heldMs: 0 });
    if (outcome.judgedQuestions > 0) result.verdict.judged += 1;
    for (const f of outcome.fired) result.verdict.fired[f.code] = (result.verdict.fired[f.code] ?? 0) + 1;
  }
  return result;
}
