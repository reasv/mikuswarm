/**
 * Late addition (spec LATE-INPUT §5.2 "Membership"; ARCHITECTURE.md §8h): does
 * a message the trigger's sender sent after the request (before the bot's first
 * delivered message) belong to that request? One `noul` (`belongs`) per
 * eligible candidate. Eligibility, folding and the redo are the caller's; this
 * module is the pure point, its input builder and its knobs.
 *
 * The state never implies that the candidate is addressed to the bot: it is the
 * chat around the request, the request, what others said in between, and the
 * candidate, with precomputed age labels. Attachments carry a caption only when
 * one already exists (the judgement never waits for captioning); a media
 * candidate's pixels go to the vision chain (default mode `always`).
 */

import type { AttachmentMeta, CanonicalChatEvent } from "../../types.js";
import type { DecisionImageRef } from "../images.js";
import { imageRefsOf } from "../images.js";
import type { DecisionPoint, DecisionStateView } from "../registry.js";
import { jsonTokens } from "../client.js";
import { DEFAULT_LATE_ADDITION_RECENT_MESSAGES, DEFAULT_LATE_ADDITION_THRESHOLD } from "../config.js";
import { clipText, durationLabel, packNewest } from "../state.js";
import { senderName } from "../transcript.js";
import type { DecisionQuestion } from "../types.js";

/** One chat message before or between, as the state shows it. */
export interface LateAdditionChatMessage {
  from: string;
  text: string;
  /** "40s before" (before the request) or "6s after request". */
  age: string;
  /** Set on the bot's own messages. */
  self?: true;
}

/** An attachment of the request or the candidate. */
export interface LateAdditionAttachment {
  kind: AttachmentMeta["mediaType"];
  /** The caption, only when one already exists. */
  caption: string | null;
  /** The subject-image ref id, for images (labelled on a vision attempt). */
  imageRefId?: string;
}

export interface LateAdditionPost {
  from: string;
  text: string;
  attachments: LateAdditionAttachment[];
}

export interface LateAdditionInput {
  /** Messages before the request, oldest first. */
  before: LateAdditionChatMessage[];
  /** The request: the trigger group, as one post. */
  request: LateAdditionPost;
  /** Messages between the request and the candidate, oldest first. */
  between: LateAdditionChatMessage[];
  /** The candidate. */
  message: LateAdditionPost & { age: string };
  /** Subject images: the candidate's, then the request's (newest first). */
  images: DecisionImageRef[];
}

export interface LateAdditionVerdict {
  /** `probability ≥ threshold`. Always false on the fallback. */
  belongs: boolean;
  /** The `belongs` probability; null when not judged. */
  probability: number | null;
  /**
   * False on the fallback verdict (point off, no decision model, a failed
   * call): the caller then applies the quick fold windows (LATE-INPUT §5.2).
   */
  judged: boolean;
}

/** The fallback verdict: not judged. */
export const LATE_ADDITION_NOT_JUDGED: LateAdditionVerdict = { belongs: false, probability: null, judged: false };

const POST_TEXT_CLIP = 1200;
const CHAT_TEXT_CLIP = 400;
const CAPTION_CLIP = 400;
/** Most messages kept between the request and the candidate (newest kept). */
const MAX_BETWEEN = 12;

function renderAttachment(attachment: LateAdditionAttachment, view: DecisionStateView | undefined) {
  const label = attachment.imageRefId ? view?.imageLabels.get(attachment.imageRefId) : undefined;
  return {
    kind: attachment.kind,
    ...(label ? { image: label } : {}),
    caption: attachment.caption,
  };
}

function renderPost(post: LateAdditionPost, view: DecisionStateView | undefined) {
  return { from: post.from, text: post.text, attachments: post.attachments.map((a) => renderAttachment(a, view)) };
}

export const lateAdditionPoint: DecisionPoint<LateAdditionInput, LateAdditionVerdict> = {
  name: "late_addition",

  questions(_input, _settings, view): Record<string, DecisionQuestion> {
    return {
      belongs: {
        type: "noul",
        instructions:
          "`message` supplies something `request` refers to or expects, or continues, corrects or adds to it, " +
          "written by the same person for the same purpose." +
          (view?.vision
            ? " The images follow the state, each after a line with its label; an attachment's `image` field is that label."
            : ""),
      },
    };
  },

  state(input, budgetTokens, view) {
    const request = renderPost(input.request, view);
    const message = { ...renderPost(input.message, view), age: input.message.age };
    const build = (before: LateAdditionChatMessage[], between: LateAdditionChatMessage[], omitted: number) => ({
      before,
      request,
      ...(omitted > 0 ? { between_omitted: omitted } : {}),
      between,
      message,
    });
    // Drop the oldest context before the request first; only when none of it
    // fits, drop the oldest messages in between (counted, never silently bridged).
    const before = packNewest(input.before, budgetTokens, (kept) => build(kept, input.between, 0));
    if (jsonTokens(build(before, input.between, 0)) <= budgetTokens) return build(before, input.between, 0);
    const between = packNewest(input.between, budgetTokens, (kept) =>
      build([], kept, input.between.length - kept.length),
    );
    return build([], between, input.between.length - between.length);
  },

  images: (input) => input.images,

  resolve(answers, _input, threshold, settings) {
    const answer = answers["belongs"];
    if (!answer || answer.type !== "noul") return null;
    const floor = threshold("threshold", settings.threshold ?? DEFAULT_LATE_ADDITION_THRESHOLD);
    return { belongs: answer.noul >= floor, probability: answer.noul, judged: true };
  },

  fallback: () => LATE_ADDITION_NOT_JUDGED,

  describe: (verdict) => ({
    belongs: verdict.belongs,
    judged: verdict.judged,
    ...(verdict.probability !== null ? { probability: Math.round(verdict.probability * 1000) / 1000 } : {}),
  }),
};

function isSelfEvent(event: CanonicalChatEvent, selfIds: ReadonlySet<string> | undefined): boolean {
  return event.role === "assistant" || event.sender?.isSelf === true || (selfIds?.has(event.sender?.id) ?? false);
}

function eventText(event: CanonicalChatEvent): string {
  return event.undecryptable ? "[unable to decrypt]" : (event.body ?? "");
}

function attachmentsOf(event: CanonicalChatEvent): LateAdditionAttachment[] {
  return [...(event.attachments ?? []), ...(event.linkedMedia ?? [])].map((attachment) => ({
    kind: attachment.mediaType,
    caption: attachment.caption ? clipText(attachment.caption, CAPTION_CLIP) : null,
    ...(attachment.mediaType === "image" ? { imageRefId: attachment.id } : {}),
  }));
}

function chatMessage(
  event: CanonicalChatEvent,
  age: string,
  selfIds: ReadonlySet<string> | undefined,
): LateAdditionChatMessage {
  return {
    from: senderName(event.sender),
    text: clipText(eventText(event), CHAT_TEXT_CLIP),
    age,
    ...(isSelfEvent(event, selfIds) ? { self: true as const } : {}),
  };
}

/**
 * Build the late-addition input from timeline events (pure). Ages are relative
 * to the request: messages before it to its first part's send time ("40s
 * before"), messages after it to its last part's ("6s after request"). The
 * request's parts are merged into one post (texts joined, attachments concatenated).
 */
export function lateAdditionInputFrom(args: {
  /** Messages before the request, oldest first (only the last `recentMessages` are kept). */
  before: readonly CanonicalChatEvent[];
  /** The trigger group, any order. */
  request: readonly CanonicalChatEvent[];
  /** Messages between the request and the candidate, oldest first. */
  between: readonly CanonicalChatEvent[];
  candidate: CanonicalChatEvent;
  /** Sender ids of the bot itself, for events that do not carry `isSelf`. */
  selfIds?: ReadonlySet<string>;
  /** Default 5 (`[decisions.late_addition].recent_messages`). */
  recentMessages?: number;
}): LateAdditionInput {
  const request = [...args.request].sort((a, b) => a.timestamp - b.timestamp);
  if (request.length === 0) throw new Error("lateAdditionInputFrom: empty request");
  const requestIds = new Set(request.map((event) => event.id));
  const start = request[0]!.timestamp;
  const end = request[request.length - 1]!.timestamp;
  const limit = args.recentMessages ?? DEFAULT_LATE_ADDITION_RECENT_MESSAGES;
  const before = args.before
    .filter((event) => !requestIds.has(event.id) && event.id !== args.candidate.id)
    .slice(limit > 0 ? -limit : args.before.length)
    .map((event) => chatMessage(event, `${durationLabel(start - event.timestamp)} before`, args.selfIds));
  const between = args.between
    .filter((event) => !requestIds.has(event.id) && event.id !== args.candidate.id)
    .slice(-MAX_BETWEEN)
    .map((event) => chatMessage(event, `${durationLabel(event.timestamp - end)} after request`, args.selfIds));
  const requestText = request
    .map(eventText)
    .filter((text) => text.trim().length > 0)
    .join(" ");
  return {
    before,
    request: {
      from: senderName(request[0]!.sender),
      text: clipText(requestText, POST_TEXT_CLIP),
      attachments: request.flatMap(attachmentsOf),
    },
    between,
    message: {
      from: senderName(args.candidate.sender),
      text: clipText(eventText(args.candidate), POST_TEXT_CLIP),
      attachments: attachmentsOf(args.candidate),
      age: `${durationLabel(args.candidate.timestamp - end)} after request`,
    },
    images: [...imageRefsOf(args.candidate), ...[...request].reverse().flatMap(imageRefsOf)],
  };
}
