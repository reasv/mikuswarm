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
   * Insert a claim synchronously (§3.2/§3.3). Keyed by the trigger's external id;
   * a trigger event is unique, so there is at most one claim per external id. A
   * re-insert (e.g. queued→spawned re-dispatch) overwrites, preserving any
   * already-attached session id only if the caller carries it.
   */
  claim(timelineKey: string, claim: SessionClaim): void {
    let perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) {
      perTimeline = new Map<string, SessionClaim>();
      this.byTimeline.set(timelineKey, perTimeline);
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
   * The claim on `externalId` by **another attributable session** (§3.4): a claim
   * whose owning session id is known and differs from `selfSessionId`. Used by the
   * marker (§4) and the live `send_message` guard (§6). Un-attributed claims
   * (sessionId not yet backfilled — a brief accept→launch window) are skipped:
   * there is nothing to render or name.
   */
  claimantOf(timelineKey: string, externalId: string, selfSessionId?: string): SessionClaim | undefined {
    const claim = this.byTimeline.get(timelineKey)?.get(externalId);
    if (!claim || !claim.sessionId) return undefined;
    if (claim.sessionId === selfSessionId) return undefined;
    return claim;
  }

  /**
   * A running session whose **trigger's own reply-target** equals
   * `replyToExternalId` (§3.4 / §5.1 — co-target coalescing). Returns the first
   * such attributable claim (sessionId known, not self). The caller still verifies
   * the steer succeeds (the session may be settling) and applies the coalesce
   * window. Only attributable claims qualify — coalescing must steer into a live
   * session, which a not-yet-launched (queued) claim cannot offer.
   */
  coTargetSession(
    timelineKey: string,
    replyToExternalId: string,
    selfSessionId?: string,
  ): SessionClaim | undefined {
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return undefined;
    for (const claim of perTimeline.values()) {
      if (!claim.sessionId || claim.sessionId === selfSessionId) continue;
      if (claim.replyToExternalId === replyToExternalId) return claim;
    }
    return undefined;
  }

  /**
   * Snapshot the claimed external ids for a build (§4.1): a stable
   * `externalId → owning sessionId` map of every OTHER attributable session's
   * claims on the timeline, taken once at build time so the frozen context's
   * markers are deterministic for the build's duration. Excludes the building
   * session's own claims and any un-attributed (queued) claim.
   */
  snapshotForBuild(timelineKey: string, selfSessionId?: string): Map<string, string> {
    const out = new Map<string, string>();
    const perTimeline = this.byTimeline.get(timelineKey);
    if (!perTimeline) return out;
    for (const claim of perTimeline.values()) {
      if (!claim.sessionId || claim.sessionId === selfSessionId) continue;
      out.set(claim.externalId, claim.sessionId);
    }
    return out;
  }

  /** Drop every claim (shutdown drain — §3.3). */
  clear(): void {
    this.byTimeline.clear();
  }
}
