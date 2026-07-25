import type { Storage } from "../storage/index.js";
import type { ReactionStreamEvent } from "../types.js";
import type { MatrixReactionStreamEvent } from "./native-types.js";
import {
  ingestReactionEvent as ingestGenericReactionEvent,
  type ReactionIngestOutcome,
} from "../timeline/reaction-ingest.js";

export type { ReactionIngestOutcome };

/** The slice of {@link Storage} the reaction ingest path needs. */
export type ReactionStore = Pick<Storage, "upsertReaction" | "tombstoneReaction">;

/**
 * Adapt a Matrix-native reaction event to the generic {@link ReactionStreamEvent}
 * envelope (ARCHITECTURE.md §9f). The Matrix provider's NAPI layer pre-resolves
 * `kind`/`display`/`shortcode`/`normalizedKey`; this adapter adds the timeline
 * key (constructed from accountId + roomId) so the generic ingest can write the
 * locality hint. No resolution logic lives here — all transformation is from the
 * already-resolved native fields.
 *
 * PK (reactionEventId) is the Matrix `$…` reaction event id, unchanged.
 */
export function adaptMatrixReactionEvent(
  accountId: string,
  event: MatrixReactionStreamEvent,
): ReactionStreamEvent {
  return {
    action: event.action,
    reactionEventId: event.reactionEventId,
    // Room-level locality hint — reactions are matched by target_event_id, but
    // the timeline_key column lets the store be partitioned by room in the future.
    timelineKey: `matrix:${accountId}:room:${event.roomId}`,
    senderId: event.senderId,
    senderDisplay: event.senderDisplay,
    reactedAtMs: event.reactedAtMs,
    targetEventId: event.targetEventId,
    kind: event.kind,
    display: event.display,
    shortcode: event.shortcode,
    normalizedKey: event.normalizedKey,
  };
}

/**
 * Persist one passively-observed Matrix reaction event (ARCHITECTURE.md §9f).
 *
 * Wraps {@link adaptMatrixReactionEvent} + the shared generic ingest so the
 * Matrix host in app.ts can call a single entry point with Matrix-specific types.
 * The resulting DB writes are byte-identical to the pre-Phase-6 path (same rows,
 * same PK, same tombstone update on un-react).
 *
 * `now` (the observation time) is injected for determinism.
 */
export async function ingestReactionEvent(
  storage: ReactionStore,
  accountId: string,
  event: MatrixReactionStreamEvent,
  now: number,
): Promise<ReactionIngestOutcome> {
  return ingestGenericReactionEvent(storage, adaptMatrixReactionEvent(accountId, event), now);
}
