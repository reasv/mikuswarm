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
import { jsonTokens } from "../client.js";
import { clipText, packNewest } from "../state.js";
import type { PointSettings } from "../config.js";
import type { DecisionAnswers, DecisionQuestion } from "../types.js";

/** The request end of the records-point input. */
export interface RecordsRequest {
  from: string;
  text: string;
  attachments?: string[];
  reply_to?: { from: string; text: string };
}

/** One recent-chat message as seen by the point. */
export interface RecordsChatMessage {
  from: string;
  text: string;
  self?: true;
  age?: string;
  /**
   * Marks the record's own bot message, emitted as record_message for the judge.
   * A candidate is skipped if its continuous conversation suffix cannot fit.
   */
  ofRecord?: true;
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
   * actually sat in the timeline (marked `ofRecord`, so packing keeps it); it is
   * never re-presented as a reply target.
   */
  recentChat?: RecordsChatMessage[];
  /** The session record text to judge for relevance. */
  record: string;
  /** The session id this record belongs to (passed through to the outcome). */
  candidateSessionId: string;
  /** True when this candidate is the session targeted by the reply (spec §6.2). */
  isReplyTarget: boolean;
  /**
   * `[session_records].inject_on_reply` (absent = true): the fallback is the
   * 6.1 rule, so a reply target is injected without a verdict only when on.
   */
  injectOnReply?: boolean;
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
          "`request` asks about, refers to, or continues the SAME specific work described in `record`. " +
          "The message marked record_message (or reply_to) belongs to that record. " +
          "A similar topic alone is not a match. If request.reply_to is present, the request refers to that message.",
      } satisfies DecisionQuestion,
    };
  },

  state(input: RecordsInput, budgetTokens: number): unknown {
    const clippedRequest: RecordsRequest = {
      from: input.request.from,
      text: clipText(input.request.text, REQUEST_TEXT_CLIP),
      ...(input.request.reply_to ? { reply_to: { from: input.request.reply_to.from, text: clipText(input.request.reply_to.text, CHAT_TEXT_CLIP) } } : {}),
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
      const fullTokenEst = jsonTokens(full);
      if (fullTokenEst <= budgetTokens) return full;
      // Clip the record to fit.
      const record = clipRecord(input.record, budgetTokens, () =>
        buildReplyState(clippedRequest, replyTo, ""),
      );
      return buildReplyState(clippedRequest, replyTo, record);
    }

    // Keep a continuous suffix. Never pin an old message across omitted chat.
    const recentChat = (input.recentChat ?? []).map((m) => ({
      from: m.from,
      text: clipText(m.text, CHAT_TEXT_CLIP),
      ...(m.self ? { self: true as const } : {}),
      ...(m.age ? { age: m.age } : {}),
      ...(m.ofRecord ? { record_message: true as const } : {}),
    }));
    const candidateIndex = recentChat.findIndex((m) => m.record_message);
    const required = candidateIndex < 0 ? [] : recentChat.slice(candidateIndex);
    const build = (chat: typeof recentChat, record: string) => ({ request: clippedRequest, recent_chat: chat, record });
    if (jsonTokens(build(required, "")) > budgetTokens) {
      // The engine's non-reply fallback skips this candidate. It cannot be judged
      // faithfully if the continuous conversation from its message will not fit.
      throw new Error("record_candidate_outside_context_budget");
    }
    let record = input.record;
    if (jsonTokens(build(required, record)) > budgetTokens) {
      record = clipRecord(record, budgetTokens, () => build(required, ""));
    }
    const packed = packNewest(recentChat, budgetTokens, (chat) => build(chat, record));
    if (candidateIndex >= 0 && !packed.some((m) => m.record_message)) {
      throw new Error("record_candidate_outside_context_budget");
    }
    return build(packed, record);
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
    // follows the threshold-name convention: `records.inject_threshold`, then
    // the bare `inject_threshold` (spec §6.2 "Verdict").
    const baseThreshold = settings.injectThreshold ?? DEFAULT_INJECT_THRESHOLD;
    const injectThreshold = threshold("inject_threshold", baseThreshold);
    return {
      inject: answer.noul >= injectThreshold,
      relevance: answer.noul,
      candidateSessionId: input.candidateSessionId,
    };
  },

  fallback(input: RecordsInput): RecordsVerdict {
    // CONTRACT decision 8 (the 6.1 rule): reply target → inject when
    // inject_on_reply is on; others → don't.
    const inject = input.isReplyTarget && input.injectOnReply !== false;
    return {
      inject,
      relevance: inject ? 1 : 0,
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
 * Clip the record text so that `builder("") + clipped record` fits the budget.
 * Appends a truncation marker so the model knows it is cut.
 */
function clipRecord(record: string, budgetTokens: number, baseBuilder: () => unknown): string {
  const base = baseBuilder() as Record<string, unknown>;
  const chars = Array.from(record);
  let low = 0;
  let high = chars.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = chars.slice(0, mid).join("") + RECORD_CLIP_SUFFIX;
    if (jsonTokens({ ...base, record: text }) <= budgetTokens) {
      best = text;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (!best || best === RECORD_CLIP_SUFFIX) throw new Error("record_candidate_outside_context_budget");
  return best;
}
