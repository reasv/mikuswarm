import type { Storage } from "../storage/index.js";
import type { MatrixReactionStreamEvent } from "./native-types.js";

/** What {@link ingestReactionEvent} did with a streamed reaction event. */
export type ReactionIngestOutcome =
  | { action: "upserted" }
  | { action: "tombstoned"; changed: number }
  | { action: "skipped"; reason: "incomplete_add" };

/** The slice of {@link Storage} the reaction ingest path needs. */
export type ReactionStore = Pick<Storage, "upsertReaction" | "tombstoneReaction">;

/**
 * Persist one passively-observed reaction stream event (ARCHITECTURE.md §9f).
 *
 * - `add` → upsert a reaction row (idempotent on duplicate delivery). The native
 *   resolver always populates `targetEventId`/`kind`/`display`/`normalizedKey` for
 *   adds; a malformed event missing any of them is skipped rather than stored
 *   half-formed.
 * - `remove` → tombstone by the reaction's own id. The native side forwards every
 *   redaction, so most removes name non-reactions and tombstone 0 rows — that is
 *   the intended stateless, self-correcting no-op.
 *
 * `now` (the observation time) is injected for determinism. This never wakes a
 * session: it only writes to the reaction store.
 */
export async function ingestReactionEvent(
  storage: ReactionStore,
  accountId: string,
  event: MatrixReactionStreamEvent,
  now: number,
): Promise<ReactionIngestOutcome> {
  if (event.action === "remove") {
    const changed = await storage.tombstoneReaction(event.reactionEventId, now);
    return { action: "tombstoned", changed };
  }

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
    // Room-level locality hint only; reactions are matched by the globally-unique
    // target_event_id, not this key (see the reactions schema in storage).
    timelineKey: `matrix:${accountId}:room:${event.roomId}`,
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
