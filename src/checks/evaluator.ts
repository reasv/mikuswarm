/**
 * Check evaluation (spec REFUSAL-HANDLING §4.2, §5, §6.2–§6.3, §10.1): one
 * evaluation per judged output, at any checkpoint. Shared by the per-session
 * output gate (src/checks/gate.ts) and the background artifact/rollout checks.
 *
 * - **Patterns first.** A pattern or word-list hit decides its check without a
 *   model call; its questions are not asked. Pattern checks of enabled checks
 *   run whether or not a decision model is configured.
 * - **Judged checks** run only with `[decisions].enabled` AND
 *   `[decisions.checks].enabled` for the agent, and never when the session's
 *   payee is over budget (the output proceeds unjudged; the miss is recorded).
 * - **Style checks** skip messages under `min_chars` (a pattern-only style check
 *   ignores it); refusal checks have no floor.
 * - **One call by default**, split by the fits ({@link planCheckCalls}); every
 *   call of one evaluation shares a `decisionGroup`.
 * - **Per-check verdict**: a check fires when any of its questions reaches its
 *   own (calibrated) threshold; its probability is the highest among them.
 *
 * Recording is separate ({@link CheckEvaluator.record}) so the caller decides
 * the consequence (sent, sent_unjudged, observed, …) once it knows it. Rows are
 * anchored (`checkpoint`, `branch_no`, `tool_call_id` | `attempt_no`) and
 * share the evaluation's `decisionGroup`; a fired refusal check writes a
 * `refusal_events` row (kind `soft`) linked to the row that fired it.
 */
import { nanoid } from "nanoid";
import type { AppConfig } from "../config/index.js";
import type { PriorityClass } from "../agent/scheduler.js";
import { checksPointKnobs, decisionsFor, type ChecksPointKnobs } from "../decisions/config.js";
import type { DecisionEngine, DecisionEvaluationRow } from "../decisions/registry.js";
import {
  assignItemIds,
  checksPoint,
  planCheckCalls,
  type CheckItem,
  type ChecksCallVerdict,
  type PlannedCall,
} from "../decisions/points/checks.js";
import type { Logger } from "../observability/logger.js";
import type {
  DecisionEvaluationInsert,
  RefusalEventInsert,
  RefusalOutcome,
} from "../storage/database.js";
import { firstPatternMatch } from "./catalogue.js";
import { hasSource, sourceText, type CheckContext, type CheckSources } from "./state.js";
import type { CheckCatalogue, CheckDefinition, CheckKind, CheckRemedy, CheckSource, Checkpoint } from "./types.js";

/** `decision_evaluations.consequence` vocabulary (CONTRACT). */
export type CheckConsequence = "sent" | "sent_unjudged" | "revise" | "overridden" | "redo" | "observed" | "withheld";

/** A check that fired in an evaluation (CONTRACT "Gate"). */
export interface FiredCheck {
  code: string;
  kind: CheckKind;
  remedy: CheckRemedy;
  reason?: string;
  probability?: number;
  method: "pattern" | "judged";
  source?: CheckSource;
  /** Pattern hits: the matched text (fills `{matched}` in the agent explanation). */
  matched?: string;
  /** `choice` questions: the option picked. */
  choice?: string;
}

/** Who and where an evaluation is for. */
export interface CheckScope {
  agent: string | null;
  /** Session type name, or an internal site (record_turn, summarize, …). */
  site: string;
  sessionId: string | null;
  sessionType: string | null;
  timelineKey: string | null;
  triggerSenderId?: string | null;
  /** The session's task keys (null = taskless, until multi-label tasks land). */
  tasks?: string[] | null;
}

/** Where the judged output sits (spec §9 anchor). */
export interface CheckAnchor {
  checkpoint: Checkpoint;
  branchNo?: number;
  toolCallId?: string;
  attemptNo?: number;
}

/** What is judged. */
export interface CheckSubject {
  context: CheckContext;
  sources: CheckSources;
  /** Logical id of the member that wrote the output (refusal_events.served_model). */
  servedModel?: string;
  wireModel?: string;
}

/** The completed evaluation, before recording. */
export interface CheckEvaluationResult {
  fired: FiredCheck[];
  /** Why some judged questions got no verdict (a fallback reason); undefined = none. */
  unjudgedReason?: string;
  /** Judged questions asked (0 = nothing to judge, or judged checks off). */
  judgedQuestions: number;
  latencyMs: number;
}

/** Storage the evaluator writes through (the single-writer queue). */
export interface CheckStorage {
  insertDecisionEvaluation(row: DecisionEvaluationInsert): Promise<number>;
  insertRefusalEvent(row: RefusalEventInsert): Promise<number>;
}

export interface CheckEvaluatorOptions {
  catalogue: CheckCatalogue;
  /** Undefined when no decision point is configured: patterns only. */
  engine?: DecisionEngine;
  config: Pick<AppConfig, "decisions" | "agents">;
  storage?: CheckStorage;
  /** True when the session's payee has no budget left (spec §16.2): no gate call. */
  isPayeeOverBudget?: (sessionId: string) => boolean;
  logger?: Logger;
  now?: () => number;
}

/** Which source texts the patterns read, per checkpoint. */
const PATTERN_SOURCES: Record<Checkpoint, readonly CheckSource[]> = {
  send: ["message"],
  ending: ["analysis", "text"],
  artifact: ["artifact"],
  rollout: ["rollout"],
};

/** A check call's default hard timeout, as a multiple of its checkpoint's deadline. */
export const CALL_TIMEOUT_DEADLINE_FACTOR = 2;

const CHECKPOINT_PRIORITY: Record<Checkpoint, PriorityClass> = {
  send: "interactive",
  ending: "interactive",
  artifact: "background",
  rollout: "background",
};

interface CallRecord {
  row: DecisionEvaluationRow;
  verdict: ChecksCallVerdict;
}

/**
 * One running (or completed) evaluation. `done` never rejects. `cancel()`
 * aborts its decision calls (an attempt discarded before execute); a canceled
 * evaluation is never recorded.
 */
export class CheckEvaluation {
  readonly decisionGroup = nanoid();
  readonly startedAt: number;
  /** Enabled checks that took part (pattern hits, judged questions). */
  readonly checks: CheckDefinition[] = [];
  readonly patternFired: FiredCheck[] = [];
  /** @internal */ readonly calls: CallRecord[] = [];
  /** @internal */ budgetRow?: DecisionEvaluationRow;
  done!: Promise<CheckEvaluationResult>;
  result?: CheckEvaluationResult;
  completedAt?: number;
  recorded = false;
  canceled = false;
  /** @internal */ readonly controller = new AbortController();

  constructor(
    readonly scope: CheckScope,
    readonly anchor: CheckAnchor,
    readonly subject: CheckSubject,
    readonly deadlineMs: number,
    now: number,
  ) {
    this.startedAt = now;
  }

  get checkpoint(): Checkpoint {
    return this.anchor.checkpoint;
  }

  cancel(): void {
    this.canceled = true;
    this.controller.abort();
  }
}

/** How a recorded evaluation ended. */
export interface RecordOutcome {
  consequence: CheckConsequence;
  /** Completed after the checkpoint's deadline (the output proceeded unjudged). */
  late: boolean;
  /** How long the output was actually held for this evaluation (0 = never held). */
  heldMs: number;
  /**
   * `refusal_events` outcome for each fired refusal check; null = write none
   * (a caller that acts on the refusal records its own event). Default observed.
   */
  refusalOutcome?: (fired: FiredCheck) => { outcome: RefusalOutcome; ruleName?: string; toModel?: string } | null;
}

export class CheckEvaluator {
  constructor(private readonly options: CheckEvaluatorOptions) {}

  get catalogue(): CheckCatalogue {
    return this.options.catalogue;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The gate's knobs for an agent (deadlines, style floor, recent window, …). */
  knobs(agent: string | null): ChecksPointKnobs {
    return checksPointKnobs(decisionsFor(this.options.config as AppConfig, agent));
  }

  /** True when judged checks run for the agent (both enables and a model). */
  judgedEnabled(agent: string | null): boolean {
    return this.options.engine?.isEnabled("checks", agent) ?? false;
  }

  /**
   * Whether an evaluation at `checkpoint` could find anything for the agent:
   * judged checks are on, or some enabled check has patterns. False = skip the
   * evaluation (and its state reads) entirely.
   */
  mightJudge(checkpoint: Checkpoint, agent: string | null): boolean {
    if (this.judgedEnabled(agent)) return true;
    return this.options.catalogue
      .enabledFor(checkpoint, agent)
      .some((c) => c.patterns.length > 0 || c.words.length > 0);
  }

  deadlineMs(checkpoint: Checkpoint, agent: string | null): number {
    const knobs = this.knobs(agent);
    if (checkpoint === "send") return knobs.sendDeadlineMs;
    if (checkpoint === "ending") return knobs.endingDeadlineMs;
    return knobs.backgroundDeadlineMs;
  }

  /** Start an evaluation: patterns now, judged calls in the background. */
  start(scope: CheckScope, subject: CheckSubject, anchor: CheckAnchor): CheckEvaluation {
    const checkpoint = anchor.checkpoint;
    const evaluation = new CheckEvaluation(scope, anchor, subject, this.deadlineMs(checkpoint, scope.agent), this.now());
    const knobs = this.knobs(scope.agent);
    const judgedOn = this.judgedEnabled(scope.agent);
    const { sources, context } = subject;
    const action = context.action;
    const nudges = context.nudges ?? 0;
    const messageChars = (sources.message ?? "").trim().length;

    const raw: Array<Omit<CheckItem, "id">> = [];
    for (const check of this.options.catalogue.enabledFor(checkpoint, scope.agent)) {
      const hasQuestions = check.questions.length > 0;
      const shortStyle = check.kind === "style" && messageChars < (check.minChars ?? knobs.styleMinChars);
      // A style check with questions skips a short message entirely; a
      // pattern-only check is free and ignores the floor (spec §6.3).
      if (shortStyle && hasQuestions) continue;
      let took = false;
      for (const source of PATTERN_SOURCES[checkpoint]) {
        if (!hasSource(sources, source)) continue;
        const matched = firstPatternMatch(check, sourceText(sources, source));
        if (matched === undefined) continue;
        evaluation.patternFired.push(firedOf(check, { method: "pattern", source, matched, probability: 1 }));
        took = true;
        break;
      }
      if (took) {
        evaluation.checks.push(check);
        continue;
      }
      if (!judgedOn || shortStyle) continue;
      for (const question of check.questions) {
        if (question.actions && !question.actions.includes(action)) continue;
        if (question.afterNudge ? nudges < 1 : !hasSource(sources, question.source)) continue;
        raw.push({ code: check.code, kind: check.kind, source: question.source, question });
        took = true;
      }
      if (took) evaluation.checks.push(check);
    }
    const items = assignItemIds(raw);
    const judged = this.judge(evaluation, items).catch((error): { fired: FiredCheck[]; unjudgedReason?: string } => {
      this.options.logger?.warn("check_gate_call_failed", {
        sessionId: scope.sessionId,
        checkpoint,
        error: error instanceof Error ? error.message : String(error),
      });
      return { fired: [], unjudgedReason: "error" };
    });
    evaluation.done = judged.then((partial) => {
      const completedAt = this.now();
      evaluation.completedAt = completedAt;
      const result: CheckEvaluationResult = {
        fired: [...evaluation.patternFired, ...partial.fired],
        judgedQuestions: items.length,
        latencyMs: completedAt - evaluation.startedAt,
        ...(partial.unjudgedReason ? { unjudgedReason: partial.unjudgedReason } : {}),
      };
      evaluation.result = result;
      return result;
    });
    return evaluation;
  }

  private async judge(
    evaluation: CheckEvaluation,
    items: CheckItem[],
  ): Promise<{ fired: FiredCheck[]; unjudgedReason?: string }> {
    const engine = this.options.engine;
    if (items.length === 0 || !engine) return { fired: [] };
    const { scope, subject } = evaluation;
    const checkpoint = evaluation.checkpoint;
    const attribution = {
      agentSessionId: scope.sessionId,
      sessionType: scope.sessionType,
      timelineKey: scope.timelineKey,
      triggerSenderId: scope.triggerSenderId ?? null,
    };
    if (scope.sessionId && this.options.isPayeeOverBudget?.(scope.sessionId)) {
      // Never refuse or delay the output for budget: it proceeds unjudged.
      evaluation.budgetRow = {
        ts: this.now(),
        decisionGroup: evaluation.decisionGroup,
        point: "checks",
        agent: scope.agent,
        timelineKey: scope.timelineKey,
        agentSessionId: scope.sessionId,
        triggerEventId: null,
        candidateSessionId: null,
        source: "heuristic",
        reason: "payee_budget",
        verdictJson: JSON.stringify({ unjudged: true }),
        answersJson: null,
        stateJson: null,
        questionsJson: null,
        servedModel: null,
        servedVersion: null,
        latencyMs: 0,
        inputTokens: null,
        costUsd: null,
      };
      return { fired: [], unjudgedReason: "payee_budget" };
    }
    const knobs = this.knobs(scope.agent);
    // The deadline only stops the waiting; the call itself may finish later and
    // is still recorded (§6.3). Unless `[decisions.checks].timeout_ms` is set,
    // a call may run for twice its checkpoint's deadline.
    const configuredTimeout = decisionsFor(this.options.config as AppConfig, scope.agent).checks?.timeout_ms;
    const callTimeoutMs = configuredTimeout ?? evaluation.deadlineMs * CALL_TIMEOUT_DEADLINE_FACTOR;
    const members = engine.usableMembers("checks", scope.agent, attribution);
    const checksByCode = new Map(evaluation.checks.map((c) => [c.code, c]));
    const plan: PlannedCall[] = planCheckCalls(items, members[0], checkpoint, subject.sources, checksByCode);
    const context = { ...subject.context, checkpoint };
    let unjudgedReason: string | undefined;
    await Promise.all(
      plan.map(async (call) => {
        const record: Partial<CallRecord> & { verdict: ChecksCallVerdict } = { verdict: { results: [] } };
        try {
          const outcome = await engine.evaluate(
            checksPoint,
            {
              items: call.items,
              shape: call.shape,
              scope: call.scope,
              context,
              sources: subject.sources,
              thinkingTailTokens: knobs.thinkingTailTokens,
              ...(call.judgeOutput !== undefined ? { judgeOutput: call.judgeOutput } : {}),
            },
            {
              agentName: scope.agent,
              attribution,
              priority: CHECKPOINT_PRIORITY[checkpoint],
              signal: evaluation.controller.signal,
              decisionGroup: evaluation.decisionGroup,
              timeoutMs: callTimeoutMs,
              onEvaluation: (row) => {
                record.row = row;
              },
            },
          );
          record.verdict = outcome.verdict;
          if (outcome.source !== "model") unjudgedReason ??= outcome.reason ?? "error";
        } catch (error) {
          unjudgedReason ??= "error";
          this.options.logger?.warn("check_gate_call_failed", {
            sessionId: scope.sessionId,
            checkpoint,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (record.row) evaluation.calls.push({ row: record.row, verdict: record.verdict });
      }),
    );

    // Per check: fired when any question reached its threshold; the reported
    // probability and source are those of the strongest question (§4.2).
    const fired: FiredCheck[] = [];
    const byCode = new Map<string, { best?: { p: number; source: CheckSource; choice?: string }; firedBest?: { p: number; source: CheckSource; choice?: string } }>();
    for (const call of evaluation.calls) {
      for (const r of call.verdict.results) {
        const entry = byCode.get(r.code) ?? {};
        const candidate = { p: r.probability, source: r.source, ...(r.choice !== undefined ? { choice: r.choice } : {}) };
        if (!entry.best || r.probability > entry.best.p) entry.best = candidate;
        if (r.fired && (!entry.firedBest || r.probability > entry.firedBest.p)) entry.firedBest = candidate;
        byCode.set(r.code, entry);
      }
    }
    for (const [code, entry] of byCode) {
      if (!entry.firedBest) continue;
      const check = checksByCode.get(code);
      if (!check) continue;
      fired.push(
        firedOf(check, {
          method: "judged",
          source: entry.firedBest.source,
          probability: entry.firedBest.p,
          ...(entry.firedBest.choice !== undefined ? { choice: entry.firedBest.choice } : {}),
        }),
      );
    }
    return unjudgedReason ? { fired, unjudgedReason } : { fired };
  }

  /**
   * Persist a completed evaluation once: its decision rows (one per call, one
   * per pattern hit, the budget skip), each anchored and carrying the
   * consequence, then a `refusal_events` row per fired refusal check. Logs
   * `check_gate_evaluated`. Returns the decision row ids. Never throws.
   */
  async record(evaluation: CheckEvaluation, outcome: RecordOutcome): Promise<number[]> {
    if (evaluation.recorded || evaluation.canceled || !evaluation.result) return [];
    evaluation.recorded = true;
    const result = evaluation.result;
    // Nothing was judged and nothing matched: no rows, no log line.
    if (result.judgedQuestions === 0 && result.fired.length === 0 && !evaluation.budgetRow) return [];
    const { scope, anchor, subject } = evaluation;
    const anchorFields = {
      checkpoint: anchor.checkpoint,
      branch_no: anchor.branchNo ?? 0,
      tool_call_id: anchor.toolCallId ?? null,
      attempt_no: anchor.attemptNo ?? null,
      consequence: outcome.consequence,
    };
    const ids: number[] = [];
    const rowFor = new Map<string, number>();
    const storage = this.options.storage;
    const insert = async (row: DecisionEvaluationInsert, codes: Iterable<string>): Promise<void> => {
      if (!storage) return;
      try {
        const id = await storage.insertDecisionEvaluation(row);
        ids.push(id);
        for (const code of codes) if (!rowFor.has(code)) rowFor.set(code, id);
      } catch (error) {
        this.options.logger?.warn("decision_evaluation_persist_failed", {
          point: "checks",
          decisionGroup: evaluation.decisionGroup,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    for (const hit of evaluation.patternFired) {
      await insert(
        {
          ts: evaluation.startedAt,
          decision_group: evaluation.decisionGroup,
          point: "checks",
          agent: scope.agent,
          timeline_key: scope.timelineKey,
          agent_session_id: scope.sessionId,
          source: "pattern",
          verdict_json: JSON.stringify({ fired: [hit.code], source: hit.source, matched: hit.matched }),
          latency_ms: 0,
          ...anchorFields,
        },
        [hit.code],
      );
    }
    // A judged check links to the row of the call whose answer fired it.
    for (const call of evaluation.calls) {
      await insert({ ...toInsert(call.row), ...anchorFields }, firedCodes(call));
    }
    if (evaluation.budgetRow) await insert({ ...toInsert(evaluation.budgetRow), ...anchorFields }, []);

    for (const fired of result.fired) {
      if (fired.kind !== "refusal") continue;
      const decided = outcome.refusalOutcome ? outcome.refusalOutcome(fired) : { outcome: "observed" as const };
      if (!decided || !storage) continue;
      try {
        await storage.insertRefusalEvent({
          ts: evaluation.completedAt ?? this.now(),
          agentSessionId: scope.sessionId,
          branchNo: anchor.branchNo ?? 0,
          site: scope.site,
          agent: scope.agent,
          timelineKey: scope.timelineKey,
          tasks: scope.tasks ?? null,
          servedModel: subject.servedModel ?? null,
          wireModel: subject.wireModel ?? null,
          kind: "soft",
          checkCode: fired.code,
          reason: fired.reason ?? "unclear",
          method: fired.method,
          source: fired.source ?? null,
          probability: fired.probability ?? null,
          checkpoint: anchor.checkpoint,
          ruleName: decided.ruleName ?? null,
          outcome: decided.outcome,
          toModel: decided.toModel ?? null,
          decisionEvaluationId: rowFor.get(fired.code) ?? null,
        });
      } catch (error) {
        this.options.logger?.warn("refusal_event_persist_failed", {
          sessionId: scope.sessionId,
          checkCode: fired.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.options.logger?.info("check_gate_evaluated", {
      sessionId: scope.sessionId ?? undefined,
      site: scope.site,
      checkpoint: anchor.checkpoint,
      toolCallId: anchor.toolCallId,
      attemptNo: anchor.attemptNo,
      action: subject.context.action,
      fired: result.fired.map((f) => f.code),
      unjudged: outcome.late || result.unjudgedReason !== undefined,
      ...(result.unjudgedReason ? { reason: result.unjudgedReason } : {}),
      late: outcome.late,
      latencyMs: result.latencyMs,
      heldMs: outcome.heldMs,
      questions: result.judgedQuestions,
      calls: evaluation.calls.length,
      consequence: outcome.consequence,
    });
    return ids;
  }
}

function firedOf(check: CheckDefinition, extra: Omit<FiredCheck, "code" | "kind" | "remedy" | "reason">): FiredCheck {
  return {
    code: check.code,
    kind: check.kind,
    remedy: check.remedy,
    ...(check.reason !== undefined ? { reason: check.reason } : {}),
    ...extra,
  };
}

function firedCodes(call: CallRecord): string[] {
  return [...new Set(call.verdict.results.filter((r) => r.fired).map((r) => r.code))];
}

/** The engine's camelCase row as a storage insert (the anchor is added by the caller). */
function toInsert(row: DecisionEvaluationRow): DecisionEvaluationInsert {
  return {
    ts: row.ts,
    decision_group: row.decisionGroup,
    point: row.point,
    agent: row.agent,
    timeline_key: row.timelineKey,
    agent_session_id: row.agentSessionId,
    trigger_event_id: row.triggerEventId,
    candidate_session_id: row.candidateSessionId,
    source: row.source,
    reason: row.reason,
    verdict_json: row.verdictJson,
    answers_json: row.answersJson,
    state_json: row.stateJson,
    questions_json: row.questionsJson,
    served_model: row.servedModel,
    served_version: row.servedVersion,
    latency_ms: row.latencyMs,
    input_tokens: row.inputTokens,
    cost_usd: row.costUsd,
  };
}
