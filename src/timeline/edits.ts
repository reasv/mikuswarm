import type { AttachmentMeta, CanonicalChatEvent, MentionInfo, TimelineState } from "../types.js";
import { needsEnrichment } from "./store.js";

/**
 * Shared edit-application helpers (issue #17). A Matrix edit (`m.replace`) is
 * applied to its target message in place — the original is updated, mirroring
 * what a normal client shows — by both the live inbound path and the
 * re-decryption sweeper, so the merge and status logic live here once.
 */

/**
 * The replacement content an edit carries: the post-edit body and attachments,
 * and the post-edit mentions as the provider normalized them (Matrix
 * `m.new_content["m.mentions"]`, Discord's resolved mentions). `mentions` is
 * optional: absent, the target keeps its own (a parked edit replayed from
 * `pending_edits`, which stores body and attachments only).
 */
export interface EditReplacement {
  body: string;
  attachments: AttachmentMeta[];
  mentions?: MentionInfo;
}

/**
 * Merge an edit's replacement content onto its target canonical event. Only the
 * `body`, `attachments` and (when the edit carries them) `mentions` change; identity (id, externalId, timelineKey,
 * provider, role, sender, timestamps, threadId, replyTo) is preserved so the
 * edited message keeps its place in the timeline. The `undecryptable` flag is
 * left untouched — an edit only ever applies to an already-decrypted target (a
 * UTD target carries no readable body to edit), and clearing it here would
 * wrongly un-flag a placeholder.
 */
export function applyEditToCanonical(
  target: CanonicalChatEvent,
  replacement: EditReplacement,
): CanonicalChatEvent {
  return {
    ...target,
    body: replacement.body,
    attachments: replacement.attachments,
    ...(replacement.mentions !== undefined ? { mentions: replacement.mentions } : {}),
  };
}

/**
 * Post-edit enrichment status for the edited target, mirroring the live append
 * path and the re-decryption `postDecryptStatus` (issues #5/#6). An inactive
 * timeline defers all work to the activation bulk-flip (`'inactive'`); otherwise
 * the status matches what the live path would store for the same content
 * (`needsEnrichment` → `'pending'` / `'skipped'`).
 */
export function editStatus(
  updated: CanonicalChatEvent,
  timelineState: TimelineState,
): string {
  if (timelineState === "inactive") return "inactive";
  return needsEnrichment(updated) ? "pending" : "skipped";
}
