/**
 * Continuation (ARCHITECTURE.md §8h "Continuation"): where does a message go when
 * there is something to continue? The candidates are the timeline's running
 * sessions and its recently completed sessions that pass every mechanical resume
 * gate and the work gate. The decision model picks one of them, a new request,
 * or (for an untriggered message) "not for the bot". The fallback is today's
 * chain (reply-resume with its same-user and window rules, else fresh; an
 * untriggered message stays inert).
 */

import type { DecisionPoint } from "../registry.js";
import { clipText, packNewest } from "../state.js";
import { senderName, toTranscriptMessage, type TranscriptMessage } from "../transcript.js";
import type { DecisionQuestion } from "../types.js";
import type { CanonicalChatEvent } from "../../types.js";

export const CONTINUATION_NEW = "new";
export const CONTINUATION_NOT_FOR_BOT = "not_for_bot";

export interface ContinuationCandidate {
  /** The session id. */
  sessionId: string;
  status: "running" | "completed";
  askedBy: string;
  asked: string;
  lastReply?: string;
  /** "40s ago" (running: since it started; completed: since it finished). */
  age: string;
}

export interface ContinuationInput {
  message: TranscriptMessage & { mentions_bot: boolean; reply_to?: { from: string; text: string } };
  /** Messages before it, oldest first. */
  context: TranscriptMessage[];
  candidates: ContinuationCandidate[];
  /** False for an untriggered message (adds the `not_for_bot` option). */
  triggered: boolean;
}

export type ContinuationVerdict =
  /** Today's chain (the fallback). */
  | { kind: "default" }
  | { kind: "continue"; sessionId: string; status: "running" | "completed" }
  | { kind: "new" }
  | { kind: "not_for_bot" };

/** Option key of candidate `i` (short keys keep the question small). */
export function candidateKey(i: number): string {
  return `c${i + 1}`;
}

export const continuationPoint: DecisionPoint<ContinuationInput, ContinuationVerdict> = {
  name: "continuation",

  questions(input) {
    const criteria: Record<string, string> = {};
    input.candidates.forEach((c, i) => {
      const reply = c.lastReply ? ` The assistant's last reply: "${c.lastReply}".` : "";
      const state = c.status === "running" ? `still working, started ${c.age}` : `finished ${c.age}`;
      criteria[candidateKey(i)] =
        `It continues, corrects, or asks about the exchange where ${c.askedBy} asked: "${c.asked}".${reply} (${state})`;
    });
    criteria[CONTINUATION_NEW] = "A new request unrelated to the candidate exchanges.";
    if (!input.triggered) {
      criteria[CONTINUATION_NOT_FOR_BOT] = "The message is not directed at the assistant and continues none of its exchanges.";
    }
    const questions: Record<string, DecisionQuestion> = {
      target: {
        type: "choice",
        instructions:
          "`message` is the newest chat message; `context` is the conversation before it; `candidates` are " +
          "exchanges between people and the assistant that are still open. Which one does `message` belong to?",
        criteria,
      },
      is_followup: {
        type: "noul",
        instructions: "`message` continues, corrects, or asks about one of the exchanges in `candidates`.",
      },
    };
    return questions;
  },

  state(input, budgetTokens) {
    const candidates = input.candidates.map((c, i) => ({
      id: candidateKey(i),
      status: c.status,
      asked_by: c.askedBy,
      asked: c.asked,
      ...(c.lastReply ? { last_reply: c.lastReply } : {}),
      age: c.age,
    }));
    const build = (context: TranscriptMessage[]) => ({
      message: input.message,
      context: context.map(({ from, text, self, attachments }) => ({
        from,
        text,
        ...(self ? { self } : {}),
        ...(attachments ? { attachments } : {}),
      })),
      candidates,
    });
    return build(packNewest(input.context, budgetTokens, build));
  },

  resolve(answers, input, threshold, settings) {
    const target = answers["target"];
    const followup = answers["is_followup"];
    if (target?.type !== "choice") return null;
    if (target.confidence < threshold("min_confidence", settings.minConfidence)) return null;
    if (target.choice === CONTINUATION_NEW) return { kind: "new" };
    if (target.choice === CONTINUATION_NOT_FOR_BOT) return input.triggered ? null : { kind: "not_for_bot" };
    const index = input.candidates.findIndex((_c, i) => candidateKey(i) === target.choice);
    if (index < 0) return null;
    // A continuation must also read as one: the two answers have to agree.
    if (followup?.type !== "noul" || followup.noul < 0.5) return null;
    const candidate = input.candidates[index]!;
    return { kind: "continue", sessionId: candidate.sessionId, status: candidate.status };
  },

  fallback: () => ({ kind: "default" }),

  describe: (verdict) =>
    verdict.kind === "continue" ? `${verdict.kind}:${verdict.status}:${verdict.sessionId}` : verdict.kind,
};

/** Build the point's message + context from hydrated events (pure). */
export function continuationMessageFrom(args: {
  message: CanonicalChatEvent;
  /** Hydrated events before it, oldest first. */
  context: CanonicalChatEvent[];
  contextMessages: number;
  mentionsBot: boolean;
}): Pick<ContinuationInput, "message" | "context"> {
  const message: ContinuationInput["message"] = {
    ...toTranscriptMessage(args.message, 1500),
    mentions_bot: args.mentionsBot,
  };
  const reply = args.message.replyTo;
  if (reply && (reply.body || reply.sender)) {
    message.reply_to = { from: senderName(reply.sender), text: clipText(reply.body ?? "", 400) };
  }
  const context = args.context
    .filter((event) => event.id !== args.message.id)
    .slice(-args.contextMessages)
    .map((event) => toTranscriptMessage(event, 400));
  return { message, context };
}
