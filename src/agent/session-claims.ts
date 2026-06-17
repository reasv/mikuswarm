/**
 * Per-timeline session-claim registry (spec DUPLICATE-REPLY-MITIGATION §3).
 *
 * A session *claims* the message that triggered it. The registry is the single
 * in-memory source of truth for "is this message being handled by another
 * running/queued session", backing all three read-side consumers:
 *
 *  - the `<handled_by_session>` render marker (§4),
 *  - the live `send_message` reply guard (§6),
 *  - co-target coalescing (§5), via the trigger's OWN reply-target.
 *
 * The decisive property (§3.2) is that a claim is inserted **synchronously at
 * trigger-accept time**, before any `await` — so a concurrent inbound handler
 * observes it even during the async gap between `triggerCoordinator.accept` and
 * the session placeholder's creation in `launchSession`. Reusing
 * `SessionManager.activeForTimeline` could not close that gap (the placeholder,
 * and hence the active-session entry, does not exist yet).
 *
 * Each claim carries TWO Matrix external ids (§3.4): the trigger's own
 * `externalId` (marker/guard key) and the trigger's `replyToExternalId` (the
 * target the trigger itself replied to — the co-target coalescing key). The
 * owning session id is backfilled when its placeholder is created; until then a
 * claim is "owned but not yet attributable", which the read consumers tolerate
 * by skipping un-attributed claims.
 */

/**
 * What a read consumer (marker / guard) needs about another session's claim on a
 * message: the owning session id when known, or `undefined` for an un-attributed
 * (queued / pre-launch) claim that is rendered/named as "pending" (review #4).
 */
export interface ClaimMarker {
  sessionId?: string;
}

/**
 * Minimal logger surface the registry needs for the advisory ordering guard
 * (spec CLAIM-VISIBILITY-SERIALIZATION §4.4). Structural so the registry stays a
 * dependency-light, unit-testable in-memory map (a test can pass a capturing stub;
 * app wiring passes a real `logger.child(...)`).
 */
export interface SessionClaimsLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface SessionClaim {
  /**
   * Owning session id. Backfilled by {@link SessionClaims.attachSession} when the
   * placeholder is created (a claim is inserted at accept time, before the
   * session id exists). `undefined` until then — read consumers ignore such
   * claims (nothing to render/identify).
   */
  sessionId?: string;
  /** Canonical (internal) id of the trigger event. */
  triggerId: string;
  /** Raw Matrix external id (`$…`) of the trigger event — the claim key (§3.1). */
  externalId: string;
  /**
   * External id of the message the trigger itself replied to, if it was a reply
   * (§3.4) — the co-target coalescing key. Absent when the trigger is not a reply.
   */
  replyToExternalId?: string;
  /** Trigger event timestamp — basis for the coalesce window (§5.1). */
  triggerTimestamp: number;
  /** Wall-clock insert time (accept time). */
  createdAt: number;
}

export class SessionClaims {
  /** timelineKey → (trigger externalId → claim). One claim per trigger event. */
  private readonly byTimeline = new Map<string, Map<string, SessionClaim>>();

  /**
   * Optional logger for the advisory ordering guard (spec
   * CLAIM-VISIBILITY-SERIALIZATION §4.4). Absent in tests that don't assert on it.
   */
  constructor(private readonly logger?: SessionClaimsLogger) {}

  /**
   * Insert a claim synchronously (§3.2/§3.3). Keyed by the trigger's external id;
   * a trigger event is unique, so there is at most one claim per external id. A
   * re-insert (e.g. queued→spawned re-dispatch) overwrites, preserving any
   * already-attached session id only if the caller carries it.
   *
   * Advisory serialization guard (spec CLAIM-VISIBILITY-SERIALIZATION §4.4,
   * invariant 3): claims for a timeline must land in trigger arrival order. This is
   * upheld structurally by the await-free pre-claim critical section in
   * `handleInbound` (see app.ts), not by this method — so the guard only *surfaces*
   * a regression: if a claim for a NEWER trigger has already landed when an OLDER
   * trigger's claim is inserted, an order-breaking `await` crept onto the pre-claim
   * path. We log `claim_out_of_order` and otherwise do nothing — never reorder or
   * drop on it: `origin_server_ts` can legitimately tie or skew under the trigger
   * hold. Compared against OTHER triggers (same-externalId re-inserts are excluded)
   * and strict (`<`), so ties never warn.
   *
   * The one DESIGNED out-of-order inserter — `redispatchCoReply` (deferred co-reply
   * / `spawn_session` replay, which re-claims an older trigger after newer ones have
   * landed) — passes `opts.redispatch` to skip the warn, so it is now structurally
   * excluded rather than left to operators to filter out (review #4). The normal
   * queued→drain path never reaches here (it re-uses the existing claim via
   * `attachSession`), so the active and activation paths remain genuine ordering
   * points and still warn.
   */
  claim(timelineKey: string, claim: SessionClaim, opts?: { redispatch?: boolean }): void {
    let perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) {
      perTimeline = new Map<string, SessionClaim>();
      this.byTimeline.set(timelineKey, perTimeline);
    } else if (this.logger && !opts?.redispatch && perTimeline.size > 0) {
      let newestExisting = Number.NEGATIVE_INFINITY;
      for (const [externalId, existing] of perTimeline) {
        if (externalId === claim.externalId) continue; // re-insert of the same trigger
        if (existing.triggerTimestamp > newestExisting) newestExisting = existing.triggerTimestamp;
      }
      if (newestExisting !== Number.NEGATIVE_INFINITY && claim.triggerTimestamp < newestExisting) {
        this.logger.warn("claim_out_of_order", {
          timelineKey,
          externalId: claim.externalId,
          triggerTimestamp: claim.triggerTimestamp,
          newestExistingTimestamp: newestExisting,
        });
      }
    }
    perTimeline.set(claim.externalId, claim);
  }

  /**
   * Backfill the owning session id once its placeholder exists (§3.3). No-op if
   * the claim was already released (e.g. a torn-down queue).
   */
  attachSession(timelineKey: string, externalId: string, sessionId: string): void {
    const claim = this.byTimeline.get(timelineKey)?.get(externalId);
    if (claim) claim.sessionId = sessionId;
  }

  /** Release the claim with this trigger external id (explicit queued-discard path). */
  releaseExternalId(timelineKey: string, externalId: string): void {
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return;
    perTimeline.delete(externalId);
    if (perTimeline.size === 0) this.byTimeline.delete(timelineKey);
  }

  /**
   * Release every claim owned by a session (§3.3 — fired from the session's
   * settle/evict seam). Mirrors how `activeForTimeline` empties on completion, so
   * a finished session stops deterring others.
   */
  releaseSession(timelineKey: string, sessionId: string): void {
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return;
    for (const [externalId, claim] of perTimeline) {
      if (claim.sessionId === sessionId) perTimeline.delete(externalId);
    }
    if (perTimeline.size === 0) this.byTimeline.delete(timelineKey);
  }

  /**
   * The claim on `externalId` by **another session** (§3.4) — used by the marker
   * (§4) and the live `send_message` guard (§6). Excludes the caller's own claim.
   * An **un-attributed** claim (sessionId not yet backfilled — the accept→launch
   * window, or a still-queued trigger) IS returned (review #4): such a claim still
   * means the message is already being handled, so it must still deter; the
   * consumer renders/names it as "pending" (no session id yet). An un-attributed
   * claim can never be self, so the self-exclusion only applies once attributed.
   */
  claimantOf(timelineKey: string, externalId: string, selfSessionId?: string): SessionClaim | undefined {
    const claim = this.byTimeline.get(timelineKey)?.get(externalId);
    if (!claim) return undefined;
    if (claim.sessionId && claim.sessionId === selfSessionId) return undefined;
    return claim;
  }

  /**
   * The claim whose **trigger's own reply-target** equals `replyToExternalId`
   * (§3.4 / §5.1 — co-target coalescing, spec DEFERRED-COALESCING). Returns the
   * first match regardless of attribution: an un-attributed (queued / pre-launch)
   * claim is returned too, so the caller can DEFER the co-reply until the owning
   * session goes live rather than spawning a twin during the accept→launch window.
   * The caller inspects `sessionId` (and the owner's liveness) to decide steer vs
   * defer vs spawn, and applies the coalesce window. Self is excluded; an
   * un-attributed claim can never be self (the caller is not yet claimed at the
   * coalesce decision point).
   */
  coTargetClaim(
    timelineKey: string,
    replyToExternalId: string,
    selfSessionId?: string,
  ): SessionClaim | undefined {
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return undefined;
    for (const claim of perTimeline.values()) {
      if (claim.sessionId && claim.sessionId === selfSessionId) continue;
      if (claim.replyToExternalId === replyToExternalId) return claim;
    }
    return undefined;
  }

  /**
   * Snapshot the claimed external ids for a build (§4.1): a stable
   * `externalId → marker` map of every OTHER session's claims on the timeline,
   * taken once at build time so the frozen context's markers are deterministic for
   * the build's duration. Excludes the building session's own claims. Un-attributed
   * (queued / pre-launch) claims ARE included (review #4) with `sessionId`
   * undefined — the renderer emits a `pending` marker so they still deter, even
   * before their owning session id exists (notably DMs, where a saturated
   * single-slot timeline means queueing is the norm).
   */
  snapshotForBuild(timelineKey: string, selfSessionId?: string): Map<string, ClaimMarker> {
    const out = new Map<string, ClaimMarker>();
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return out;
    for (const claim of perTimeline.values()) {
      if (claim.sessionId && claim.sessionId === selfSessionId) continue;
      out.set(claim.externalId, { sessionId: claim.sessionId });
    }
    return out;
  }

  /** Drop every claim (shutdown drain — §3.3). */
  clear(): void {
    this.byTimeline.clear();
  }
}

/**
 * Whether a co-target match's owning session will (eventually) become steerable, so
 * a co-reply that cannot be steered RIGHT NOW should DEFER rather than spawn a twin
 * (spec DEFERRED-COALESCING). Two pre-live cases qualify:
 *
 *  - the claim is un-attributed (`attributed === false`): no session exists yet — it
 *    is queued or in its accept→launch window and WILL launch;
 *  - the claim is attributed but its session record is still `created`/`running`:
 *    attributed at `attachSession` but not yet agent-live (the `attachSession →
 *    attachAgent` context-build window), so a steer attempt fails transiently.
 *
 * A terminal/evicted owner (`ownerStatus` absent or any other value) will never be
 * steerable again → the caller falls through to a normal spawn (§5.2).
 */
export function coTargetOwnerSteerableSoon(
  attributed: boolean,
  ownerStatus: string | undefined,
): boolean {
  if (!attributed) return true;
  return ownerStatus === "created" || ownerStatus === "running";
}
