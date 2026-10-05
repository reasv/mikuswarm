/**
 * Records point (spec SESSION-RECORDS §6.2): for each candidate session record,
 * decide whether it is relevant to the current request and should be injected
 * into the new session's context.
 *
 * One evaluate() call per candidate, in parallel, sharing a decisionGroup.
 * The orchestration helper {@link selectRecordsToInject} owns the parallel
 * fan-out and the fallback rules (CONTRACT decision 8).
 */

import type { DecisionPoint } from "../registry.js";
import { clipText, packNewest } from "../state.js";
import type { PointSettings } from "../config.js";
import type { DecisionAnswers, DecisionQuestion } from "../types.js";

/** The request end of the records-point input. */
export interface RecordsRequest {
  from: string;
  text: string;
  attachments?: string[];
}

/** One recent-chat message as seen by the point. */
export interface RecordsChatMessage {
  from: string;
  text: string;
  self?: true;
}

/**
 * Input for one records-point evaluation (one candidate session record).
 * The caller builds one of these per candidate and calls engine.evaluate()
 * for each (in parallel via {@link selectRecordsToInject}).
 */
export interface RecordsInput {
  /** The incoming request message. */
  request: RecordsRequest;
  /**
   * Set when the trigger is a reply to a bot message (spec §6.2 state shaping).
   * When set, the state is shaped as `{ request, reply_to, record }`.
   * When absent, the state is `{ request, recent_chat, record }`.
   */
  replyTo?: { from: string; text: string };
  /**
   * Recent chat messages before the request, oldest first. Used in the
   * non-reply state. The record's bot message appears inline here where it
   * actually sat in the timeline; it is never re-presented as a reply target.
   */
  recentChat?: RecordsChatMessage[];
  /** The session record text to judge for relevance. */
  record: string;
  /** The session id this record belongs to (passed through to the outcome). */
  candidateSessionId: string;
  /** True when this candidate is the session targeted by the reply (spec §6.2). */
  isReplyTarget: boolean;
}

/** Verdict: whether to inject this record. */
export interface RecordsVerdict {
  inject: boolean;
  /** Probability from the `relevant` question. */
  relevance: number;
  candidateSessionId: string;
}

const DEFAULT_INJECT_THRESHOLD = 0.6;
/** Maximum chars for the request text in state. */
const REQUEST_TEXT_CLIP = 1200;
/** Maximum chars per recent-chat message text in state. */
const CHAT_TEXT_CLIP = 400;
/** Maximum chars for the record in state when it can't fit whole. */
const RECORD_CLIP_SUFFIX = "…[record truncated]";

export const recordsPoint: DecisionPoint<RecordsInput, RecordsVerdict> = {
  name: "records",

  questions(_input: RecordsInput, _settings: PointSettings): Record<string, DecisionQuestion> {
    return {
      relevant: {
        type: "noul",
        instructions:
          "`request` asks about, refers to, or continues the work described in `record`.",
      } satisfies DecisionQuestion,
    };
  },

  state(input: RecordsInput, budgetTokens: number): unknown {
    const clippedRequest: RecordsRequest = {
      from: input.request.from,
      text: clipText(input.request.text, REQUEST_TEXT_CLIP),
      ...(input.request.attachments?.length ? { attachments: input.request.attachments } : {}),
    };

    if (input.replyTo) {
      // Reply framing: the model sees the request as a reply to this bot message.
      const replyTo = {
        from: input.replyTo.from,
        text: clipText(input.replyTo.text, CHAT_TEXT_CLIP),
      };
      // Try to fit the full record; clip it if the budget is tight.
      const full = buildReplyState(clippedRequest, replyTo, input.record);
      const fullTokenEst = roughTokens(JSON.stringify(full));
      if (fullTokenEst <= budgetTokens) return full;
      // Clip the record to fit.
      const record = clipRecord(input.record, budgetTokens, () =>
        buildReplyState(clippedRequest, replyTo, ""),
      );
      return buildReplyState(clippedRequest, replyTo, record);
    }

    // Non-reply framing: the record's bot message appears inline in recent_chat.
    const recentChat = (input.recentChat ?? []).map((m) => ({
      from: m.from,
      text: clipText(m.text, CHAT_TEXT_CLIP),
      ...(m.self ? { self: true as const } : {}),
    }));

    const buildWithChat = (chat: typeof recentChat) => ({
      request: clippedRequest,
      recent_chat: chat,
      record: input.record,
    });
    const buildWithChatClipped = (chat: typeof recentChat, rec: string) => ({
      request: clippedRequest,
      recent_chat: chat,
      record: rec,
    });

    // Pack newest-first, then try to fit the record whole.
    const packed = packNewest(recentChat, budgetTokens, buildWithChat);
    const withPacked = buildWithChat(packed);
    const packedTokens = roughTokens(JSON.stringify(withPacked));
    if (packedTokens <= budgetTokens) return withPacked;

    // Record doesn't fit whole: clip it.
    const record = clipRecord(input.record, budgetTokens, () => buildWithChatClipped(packed, ""));
    return buildWithChatClipped(packed, record);
  },

  resolve(
    answers: DecisionAnswers,
    input: RecordsInput,
    threshold: (name: string, value: number) => number,
    settings: PointSettings,
  ): RecordsVerdict | null {
    const answer = answers["relevant"];
    if (!answer || answer.type !== "noul") return null;
    // `settings.injectThreshold` is populated by pointSettings() for the records
    // point (from config `[decisions.records].inject_threshold`). Calibration
    // keys are `records.relevant` → `relevant` (spec §6.2 "Verdict").
    const baseThreshold = settings.injectThreshold ?? DEFAULT_INJECT_THRESHOLD;
    const injectThreshold = threshold("relevant", baseThreshold);
    return {
      inject: answer.noul >= injectThreshold,
      relevance: answer.noul,
      candidateSessionId: input.candidateSessionId,
    };
  },

  fallback(input: RecordsInput): RecordsVerdict {
    // CONTRACT decision 8: reply target → inject; others → don't.
    return {
      inject: input.isReplyTarget,
      relevance: input.isReplyTarget ? 1 : 0,
      candidateSessionId: input.candidateSessionId,
    };
  },

  describe(verdict: RecordsVerdict): unknown {
    return {
      inject: verdict.inject,
      relevance: Math.round(verdict.relevance * 1000) / 1000,
      candidateSessionId: verdict.candidateSessionId,
    };
  },
};

function buildReplyState(
  request: RecordsRequest,
  replyTo: { from: string; text: string },
  record: string,
): unknown {
  return { request, reply_to: replyTo, record };
}

/**
 * Estimate tokens for a JSON string: 1 token ≈ 4 chars (rough but consistent
 * with how routing state is packed).
 */
function roughTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Clip the record text so that `builder("") + clipped record` fits the budget.
 * Appends a truncation marker so the model knows it is cut.
 */
function clipRecord(record: string, budgetTokens: number, baseBuilder: () => unknown): string {
  const baseJson = JSON.stringify(baseBuilder());
  const baseTokens = roughTokens(baseJson);
  const recordBudgetChars = Math.max(0, (budgetTokens - baseTokens) * 4 - RECORD_CLIP_SUFFIX.length - 10);
  if (recordBudgetChars <= 0) return RECORD_CLIP_SUFFIX;
  const chars = Array.from(record);
  if (chars.length <= recordBudgetChars) return record;
  return chars.slice(0, recordBudgetChars).join("") + RECORD_CLIP_SUFFIX;
}
