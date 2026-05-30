import type { InboundChatEvent } from "../types.js";
import type { TimelineRouter } from "./router.js";
import { needsEnrichment } from "./store.js";
import type { TriggerCoordinator } from "./trigger.js";

/**
 * Minimal storage surface the activation lifecycle needs. Kept narrow so the
 * coordinator can be unit-tested with an in-memory Storage (or a fake).
 */
export interface ActivationStorage {
  getTimelineState(timelineKey: string): string;
  setTimelineState(timelineKey: string, state: string): Promise<void>;
  activateTimelineEvents(timelineKey: string): Promise<number>;
}

/** Sets the enrichment status of an already-stored event. */
export type SetEnrichmentStatus = (eventId: string, status: string) => Promise<void>;

export interface ActivationLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface ActivationCoordinatorOptions {
  storage: ActivationStorage;
  router: TimelineRouter;
  triggerCoordinator: TriggerCoordinator;
  setEnrichmentStatus: SetEnrichmentStatus;
  /** Nudge the enrichment pool for a single event (poll drains all pending). */
  notifyEnrichment: (eventId: string) => void;
  /** Nudge the caption pool. */
  notifyCaptions: () => void;
  /** Blocking initial Matrix-history backfill; best-effort (never throws). */
  runInitialBackfill: (inbound: InboundChatEvent) => Promise<void>;
  /** Resolve and persist the trigger group for the inbound event. */
  resolveTriggerGroup: (inbound: InboundChatEvent) => Promise<void>;
  /** Wait for the trigger group's enrichment/captions to be ready. */
  awaitTriggerReadiness: (inbound: InboundChatEvent) => Promise<void>;
  /** Spawn and run a session for a trigger that won the coordinator slot. */
  launchSession: (inbound: InboundChatEvent, duplicate: boolean) => Promise<void>;
  /** Re-dispatch an inbound event through the top-level handler (held replay). */
  dispatch: (inbound: InboundChatEvent) => void;
  logger: ActivationLogger;
}

/**
 * Owns the channel-lifecycle gating and first-trigger activation (CHANNEL-
 * LIFECYCLE.md §2–§4). Extracted from app.ts so the orchestration — guard
 * lifecycle, held-trigger handling, enrichment ordering — is unit-testable.
 *
 * The double-activation race is closed by the in-memory `activating` guard:
 * `gateInbound` adds it (and creates the held-trigger buffer) synchronously,
 * with no `await` between the state read and the add, so two concurrent first
 * triggers can't both activate.
 */
export class ActivationCoordinator {
  // Timelines currently running the activation *prelude* (state transitions +
  // backfill + bulk-flip + trigger readiness). The guard is cleared the moment
  // the timeline goes 'active' — before the first session runs — so the live
  // session is handled by the normal active path for the rest of its life (#2).
  private readonly activatingTimelines = new Set<string>();
  // Triggers that arrive while a timeline is in the activation prelude: stored
  // (so they enrich and the activating session sees them) but their spawn is
  // deferred and replayed once the timeline settles (#1).
  private readonly heldTriggers = new Map<string, InboundChatEvent[]>();

  constructor(private readonly opts: ActivationCoordinatorOptions) {}

  /** True while a timeline's activation prelude is in flight. */
  isActivating(timelineKey: string): boolean {
    return this.activatingTimelines.has(timelineKey);
  }

  /**
   * Gate an inbound event against the timeline lifecycle. Returns:
   * - `"handled"` — the event was consumed by the inactive/activating path
   *   (stored cheaply, held, or it began/queued an activation). The caller
   *   must not run the active path.
   * - `"active"` — the timeline is active (or backfilling); the caller runs the
   *   normal active path.
   */
  async gateInbound(inbound: InboundChatEvent): Promise<"handled" | "active"> {
    const timelineState = this.opts.storage.getTimelineState(inbound.timelineKey);

    // Activation prelude in flight (state may still read 'inactive' until the
    // write lands, so the in-memory set is authoritative): store the event so
    // it enriches and the activating session sees it. A trigger here can't spawn
    // a second session yet — buffer it and replay once the timeline settles.
    if (timelineState === "activating" || this.activatingTimelines.has(inbound.timelineKey)) {
      const holdStatus = needsEnrichment(inbound.event) ? "pending" : "skipped";
      await this.opts.router.route(inbound, holdStatus);
      if (holdStatus === "pending") this.opts.notifyEnrichment(inbound.event.id);
      if (inbound.trigger) {
        const held = this.heldTriggers.get(inbound.timelineKey);
        if (held) {
          held.push(inbound);
          this.opts.logger.info("trigger_held_during_activation", {
            timelineKey: inbound.timelineKey,
            eventId: inbound.event.id,
          });
        } else {
          // The guard was cleared between the state read and here (activation
          // just finished). Re-dispatch so the trigger isn't lost; the timeline
          // is now 'active' or 'inactive'.
          this.opts.dispatch(inbound);
        }
      }
      return "handled";
    }

    if (timelineState === "inactive") {
      if (inbound.trigger) {
        // Begin activation. Add the guard and create the held-trigger buffer
        // synchronously (no await in between) so the double-activation race is
        // closed and no concurrent trigger slips past the buffer.
        this.activatingTimelines.add(inbound.timelineKey);
        this.heldTriggers.set(inbound.timelineKey, []);
        await this.activateTimeline(inbound);
        return "handled";
      }
      await this.opts.router.route(inbound, "inactive");
      return "handled";
    }

    return "active";
  }

  /**
   * First-trigger activation (§4). Transitions inactive → activating → active,
   * then launches the first session. The prelude (state transitions + backfill
   * + bulk-flip + readiness) runs under the guard; the guard and held-trigger
   * buffer are cleared the moment the timeline goes 'active' — before the first
   * session is awaited — so the live session and any replayed triggers use the
   * normal active path (#1, #2, #4).
   *
   * The caller (gateInbound) has already added the guard and created the buffer.
   */
  private async activateTimeline(inbound: InboundChatEvent): Promise<void> {
    this.opts.logger.info("timeline_activating", { timelineKey: inbound.timelineKey });

    let duplicate = false;
    try {
      await this.opts.storage.setTimelineState(inbound.timelineKey, "activating");

      // Store the trigger event. It may already exist as an 'inactive' row (the
      // provider emits each event once without a trigger and again when the hold
      // flushes); in that duplicate case router.route only attaches the trigger
      // and leaves the existing row's enrichment_status untouched.
      const enrichmentStatus = needsEnrichment(inbound.event) ? "pending" : "skipped";
      const routed = await this.opts.router.route(inbound, enrichmentStatus);
      duplicate = routed.duplicate;

      // The trigger event must reach a processable status BEFORE we await its
      // readiness, otherwise awaitTriggerReadiness hangs. For the duplicate case
      // appendIfMissing won't have updated the pre-existing 'inactive' row, so
      // flip it explicitly here — the bulk activateTimelineEvents below happens
      // only after readiness (#3) and so can't be relied on for this (#9). For a
      // fresh insert the row already carries `enrichmentStatus`.
      if (enrichmentStatus === "pending") {
        if (duplicate) await this.opts.setEnrichmentStatus(inbound.event.id, "pending");
        this.opts.notifyEnrichment(inbound.event.id);
      } else if (duplicate) {
        // A non-enriching trigger that previously landed 'inactive' must leave
        // 'inactive' so it isn't re-swept by the post-readiness bulk flip as if
        // it were unprocessed history; mark it 'skipped' (readiness treats any
        // non-pending/processing status as ready).
        await this.opts.setEnrichmentStatus(inbound.event.id, "skipped");
      }

      // Initial Matrix-history backfill (§4 step 3): blocking, held with the
      // trigger. Best-effort — never throws (failures logged inside).
      await this.opts.runInitialBackfill(inbound);

      // Await trigger readiness. The trigger group's own events were routed/
      // flipped above; readiness depends only on those, not on the not-yet-
      // activated backlog.
      await this.opts.resolveTriggerGroup(inbound);
      this.opts.notifyCaptions();
      await this.opts.awaitTriggerReadiness(inbound);

      // Flip all previously-stored inactive events to pending and nudge the
      // enrichment pool. AFTER readiness succeeds so a pre-active failure (or
      // crash) leaves the backlog 'inactive' rather than stranding it 'pending'
      // under an 'inactive' timeline (#3). One nudge drains every pending row.
      const activatedCount = await this.opts.storage.activateTimelineEvents(inbound.timelineKey);
      if (activatedCount > 0) this.opts.notifyEnrichment(inbound.event.id);
      this.opts.logger.info("timeline_events_activated", {
        timelineKey: inbound.timelineKey,
        activatedCount,
      });

      await this.opts.storage.setTimelineState(inbound.timelineKey, "active");
      this.opts.logger.info("timeline_activated", { timelineKey: inbound.timelineKey });
    } catch (error) {
      // Don't strand the timeline in 'activating' (it would read as active with
      // no recovery). Reset to 'inactive' so the next trigger retries; best-
      // effort so the original error still propagates.
      try {
        await this.opts.storage.setTimelineState(inbound.timelineKey, "inactive");
      } catch (resetError) {
        this.opts.logger.error("timeline_activation_reset_failed", {
          timelineKey: inbound.timelineKey,
          error: resetError instanceof Error ? resetError.message : String(resetError),
        });
      }
      // Clear the guard/buffer and replay held triggers so a buffered trigger
      // re-activates the (now 'inactive') timeline. The initiating trigger is
      // not auto-replayed — that would loop on a deterministic failure; recovery
      // is guaranteed by the replayed held triggers or the next inbound trigger.
      this.replay(this.finishActivation(inbound.timelineKey));
      throw error;
    }

    // Prelude succeeded and state is 'active'. Clear the guard/buffer FIRST so
    // the session run and replayed triggers use the normal active path, then
    // dispatch the initiating trigger's session and replay held triggers.
    // Nothing here is awaited under the guard.
    const held = this.finishActivation(inbound.timelineKey);

    const decision = this.opts.triggerCoordinator.accept(inbound);
    if (decision.action === "spawn") {
      void this.opts.launchSession(inbound, duplicate).catch((error) => {
        this.opts.logger.error("activation_session_launch_failed", {
          timelineKey: inbound.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        this.opts.triggerCoordinator.complete(inbound.timelineKey);
      });
    } else {
      this.opts.logger.info("trigger_not_spawned", {
        timelineKey: inbound.timelineKey,
        action: decision.action,
        reason: decision.reason,
        queueLength: decision.queueLength,
      });
    }

    this.replay(held);
  }

  /** Clear the guard and held-trigger buffer for a timeline; return the buffer. */
  private finishActivation(timelineKey: string): InboundChatEvent[] {
    this.activatingTimelines.delete(timelineKey);
    const held = this.heldTriggers.get(timelineKey) ?? [];
    this.heldTriggers.delete(timelineKey);
    return held;
  }

  /** Re-dispatch triggers buffered during activation through the normal path. */
  private replay(held: InboundChatEvent[]): void {
    for (const heldInbound of held) this.opts.dispatch(heldInbound);
  }
}
