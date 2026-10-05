/**
 * Orchestration helper for the records decision point (spec SESSION-RECORDS §6.2).
 *
 * {@link selectRecordsToInject} runs one evaluate() per candidate IN PARALLEL,
 * all sharing one decisionGroup, and returns which records to inject ordered by
 * relevance (highest first), capped at max_injected (CONTRACT decision 8).
 *
 * Candidate GATHERING is NOT here — that is W6's job. Callers assemble the
 * candidate list from the timeline and pass it in.
 */

import { nanoid } from "nanoid";
import type { DecisionEngine, DecisionOutcome, EvaluateContext } from "../registry.js";
import type { DecisionsRawConfig } from "../../config/schema.js";
import { recordsPoint, type RecordsInput, type RecordsVerdict } from "./records.js";

/** Default config values (CONTRACT §config). */
export const DEFAULT_RECORDS_CANDIDATES = 3;
export const DEFAULT_RECORDS_MAX_INJECTED = 2;

/** One candidate session record passed to the helper. */
export interface RecordsCandidate {
  /** The session id this record belongs to. */
  sessionId: string;
  /** The record text. */
  record: string;
  /** True when this candidate is the session the trigger is a reply to. */
  isReplyTarget: boolean;
  /** The incoming request (text, sender name, optional attachments). */
  request: RecordsInput["request"];
  /**
   * Set when the trigger is a reply to a bot message in this candidate's
   * session. Only relevant when `isReplyTarget` is true (spec §6.2 state shapes:
   * when `replyTo` is present the reply framing is used regardless of
   * `isReplyTarget`, but conventionally callers set it only on the reply target).
   */
  replyTo?: RecordsInput["replyTo"];
  /**
   * Recent chat messages before the request, oldest first (non-reply framing).
   * Mark this candidate's own bot message with `ofRecord: true`: packing always
   * keeps it in place and budgets the record around it (spec §6.2).
   */
  recentChat?: RecordsInput["recentChat"];
}

/**
 * What W6 must wire to call this helper:
 *
 * ```ts
 * import { selectRecordsToInject } from "../decisions/points/records-select.js";
 *
 * const { inject, decisionGroup, outcomes } = await selectRecordsToInject(
 *   engine,
 *   {
 *     candidates: [
 *       {
 *         sessionId: "s-abc",
 *         record: "...",
 *         isReplyTarget: true,
 *         request: { from: "Alice", text: "post the second one" },
 *         replyTo: { from: "Miku", text: "Found X and Y, not Z." },
 *       },
 *       {
 *         sessionId: "s-def",
 *         record: "...",
 *         isReplyTarget: false,
 *         request: { from: "Alice", text: "post the second one" },
 *         recentChat: [{ from: "Alice", text: "..." }, { from: "Miku", text: "...", self: true, ofRecord: true }],
 *       },
 *     ],
 *     rawDecisions: decisionsFor(config, agentName),
 *   },
 *   {
 *     agentName: "miku",
 *     attribution: { agentSessionId: sessionId, timelineKey, triggerSenderId },
 *     triggerEventId: triggerId,
 *   },
 * );
 * // `inject` is an array of session ids to pass to the injection mechanism.
 * // `decisionGroup` ties all rows in decision_evaluations together.
 * // `outcomes` is a Map<sessionId, DecisionOutcome<RecordsVerdict>> for logging.
 * ```
 */
export interface SelectRecordsInput {
  candidates: RecordsCandidate[];
  /** The effective `[decisions]` table for this agent (from decisionsFor()). */
  rawDecisions: DecisionsRawConfig;
}

export interface SelectRecordsContext {
  agentName: string | null;
  attribution: EvaluateContext["attribution"];
  priority?: EvaluateContext["priority"];
  signal?: AbortSignal;
  triggerEventId?: string | null;
}

export interface SelectRecordsResult {
  /** Session ids to inject, ordered by relevance (highest first). */
  inject: string[];
  /** Shared decision group for all evaluation rows in this batch. */
  decisionGroup: string;
  /** Per-candidate outcomes, keyed by sessionId. */
  outcomes: Map<string, DecisionOutcome<RecordsVerdict>>;
}

/**
 * Run the records decision point for each candidate in parallel, then apply
 * the threshold and inject cap (CONTRACT decision 8, spec §6.2 "Verdict").
 *
 * CONTRACT decision 8 fallback rules (applied automatically when the point is
 * off or the whole engine fails):
 *   - Point off / whole batch failure → inject only the reply target's record
 *     (if any), i.e. the 6.1 rule.
 *   - Per-candidate failure / low confidence → inject reply target, skip others.
 *
 * The records point's own `fallback()` handles per-candidate heuristics, so
 * the fallback rules above emerge naturally: the reply target gets
 * `inject=true` from `fallback()`, others get `inject=false`.
 */
export async function selectRecordsToInject(
  engine: DecisionEngine,
  { candidates, rawDecisions }: SelectRecordsInput,
  ctx: SelectRecordsContext,
): Promise<SelectRecordsResult> {
  const decisionGroup = nanoid();
  const outcomes = new Map<string, DecisionOutcome<RecordsVerdict>>();

  if (candidates.length === 0) {
    return { inject: [], decisionGroup, outcomes };
  }

  const records = rawDecisions.records;
  const maxInjected = records?.max_injected ?? DEFAULT_RECORDS_MAX_INJECTED;

  // Run all candidates in parallel, sharing one decisionGroup.
  const evalCtx: EvaluateContext = {
    agentName: ctx.agentName,
    attribution: ctx.attribution,
    priority: ctx.priority,
    signal: ctx.signal,
    triggerEventId: ctx.triggerEventId,
    decisionGroup,
  };

  const settled = await Promise.allSettled(
    candidates.map((candidate) => {
      const input: RecordsInput = {
        request: candidate.request,
        replyTo: candidate.replyTo,
        recentChat: candidate.recentChat,
        record: candidate.record,
        candidateSessionId: candidate.sessionId,
        isReplyTarget: candidate.isReplyTarget,
      };
      return engine.evaluate(recordsPoint, input, {
        ...evalCtx,
        candidateSessionId: candidate.sessionId,
      });
    }),
  );

  for (let i = 0; i < candidates.length; i++) {
    const result = settled[i]!;
    const sessionId = candidates[i]!.sessionId;
    if (result.status === "fulfilled") {
      outcomes.set(sessionId, result.value);
    } else {
      // A rejected promise means an unhandled throw from evaluate() — should
      // not happen since evaluate() catches internally, but handle defensively.
      // Apply the CONTRACT decision 8 fallback: reply target → inject.
      const isReplyTarget = candidates[i]!.isReplyTarget;
      outcomes.set(sessionId, {
        verdict: {
          inject: isReplyTarget,
          relevance: isReplyTarget ? 1 : 0,
          candidateSessionId: sessionId,
        },
        source: "heuristic",
        reason: "error",
        costUsd: 0,
        decisionGroup,
      });
    }
  }

  // Collect injections: filter to inject=true, sort by relevance desc, cap.
  const injections: Array<{ sessionId: string; relevance: number }> = [];
  for (const [sessionId, outcome] of outcomes) {
    if (outcome.verdict.inject) {
      injections.push({ sessionId, relevance: outcome.verdict.relevance });
    }
  }
  injections.sort((a, b) => b.relevance - a.relevance);
  const inject = injections.slice(0, maxInjected).map((i) => i.sessionId);

  return { inject, decisionGroup, outcomes };
}
