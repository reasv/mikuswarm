/**
 * Shared chat-message shape for decision-point state (ARCHITECTURE.md §8h).
 * Plain bodies, display names, and caption strings for attachments (never
 * paths). Ids are the external ids the agent already sees, so a verdict can name
 * a message the agent can act on.
 */

import type { AttachmentMeta, CanonicalChatEvent, SenderInfo } from "../types.js";
import { clipText } from "./state.js";
import { deletedPlaceholder, isDeleted } from "../timeline/deletions.js";

export interface TranscriptMessage {
  id: string;
  from: string;
  /** Set on the bot's own messages. */
  self?: true;
  text: string;
  attachments?: string[];
}

export function senderName(sender: SenderInfo | undefined): string {
  if (!sender) return "unknown";
  return sender.displayName ?? sender.username ?? sender.id;
}

function attachmentLabel(attachment: AttachmentMeta): string {
  if (attachment.caption) return clipText(attachment.caption, 400);
  if (attachment.mediaType === "image") return "[image, not yet described]";
  return `[${attachment.mediaType}${attachment.filename ? `: ${attachment.filename}` : ""}]`;
}

export interface TranscriptMessageOptions {
  /**
   * A message of the recent-chat window: when deleted, it shows the deletion
   * placeholder (sender and position kept, no content), as in the recent tiers.
   * `true` for any deletion, a time for deletions at or before it (a window
   * rebuilt for a past moment shows what users saw then).
   */
  deletedPlaceholder?: true | number;
}

/** True when `event` shows as deleted under `opts` (see {@link TranscriptMessageOptions}). */
export function showsDeleted(event: CanonicalChatEvent, opts?: TranscriptMessageOptions): boolean {
  if (opts?.deletedPlaceholder === undefined) return false;
  return isDeleted(event, opts.deletedPlaceholder === true ? undefined : opts.deletedPlaceholder);
}

/** One timeline event as a decision-state message (text clipped to `maxChars`). */
export function toTranscriptMessage(
  event: CanonicalChatEvent,
  maxChars: number,
  opts?: TranscriptMessageOptions,
): TranscriptMessage {
  if (showsDeleted(event, opts)) {
    const message: TranscriptMessage = {
      id: event.externalId ?? event.id,
      from: senderName(event.sender),
      text: deletedPlaceholder(event.deleted!, event.sender?.id),
    };
    if (event.role === "assistant" || event.sender?.isSelf) message.self = true;
    return message;
  }
  const message: TranscriptMessage = {
    id: event.externalId ?? event.id,
    from: senderName(event.sender),
    text: event.undecryptable ? "[unable to decrypt]" : clipText(event.body ?? "", maxChars),
  };
  if (event.role === "assistant" || event.sender?.isSelf) message.self = true;
  const media = [...(event.attachments ?? []), ...(event.linkedMedia ?? [])];
  if (media.length > 0) message.attachments = media.map(attachmentLabel);
  return message;
}
