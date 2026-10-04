/**
 * Decision points and their evaluation (ARCHITECTURE.md §8h).
 *
 * A {@link DecisionPoint} declares how to build state from its input, its
 * question map, a pure `resolve` (null = not confident enough), and the
 * fallback verdict (today's behaviour, unchanged). {@link DecisionEngine.evaluate}
 * runs the chain and falls back on any failure of the whole chain: point off,
 * budget blocked, every member unhealthy, no fitting member, timeout, HTTP or
 * parse failure, or low confidence. Every evaluation of an enabled point is
 * logged once (`decision_evaluated`) and every billed attempt is one
 * `usage_events` row of class `decision`. Enabled points also emit one
 * {@link DecisionEvaluationRow} per evaluation to the optional `onEvaluation`
 * sink (CONTRACT decision 6/§8); storage wiring is left to the caller.
 */

import { nanoid } from "nanoid";
import type { AppConfig } from "../config/index.js";
import type { LlmScheduler, PriorityClass } from "../agent/scheduler.js";
import type { Logger } from "../observability/logger.js";
import type { UsageEventInput } from "../storage/database.js";
import { DecisionClient, NoFittingMemberError, type BilledAttempt } from "./client.js";
import {
  calibratedThreshold,
  decisionsFor,
  pointSettings,
  type DecisionPointName,
  type PointSettings,
} from "./config.js";
import { summarizeAnswers, type DecisionAnswers, type DecisionQuestion } from "./types.js";

/**
 * One row emitted per `evaluate()` outcome — maps 1:1 to the
 * `decision_evaluations` table (CONTRACT §storage). The sink receives it
 * immediately after the evaluation; storage wiring is the caller's concern.
 *
 * Column mapping (camelCase → snake_case):
 *   ts               → ts
 *   decisionGroup    → decision_group
 *   point            → point
 *   agent            → agent
 *   timelineKey      → timeline_key
 *   agentSessionId   → agent_session_id
 *   triggerEventId   → trigger_event_id
 *   candidateSessionId → candidate_session_id
 *   source           → source
 *   reason           → reason
 *   verdictJson      → verdict_json
 *   answersJson      → answers_json
 *   stateJson        → state_json  (capped 64 KiB; ends with "…[truncated]" when cut)
 *   questionsJson    → questions_json  (capped 16 KiB; same marker when cut)
 *   servedModel      → served_model
 *   servedVersion    → served_version
 *   latencyMs        → latency_ms
 *   inputTokens      → input_tokens
 *   costUsd          → cost_usd
 */
export interface DecisionEvaluationRow {
  ts: number;
  decisionGroup: string;
  point: string;
  agent: string | null;
  timelineKey: string | null;
  agentSessionId: string | null;
  triggerEventId: string | null;
  candidateSessionId: string | null;
  source: "model" | "heuristic";
  reason: string | null;
  verdictJson: string | null;
  answersJson: string | null;
  /** JSON of the state sent to the member; capped at 64 KiB. */
  stateJson: string | null;
  /** JSON of the questions sent; capped at 16 KiB. */
  questionsJson: string | null;
  servedModel: string | null;
  servedVersion: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  costUsd: number | null;
}

/** Who a decision is billed to (ARCHITECTURE.md §8f/§8h). */
export interface DecisionAttribution {
  agentSessionId?: string | null;
  sessionType?: string | null;
  timelineKey?: string | null;
  triggerSenderId?: string | null;
}

/** Threshold lookup bound to the member that served the answers. */
export type ThresholdFn = (name: string, pointValue: number) => number;

export interface DecisionPoint<I, V> {
  name: DecisionPointName;
  questions(input: I, settings: PointSettings): Record<string, DecisionQuestion>;
  /** State for a token budget; must fit it (pack newest-first). */
  state(input: I, budgetTokens: number): unknown;
  /** Map answers to a verdict, or null when not confident enough. */
  resolve(answers: DecisionAnswers, input: I, threshold: ThresholdFn, settings: PointSettings): V | null;
  /** Today's behaviour for this decision — the last rung. */
  fallback(input: I): V;
  /** A cheap, loggable summary of a verdict. */
  describe(verdict: V): unknown;
}

export type DecisionSource = "model" | "heuristic";

export interface DecisionOutcome<V> {
  verdict: V;
  source: DecisionSource;
  /** Why the fallback verdict was used. */
  reason?: string;
  answers?: DecisionAnswers;
  servedModel?: string;
  costUsd: number;
  /** Groups this outcome with related evaluations (CONTRACT decision 6). */
  decisionGroup: string;
}

export interface BudgetCheck {
  check(descriptor: {
    class: string;
    tool?: string;
    modelId: string;
    logicalModelId?: string;
    sessionType?: string;
    timelineKey?: string;
  }): { allowed: boolean };
}

export interface DecisionEngineOptions {
  config: AppConfig;
  client: DecisionClient;
  scheduler?: LlmScheduler;
  /** The §8e engine; read per call (it is built after the engine). */
  budget?: () => BudgetCheck | undefined;
  /** The usage-ledger fan-in (`recordUsageEvent`). */
  record?: (event: UsageEventInput) => void;
  /**
   * Evaluation sink (CONTRACT decision 6/§8): called once per `evaluate()`
   * outcome for every enabled point. The caller wires this to storage; no
   * storage import here. Disabled points produce no row.
   */
  onEvaluation?: (row: DecisionEvaluationRow) => void;
  logger?: Logger;
  now?: () => number;
}

export interface EvaluateContext {
  agentName: string | null;
  attribution: DecisionAttribution;
  priority?: PriorityClass;
  signal?: AbortSignal;
  /** Cheap verdict of today's code, logged alongside for agreement analysis. */
  heuristicVerdict?: unknown;
  /**
   * Groups related evaluations (CONTRACT decision 6). When omitted a fresh id
   * is generated; pass the same value across a parallel batch (e.g. all records
   * candidates plus routing in one trigger) to tie their rows together.
   */
  decisionGroup?: string;
  /** The candidate session being evaluated (records point; logged as-is). */
  candidateSessionId?: string | null;
  /** The event that triggered this decision (logged as-is). */
  triggerEventId?: string | null;
}

const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

export class DecisionEngine {
  private readonly lastUnavailableLog = new Map<string, number>();

  constructor(private readonly options: DecisionEngineOptions) {}

  /** The resolved settings of `point` for an agent, or undefined when it is off. */
  settings(point: DecisionPointName, agentName: string | null): PointSettings | undefined {
    return pointSettings(decisionsFor(this.options.config, agentName), point);
  }

  /** The effective raw `[decisions]` table for an agent (point-specific knobs). */
  raw(agentName: string | null) {
    return decisionsFor(this.options.config, agentName);
  }

  isEnabled(point: DecisionPointName, agentName: string | null): boolean {
    return this.settings(point, agentName) !== undefined;
  }

  async evaluate<I, V>(point: DecisionPoint<I, V>, input: I, ctx: EvaluateContext): Promise<DecisionOutcome<V>> {
    const settings = this.settings(point.name, ctx.agentName);
    const decisionGroup = ctx.decisionGroup ?? nanoid();
    if (!settings) {
      return { verdict: point.fallback(input), source: "heuristic", reason: "disabled", costUsd: 0, decisionGroup };
    }
    const now = this.options.now ?? Date.now;
    const started = now();
    let costUsd = 0;
    let inputTokens = 0;

    // Compute questions once (pure, deterministic for the same settings).
    const questions = point.questions(input, settings);
    const questionsJson = capJsonBytes(questions, 16 * 1024);

    // Emit one evaluation row to the optional sink (no storage import here).
    const emitRow = (
      source: "model" | "heuristic",
      reason: string | null,
      verdictJson: string | null,
      answersJson: string | null,
      stateJson: string | null,
      servedModel: string | null,
      servedVersion: string | null,
    ): void => {
      if (!this.options.onEvaluation) return;
      try {
        this.options.onEvaluation({
          ts: now(),
          decisionGroup,
          point: point.name,
          agent: ctx.agentName,
          timelineKey: ctx.attribution.timelineKey ?? null,
          agentSessionId: ctx.attribution.agentSessionId ?? null,
          triggerEventId: ctx.triggerEventId ?? null,
          candidateSessionId: ctx.candidateSessionId ?? null,
          source,
          reason,
          verdictJson,
          answersJson,
          stateJson,
          questionsJson,
          servedModel,
          servedVersion: servedVersion ?? null,
          latencyMs: now() - started,
          inputTokens: inputTokens > 0 ? inputTokens : null,
          costUsd: costUsd > 0 ? costUsd : null,
        });
      } catch (error) {
        this.options.logger?.warn("decision_emit_row_failed", { point: point.name, error: errorMessage(error) });
      }
    };

    // Best-effort state JSON for fallback rows where no request was made.
    const fallbackStateJson = (): string | null => {
      try {
        const state = point.state(input, settings.stateMaxTokens);
        return capJsonBytes(state, 64 * 1024);
      } catch {
        return null;
      }
    };

    const fallback = (reason: string, extra: Record<string, unknown> = {}): DecisionOutcome<V> => {
      const verdict = point.fallback(input);
      this.log(point, settings, ctx, started, {
        source: "heuristic",
        reason,
        verdict: point.describe(verdict),
        costUsd,
        inputTokens,
        ...extra,
      });
      // Use actual state when we ran a request (low_confidence has stateTokens).
      let stateJson: string | null;
      const stateTokens = typeof extra["stateTokens"] === "number" ? extra["stateTokens"] : null;
      if (stateTokens !== null) {
        try {
          stateJson = capJsonBytes(point.state(input, stateTokens), 64 * 1024);
        } catch {
          stateJson = fallbackStateJson();
        }
      } else {
        stateJson = fallbackStateJson();
      }
      const answersJson = "answers" in extra ? safeJson(extra["answers"]) : null;
      emitRow(
        "heuristic",
        reason,
        safeJson(point.describe(verdict)),
        answersJson,
        stateJson,
        typeof extra["servedModel"] === "string" ? extra["servedModel"] : null,
        typeof extra["servedVersion"] === "string" ? extra["servedVersion"] : null,
      );
      return {
        verdict,
        source: "heuristic",
        reason,
        costUsd,
        decisionGroup,
        ...("answers" in extra ? { answers: extra["answers"] as DecisionAnswers } : {}),
      };
    };

    let chain;
    try {
      chain = this.options.client.chain(settings.model);
    } catch (error) {
      return fallback("config", { error: errorMessage(error) });
    }

    // Budget: a member is usable only while every covering [[limits]] rule has
    // headroom. A blocked decision budget means "decide the old way".
    const budget = this.options.budget?.();
    const available = new Map<string, boolean>();
    for (const member of chain) {
      const allowed = budget
        ? budget.check({
            class: "decision",
            tool: point.name,
            modelId: member.config.id,
            logicalModelId: member.logicalId,
            sessionType: ctx.attribution.sessionType ?? undefined,
            timelineKey: ctx.attribution.timelineKey ?? undefined,
          }).allowed
        : true;
      available.set(member.logicalId, allowed);
    }
    if (![...available.values()].some(Boolean)) return fallback("budget");

    // Every member unhealthy with no probe due → do not even try.
    const scheduler = this.options.scheduler;
    if (scheduler) {
      const usable = chain.some((member) => {
        const key = `${member.config.endpoint ?? "unknown"}::${member.config.id}`;
        return scheduler.modelHealth(key) === "healthy" || scheduler.isProbeDue(key);
      });
      if (!usable) {
        this.logUnavailable(settings.model, chain.map((m) => m.logicalId));
        return fallback("unavailable");
      }
    }

    const onBilled = (attempt: BilledAttempt): void => {
      costUsd += attempt.costUsd;
      inputTokens += attempt.inputTokens;
      this.recordUsage(point, ctx.attribution, attempt);
    };

    let result;
    try {
      result = await this.options.client.decide(
        settings.model,
        {
          questions,
          state: (budgetTokens) => point.state(input, budgetTokens),
          stateMaxTokens: settings.stateMaxTokens,
          minStateTokens: settings.minStateTokens,
        },
        {
          consumer: `decision:${point.name}`,
          priority: ctx.priority ?? "interactive",
          timeoutMs: settings.timeoutMs,
          signal: ctx.signal,
          isModelAvailable: (id) => available.get(id) ?? true,
          onBilled,
        },
      );
    } catch (error) {
      if (error instanceof NoFittingMemberError) return fallback("no_fitting_member");
      if (error instanceof Error && error.name === "AbortError") {
        return fallback(ctx.signal?.aborted ? "aborted" : "timeout");
      }
      return fallback("error", { error: errorMessage(error) });
    }

    const threshold: ThresholdFn = (name, pointValue) =>
      calibratedThreshold(settings, result.logicalId, name, pointValue);
    let verdict: V | null;
    try {
      verdict = point.resolve(result.answers, input, threshold, settings);
    } catch (error) {
      verdict = null;
      this.options.logger?.warn("decision_resolve_failed", { point: point.name, error: errorMessage(error) });
    }
    const served = {
      answers: result.answers,
      servedModel: result.logicalId,
      servedVersion: result.servedVersion,
      stateTokens: result.stateTokens,
      billing: result.billing,
    };
    if (verdict === null) return fallback("low_confidence", served);
    this.log(point, settings, ctx, started, {
      source: "model",
      verdict: point.describe(verdict),
      costUsd,
      inputTokens,
      ...served,
    });
    // Reconstruct actual state sent using the stateTokens reported by the result.
    let stateJson: string | null;
    try {
      stateJson = capJsonBytes(point.state(input, result.stateTokens), 64 * 1024);
    } catch {
      stateJson = null;
    }
    emitRow(
      "model",
      null,
      safeJson(point.describe(verdict)),
      safeJson(result.answers),
      stateJson,
      result.logicalId,
      result.servedVersion ?? null,
    );
    return {
      verdict,
      source: "model",
      answers: result.answers,
      servedModel: result.logicalId,
      costUsd,
      decisionGroup,
    };
  }

  private recordUsage(point: { name: string }, attribution: DecisionAttribution, attempt: BilledAttempt): void {
    if (!this.options.record) return;
    try {
      this.options.record({
        class: "decision",
        toolName: point.name,
        agentSessionId: attribution.agentSessionId ?? null,
        sessionType: attribution.sessionType ?? null,
        timelineKey: attribution.timelineKey ?? null,
        triggerSenderId: attribution.triggerSenderId ?? null,
        modelId: attempt.config.id,
        logicalModelId: attempt.logicalId,
        provider: attempt.config.provider,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        costUsd: attempt.costUsd,
        ref: attempt.servedVersion ?? null,
      });
    } catch (error) {
      this.options.logger?.warn("decision_usage_record_failed", { point: point.name, error: errorMessage(error) });
    }
  }

  private log(
    point: { name: string },
    settings: PointSettings,
    ctx: EvaluateContext,
    started: number,
    fields: Record<string, unknown> & { answers?: DecisionAnswers },
  ): void {
    const { answers, ...rest } = fields;
    this.options.logger?.info("decision_evaluated", {
      point: point.name,
      agent: ctx.agentName ?? undefined,
      timelineKey: ctx.attribution.timelineKey ?? undefined,
      sessionId: ctx.attribution.agentSessionId ?? undefined,
      model: settings.model,
      latencyMs: (this.options.now ?? Date.now)() - started,
      ...(answers ? { answers: summarizeAnswers(answers) } : {}),
      ...(ctx.heuristicVerdict !== undefined ? { heuristicVerdict: ctx.heuristicVerdict } : {}),
      ...rest,
    });
  }

  private logUnavailable(model: string, chain: string[]): void {
    const now = (this.options.now ?? Date.now)();
    const last = this.lastUnavailableLog.get(model) ?? 0;
    if (now - last < UNAVAILABLE_LOG_INTERVAL_MS) return;
    this.lastUnavailableLog.set(model, now);
    this.options.logger?.warn("decision_model_unavailable", { model, chain });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize `value` to JSON, capping the result at `maxBytes` UTF-8 bytes.
 * When truncated, appends `…[truncated]` so the reader knows the value is cut.
 */
function capJsonBytes(value: unknown, maxBytes: number): string {
  const full = JSON.stringify(value);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
  // Slice to roughly maxBytes chars (UTF-8 chars are 1–4 bytes; chars ≈ bytes).
  const marker = "…[truncated]";
  let sliced = full.slice(0, maxBytes - marker.length);
  while (Buffer.byteLength(sliced + marker, "utf8") > maxBytes && sliced.length > 0) {
    sliced = sliced.slice(0, sliced.length - 1);
  }
  return sliced + marker;
}

/** `JSON.stringify(value)` or `null` on any error. */
function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
