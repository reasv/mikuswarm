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
 * An output the gate already judged (a live `model` row at the same anchor) is
 * skipped; one with only pattern rows is judged without patterns (its hits are
 * already recorded). The backlog runs the pass in stages (the contract kinds with
 * the send-contract audit, the rest later): checks an earlier audit stage already
 * judged at the anchor are not asked again.
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

/** The decision groups the audit writes start with this (the console tells them from live verdicts by it). */
export const AUDIT_GROUP_PREFIX = "audit:";

/**
 * Check codes a judged row asked or fired: `results[].id` is `<code>__<source>`
 * (split at the last `__`), `fired[]` holds codes (or `{ code }`).
 */
export function judgedCodes(verdictJson: string | null): string[] {
  if (!verdictJson) return [];
  try {
    const v = JSON.parse(verdictJson) as { results?: unknown; fired?: unknown };
    const out: string[] = [];
    for (const r of Array.isArray(v?.results) ? v.results : []) {
      const id = (r as { id?: unknown; code?: unknown })?.id;
      const code = (r as { code?: unknown })?.code;
      if (typeof code === "string") out.push(code);
      else if (typeof id === "string" && id.lastIndexOf("__") > 0) out.push(id.slice(0, id.lastIndexOf("__")));
    }
    for (const f of Array.isArray(v?.fired) ? v.fired : []) {
      if (typeof f === "string") out.push(f);
      else if (typeof (f as { code?: unknown })?.code === "string") out.push((f as { code: string }).code);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Existing check rows at an output's anchor: judged live by a model, only pattern
 * hits, and the codes an earlier audit stage already judged there.
 */
function existingAt(
  rows: readonly DecisionEvaluationRow[],
  item: AuditCheckItem,
): { judged: boolean; patterns: boolean; auditCodes: Set<string> } {
  let judged = false;
  let patterns = false;
  const auditCodes = new Set<string>();
  for (const r of rows) {
    if (r.point !== "checks" || r.checkpoint !== item.checkpoint || (r.branch_no ?? 0) !== 0) continue;
    const same = item.toolCallId !== undefined
      ? r.tool_call_id === item.toolCallId
      : r.tool_call_id === null && r.attempt_no === (item.attemptNo ?? null);
    if (!same) continue;
    if (r.source === "pattern") patterns = true;
    else if (r.source === "model") {
      if (r.decision_group.startsWith(AUDIT_GROUP_PREFIX)) for (const code of judgedCodes(r.verdict_json)) auditCodes.add(code);
      else judged = true;
    }
  }
  return { judged, patterns, auditCodes };
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
      { patterns: !live.patterns, kinds, ...(live.auditCodes.size > 0 ? { skipCodes: live.auditCodes } : {}) },
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
