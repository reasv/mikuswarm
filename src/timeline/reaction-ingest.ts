import type { Storage } from "../storage/index.js";
import type { ReactionStreamEvent } from "../types.js";

/** What {@link ingestReactionEvent} did with a streamed reaction event. */
export type ReactionIngestOutcome =
  | { action: "upserted" }
  | { action: "tombstoned"; changed: number }
  | { action: "skipped"; reason: "incomplete_add" };

/** The slice of {@link Storage} the reaction ingest path needs. */
export type ReactionStore = Pick<Storage, "upsertReaction" | "tombstoneReaction">;

/**
 * Persist one passively-observed generic reaction event (ARCHITECTURE.md §9f).
 *
 * This is the shared ingest path used by ALL providers (Matrix and future
 * providers like Discord). Providers pre-resolve kind/display/normalizedKey
 * and the storage PK before calling host.onReaction; this function only writes
 * to the store, never wakes a session.
 *
 * - "add" → upsert a reaction row (idempotent on duplicate delivery). A
 *   malformed event missing any required "add" field is skipped rather than
 *   stored half-formed.
 * - "remove" → tombstone by the reaction's own PK. For Matrix the PK is the
 *   `$…` reaction event id; for Discord the deterministic synthetic key
 *   `discord:<messageId>:<emojiKey>:<userId>`. The tombstone-by-PK path is
 *   identical regardless of provider.
 *
 * `now` (the observation time) is injected for determinism.
 */
export async function ingestReactionEvent(
  storage: ReactionStore,
  event: ReactionStreamEvent,
  now: number,
): Promise<ReactionIngestOutcome> {
  if (event.action === "remove") {
    const changed = await storage.tombstoneReaction(event.reactionEventId, now);
    return { action: "tombstoned", changed };
  }

  // "add" — all resolved fields are required; skip rather than store half-formed.
  if (
    event.targetEventId === undefined ||
    event.kind === undefined ||
    event.display === undefined ||
    event.normalizedKey === undefined
  ) {
    return { action: "skipped", reason: "incomplete_add" };
  }

  await storage.upsertReaction({
    reactionEventId: event.reactionEventId,
    timelineKey: event.timelineKey,
    targetEventId: event.targetEventId,
    senderId: event.senderId,
    senderDisplay: event.senderDisplay ?? null,
    kind: event.kind,
    display: event.display,
    shortcode: event.shortcode ?? null,
    normalizedKey: event.normalizedKey,
    reactedAt: event.reactedAtMs,
    observedAt: now,
  });
  return { action: "upserted" };
}
