/**
 * Implicit reply (spec LATE-INPUT §6; ARCHITECTURE.md §8h): does a bare group
 * message respond to a specific recent bot message M, without the reply
 * function or a mention? One `noul` (`replies`) per (candidate, M) pair. A yes
 * is handled by the caller exactly as an explicit reply to M; below the
 * threshold, or on any failure, the message stays inert. No heuristic rung.
 *
 * The state is the records point's non-reply framing: recent chat as a
 * continuous suffix with M marked `bot_message: true`, ages precomputed, then
 * the candidate as `message`. Nothing implies a relationship that is not known.
 * {@link implicitReplyPreGate} is the mechanical gate that decides whether the
 * point is asked at all.
 */

import type { CanonicalChatEvent } from "../../types.js";
import type { DecisionPoint } from "../registry.js";
import { jsonTokens } from "../client.js";
import { DEFAULT_IMPLICIT_REPLY_RECENT_MESSAGES, DEFAULT_IMPLICIT_REPLY_THRESHOLD } from "../config.js";
import { ageLabel, packNewest } from "../state.js";
import { toTranscriptMessage } from "../transcript.js";
import type { DecisionQuestion } from "../types.js";

/** One recent-chat message as the state shows it. */
export interface ImplicitReplyChatMessage {
  from: string;
  text: string;
  age: string;
  self?: true;
  /** Marks M, the bot message the candidate may respond to. */
  bot_message?: true;
  attachments?: string[];
}

export interface ImplicitReplyInput {
  /** Chat before the candidate, oldest first, M (marked) included. */
  recent: ImplicitReplyChatMessage[];
  /** The candidate. */
  message: { from: string; text: string; age: string; attachments?: string[] };
  /** External id of M (passed through to the verdict). */
  botMessageId: string;
}

export interface ImplicitReplyVerdict {
  /** `probability ≥ threshold`. Always false on the fallback. */
  replies: boolean;
  /** The `replies` probability; null when not judged. */
  probability: number | null;
  /** False on the fallback verdict (inert). */
  judged: boolean;
  botMessageId: string;
}

const CANDIDATE_TEXT_CLIP = 1200;
const CHAT_TEXT_CLIP = 400;

export const implicitReplyPoint: DecisionPoint<ImplicitReplyInput, ImplicitReplyVerdict> = {
  name: "implicit_reply",

  questions(): Record<string, DecisionQuestion> {
    return {
      replies: {
        type: "noul",
        instructions:
          "`message` responds to the message marked `bot_message` in `recent_chat`: " +
          "it answers it, reacts to it, or asks about it.",
      },
    };
  },

  state(input, budgetTokens) {
    const build = (recent: ImplicitReplyChatMessage[]) => ({ recent_chat: recent, message: input.message });
    // Keep a continuous suffix from M to the candidate; only context before M
    // may be dropped. A suffix that cannot fit is not judged (inert).
    const anchor = input.recent.findIndex((m) => m.bot_message);
    const required = anchor < 0 ? input.recent : input.recent.slice(anchor);
    if (jsonTokens(build(required)) > budgetTokens) throw new Error("implicit_reply_bot_message_outside_budget");
    const packed = packNewest(input.recent, budgetTokens, build);
    return build(packed.length >= required.length ? packed : required);
  },

  resolve(answers, input, threshold, settings) {
    const answer = answers["replies"];
    if (!answer || answer.type !== "noul") return null;
    const floor = threshold("threshold", settings.threshold ?? DEFAULT_IMPLICIT_REPLY_THRESHOLD);
    return { replies: answer.noul >= floor, probability: answer.noul, judged: true, botMessageId: input.botMessageId };
  },

  fallback: (input) => ({ replies: false, probability: null, judged: false, botMessageId: input.botMessageId }),

  describe: (verdict) => ({
    replies: verdict.replies,
    judged: verdict.judged,
    botMessageId: verdict.botMessageId,
    ...(verdict.probability !== null ? { probability: Math.round(verdict.probability * 1000) / 1000 } : {}),
  }),
};

function stateMessage(event: CanonicalChatEvent, maxChars: number, now: number, self: boolean) {
  const message = toTranscriptMessage(event, maxChars);
  return {
    from: message.from,
    text: message.text,
    age: ageLabel(now, event.timestamp),
    ...(self || message.self ? { self: true as const } : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
  };
}

/**
 * Build the implicit-reply input from timeline events (pure). `recent` is the
 * chat before the candidate, oldest first; M is inserted by timestamp if it is
 * missing. Up to `recentMessages` messages before M are kept, plus everything
 * from M up to the candidate. Ages are relative to `now` (default the
 * candidate's send time).
 */
export function implicitReplyInputFrom(args: {
  recent: readonly CanonicalChatEvent[];
  botMessage: CanonicalChatEvent;
  candidate: CanonicalChatEvent;
  /** Sender ids of the bot itself, for events that do not carry `isSelf`. */
  selfIds?: ReadonlySet<string>;
  /** Default 6 (`[decisions.implicit_reply].recent_messages`). */
  recentMessages?: number;
  now?: number;
}): ImplicitReplyInput {
  const now = args.now ?? args.candidate.timestamp;
  const events = args.recent.filter(
    (event) => event.id !== args.candidate.id && event.timestamp <= args.candidate.timestamp,
  );
  let anchor = events.findIndex((event) => event.id === args.botMessage.id);
  if (anchor < 0) {
    const at = events.findIndex((event) => event.timestamp > args.botMessage.timestamp);
    anchor = at < 0 ? events.length : at;
    events.splice(anchor, 0, args.botMessage);
  }
  const limit = args.recentMessages ?? DEFAULT_IMPLICIT_REPLY_RECENT_MESSAGES;
  const window = events.slice(Math.max(0, anchor - limit));
  const isSelf = (event: CanonicalChatEvent) => args.selfIds?.has(event.sender?.id) ?? false;
  const recent: ImplicitReplyChatMessage[] = window.map((event) => ({
    ...stateMessage(event, CHAT_TEXT_CLIP, now, isSelf(event)),
    ...(event.id === args.botMessage.id ? { bot_message: true as const } : {}),
  }));
  const message = stateMessage(args.candidate, CANDIDATE_TEXT_CLIP, now, false);
  delete (message as { self?: true }).self;
  return {
    recent,
    message,
    botMessageId: args.botMessage.externalId ?? args.botMessage.id,
  };
}

// --- mechanical pre-gate (LATE-INPUT §6) ---------------------------------------

/** One timeline message as the pre-gate sees it. */
export interface ImplicitReplyGateEvent {
  id: string;
  /** Send time. */
  timestamp: number;
  /** This agent, another bot (a sibling agent or any bot account), or a human. */
  author: "self" | "bot" | "human";
}

export interface ImplicitReplyGateCandidate extends ImplicitReplyGateEvent {
  /** Carries an explicit reply (to anything). */
  hasReply: boolean;
  /** Mentions this agent. */
  mentionsBot: boolean;
  /** Triggers on its own (mention, DM, reply, …). */
  hasTrigger: boolean;
  /** Already consumed by late input (an edit, a late addition, a revival). */
  consumed?: boolean;
}

export interface ImplicitReplyPreGateInput {
  /** The candidate's timeline is a group (not a DM). */
  isGroup: boolean;
  candidate: ImplicitReplyGateCandidate;
  /** Timeline messages before the candidate, oldest first (only the tail is read). */
  preceding: readonly ImplicitReplyGateEvent[];
  /** `[decisions.implicit_reply].max_messages_after`. */
  maxMessagesAfter: number;
  /** `[decisions.implicit_reply].max_age_ms`. */
  maxAgeMs: number;
}

export type ImplicitReplyGateReason =
  | "not_group"
  | "not_human"
  | "has_reply"
  | "mentions_bot"
  | "has_trigger"
  | "consumed"
  | "no_bot_message";

export type ImplicitReplyPreGateResult =
  | { eligible: true; /** This agent's messages in range, newest first: one evaluation each. */ botMessageIds: string[] }
  | { eligible: false; reason: ImplicitReplyGateReason; botMessageIds: [] };

/**
 * The mechanical gate (pure): a group message from a human, with no reply,
 * mention or trigger of its own and not consumed by late input, sent within
 * `maxMessagesAfter` messages (the candidate is the 1st, 2nd, … message after
 * M) and `maxAgeMs` of a message M of this agent, with no other bot's message
 * in between. Walking back from the candidate, every message of this agent in
 * range is an M (a reply split over several messages gives several); the walk
 * stops at the first message of another bot, at the message bound, or at the
 * age bound.
 */
export function implicitReplyPreGate(input: ImplicitReplyPreGateInput): ImplicitReplyPreGateResult {
  const { candidate } = input;
  const no = (reason: ImplicitReplyGateReason): ImplicitReplyPreGateResult => ({
    eligible: false,
    reason,
    botMessageIds: [],
  });
  if (!input.isGroup) return no("not_group");
  if (candidate.author !== "human") return no("not_human");
  if (candidate.hasReply) return no("has_reply");
  if (candidate.mentionsBot) return no("mentions_bot");
  if (candidate.hasTrigger) return no("has_trigger");
  if (candidate.consumed) return no("consumed");
  const found: string[] = [];
  const preceding = input.preceding;
  for (let i = preceding.length - 1; i >= 0; i--) {
    const distance = preceding.length - i;
    if (distance > input.maxMessagesAfter) break;
    const event = preceding[i]!;
    if (event.timestamp > candidate.timestamp) continue;
    if (candidate.timestamp - event.timestamp > input.maxAgeMs) break;
    if (event.author === "bot") break;
    if (event.author === "self") found.push(event.id);
  }
  return found.length > 0 ? { eligible: true, botMessageIds: found } : no("no_bot_message");
}

/**
 * A timeline event as a pre-gate event: `bot` when its sender is in
 * `otherBotIds` (sibling agents); else `self` by `isSelf`, role `assistant` or
 * `selfIds`; else `bot` for a bot account (`isBot`; webhooks count as human);
 * else `human`.
 */
export function implicitReplyGateEventOf(
  event: CanonicalChatEvent,
  ids: { selfIds?: ReadonlySet<string>; otherBotIds?: ReadonlySet<string> } = {},
): ImplicitReplyGateEvent {
  const senderId = event.sender?.id;
  const author: ImplicitReplyGateEvent["author"] = ids.otherBotIds?.has(senderId)
    ? "bot"
    : event.role === "assistant" || event.sender?.isSelf === true || ids.selfIds?.has(senderId)
      ? "self"
      : event.sender?.isBot === true && event.sender?.isWebhook !== true
        ? "bot"
        : "human";
  return { id: event.id, timestamp: event.timestamp, author };
}
