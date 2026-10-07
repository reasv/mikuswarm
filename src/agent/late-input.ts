/**
 * Late input (ARCHITECTURE.md §8 "Late input"): the per-session state that lets
 * a request be corrected after the session started.
 *
 * One {@link LateInputSession} per chat session holds:
 *
 * - the **irreversibility hold**: the first irreversible (or undoable) tool call
 *   waits until `trigger received_at + hold_ms` (extended by each correction,
 *   bounded by `max_hold_ms`) and for late-addition verdicts still pending, so a
 *   correction arriving meanwhile can still redo the session;
 * - the **effects** the session's tool calls left (irreversible ones forbid a
 *   redo; undoable ones are compensated before one);
 * - the **replay store**: the latest result per call key of every `redo_safe` /
 *   `repeatable` call, served at most once per lineage, so a redo pays nothing
 *   for a repeated search;
 * - the **pending step** the runner applies at its next idle point: a redo from
 *   scratch (restart) or an abort-and-interject.
 *
 * The app decides what a correction means (it knows the timeline); this module
 * only decides *how* it is applied: wait for the in-flight request's first
 * stream event (the abort rule), abort, and hand the runner the step.
 */

import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { SessionBranchReason } from "../storage/database.js";
import { compensationFor, isPostingTool, toolEffect } from "../tools/side-effects.js";
import type { RequestProgress } from "./request-progress.js";

type LateInputRaw = NonNullable<NonNullable<AppConfig["agent"]["sessions"]>["late_input"]>;

export interface LateInputSettings {
  enabled: boolean;
  holdMs: number;
  extendMs: number;
  maxHoldMs: number;
  maxRedos: number;
  firstEventWaitMs: number;
  replayMaxAgeMs: number;
  reviveMaxMs: number;
  skewToleranceMs: number;
}

export const LATE_INPUT_DEFAULTS: Omit<LateInputSettings, "enabled"> = {
  holdMs: 8000,
  extendMs: 4000,
  maxHoldMs: 20_000,
  maxRedos: 3,
  firstEventWaitMs: 10_000,
  replayMaxAgeMs: 300_000,
  reviveMaxMs: 300_000,
  skewToleranceMs: 0,
};

/** `[agent.sessions.late_input]` with defaults applied; off when the block is absent. */
export function resolveLateInputSettings(raw: LateInputRaw | undefined): LateInputSettings {
  return {
    enabled: raw?.enabled === true,
    holdMs: raw?.hold_ms ?? LATE_INPUT_DEFAULTS.holdMs,
    extendMs: raw?.extend_ms ?? LATE_INPUT_DEFAULTS.extendMs,
    maxHoldMs: raw?.max_hold_ms ?? LATE_INPUT_DEFAULTS.maxHoldMs,
    maxRedos: raw?.max_redos ?? LATE_INPUT_DEFAULTS.maxRedos,
    firstEventWaitMs: raw?.first_event_wait_ms ?? LATE_INPUT_DEFAULTS.firstEventWaitMs,
    replayMaxAgeMs: raw?.replay_max_age_ms ?? LATE_INPUT_DEFAULTS.replayMaxAgeMs,
    reviveMaxMs: raw?.revive_max_ms ?? LATE_INPUT_DEFAULTS.reviveMaxMs,
    skewToleranceMs: raw?.skew_tolerance_ms ?? LATE_INPUT_DEFAULTS.skewToleranceMs,
  };
}

// ── Call keys and the replay store ─────────────────────────────────────────

/** Canonical JSON: object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The replay key of a tool call: its name and canonical arguments. */
export function callKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args ?? {})}`;
}

/**
 * Tools never served from the replay store even though they are redo-safe: their
 * call changes session state the result alone does not restore (loading tools,
 * the browser's page), or their result is the session's own control flow.
 */
const NEVER_REPLAYED = new Set(["load_skill", "tool_search", "no_reply", "browser", "session_record_tool"]);

interface ReplayEntry {
  result: AgentToolResult<unknown>;
  at: number;
}

/**
 * The latest result per call key of the session's redo-safe and repeatable calls,
 * on any branch. Never emptied on use: an entry is replaced by a newer execution
 * of the same key and dropped past `replay_max_age_ms`.
 */
export class ReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();

  constructor(private readonly maxAgeMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): AgentToolResult<unknown> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.maxAgeMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.result;
  }

  put(key: string, result: AgentToolResult<unknown>): void {
    this.entries.set(key, { result, at: this.now() });
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * How many tool calls with `key` the live transcript already holds, ignoring the
 * call `exceptId` (the one being executed, already in its assistant message).
 */
export function lineageCallCount(messages: readonly AgentMessage[], key: string, exceptId?: string): number {
  let count = 0;
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
      if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
      if (exceptId !== undefined && block.id === exceptId) continue;
      if (callKey(block.name, block.arguments) === key) count += 1;
    }
  }
  return count;
}

// ── Corrections and steps ──────────────────────────────────────────────────

/** A correction that redoes the session from scratch. */
export interface RestartRequest {
  reason: Extract<SessionBranchReason, "edit_redo" | "addition_redo">;
  /** Timeline events that caused it (the first one names the branch). */
  causeEventIds: string[];
  /**
   * What to deliver instead when the redo turns out impossible at apply time
   * (an undoable effect could not be compensated): the interjections of the
   * same corrections.
   */
  fallbackInterjections: AgentMessage[];
  /** Late additions that join the trigger group. */
  addedEventIds: string[];
  /** Grouped parts removed from the trigger group (deleted). */
  removedEventIds: string[];
}

/** What the runner does at its next idle point. */
export type LateInputPending =
  | { kind: "restart"; request: RestartRequest }
  /** A generation was aborted so the steered interjection is read now. */
  | { kind: "interject" }
  | { kind: "cancel"; reason: string; causeEventId: string };

/** An effect a tool call left, as the controller recorded it. */
export interface EffectRecord {
  toolCallId: string;
  name: string;
  args: unknown;
  effect: "undoable" | "irreversible";
  /** The call failed (a posting call that failed delivered nothing). */
  failed: boolean;
}

/** Why a held call waited (recorded on its tool result). */
export type HoldReason = "hold_deadline" | "verdict_pending" | "correction";

export interface HoldRecord {
  heldMs: number;
  reason: HoldReason;
}

export type SessionPhase = "building" | "running" | "ended";

export interface LateInputSessionOptions {
  sessionId: string;
  settings: LateInputSettings;
  /** The trigger's arrival (harness clock). */
  triggerReceivedAt: number;
  /** Chat-lane session triggered by a human: the hold applies. */
  holdApplies: boolean;
  logger?: Logger;
  now?: () => number;
}

/** A pending late-addition verdict the hold waits for (bounded by its own timeout). */
type PendingVerdict = Promise<unknown>;

/** Tool-result text of a held call cancelled by a correction (its span is discarded). */
export const HELD_CALL_CANCELLED = "error: not executed: the request changed while this call was held; the session is redone.";

export class LateInputSession {
  readonly sessionId: string;
  readonly settings: LateInputSettings;
  readonly replay: ReplayStore;
  readonly triggerReceivedAt: number;
  private readonly holdApplies: boolean;
  private readonly logger?: Logger;
  private readonly now: () => number;

  phase: SessionPhase = "building";
  /** When the main run ended (the settled point revival compares against). */
  runEndedAt?: number;
  /** When the session's first message was delivered (late additions end there). */
  firstDeliveryAt?: number;
  /** The context build read the timeline: a correction from now on needs a rebuild. */
  private buildStarted = false;
  redoCount = 0;

  private holdDeadlineAt: number;
  private holdReleased = false;
  private readonly effects: EffectRecord[] = [];
  private readonly holds = new Map<string, HoldRecord>();
  private readonly verdicts = new Set<PendingVerdict>();
  private pending?: LateInputPending;
  /** A correction while still building: rebuild before the first request. */
  private rebuildBeforeStart?: RestartRequest;
  private agent?: Agent;
  private progress?: RequestProgress;
  private readonly changeListeners = new Set<() => void>();
  private aborting = false;
  /** Called when a step is pending while no run is active (the runner picks it up at its next check). */
  onPendingWhileIdle?: () => void;

  constructor(options: LateInputSessionOptions) {
    this.sessionId = options.sessionId;
    this.settings = options.settings;
    this.triggerReceivedAt = options.triggerReceivedAt;
    this.holdApplies = options.holdApplies && options.settings.enabled;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.replay = new ReplayStore(options.settings.replayMaxAgeMs, this.now);
    this.holdDeadlineAt = this.triggerReceivedAt + Math.min(options.settings.holdMs, options.settings.maxHoldMs);
  }

  // ── binding ──

  /** The agent currently running the session (replaced by a restart). */
  bind(agent: Agent, progress: RequestProgress | undefined): void {
    this.agent = agent;
    this.progress = progress;
    this.aborting = false;
    // A fresh lineage starts with no effects of its own: a restart only happens
    // when every effect was compensated (undoable) or none existed.
    this.effects.length = 0;
  }

  get boundAgent(): Agent | undefined {
    return this.agent;
  }

  // ── the hold ──

  /** The hold deadline (harness clock). */
  get holdDeadline(): number {
    return this.holdDeadlineAt;
  }

  /** A correction arrived: extend the hold, bounded by `max_hold_ms` from the trigger's arrival. */
  extendHold(): void {
    const bound = this.triggerReceivedAt + this.settings.maxHoldMs;
    this.holdDeadlineAt = Math.min(bound, Math.max(this.holdDeadlineAt, this.now()) + this.settings.extendMs);
    this.emitChange();
  }

  /** Register a late-addition verdict still being judged; the hold waits for it. */
  trackVerdict(verdict: PendingVerdict): void {
    this.verdicts.add(verdict);
    const done = (): void => {
      this.verdicts.delete(verdict);
      this.emitChange();
    };
    verdict.then(done, done);
    this.emitChange();
  }

  /** True while the hold still applies to the next irreversible call. */
  holdActive(): boolean {
    return this.holdApplies && !this.holdReleased && this.phase === "running";
  }

  holdRecordFor(toolCallId: string): HoldRecord | undefined {
    return this.holds.get(toolCallId);
  }

  // ── effects ──

  /** No irreversible effect exists on the live lineage. */
  hasIrreversibleEffect(): boolean {
    return this.effects.some((e) => e.effect === "irreversible" && !(e.failed && isPostingTool(e.name)));
  }

  /** Undoable effects on the live lineage that must be compensated before a redo. */
  undoableEffects(): EffectRecord[] {
    return this.effects.filter((e) => e.effect === "undoable" && !e.failed);
  }

  /** A redo from scratch is possible now. */
  canRedo(): boolean {
    if (!this.settings.enabled) return false;
    if (this.redoCount >= this.settings.maxRedos) return false;
    if (this.phase === "ended") return false;
    if (this.hasIrreversibleEffect()) return false;
    return this.undoableEffects().every((e) => compensationFor(e.name, e.args) !== undefined);
  }

  // ── corrections ──

  /**
   * Redo from scratch. While still building, the build is simply redone before
   * the first request (no branch). While running, the in-flight request is
   * aborted under the first-event rule and the runner applies the restart at
   * its next idle point. A restart already pending absorbs this one.
   */
  requestRestart(request: RestartRequest): void {
    this.extendHold();
    if (this.phase === "building") {
      // Before the build read the timeline, the build sees the correction itself.
      if (this.buildStarted) this.rebuildBeforeStart = mergeRestart(this.rebuildBeforeStart, request);
      return;
    }
    if (this.pending?.kind === "restart") {
      this.pending = { kind: "restart", request: mergeRestart(this.pending.request, request) };
      return;
    }
    if (this.pending?.kind === "cancel") return;
    // A pending abort-and-interject is superseded: the redo rebuilds from the
    // stored state, and redelivers the steered interjections.
    this.pending = { kind: "restart", request };
    this.emitChange();
    void this.abortForStep();
  }

  /** The trigger was deleted (or no longer addresses the bot) before any irreversible effect. */
  requestCancel(reason: string, causeEventId: string): void {
    if (this.phase === "building") {
      this.pending = { kind: "cancel", reason, causeEventId };
      return;
    }
    this.pending = { kind: "cancel", reason, causeEventId };
    this.emitChange();
    void this.abortForStep();
  }

  /**
   * Abort and interject (the interjection was already steered into the agent):
   * a generation in flight is aborted under the first-event rule, so the steer is
   * read as the next user turn instead of after the request; an executing tool is
   * left to finish (the steer is read after it). Returns false when the session
   * is not running (the caller revives it instead).
   */
  abortGenerationForSteer(): boolean {
    if (!this.agent || this.phase !== "running") return false;
    if (this.pending) return true;
    if ((this.progress?.phase ?? "idle") === "idle") return true;
    this.pending = { kind: "interject" };
    this.emitChange();
    void this.abortForStep();
    return true;
  }

  /** The runner takes the pending step at an idle point. */
  takePending(): LateInputPending | undefined {
    const step = this.pending;
    this.pending = undefined;
    this.aborting = false;
    return step;
  }

  peekPending(): LateInputPending | undefined {
    return this.pending;
  }

  /** A correction arrived while building: the caller rebuilds before starting. */
  takeRebuildBeforeStart(): RestartRequest | undefined {
    const r = this.rebuildBeforeStart;
    this.rebuildBeforeStart = undefined;
    return r;
  }

  /** The cancel requested while building, if any. */
  takeCancelBeforeStart(): Extract<LateInputPending, { kind: "cancel" }> | undefined {
    if (this.pending?.kind !== "cancel") return undefined;
    const p = this.pending;
    this.pending = undefined;
    return p;
  }

  /** The context build is about to read the timeline. */
  markBuildStarted(): void {
    this.buildStarted = true;
  }

  markRunning(): void {
    this.phase = "running";
  }

  markEnded(at: number = this.now()): void {
    this.phase = "ended";
    this.runEndedAt = at;
    this.emitChange();
  }

  /** A revival continues the session: running again, hold released (an effect exists). */
  markRevived(): void {
    this.phase = "running";
    this.holdReleased = true;
  }

  // ── tool wrappers ──

  /**
   * The hold and effect tracking, around the session's final tool list (inside
   * the record-turn gate, outside the output gate so both waits overlap).
   */
  wrapHoldTools(tools: readonly AgentTool[]): AgentTool[] {
    return tools.map((tool) => {
      const original = tool.execute;
      const execute: typeof original = async (toolCallId, params, signal, onUpdate) => {
        const effect = toolEffect(tool.name, params);
        const visible = effect === "irreversible" || effect === "undoable";
        if (visible && this.pending && this.pending.kind !== "interject") return cancelledResult();
        let held: HoldRecord | undefined;
        if (visible && tool.name !== "session_record_tool" && this.holdActive()) {
          const outcome = await this.waitHold(signal);
          if (outcome.cancelled) {
            this.holds.set(toolCallId, { heldMs: outcome.heldMs, reason: "correction" });
            return cancelledResult();
          }
          if (outcome.heldMs > 0) {
            held = { heldMs: outcome.heldMs, reason: outcome.reason };
            this.holds.set(toolCallId, held);
            this.logger?.info("irreversible_hold", {
              sessionId: this.sessionId,
              tool: tool.name,
              ms: outcome.heldMs,
              reason: outcome.reason,
            });
          }
        }
        if (visible) this.holdReleased = true;
        let failed = false;
        try {
          const result = await original.call(tool, toolCallId, params, signal, onUpdate);
          failed = isErrorResult(result);
          return result;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (visible) {
            this.effects.push({ toolCallId, name: tool.name, args: params, effect, failed });
            if (!failed && isPostingTool(tool.name) && this.firstDeliveryAt === undefined) this.firstDeliveryAt = this.now();
          }
        }
      };
      return { ...tool, execute };
    });
  }

  /**
   * The replay store, around the raw catalog tools: a redo-safe or repeatable
   * call is served from the store when no call with the same key exists on the
   * live lineage; otherwise it executes and its result is stored.
   */
  wrapReplayTools(tools: readonly AgentTool[], liveMessages: () => readonly AgentMessage[]): AgentTool[] {
    return tools.map((tool) => {
      if (NEVER_REPLAYED.has(tool.name)) return tool;
      const original = tool.execute;
      const execute: typeof original = async (toolCallId, params, signal, onUpdate) => {
        const effect = toolEffect(tool.name, params);
        if (effect !== "redo_safe" && effect !== "repeatable") {
          return original.call(tool, toolCallId, params, signal, onUpdate);
        }
        const key = callKey(tool.name, params);
        if (lineageCallCount(liveMessages(), key, toolCallId) === 0) {
          const cached = this.replay.get(key);
          if (cached) {
            this.logger?.info("redo_replayed_call", { sessionId: this.sessionId, tool: tool.name });
            return cached as Awaited<ReturnType<typeof original>>;
          }
        }
        const result = await original.call(tool, toolCallId, params, signal, onUpdate);
        if (!isErrorResult(result)) this.replay.put(key, result as AgentToolResult<unknown>);
        return result;
      };
      return { ...tool, execute };
    });
  }

  // ── internals ──

  private async waitHold(signal?: AbortSignal): Promise<{ heldMs: number; reason: HoldReason; cancelled: boolean }> {
    const started = this.now();
    let reason: HoldReason = "hold_deadline";
    for (;;) {
      if (this.pending && this.pending.kind !== "interject") {
        return { heldMs: this.now() - started, reason: "correction", cancelled: true };
      }
      if (signal?.aborted) return { heldMs: this.now() - started, reason, cancelled: true };
      const remaining = this.holdDeadlineAt - this.now();
      if (remaining <= 0 && this.verdicts.size === 0) {
        return { heldMs: this.now() - started, reason, cancelled: false };
      }
      if (remaining <= 0) reason = "verdict_pending";
      await this.waitChange(remaining > 0 ? remaining : 1000, signal);
    }
  }

  private waitChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.changeListeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      timer.unref?.();
      this.changeListeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  /**
   * Abort the agent for the pending step, under the abort rule: a request still
   * queued for admission is aborted at once (nothing was sent); a request sent
   * but without its first stream event is waited for (bounded); a streaming one
   * is aborted. No request in flight: an executing tool is aborted for a restart
   * or a cancel (its span is discarded), and an interjection just waits.
   */
  private async abortForStep(): Promise<void> {
    if (this.aborting) return;
    this.aborting = true;
    const agent = this.agent;
    if (!agent) return;
    const progress = this.progress;
    if (progress?.phase === "awaiting_first_event") {
      await progress.waitForFirstEventOrEnd(this.settings.firstEventWaitMs);
    }
    const step = this.pending;
    if (!step || this.agent !== agent) return;
    if (step.kind === "interject" && (progress?.phase ?? "idle") === "idle") {
      // The request ended while we waited: the steer is read before the next one.
      this.pending = undefined;
      this.aborting = false;
      return;
    }
    if (agent.signal !== undefined) {
      if (step.kind === "interject") {
        this.logger?.info("turn_aborted_for_interjection", { sessionId: this.sessionId, phase: progress?.phase });
      }
      agent.abort();
    } else {
      this.onPendingWhileIdle?.();
    }
  }
}

function mergeRestart(a: RestartRequest | undefined, b: RestartRequest): RestartRequest {
  if (!a) return { ...b, causeEventIds: [...b.causeEventIds], fallbackInterjections: [...b.fallbackInterjections] };
  return {
    reason: a.reason === "edit_redo" || b.reason === "edit_redo" ? "edit_redo" : "addition_redo",
    causeEventIds: [...new Set([...a.causeEventIds, ...b.causeEventIds])],
    fallbackInterjections: [...a.fallbackInterjections, ...b.fallbackInterjections],
    addedEventIds: [...new Set([...a.addedEventIds, ...b.addedEventIds])],
    removedEventIds: [...new Set([...a.removedEventIds, ...b.removedEventIds])],
  };
}

function cancelledResult(): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: HELD_CALL_CANCELLED }], details: { lateInputCancelled: true } };
}

/** A tool result reporting a failure as text (the tools' `error: …` convention). */
function isErrorResult(result: unknown): boolean {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" && /^error\b/i.test(first.text.trimStart());
}
