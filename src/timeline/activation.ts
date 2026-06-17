import type { CanonicalChatEvent, InboundChatEvent } from "../types.js";
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
  /** Read a stored event by id (used to extend the trigger-group flip, #2). */
  getTimelineEventById(eventId: string): CanonicalChatEvent | undefined;
  /** Read the current enrichment_status of a stored event (#2). */
  getEnrichmentStatus(eventId: string): string | undefined;
}

/** Sets the enrichment status of an already-stored event. */
export type SetEnrichmentStatus = (eventId: string, status: string) => Promise<void>;

export interface ActivationLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
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
  /**
   * Insert the per-timeline session claim for an accepted activating trigger (spec
   * CLAIM-VISIBILITY-SERIALIZATION §4.3) — synchronous, side-effect-free beyond the
   * in-memory registry write — so the first session's trigger message renders a
   * `<handled_by_session>` marker like every other accepted trigger. Mirrors
   * `handleInbound`'s `addClaim`.
   */
  addClaim: (inbound: InboundChatEvent) => void;
  /**
   * Release a claim added by {@link addClaim} for an activating trigger whose launch
   * failed before attribution (spec CLAIM-VISIBILITY-SERIALIZATION §4.3) — otherwise
   * the un-attributed claim would deter forever. Idempotent: a launch failure past
   * `attachSession` already released the claim via the session's settle listener.
   * Mirrors `handleInbound`'s `releaseClaimFor`.
   */
  releaseClaim: (inbound: InboundChatEvent) => void;
  /** Spawn and run a session for a trigger that won the coordinator slot. */
  launchSession: (inbound: InboundChatEvent, duplicate: boolean) => Promise<void>;
  /** Re-dispatch an inbound event through the top-level handler (held replay). */
  dispatch: (inbound: InboundChatEvent) => void;
  /**
   * True once the app has begun draining for shutdown. An activation prelude
   * already past gateInbound's `draining` early-return re-checks this before its
   * post-readiness writes + session launch so it can't spawn a session that races
   * `storage.waitForIdle()`/`close()` (#2).
   */
  isDraining: () => boolean;
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
    const guarded = this.activatingTimelines.has(inbound.timelineKey);

    // Inconsistent state: persisted state reads 'activating' but no in-memory
    // guard is present. This means a prelude failed AND its catch-path reset to
    // 'inactive' also failed (logged as timeline_activation_reset_failed), so
    // the persisted state is stranded in 'activating' with the guard/buffer
    // already cleared. Instead, store the event cheaply (never dropped) and
    // attempt a one-shot recovery by re-persisting 'inactive'. Re-dispatch the
    // trigger ONLY after that reset write SUCCEEDS: the next pass then reads
    // 'inactive' and activates normally (no loop). If the reset write FAILS, do
    // NOT re-dispatch — re-dispatching on every pass would busy-loop (each
    // trigger reads 'activating', finds no buffer, re-dispatches, re-reads
    // 'activating'... forever, one failing DB write per pass). The stranded
    // state itself requires TWO consecutive write failures to arise, so this
    // recovery only re-dispatches once per successful reset.
    if (timelineState === "activating" && !guarded) {
      await this.storeHeld(inbound);
      this.opts.logger.error("activation_state_inconsistent", {
        timelineKey: inbound.timelineKey,
        eventId: inbound.event.id,
        trigger: Boolean(inbound.trigger),
      });
      // One-shot recovery: clear the stranded 'activating' so the next trigger
      // re-activates from a clean state. Best-effort — if it fails again we stay
      // inconsistent (still no loop) until the write heals.
      try {
        await this.opts.storage.setTimelineState(inbound.timelineKey, "inactive");
        // Reset succeeded: re-dispatch so this trigger isn't lost. The next pass
        // reads 'inactive' and activates normally — no loop (the state is no
        // longer 'activating'). Only re-dispatch a real trigger; a non-trigger
        // event was already stored above and needs no session.
        if (inbound.trigger) this.opts.dispatch(inbound);
      } catch (resetError) {
        this.opts.logger.error("activation_state_recovery_failed", {
          timelineKey: inbound.timelineKey,
          error: resetError instanceof Error ? resetError.message : String(resetError),
        });
        // The reset write failed, so we do NOT re-dispatch (that would busy-loop
        // — see above). A trigger that arrives on this path is therefore stored
        // but neither spawned nor buffered: its session is dropped until a future
        // trigger heals the state or a restart's resetStaleActivations() runs.
        // Behavior is intentional (anti-busy-loop); log distinctly so an operator
        // can correlate the otherwise-silent drop (#7).
        if (inbound.trigger) {
          this.opts.logger.warn("activation_trigger_dropped_pending_heal", {
            timelineKey: inbound.timelineKey,
            eventId: inbound.event.id,
          });
        }
      }
      return "handled";
    }

    // Activation prelude in flight (state may still read 'inactive' until the
    // write lands, so the in-memory set is authoritative): store the event so
    // it enriches and the activating session sees it. A trigger here can't spawn
    // a second session yet — buffer it and replay once the timeline settles.
    if (timelineState === "activating" || guarded) {
      await this.storeHeld(inbound);
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
          // is now 'active' or 'inactive' (persisted state is no longer
          // 'activating' — the inconsistent case is handled above). This is the
          // legitimate just-cleared-guard re-dispatch race.
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

    // 'active' and (once Phase 4 lands) 'backfilling' both run the normal active
    // path: a backfilling timeline still spawns sessions (CHANNEL-LIFECYCLE §2).
    // This fall-through is intentional — there is no separate handling this pass.
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

      // Resolve the trigger group FIRST: it can pull a prior attachment-bearing
      // message into the group (app.ts resolveTriggerGroup), and on first
      // activation that grouped message is still 'inactive'. The bulk flip below
      // runs only AFTER readiness (#3), so we must flip the resolved group's
      // still-'inactive' members to a processable status here — otherwise
      // awaitEnrichmentComplete treats 'inactive' as ready and countPendingCaptions
      // sees no media_assets rows (none exist until enrichment runs), and the first
      // session renders a grouped image with no enrichment and no caption (#2).
      await this.opts.resolveTriggerGroup(inbound);
      await this.activateTriggerGroupEvents(inbound);
      this.opts.notifyCaptions();
      await this.opts.awaitTriggerReadiness(inbound);

      // Shutdown began while this prelude was in flight (backfill/readiness can
      // hold for tens of seconds). Bail BEFORE the post-readiness writes and the
      // session launch so we can't spawn a session whose writes race
      // `storage.waitForIdle()`/`close()` during drain (#2). Clear the guard and
      // buffer WITHOUT replaying — `handleInbound`'s `draining` early-return would
      // swallow any replayed trigger anyway. The timeline is left 'activating';
      // `resetStaleActivations()` heals it to 'inactive' on the next startup.
      if (this.opts.isDraining()) {
        this.finishActivation(inbound.timelineKey);
        this.opts.logger.info("activation_aborted_draining", {
          timelineKey: inbound.timelineKey,
          eventId: inbound.event.id,
        });
        return;
      }

      // Flip all previously-stored inactive events to pending and nudge the
      // enrichment pool. AFTER readiness succeeds so a pre-active failure (or
      // crash) leaves the backlog 'inactive' rather than stranding it 'pending'
      // under an 'inactive' timeline (#3). One nudge drains every pending row.
      //
      // LOAD-BEARING ORDERING (#9): this bulk 'inactive'→'pending' flip MUST run
      // BEFORE the setTimelineState('active') promotion below, never after. If a
      // future change promoted to 'active' first, a crash between the two writes
      // would strand 'inactive' rows under an 'active' timeline — invisible to
      // BOTH recovery paths: resetStaleActivations() only heals timelines stuck
      // in 'activating', and the retention sweep (pruneInactiveTimelineEvents)
      // only touches inactive timelines. Such rows would never enrich and never
      // prune. Flip first, then promote.
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
    // Claim the activating trigger (spec CLAIM-VISIBILITY-SERIALIZATION §4.3),
    // synchronously right after accept and BEFORE `replay(held)` below, so the
    // first session's trigger message renders a `<handled_by_session>` marker like
    // every other accepted trigger — and any replayed held trigger sees the claim.
    // Both spawn and queued claim; `ignored` does not. There is no concurrent-session
    // hazard during activation (later triggers were held and are replayed only here),
    // so claiming at the end of the prelude rather than at recognition is sufficient.
    if (decision.action === "spawn" || decision.action === "queued") {
      this.opts.addClaim(inbound);
    }
    if (decision.action === "spawn") {
      void this.opts.launchSession(inbound, duplicate).catch((error) => {
        // Pre-attribution launch failure: release the just-added claim so it cannot
        // leak un-attributed (idempotent — a failure past `attachSession` already
        // released via the session's settle listener).
        this.opts.releaseClaim(inbound);
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

  /**
   * Store an event that arrived while a timeline is in the activation prelude
   * (held). It must reach a processable status (never dropped) so the activating
   * session sees it and enrichment runs: 'pending' when the event needs
   * enrichment (nudging the pool), else 'skipped'. Returns the stored status.
   * Shared by both `activating` branches in `gateInbound` (#9).
   */
  private async storeHeld(inbound: InboundChatEvent): Promise<"pending" | "skipped"> {
    const holdStatus = needsEnrichment(inbound.event) ? "pending" : "skipped";
    await this.opts.router.route(inbound, holdStatus);
    if (holdStatus === "pending") this.opts.notifyEnrichment(inbound.event.id);
    return holdStatus;
  }

  /**
   * Flip the resolved trigger group's still-'inactive' members to a processable
   * status BEFORE awaiting readiness, and nudge the pools (#2). This extends the
   * single-trigger pre-readiness exception (above) to the whole resolved group:
   * `resolveTriggerGroup` may have pulled a prior attachment-bearing message into
   * the group that, on first activation, is still 'inactive'. Without this, that
   * grouped media would be treated as ready (awaitEnrichmentComplete) with no
   * caption (countPendingCaptions sees no media_assets until enrichment runs).
   *
   * Only events currently 'inactive' are touched — the trigger event itself was
   * already routed/flipped above, and any non-'inactive' member is left as is.
   * Invariant #3 is preserved for the rest of the backlog: only the resolved
   * group is flipped here; the broader backlog flips only after readiness via
   * `activateTimelineEvents`, so a pre-active failure still leaves it 'inactive'.
   * The few group rows flipped here are an accepted, bounded exception (same as
   * the single trigger event) — on a pre-active failure they stay 'pending' under
   * a reset-to-'inactive' timeline, but the enrichment/caption pools simply drain
   * them; the timeline re-activates on the next trigger.
   */
  private async activateTriggerGroupEvents(inbound: InboundChatEvent): Promise<void> {
    const groupIds = inbound.trigger?.groupedEventIds ?? [];
    let nudgeEnrichment = false;
    for (const eventId of groupIds) {
      if (eventId === inbound.event.id) continue; // trigger handled above
      if (this.opts.storage.getEnrichmentStatus(eventId) !== "inactive") continue;
      const event = this.opts.storage.getTimelineEventById(eventId);
      if (!event) continue;
      if (needsEnrichment(event)) {
        await this.opts.setEnrichmentStatus(eventId, "pending");
        nudgeEnrichment = true;
      } else {
        // Leave it processable but skip enrichment/captions (readiness treats any
        // non-pending/processing status as ready).
        await this.opts.setEnrichmentStatus(eventId, "skipped");
      }
    }
    // The caption pool is nudged unconditionally by the caller after this; only
    // the enrichment pool needs an explicit nudge for the rows we just flipped.
    if (nudgeEnrichment) this.opts.notifyEnrichment(inbound.event.id);
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
