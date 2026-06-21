import type { CanonicalChatEvent } from "../types.js";

/**
 * Follow-up folding (spec FOLLOWUP-FOLDING). A quick same-sender follow-up — a
 * forced-split image, a trailing bare-text thought, or an amending re-`@` — is
 * folded into the session its immediately-prior triggering message produced
 * (steered / parked / resumed) instead of being lost, answered in isolation, or
 * spawned as a parallel twin.
 *
 * This module owns the in-memory plumbing the fold decision needs:
 *  - {@link FollowUpWatch}, a per-`(timeline, sender)` registry of "the most
 *    recent session this sender triggered" (analogous to `SessionClaims`, but
 *    keyed and lifetimed differently — §4.1);
 *  - {@link classifyFollowUpForm}, which bucket (media/text/mention) a follow-up
 *    falls into — the bucket picks the gate window;
 *  - {@link followUpGateDecision}, the two-clock gate (§4) that admits a fold.
 *
 * The orchestration (steer vs park vs resume vs native fate) lives in `app.ts`,
 * wired around these pure pieces the same way the co-reply machinery is.
 */

/**
 * Which fold lever a follow-up uses (spec §2/§4). Mutually exclusive by the
 * scope definitions: an explicit re-address (`@`) is **mention**; otherwise an
 * image-bearing event is **media** (forced-split, highest confidence); otherwise
 * a bare-text event is **text**. Confidence-it's-a-continuation falls as the
 * address gets more explicit, so the per-form gap tightens media > text > mention.
 */
export type FollowUpForm = "media" | "text" | "mention";

/** One armed watch: the live session a sender's most recent trigger produced. */
export interface FollowUpWatchEntry {
  /**
   * The session that handled the trigger — fresh or resumed. Always known at arm
   * time (the watch is armed at the claim-attribution seam, after the resume-vs-
   * fresh fork resolves — §4.1/§7), so there is no separate backfill step.
   */
  sessionId: string;
  /**
   * `origin_server_ts` of the triggering message (the user-gap clock's anchor).
   * Same-sender scope makes this comparable to the follow-up's own origin ts —
   * both originate on that user's homeserver, one clock, no federation skew (§4).
   */
  triggerOriginTs: number;
  /** Wall-clock instant the watch was armed (the staleness/lifetime clock). */
  armedAtWallClock: number;
}

/** Per-form lever (resolved from `[agent.sessions.followup.<form>]`, §9). */
export interface FollowUpLeverConfig {
  enabled: boolean;
  /** Max user-perceived gap (origin-ts diff) trigger→follow-up. */
  userGapMs: number;
  /** Watch lifetime / staleness bound; absorbs upload/federation/decrypt/caption lag. */
  wallClockMs: number;
}

/** The three levers, resolved once at startup (spec §9). */
export interface FollowUpConfig {
  media: FollowUpLeverConfig;
  text: FollowUpLeverConfig;
  mention: FollowUpLeverConfig;
}

/** True if `event` carries at least one (downloadable) image attachment. */
export function hasImageAttachment(event: CanonicalChatEvent): boolean {
  return (event.attachments ?? []).some((a) => a.mediaType === "image");
}

/**
 * Bucket a (non-reply, same-sender) follow-up into its fold lever (spec §2). The
 * `@` is the dominant signal — an explicit re-address is a **mention** even if it
 * also carries an image (the tightest window applies, since an `@` can legitimately
 * be a new ask). Absent an `@`, an image-bearing event is **media** (forced-split,
 * the strongest "this belongs together" signal); everything else is **text**.
 */
export function classifyFollowUpForm(event: CanonicalChatEvent): FollowUpForm {
  if (event.mentions?.mentionedSelf) return "mention";
  if (hasImageAttachment(event)) return "media";
  return "text";
}

/**
 * The two-clock gate (spec §4). A follow-up qualifies only when BOTH clocks pass:
 *
 *  - **user gap** — `|followup.origin_ts − trigger.origin_ts|` ≤ the form's
 *    `userGapMs`. Guards false-merges (did the user actually send these close
 *    together, as they experienced it).
 *  - **wall-clock lifetime** — `now − armedAtWallClock` ≤ the form's `wallClockMs`.
 *    Guards staleness — absorbs upload/federation/decrypt/caption lag without
 *    resurrecting an ancient session.
 *
 * The lever must also be enabled. Pure over its inputs (the caller resolves the
 * form, reads the watch, and supplies `now`), so it is trivially unit-testable.
 */
export function followUpGateDecision(args: {
  form: FollowUpForm;
  config: FollowUpConfig;
  triggerOriginTs: number;
  followUpOriginTs: number;
  armedAtWallClock: number;
  now: number;
}): boolean {
  const lever = args.config[args.form];
  if (!lever.enabled) return false;
  const userGap = Math.abs(args.followUpOriginTs - args.triggerOriginTs);
  if (userGap > lever.userGapMs) return false;
  const wallClock = args.now - args.armedAtWallClock;
  if (wallClock > lever.wallClockMs) return false;
  return true;
}

/** Where a gated follow-up is delivered, given the owner's state (spec §5 / §2 table). */
export type FollowUpRoute = "steer" | "park" | "resume" | "none";

/**
 * Resolve the delivery route for a follow-up that already passed the gate, from the
 * owner session's liveness at fold time (spec §5 / §2 delivery table). Pure over its
 * inputs so the precedence the orchestration in `app.ts` depends on is unit-testable
 * without the full inbound pipeline:
 *
 *  - owner still in memory and `created`/`running`: **steer** iff it is `running` AND
 *    its agent is attached (the same gate `SessionManager.steer` applies — an attached
 *    agent queues a steered message even in the attachAgent→first-prompt gap); else
 *    **park** (created, or running-but-pre-attach) to drain when it goes live;
 *  - owner still in memory and `resuming`: **park** — a session is `resuming` only
 *    inside `runResumeSession`'s adopt→markRunning transition (no agent attached yet),
 *    so it is the resume analogue of running-pre-attach: park it to drain at go-live
 *    rather than letting it fall through to the durable row's (possibly already
 *    `completed`) native fate;
 *  - owner gone from memory → settled: **resume** iff the durable row is `completed`
 *    (the only fold-resumable state, §5.3/§7.2); otherwise **none** (a
 *    discarded/interrupted/failed/pruned row → native fate at the call site).
 */
export function decideFollowUpRoute(input: {
  recordPresent: boolean;
  recordStatus: string | undefined;
  agentAttached: boolean;
  rowCompleted: boolean;
}): FollowUpRoute {
  if (input.recordPresent && (input.recordStatus === "created" || input.recordStatus === "running")) {
    return input.recordStatus === "running" && input.agentAttached ? "steer" : "park";
  }
  // A present `resuming` record is running-pre-attach in disguise — park it (it drains on
  // go-live). The genuinely-terminal-ish present states (`suspended`/`interrupted`/
  // `failed-resumable`) intentionally fall through to the durable row's fate below.
  if (input.recordPresent && input.recordStatus === "resuming") {
    return "park";
  }
  return input.rowCompleted ? "resume" : "none";
}

/**
 * Resolve the route with the **settle-window discrimination** layered on top of the
 * pure {@link decideFollowUpRoute} (spec §5.3; review issue #3). `SessionManager`'s
 * `markCompleted` does update-in-memory→`completed`, then enqueues the `completed`
 * persist on the single-writer queue (NOT drained synchronously), then evicts the
 * in-memory record synchronously. So in the window between evict and the queued write
 * draining, a fold observes the record **absent** while the durable row still reads
 * its pre-completion status (`running`/`resuming`) — and `decideFollowUpRoute` returns
 * `none` (record gone, row not yet `completed`), demoting a just-settled session to
 * native fate in the feature's hottest window.
 *
 * This wrapper detects exactly that case — record absent **and** the raw durable
 * status is one a session passes *through* on its way to `completed` — and routes to
 * **resume**. `resumeFollowUp` then `await storage.waitForIdle()`s before the gate, so
 * the queued `completed` write has drained by the time the gate (and the FIFO-ordered
 * CAS) read the row. A genuinely-terminal non-completed status (`discarded` /
 * `interrupted` / `failed-resumable`) or a missing row stays `none` → native fate.
 *
 * `decideFollowUpRoute` is left untouched (its pinned `recordPresent:false,
 * rowCompleted:false → "none"` contract is the *post-drain* truth); the ambiguity is a
 * pre-drain race only this caller, which can `waitForIdle`, is positioned to resolve.
 */
export function resolveFollowUpRoute(input: {
  recordPresent: boolean;
  recordStatus: string | undefined;
  agentAttached: boolean;
  rawRowStatus: string | undefined;
}): FollowUpRoute {
  const route = decideFollowUpRoute({
    recordPresent: input.recordPresent,
    recordStatus: input.recordStatus,
    agentAttached: input.agentAttached,
    rowCompleted: input.rawRowStatus === "completed",
  });
  if (
    route === "none" &&
    !input.recordPresent &&
    (input.rawRowStatus === "running" || input.rawRowStatus === "resuming")
  ) {
    // Ambiguous-settling: the record was evicted but the `completed` persist hasn't
    // drained. Route to resume; `resumeFollowUp`'s `waitForIdle` settles the row.
    return "resume";
  }
  return route;
}

/** True if ANY lever is enabled — i.e. follow-up folding is live at all (§9). */
export function followUpConfigActive(config: FollowUpConfig): boolean {
  return config.media.enabled || config.text.enabled || config.mention.enabled;
}

/**
 * The widest ENABLED lever's `wallClockMs` — the watch GC lifetime (spec §4.1: "a
 * single timer at the larger of the per-lever `wall_clock_ms`"). A disabled lever
 * never admits a fold, so its (possibly wide) window must not inflate retention. Only
 * called when at least one lever is enabled (the call site gates on
 * {@link followUpConfigActive}), so the filtered set is never empty.
 */
export function maxWallClockMs(config: FollowUpConfig): number {
  const enabled = [config.media, config.text, config.mention].filter((l) => l.enabled);
  return Math.max(...enabled.map((l) => l.wallClockMs));
}

/**
 * Per-`(timelineKey, senderId)` registry of the most-recent session a sender's
 * trigger produced (spec §4.1). Analogous to `SessionClaims`, but:
 *
 *  - keyed by `(timeline, sender)` rather than trigger external id;
 *  - **persists past settle** (unlike a claim, released on settle) — the
 *    settled→resume fold needs to find the just-completed session;
 *  - GC'd purely by wall-clock lifetime (`gcLifetimeMs`, the widest lever), not by
 *    session lifecycle; arming for a sender overwrites and resets the timer
 *    (most-recent wins — posting order is causal).
 *
 * Liveness (steer vs park vs resume) is resolved by the caller at follow-up time
 * from the live session record / durable row, never stored here.
 *
 * The GC timer and clock are injectable so the registry is a deterministic,
 * dependency-light unit (a test passes a fake clock + synchronous/no-op scheduler).
 */
export class FollowUpWatch {
  private readonly entries = new Map<string, FollowUpWatchEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param gcLifetimeMs Watch lifetime — the widest per-lever `wallClockMs`.
   *   A non-positive value disables arming entirely (the registry is inert).
   */
  constructor(
    private readonly gcLifetimeMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  private key(timelineKey: string, senderId: string): string {
    // NUL can't appear in a Matrix timeline key or user id, so it is an
    // unambiguous separator (avoids `a:b` vs `a` + `:b` collisions).
    return `${timelineKey} ${senderId}`;
  }

  /**
   * Arm (or replace) the watch for a sender. Most-recent overwrites: a later
   * trigger's session supersedes an earlier one (causal posting order), resetting
   * the GC timer. No-op when the registry is inert (`gcLifetimeMs <= 0`).
   */
  arm(timelineKey: string, senderId: string, entry: FollowUpWatchEntry): void {
    if (this.gcLifetimeMs <= 0) return;
    const key = this.key(timelineKey, senderId);
    const prev = this.timers.get(key);
    if (prev) this.cancel(prev);
    this.entries.set(key, entry);
    this.timers.set(
      key,
      this.schedule(() => {
        this.entries.delete(key);
        this.timers.delete(key);
      }, this.gcLifetimeMs),
    );
  }

  /**
   * The armed watch for a sender, or undefined if none / expired. Lazily evicts an
   * entry past its wall-clock lifetime (belt-and-suspenders with the GC timer), so
   * a stale watch can never admit a fold even if its timer hasn't fired yet.
   */
  get(timelineKey: string, senderId: string): FollowUpWatchEntry | undefined {
    const key = this.key(timelineKey, senderId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.armedAtWallClock > this.gcLifetimeMs) {
      this.entries.delete(key);
      const timer = this.timers.get(key);
      if (timer) {
        this.cancel(timer);
        this.timers.delete(key);
      }
      return undefined;
    }
    return entry;
  }

  /** Drop every watch + timer (shutdown drain). */
  clear(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.entries.clear();
  }

  /** Test/observability: number of currently-armed watches. */
  get size(): number {
    return this.entries.size;
  }
}
