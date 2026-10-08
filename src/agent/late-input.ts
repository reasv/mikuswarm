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
import { compensationFor, isNotExecutedError, isPostingTool, toolEffect } from "../tools/side-effects.js";
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

/**
 * The replay key of a tool call: its name and canonical arguments. The OpenAI
 * prefill's `analysis` argument (ARCHITECTURE.md "Model-scoped OpenAI prefill")
 * is not part of a call's identity: the tool never sees it.
 */
export function callKey(name: string, args: unknown): string {
  let identity = args ?? {};
  if (identity !== null && typeof identity === "object" && !Array.isArray(identity) && "analysis" in identity) {
    const { analysis: _analysis, ...rest } = identity as Record<string, unknown>;
    identity = rest;
  }
  return `${name}\u0000${canonicalJson(identity)}`;
}

/**
 * The arguments of tool call `toolCallId` as the live transcript stores them (the
 * model's own, before validation, coercion or stripping), or undefined when the
 * transcript does not hold it (a synthetic call executed before the agent exists).
 */
export function transcriptArguments(messages: readonly AgentMessage[], toolCallId: string): { found: boolean; args: unknown } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: unknown; id?: unknown; arguments?: unknown }>) {
      if (block?.type === "toolCall" && block.id === toolCallId) return { found: true, args: block.arguments };
    }
  }
  return { found: false, args: undefined };
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
 * The transcript's arguments are the model's own, so `key` must be computed from
 * those too ({@link transcriptArguments}), never from the executed parameters.
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

/**
 * Remove and return an agent's queued steering messages it has not read yet. A
 * redo moves them to the rebuilt agent (pi-agent-core exposes no read access to
 * its queue; when the shape is not the expected one nothing is moved, and the
 * session's unread-steer redelivery at settle still covers tracked steers).
 */
export function takeQueuedSteers(agent: Agent): AgentMessage[] {
  const queue = (agent as unknown as { steeringQueue?: { messages?: unknown } }).steeringQueue;
  if (!Array.isArray(queue?.messages)) return [];
  const messages = (queue.messages as AgentMessage[]).slice();
  agent.clearSteeringQueue();
  return messages;
}

// ── Corrections and steps ──────────────────────────────────────────────────

/** A correction that redoes the session from scratch. */
export interface RestartRequest {
  reason: Extract<SessionBranchReason, "edit_redo" | "addition_redo">;
  /** Timeline events that caused it (the first one names the branch). */
  causeEventIds: string[];
  /**
   * What to deliver instead when the redo turns out impossible at apply time
   * (an irreversible effect exists by then, an undoable one could not be
   * compensated, or the run ended first): the interjections of the same
   * corrections.
   */
  fallbacks: CorrectionFallback[];
  /** Late additions that join the trigger group. */
  addedEventIds: string[];
  /** Grouped parts removed from the trigger group (deleted). */
  removedEventIds: string[];
}

/**
 * Delivers a correction as an interjection instead of the redo or cancel it
 * requested, decided synchronously when the correction arrived but impossible
 * when the step is applied. `live`: steered into the running session; `late`:
 * the run ended before the step was taken, so the settled session is revived.
 */
export type CorrectionFallback = (mode: "live" | "late") => Promise<void>;

/** What the runner does at its next idle point. */
export type LateInputPending =
  | { kind: "restart"; request: RestartRequest }
  /** A generation was aborted so the steered interjection is read now. */
  | { kind: "interject" }
  | { kind: "cancel"; reason: string; causeEventId: string; fallback: CorrectionFallback };

/** An effect a tool call left, as the controller recorded it. */
export interface EffectRecord {
  toolCallId: string;
  name: string;
  args: unknown;
  effect: "undoable" | "irreversible";
  /**
   * The call reported a failure cleanly (a posting call that failed delivered
   * nothing). An effect is recorded before its call executes, so a call still
   * executing, or one that threw (an abort included), counts as having
   * happened; a call a wrapper stopped before it ran (`NotExecutedError`) is
   * removed.
   */
  failed: boolean;
  /** An undoable effect the tool reported as a no-op (nothing to compensate). */
  noop?: boolean;
  /** An undoable effect already compensated (never compensated twice). */
  compensated?: boolean;
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
  /**
   * When the run ended (the point revival compares against): stamped when the
   * runner passes its last check, and again when the run has settled.
   */
  runEndedAt?: number;
  /** The ended run has settled (the session is completed or discarded). */
  runSettled = false;
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
  /** Repeatable calls executing now: a restart lets them finish (their result is replayed). */
  private repeatableExecuting = 0;

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
    // when every effect was compensated (undoable) or none existed. Its first
    // visible call is held again (the correction extended the deadline).
    this.effects.length = 0;
    this.holdReleased = false;
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

  /**
   * Undoable effects on the live lineage that must be compensated before a redo
   * (or a cancel): not failed, not a reported no-op, not compensated already.
   */
  undoableEffects(): EffectRecord[] {
    return this.effects.filter((e) => e.effect === "undoable" && !e.failed && !e.noop && !e.compensated);
  }

  /** A redo from scratch is possible now. */
  canRedo(): boolean {
    if (!this.settings.enabled) return false;
    if (this.redoCount >= this.settings.maxRedos) return false;
    if (this.phase === "ended") return false;
    return this.canDiscardRollout();
  }

  /**
   * The rollout can still be thrown away (a redo or cancel applied now): no
   * irreversible effect, and every undoable one has an inverse. Checked again
   * when a step is applied, since an effect may have happened since the
   * correction was decided.
   */
  canDiscardRollout(): boolean {
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
      // The first abort may have found nothing to abort (the agent idle between
      // steps); a request issued since then is aborted now.
      void this.abortForStep();
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
  requestCancel(reason: string, causeEventId: string, fallback: CorrectionFallback): void {
    this.pending = { kind: "cancel", reason, causeEventId, fallback };
    if (this.phase === "building") return;
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

  /**
   * A redo or cancel is pending: the runner applies it instead of issuing a
   * request that it would make stale (a step filed while the agent was idle
   * between steps finds nothing to abort).
   */
  hasPendingStep(): boolean {
    return this.pending !== undefined && this.pending.kind !== "interject";
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
    this.aborting = false;
    return p;
  }

  /** The context build is about to read the timeline. */
  markBuildStarted(): void {
    this.buildStarted = true;
  }

  markRunning(): void {
    this.phase = "running";
  }

  /**
   * A redo rebuilds the context: corrections meanwhile join the rebuild (no
   * branch, no request). A restart filed while the redo was being applied (the
   * old rollout compensated or forked, the phase still `running`) is returned
   * for the rebuild to absorb: it has not read the timeline yet. A pending
   * interjection is dropped (the rebuild redelivers the steers); a pending
   * cancel stays for the rebuild to honour.
   */
  markRebuilding(): RestartRequest | undefined {
    this.phase = "building";
    this.aborting = false;
    const pending = this.pending;
    if (pending?.kind === "cancel") return undefined;
    this.pending = undefined;
    return pending?.kind === "restart" ? pending.request : undefined;
  }

  /**
   * The run ended (the runner's last late-input check is behind it). Idempotent:
   * the first call stamps the run end. A step still pending was never taken; it
   * is returned (and cleared) so the caller delivers its correction another way
   * (a redo or cancel by its fallback, which revives the settled session).
   */
  markEnded(at: number = this.now()): LateInputPending | undefined {
    if (this.phase === "ended") return undefined;
    this.phase = "ended";
    this.runSettled = false;
    this.runEndedAt = at;
    const dropped = this.pending;
    this.pending = undefined;
    this.rebuildBeforeStart = undefined;
    this.aborting = false;
    this.emitChange();
    return dropped;
  }

  /**
   * The ended run has settled. Until now a message was still delivered to the
   * session (as a steer it never read), so the run end that revival compares
   * against is this moment.
   */
  markSettled(at: number = this.now()): void {
    if (this.phase !== "ended") this.markEnded(at);
    if (this.runSettled) return;
    this.runSettled = true;
    this.runEndedAt = at;
  }

  /** A revival continues the session: running again, hold released (an effect exists). */
  markRevived(): void {
    this.phase = "running";
    this.runSettled = false;
    this.holdReleased = true;
    this.pending = undefined;
    this.aborting = false;
  }

  /** An undoable effect was compensated (a later redo or cancel must not undo it again). */
  markCompensated(effect: EffectRecord): void {
    effect.compensated = true;
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
        if (!visible) {
          if (effect !== "repeatable") return original.call(tool, toolCallId, params, signal, onUpdate);
          // A restart waits for a repeatable call (its result lands in the replay store).
          this.repeatableExecuting += 1;
          try {
            return await original.call(tool, toolCallId, params, signal, onUpdate);
          } finally {
            this.repeatableExecuting -= 1;
            this.emitChange();
          }
        }
        const wasReleased = this.holdReleased;
        this.holdReleased = true;
        // Recorded before the call executes: a correction arriving while it runs
        // (a send on its way out) must not redo or cancel the session. Only a
        // clean failure downgrades it: an error the tool reports. A call a
        // wrapper stopped before it ran (the output gate's block) leaves no
        // effect at all, and the hold applies again to the next visible call.
        // Any other throw (an abort included) may have delivered, so it counts.
        const record: EffectRecord = { toolCallId, name: tool.name, args: params, effect, failed: false };
        this.effects.push(record);
        let result: Awaited<ReturnType<typeof original>>;
        try {
          result = await original.call(tool, toolCallId, params, signal, onUpdate);
        } catch (error) {
          if (isNotExecutedError(error)) {
            const at = this.effects.indexOf(record);
            if (at >= 0) this.effects.splice(at, 1);
            this.holdReleased = wasReleased || this.effects.length > 0;
          }
          throw error;
        }
        if (isErrorResult(result)) record.failed = true;
        else if ((result as { details?: { changed?: unknown } } | undefined)?.details?.changed === false) record.noop = true;
        if (!record.failed && isPostingTool(tool.name) && this.firstDeliveryAt === undefined) this.firstDeliveryAt = this.now();
        return result;
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
        // Keyed on the transcript's own arguments, like the lineage it is compared
        // with (the executed parameters went through validation and stripping).
        const live = liveMessages();
        const stored = transcriptArguments(live, toolCallId);
        const key = callKey(tool.name, stored.found ? stored.args : params);
        if (lineageCallCount(live, key, toolCallId) === 0) {
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
   * is aborted. No request in flight: a repeatable call is let finish (its result
   * is replayed by the redo), an executing redo-safe tool is aborted for a
   * restart or a cancel (its span is discarded), and an interjection just
   * waits. Nothing to abort (the agent idle between steps): the runner takes
   * the step at its next check.
   */
  private async abortForStep(): Promise<void> {
    if (this.aborting) return;
    const agent = this.agent;
    if (!agent) return;
    this.aborting = true;
    const progress = this.progress;
    for (;;) {
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
      if (step.kind !== "interject" && this.repeatableExecuting > 0 && (progress?.phase ?? "idle") === "idle") {
        await this.waitChange(1000);
        continue;
      }
      break;
    }
    const step = this.pending;
    if (!step || this.agent !== agent) return;
    if (agent.signal === undefined) {
      // Nothing in flight: the runner applies the step before its next request
      // (`hasPendingStep`); a later correction may abort again.
      this.aborting = false;
      return;
    }
    if (step.kind === "interject") {
      this.logger?.info("turn_aborted_for_interjection", { sessionId: this.sessionId, phase: progress?.phase });
    }
    agent.abort();
  }
}

export function mergeRestart(a: RestartRequest | undefined, b: RestartRequest): RestartRequest {
  if (!a) return { ...b, causeEventIds: [...b.causeEventIds], fallbacks: [...b.fallbacks] };
  return {
    reason: a.reason === "edit_redo" || b.reason === "edit_redo" ? "edit_redo" : "addition_redo",
    causeEventIds: [...new Set([...a.causeEventIds, ...b.causeEventIds])],
    fallbacks: [...a.fallbacks, ...b.fallbacks],
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
