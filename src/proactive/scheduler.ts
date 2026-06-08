import { nanoid } from "nanoid";
import type { AppConfig, ProactiveChannelConfig, ProactiveConfig } from "../config/index.js";
import type {
  CanonicalChatEvent,
  InboundChatEvent,
  OutboundTarget,
  SenderInfo,
  TriggerInfo,
} from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import type { TriggerCoordinator } from "../timeline/index.js";
import type { SessionManager } from "../agent/index.js";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/index.js";
import { agentDayEndMs, agentDayStartMs, agentHourOfDayMs } from "../time/index.js";

/**
 * Proactive posting scheduler (ARCHITECTURE.md §9g).
 *
 * Per eligible channel it holds ONE self-rescheduling timer. On each tick it
 * derives the day's remaining budget by counting `agent_sessions` rows (so
 * `NO_REPLY` runs count automatically and the state is restart-safe), checks a
 * cheap eligibility gate, and — if everything passes — produces a synthetic
 * inbound and hands it to the existing `launchSession(..., { proactive: true })`.
 * It is NOT a job-queue pool; it is a `Map<timelineKey, Timeout>` of per-channel
 * `setTimeout`s.
 *
 * The cadence is memoryless and self-compressing: gate skips don't spend budget
 * but do reschedule, so `remaining` stays put while the window shrinks → the mean
 * spacing tightens the more often attempts are skipped, floored by `min_gap_ms`.
 */

/** Hardcoded fallbacks when neither a per-channel nor a global value is set. */
const DEFAULTS = {
  dailyPosts: 3,
  minUserMessages: 10,
  deadChannelBackstopMs: 21_600_000, // 6h
  minGapMs: 1_800_000, // 30m
} as const;

export interface EffectiveChannelConfig {
  timelineKey: string;
  dailyPosts: number;
  minUserMessages: number;
  deadChannelBackstopMs: number;
  minGapMs: number;
  activeHours?: { start: number; end: number };
}

/** Effective per-channel value = channel override ?? global ?? hardcoded default. */
export function resolveChannelConfig(
  global: ProactiveConfig | undefined,
  channel: ProactiveChannelConfig,
): EffectiveChannelConfig {
  return {
    timelineKey: channel.timeline_key,
    dailyPosts: channel.daily_posts ?? global?.daily_posts ?? DEFAULTS.dailyPosts,
    minUserMessages: channel.min_user_messages ?? global?.min_user_messages ?? DEFAULTS.minUserMessages,
    deadChannelBackstopMs:
      channel.dead_channel_backstop_ms ?? global?.dead_channel_backstop_ms ?? DEFAULTS.deadChannelBackstopMs,
    minGapMs: channel.min_gap_ms ?? global?.min_gap_ms ?? DEFAULTS.minGapMs,
    activeHours: channel.active_hours ?? global?.active_hours,
  };
}

/** How many tail events the gate scans — comfortably above `min_user_messages`. */
export function proactiveGateScanLimit(minUserMessages: number): number {
  return Math.max(80, minUserMessages + 32);
}

export type GateDecision =
  | { ok: true }
  | { ok: false; reason: "skip_dead" | "skip_sparse" };

/**
 * The eligibility gate (§9g): two cheap conditions over a single tail scan of the
 * timeline (`events` oldest→newest).
 *
 * (a) Dead-channel backstop — if there is no event, or the newest is older than
 *     `deadChannelBackstopMs`, skip (don't necro-bump a channel nobody is using).
 * (b) Sparsity / non-consecutive — count human (non-assistant) messages strictly
 *     after the last assistant message (triggered replies AND prior proactive
 *     posts both count as assistant speech). If `< minUserMessages`, skip. If
 *     there is no assistant message at all, the bot hasn't spoken recently → the
 *     same human-count threshold over the whole window decides eligibility.
 *
 * Counting intervening *human messages* (not elapsed time) is the core
 * anti-monopolization rule. A `NO_REPLY` proactive session leaves no assistant
 * message, so it correctly does NOT reset this counter.
 */
export function evaluateGate(
  events: CanonicalChatEvent[],
  now: number,
  eff: Pick<EffectiveChannelConfig, "deadChannelBackstopMs" | "minUserMessages">,
): GateDecision {
  const newest = events[events.length - 1];
  if (!newest || now - newest.timestamp > eff.deadChannelBackstopMs) {
    return { ok: false, reason: "skip_dead" };
  }
  let lastAssistantIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  let humanCount = 0;
  for (let i = lastAssistantIdx + 1; i < events.length; i++) {
    if (events[i]!.role !== "assistant") humanCount++;
  }
  if (humanCount < eff.minUserMessages) return { ok: false, reason: "skip_sparse" };
  return { ok: true };
}

export interface SchedulingWindow {
  /** Whether `now` is inside an active posting window. */
  inWindow: boolean;
  /** End of the current/relevant window (ms). */
  windowEnd: number;
  /** Next window-open instant at/after `windowEnd` (the spill-over target). */
  nextOpen: number;
}

interface Window {
  open: number;
  close: number;
}

/** The active window anchored at the local day containing `dayAnchorMs`. */
function windowForDay(dayAnchorMs: number, hours: { start: number; end: number }): Window {
  const open = agentHourOfDayMs(dayAnchorMs, hours.start);
  let close: number;
  if (hours.end > hours.start) {
    close = agentHourOfDayMs(dayAnchorMs, hours.end);
  } else {
    // Wrap past midnight (end <= start), incl. start==end ⇒ a full 24h window:
    // close is `end` o'clock on the NEXT local day.
    close = agentHourOfDayMs(agentDayEndMs(dayAnchorMs), hours.end);
  }
  return { open, close };
}

/** Candidate windows around `now` (yesterday/today/tomorrow), sorted by open. */
function activeWindowsAround(now: number, hours: { start: number; end: number }): Window[] {
  const todayStart = agentDayStartMs(now);
  const anchors = [
    agentDayStartMs(todayStart - 1), // yesterday (its window may still be open if wrapped)
    todayStart,
    agentDayEndMs(now), // tomorrow's start
  ];
  return anchors.map((a) => windowForDay(a, hours)).sort((x, y) => x.open - y.open);
}

function nextOpenAtOrAfter(t: number, hours: { start: number; end: number }): number {
  const windows = activeWindowsAround(t, hours);
  for (const w of windows) {
    if (w.open >= t) return w.open;
  }
  // Beyond the local horizon — extend forward from just after `t`.
  const more = activeWindowsAround(t + 1, hours);
  for (const w of more) {
    if (w.open >= t) return w.open;
  }
  return more[more.length - 1]!.open;
}

/**
 * Resolve the scheduling window for `now` (§9g). Without `activeHours` the window
 * is the whole local day, so posting may be scheduled any time and the
 * spill/next-open target is simply the next local midnight. With `activeHours`,
 * scheduling is confined to the active window; `windowEnd` is its close and
 * `nextOpen` is the next window's open.
 *
 * All zone math runs through the time module, which formats in the configured
 * `agent.timezone`.
 */
export function resolveSchedulingWindow(
  now: number,
  activeHours: { start: number; end: number } | undefined,
): SchedulingWindow {
  if (!activeHours) {
    const end = agentDayEndMs(now);
    return { inWindow: true, windowEnd: end, nextOpen: end };
  }
  const windows = activeWindowsAround(now, activeHours);
  for (const w of windows) {
    if (now >= w.open && now < w.close) {
      return { inWindow: true, windowEnd: w.close, nextOpen: nextOpenAtOrAfter(w.close, activeHours) };
    }
  }
  for (const w of windows) {
    if (w.open > now) {
      return { inWindow: false, windowEnd: w.close, nextOpen: w.open };
    }
  }
  // Defensive fallback (should not happen): treat as a full day.
  const end = agentDayEndMs(now);
  return { inWindow: true, windowEnd: end, nextOpen: end };
}

/**
 * Compute the next attempt instant (§9g cadence). Memoryless: the mean spacing is
 * the remaining window divided by the remaining budget, jittered uniformly in
 * [0.5, 1.5)× and floored by `minGapMs`. If the jittered gap would land at/after
 * the window close, the attempt spills to the next window's open.
 */
export function computeNextAttempt(p: {
  now: number;
  windowEnd: number;
  nextWindowOpen: number;
  remaining: number;
  minGapMs: number;
  random: () => number;
}): number {
  const windowRemaining = Math.max(0, p.windowEnd - p.now);
  const mean = p.remaining > 0 ? windowRemaining / p.remaining : windowRemaining;
  let gap = mean * (0.5 + p.random()); // uniform(0.5, 1.5)
  gap = Math.max(gap, p.minGapMs);
  const next = p.now + gap;
  if (next >= p.windowEnd) return p.nextWindowOpen; // spill to the next window/day
  return next;
}

/** Parse a Matrix per-room timeline key into account/room/thread parts. */
function parseMatrixTimelineKey(
  timelineKey: string,
): { accountId: string; roomId: string; threadId?: string } | null {
  const m = /^matrix:([^:]+):room:(.+?)(?::thread:(.*))?$/.exec(timelineKey);
  if (!m) return null;
  return { accountId: m[1]!, roomId: m[2]!, threadId: m[3] };
}

export interface ProactiveSchedulerOptions {
  config: AppConfig;
  timeline: TimelineStore;
  sessions: SessionManager;
  triggerCoordinator: TriggerCoordinator;
  storage: Storage;
  /**
   * The existing session launcher. Proactive sessions reuse it verbatim so they
   * get tool assembly, capture, slot release, and queued-trigger drainage for
   * free; the only branch is the `{ proactive: true }` option.
   */
  launchSession: (inbound: InboundChatEvent, duplicate: boolean, opts: { proactive: true }) => void;
  isDraining: () => boolean;
  logger: Logger;
  /** Injectable clock/RNG for deterministic tests. */
  now?: () => number;
  random?: () => number;
}

interface TickDecision {
  decision: string;
  consumed: number;
  remaining: number;
  reason?: string;
}

export class ProactiveScheduler {
  private running = false;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly channels: EffectiveChannelConfig[];
  private readonly sessionType: string;
  private readonly nowFn: () => number;
  private readonly randomFn: () => number;

  constructor(private readonly options: ProactiveSchedulerOptions) {
    const pcfg = options.config.proactive;
    this.sessionType = pcfg?.session_type ?? "proactive";
    this.channels = (pcfg?.channels ?? []).map((c) => resolveChannelConfig(pcfg, c));
    this.nowFn = options.now ?? (() => Date.now());
    this.randomFn = options.random ?? Math.random;
  }

  /** Configured to run: master switch on AND at least one channel listed. */
  get active(): boolean {
    return this.options.config.proactive?.enabled === true && this.channels.length > 0;
  }

  start(): void {
    if (!this.active || this.running) return;
    this.running = true;
    this.options.logger.info("proactive_scheduler_started", {
      channels: this.channels.length,
      sessionType: this.sessionType,
    });
    for (const eff of this.channels) {
      this.rescheduleChannel(eff);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private consumedToday(timelineKey: string, now: number): number {
    return this.options.storage.countSessionsByType(timelineKey, this.sessionType, agentDayStartMs(now));
  }

  /** Arm the per-channel timer for an absolute instant `atMs`. */
  private armChannel(eff: EffectiveChannelConfig, atMs: number): number {
    const existing = this.timers.get(eff.timelineKey);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, atMs - this.nowFn());
    const timer = setTimeout(() => {
      this.timers.delete(eff.timelineKey);
      this.tick(eff);
    }, delay);
    timer.unref?.();
    this.timers.set(eff.timelineKey, timer);
    return delay;
  }

  /** Compute the next attempt instant and arm the channel; returns the delay (ms). */
  private rescheduleChannel(eff: EffectiveChannelConfig): number {
    const now = this.nowFn();
    const remaining = eff.dailyPosts - this.consumedToday(eff.timelineKey, now);
    const win = resolveSchedulingWindow(now, eff.activeHours);
    let next: number;
    if (remaining <= 0 || !win.inWindow) {
      next = win.nextOpen;
    } else {
      next = computeNextAttempt({
        now,
        windowEnd: win.windowEnd,
        nextWindowOpen: win.nextOpen,
        remaining,
        minGapMs: eff.minGapMs,
        random: this.randomFn,
      });
    }
    return this.armChannel(eff, next);
  }

  private tick(eff: EffectiveChannelConfig): void {
    if (!this.running || this.options.isDraining()) return; // no reschedule
    let outcome: TickDecision;
    try {
      outcome = this.evaluate(eff);
    } catch (error) {
      outcome = {
        decision: "error",
        consumed: -1,
        remaining: -1,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    // Always reschedule (unless we stopped/drained mid-tick).
    const nextAttemptInMs =
      this.running && !this.options.isDraining() ? this.rescheduleChannel(eff) : undefined;
    this.options.logger.info("proactive_tick", {
      timelineKey: eff.timelineKey,
      ...outcome,
      nextAttemptInMs,
    });
  }

  /** Run the budget/gate/concurrency checks and launch on a full pass. */
  private evaluate(eff: EffectiveChannelConfig): TickDecision {
    const now = this.nowFn();
    const consumed = this.consumedToday(eff.timelineKey, now);
    const remaining = eff.dailyPosts - consumed;
    const base = { consumed, remaining };

    if (remaining <= 0) return { decision: "skip_budget", ...base };
    if (this.options.sessions.activeForTimeline(eff.timelineKey).length > 0) {
      return { decision: "skip_active", ...base };
    }

    const events = this.options.timeline.query({
      timelineKey: eff.timelineKey,
      limit: proactiveGateScanLimit(eff.minUserMessages),
    });
    const gate = evaluateGate(events, now, eff);
    if (!gate.ok) return { decision: gate.reason, ...base };

    if (!this.options.triggerCoordinator.tryAcquire(eff.timelineKey)) {
      return { decision: "skip_busy_slot", ...base };
    }

    const inbound = this.buildSyntheticInbound(eff.timelineKey, now);
    if (!inbound) {
      // Could not resolve account/room from the timeline key — release the slot.
      this.options.triggerCoordinator.complete(eff.timelineKey);
      return { decision: "skip_unresolved", reason: "invalid_timeline_key", ...base };
    }

    // Consumes 1 budget (via the agent_sessions row inserted at session start).
    this.options.launchSession(inbound, false, { proactive: true });
    return { decision: "run", ...base };
  }

  /**
   * Build the synthetic proactive inbound (§9g). The event is NOT persisted to the
   * timeline — `agent_sessions` captures its id/body for observability only, and
   * there is no FK to `timeline_events`, so an unpersisted synthetic trigger is
   * safe. `role` is a sentinel: the event is never rendered (no trigger group) and
   * never stored.
   */
  private buildSyntheticInbound(timelineKey: string, now: number): InboundChatEvent | null {
    const parsed = parseMatrixTimelineKey(timelineKey);
    if (!parsed) return null;
    const selfUserId = this.options.config.matrix.accounts[parsed.accountId]?.user_id;
    if (!selfUserId) return null;
    const self: SenderInfo = { id: selfUserId, isSelf: true };
    const target: OutboundTarget = {
      provider: "matrix",
      timelineKey,
      accountId: parsed.accountId,
      roomId: parsed.roomId,
      threadId: parsed.threadId,
    };
    const trigger: TriggerInfo = { type: "timer", reason: "proactive", triggeredBy: self };
    const event: CanonicalChatEvent = {
      id: `proactive-${nanoid(10)}`,
      timelineKey,
      provider: "matrix",
      role: "user",
      sender: self,
      body: "",
      timestamp: now,
      receivedAt: now,
      trigger,
    };
    return { provider: "matrix", timelineKey, event, trigger, outboundTarget: target };
  }
}
