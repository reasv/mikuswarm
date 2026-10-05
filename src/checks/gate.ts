/**
 * The output gate (spec REFUSAL-HANDLING §5.2, §5.4, §6; CONTRACT "Gate"): one
 * per session, judging every model-written output at its checkpoint.
 *
 * - **send**: every posting tool call (`isPostingTool`: send_message, send_dm,
 *   send_to_channel, edit_message, create_poll). The judged text is the
 *   model-written text ({@link postedText}); harness-written messages never pass
 *   through a tool and are never judged.
 * - **ending**: the `no_reply` call (through the tool wrapper), the literal
 *   `NO_REPLY` text and forced-completion exhaustion (through the runner's
 *   ending hook, {@link OutputGate.onEnding}), in every session type.
 * - **artifact**: the session record (the record turn); internal jobs use
 *   {@link BackgroundChecks}.
 *
 * **Early start.** For a gated call the evaluation begins at `toolcall_end`
 * from the live attempt tap ({@link OutputGate.onAttemptEvent}); a discarded
 * attempt cancels the evaluations it started; `execute` reuses the started
 * evaluation by tool call id.
 *
 * **Hold path.** Phase 3 is observe-only: {@link OBSERVE_POLICY} never holds, so
 * the send runs at once and the evaluation is recorded when it completes. The
 * hold path is built: when `policy.shouldHold()` is true the wrapper waits for
 * the verdict (bounded by the checkpoint's deadline, past which the output
 * proceeds unjudged), records it with `policy.consequence()`, then lets
 * `policy.act()` block the call. Blocking remedies (redo, revise) only swap the
 * policy.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SessionEnding, SessionEndingHook } from "../agent/runner.js";
import type { Logger } from "../observability/logger.js";
import type { RefusalOutcome } from "../storage/database.js";
import { isPostingTool } from "../tools/side-effects.js";
import {
  CheckEvaluation,
  type CheckConsequence,
  type CheckEvaluator,
  type CheckScope,
  type CheckSubject,
  type FiredCheck,
} from "./evaluator.js";
import {
  findCallMessage,
  nudgeHistory,
  postedText,
  reasoningSources,
  rolloutTexts,
  type CheckSources,
  type StateMessage,
} from "./state.js";
import type { CheckDefinition, Checkpoint } from "./types.js";

/** The gate's verdict on one evaluation (CONTRACT "Gate"). */
export interface GateVerdict {
  /** Decision row ids; empty when the evaluation was not recorded yet (late). */
  evaluationIds: number[];
  fired: FiredCheck[];
  /** The strongest fired refusal check (refusal wins over style, §6.4). */
  refusal?: FiredCheck;
  /** Fired checks with remedy `revise`. */
  revise: FiredCheck[];
  /** No verdict in time (deadline) or a judged call fell back. */
  unjudged: boolean;
  latencyMs: number;
}

/** What the gated tool does after the verdict. */
export type GateAction = { kind: "proceed" } | { kind: "block"; message: string };

/** A held or observed output, as the policy sees it. */
export interface GateCallInfo {
  checkpoint: Checkpoint;
  /** Tool name, `NO_REPLY`, `exhausted`, or an artifact kind. */
  action: string;
  toolCallId?: string;
  attemptNo?: number;
  scope: CheckScope;
}

/**
 * What the gate does with verdicts. Phase 3 ships {@link OBSERVE_POLICY};
 * blocking remedies replace it (`gate.policy = …`) without touching the
 * plumbing.
 */
export interface GatePolicy {
  /**
   * Hold the output until judged (spec §6.3: only when a check in the
   * evaluation could act in this session: a `revise` check, or a `redo` check a
   * soft rule can match).
   */
  shouldHold(info: GateCallInfo, checks: readonly CheckDefinition[]): boolean;
  /** The consequence recorded on the evaluation's rows. */
  consequence(info: GateCallInfo, verdict: GateVerdict, opts: { held: boolean; late: boolean }): CheckConsequence;
  /** `refusal_events` outcome for a fired refusal; null = the policy records its own. */
  refusalOutcome(info: GateCallInfo, fired: FiredCheck): { outcome: RefusalOutcome; ruleName?: string; toModel?: string } | null;
  /** Act on a held verdict (after it is recorded). */
  act(info: GateCallInfo, verdict: GateVerdict): GateAction | Promise<GateAction>;
}

/** Observe-only (phase 3, and every check with remedy `observe`): record, never hold. */
export const OBSERVE_POLICY: GatePolicy = {
  shouldHold: () => false,
  consequence: (info, verdict, { late }) => {
    if (late || (verdict.unjudged && verdict.fired.length === 0)) return "sent_unjudged";
    if (verdict.fired.length > 0) return "observed";
    return info.checkpoint === "send" ? "sent" : "observed";
  },
  refusalOutcome: () => ({ outcome: "observed" }),
  act: () => ({ kind: "proceed" }),
};

/** The checkpoint of a gated tool: posting tools → send, `no_reply` → ending. */
export function gatedCheckpoint(toolName: string): Checkpoint | undefined {
  if (isPostingTool(toolName)) return "send";
  if (toolName === "no_reply") return "ending";
  return undefined;
}

export interface OutputGateOptions {
  evaluator: CheckEvaluator;
  scope: CheckScope;
  /** The session's live messages (`agent.state.messages`). */
  getMessages: () => readonly AgentMessage[];
  /** The trigger/kickoff and recent chat, read when an evaluation starts. */
  chat?: (recentMessages: number) => { request: StateMessage[]; recent: StateMessage[] };
  /** Logical id of the member serving the session's latest request. */
  servingModel?: () => string | undefined;
  policy?: GatePolicy;
  logger?: Logger;
  now?: () => number;
}

interface Entry {
  evaluation: CheckEvaluation;
  info: GateCallInfo;
  /** Set once execute (or the ending hook) claimed it; unclaimed entries are never recorded. */
  claimed: boolean;
  recording?: Promise<GateVerdict>;
}

export class OutputGate implements SessionEndingHook {
  /** Policy; swapped by blocking remedies. */
  policy: GatePolicy;
  /** The branch the live transcript's outputs are recorded on (0 = live). */
  branchNo = 0;
  private readonly entries = new Map<string, Entry>();
  /** Evaluations begun from each in-flight attempt's tap, cleared on commit. */
  private readonly attemptStarts = new Map<number, Set<string>>();
  private disposed = false;
  private artifactSeq = 0;

  constructor(private readonly options: OutputGateOptions) {
    this.policy = options.policy ?? OBSERVE_POLICY;
  }

  get scope(): CheckScope {
    return this.options.scope;
  }

  get evaluator(): CheckEvaluator {
    return this.options.evaluator;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The evaluation under a tool call id (or an ending key), for inspection. */
  evaluation(key: string): CheckEvaluation | undefined {
    return this.entries.get(key)?.evaluation;
  }

  /**
   * Start judging an output (idempotent per key: the first start wins). The
   * evaluation runs in the background; nothing is recorded until the output is
   * claimed by {@link settle} or {@link observe}.
   */
  begin(checkpoint: Checkpoint, key: string, subject: GateSubject): CheckEvaluation | undefined {
    if (this.disposed) return undefined;
    const existing = this.entries.get(key);
    if (existing) return existing.evaluation;
    const scope = this.options.scope;
    if (!this.evaluator.mightJudge(checkpoint, scope.agent)) return undefined;
    const recentLimit = this.evaluator.knobs(scope.agent).recentMessages;
    let chat: { request: StateMessage[]; recent: StateMessage[] } = { request: [], recent: [] };
    if (this.options.chat) {
      try {
        chat = this.options.chat(recentLimit);
      } catch (error) {
        this.options.logger?.warn("check_gate_chat_state_failed", {
          sessionId: scope.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const full: CheckSubject = {
      context: {
        checkpoint,
        request: chat.request,
        recent: recentLimit > 0 ? chat.recent.slice(-recentLimit) : [],
        action: subject.action,
        ...(subject.nudges !== undefined ? { nudges: subject.nudges } : {}),
        ...(subject.firstAttempt ? { firstAttempt: subject.firstAttempt } : {}),
      },
      sources: subject.sources,
      ...(subject.wireModel ? { wireModel: subject.wireModel } : {}),
    };
    const servedModel = subject.servedModel ?? this.options.servingModel?.();
    if (servedModel) full.servedModel = servedModel;
    const anchor = {
      checkpoint,
      branchNo: this.branchNo,
      ...(subject.toolCallId ? { toolCallId: subject.toolCallId } : {}),
      ...(subject.attemptNo !== undefined ? { attemptNo: subject.attemptNo } : {}),
    };
    const evaluation = this.evaluator.start(scope, full, anchor);
    const info: GateCallInfo = {
      checkpoint,
      action: subject.action,
      ...(subject.toolCallId ? { toolCallId: subject.toolCallId } : {}),
      ...(subject.attemptNo !== undefined ? { attemptNo: subject.attemptNo } : {}),
      scope,
    };
    this.entries.set(key, { evaluation, info, claimed: false });
    return evaluation;
  }

  /** Whether the output under `key` is held until judged (always false in observe mode). */
  shouldHold(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    return this.policy.shouldHold(entry.info, entry.evaluation.checks);
  }

  /**
   * Wait for the verdict, bounded by the checkpoint's deadline, and record it.
   * Past the deadline the verdict is unjudged (pattern hits only) and the
   * evaluation is recorded `sent_unjudged` when it completes.
   */
  async settle(key: string, opts: { held?: boolean } = {}): Promise<GateVerdict> {
    const entry = this.entries.get(key);
    if (!entry) return emptyVerdict();
    entry.claimed = true;
    const held = opts.held ?? true;
    const heldFrom = this.now();
    const { evaluation } = entry;
    const remaining = evaluation.deadlineMs - (heldFrom - evaluation.startedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inTime = await Promise.race([
      evaluation.done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, remaining));
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (inTime) return this.recordEntry(key, entry, { held, heldMs: held ? this.now() - heldFrom : 0 });
    const heldMs = held ? this.now() - heldFrom : 0;
    // The output proceeds unjudged; the evaluation still completes and is recorded.
    void this.recordEntry(key, entry, { held, heldMs });
    return {
      evaluationIds: [],
      fired: [...evaluation.patternFired],
      ...strongest(evaluation.patternFired),
      unjudged: true,
      latencyMs: this.now() - evaluation.startedAt,
    };
  }

  /** Never wait: record the evaluation when it completes (observe mode). */
  observe(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.claimed = true;
    void this.recordEntry(key, entry, { held: false, heldMs: 0 });
  }

  private recordEntry(key: string, entry: Entry, opts: { held: boolean; heldMs: number }): Promise<GateVerdict> {
    entry.recording ??= (async () => {
      const result = await entry.evaluation.done;
      const evaluation = entry.evaluation;
      const late = (evaluation.completedAt ?? this.now()) - evaluation.startedAt > evaluation.deadlineMs;
      const base: GateVerdict = {
        evaluationIds: [],
        fired: result.fired,
        ...strongest(result.fired),
        unjudged: late || result.unjudgedReason !== undefined,
        latencyMs: result.latencyMs,
      };
      if (evaluation.canceled) return base;
      this.entries.delete(key);
      try {
        const consequence = this.policy.consequence(entry.info, base, { held: opts.held, late });
        const ids = await this.evaluator.record(evaluation, {
          consequence,
          late,
          heldMs: opts.heldMs,
          refusalOutcome: (fired) => this.policy.refusalOutcome(entry.info, fired),
        });
        return { ...base, evaluationIds: ids };
      } catch (error) {
        this.options.logger?.warn("check_gate_record_failed", {
          sessionId: this.scope.sessionId,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return base;
      }
    })();
    return entry.recording;
  }

  /**
   * The gate inside a gated tool's execute: start (or reuse) the evaluation,
   * then hold and act, or observe and proceed at once.
   */
  async gateCall(toolName: string, toolCallId: string, args: Record<string, unknown> | undefined): Promise<GateAction> {
    const checkpoint = gatedCheckpoint(toolName);
    if (!checkpoint || this.disposed) return { kind: "proceed" };
    if (!this.entries.has(toolCallId) && this.evaluator.mightJudge(checkpoint, this.scope.agent)) {
      this.begin(checkpoint, toolCallId, this.subjectForCall(toolName, toolCallId, args));
    }
    const entry = this.entries.get(toolCallId);
    if (!entry) return { kind: "proceed" };
    if (!this.shouldHold(toolCallId)) {
      this.observe(toolCallId);
      return { kind: "proceed" };
    }
    const verdict = await this.settle(toolCallId, { held: true });
    try {
      return await this.policy.act(entry.info, verdict);
    } catch (error) {
      this.options.logger?.warn("check_gate_act_failed", {
        sessionId: this.scope.sessionId,
        toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "proceed" };
    }
  }

  /**
   * The judged texts of a gated call (spec §5.4–§5.5). `containing` is the
   * assistant message holding the call when it is not in the live messages yet
   * (the streaming partial at `toolcall_end`).
   */
  subjectForCall(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown> | undefined,
    containing?: unknown,
  ): GateSubject {
    const messages = this.options.getMessages();
    const index = containing ? -1 : findCallMessage(messages, toolCallId);
    const holder = containing ?? (index >= 0 ? messages[index] : undefined);
    const searchBefore = index >= 0 ? index : messages.length;
    const reasoning = reasoningSources(messages, holder, searchBefore);
    const checkpoint = gatedCheckpoint(toolName) ?? "send";
    const sources: CheckSources = {};
    const analysis = typeof args?.["analysis"] === "string" ? (args["analysis"] as string) : undefined;
    if (analysis?.trim()) sources.analysis = analysis;
    if (reasoning.text) sources.text = reasoning.text;
    if (checkpoint === "send") {
      // Thinking is not judged at sends: deliberation ending in a full answer
      // reads as a refusal (§5.5).
      const message = postedText(toolName, args);
      if (message?.trim()) sources.message = message;
    } else if (reasoning.thinking) {
      sources.thinking = reasoning.thinking;
    }
    const subject: GateSubject = { action: toolName, sources, toolCallId };
    if (checkpoint === "ending") {
      const history = nudgeHistory(messages);
      subject.nudges = history.nudges;
      subject.attemptNo = history.nudges;
      if (history.firstAttempt) subject.firstAttempt = history.firstAttempt;
    }
    const wire = (holder as { model?: unknown } | undefined)?.model;
    if (typeof wire === "string") subject.wireModel = wire;
    return subject;
  }

  /**
   * Live attempt tap (factory `onAttemptEvent`): at `toolcall_end` of a gated
   * tool, start its evaluation before the tool executes; a committed attempt
   * (`done`) keeps its evaluations.
   */
  onAttemptEvent(attempt: number, event: AssistantMessageEvent): void {
    if (this.disposed) return;
    if (event.type === "toolcall_end") {
      const call = event.toolCall;
      const checkpoint = gatedCheckpoint(call.name);
      if (!checkpoint || this.entries.has(call.id)) return;
      if (!this.evaluator.mightJudge(checkpoint, this.scope.agent)) return;
      const subject = this.subjectForCall(call.name, call.id, call.arguments, event.partial);
      this.begin(checkpoint, call.id, subject);
      const started = this.attemptStarts.get(attempt) ?? new Set<string>();
      started.add(call.id);
      this.attemptStarts.set(attempt, started);
    } else if (event.type === "done") {
      this.attemptStarts.delete(attempt);
    }
  }

  /** A discarded attempt (factory `onAttemptDiscarded`): its evaluations are canceled and dropped. */
  onAttemptDiscarded(attempt: number): void {
    const started = this.attemptStarts.get(attempt);
    if (!started) return;
    this.attemptStarts.delete(attempt);
    for (const id of started) {
      const entry = this.entries.get(id);
      if (!entry || entry.claimed) continue;
      entry.evaluation.cancel();
      this.entries.delete(id);
    }
  }

  /**
   * Runner hook (spec §5.4): a run that ended with the `NO_REPLY` text or
   * exhausted its nudges. Observe-only: starts the evaluation and returns.
   */
  onEnding(ending: SessionEnding): void {
    if (this.disposed || !this.evaluator.mightJudge("ending", this.scope.agent)) return;
    const messages = this.options.getMessages();
    let lastIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { role?: string }).role === "assistant") {
        lastIndex = i;
        break;
      }
    }
    const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
    const reasoning = reasoningSources(messages, last, lastIndex >= 0 ? lastIndex : messages.length);
    const sources: CheckSources = {};
    if (reasoning.text) sources.text = reasoning.text;
    if (reasoning.thinking) sources.thinking = reasoning.thinking;
    const history = nudgeHistory(messages);
    const subject: GateSubject = {
      action: ending.kind,
      sources,
      nudges: ending.nudges,
      attemptNo: ending.nudges,
      ...(history.firstAttempt ? { firstAttempt: history.firstAttempt } : {}),
    };
    const wire = (last as { model?: unknown } | undefined)?.model;
    if (typeof wire === "string") subject.wireModel = wire;
    const key = `ending:${this.branchNo}:${ending.kind}:${ending.nudges}:${messages.length}`;
    if (!this.begin("ending", key, subject)) return;
    this.observe(key);
  }

  /** Judge a session-bound artifact (the session record), off the interactive path. */
  judgeArtifact(kind: string, text: string, opts: { site?: string; request?: string } = {}): Promise<GateVerdict> {
    const key = `artifact:${kind}:${++this.artifactSeq}`;
    const subject: GateSubject = { action: kind, sources: { artifact: text } };
    const evaluation = this.evaluator.start(
      { ...this.scope, ...(opts.site ? { site: opts.site } : {}) },
      {
        context: {
          checkpoint: "artifact",
          request: [{ from: "task", text: opts.request ?? ARTIFACT_INSTRUCTIONS[kind] ?? kind }],
          action: kind,
        },
        sources: subject.sources,
        ...servedModelField(this.options.servingModel?.()),
      },
      { checkpoint: "artifact", branchNo: this.branchNo },
    );
    const info: GateCallInfo = { checkpoint: "artifact", action: kind, scope: this.scope };
    const entry: Entry = { evaluation, info, claimed: true };
    this.entries.set(key, entry);
    return this.recordEntry(key, entry, { held: false, heldMs: 0 });
  }

  /** Drop pending, never-claimed evaluations (session end). Claimed ones still record. */
  dispose(): void {
    this.disposed = true;
    for (const [key, entry] of this.entries) {
      if (entry.claimed) continue;
      entry.evaluation.cancel();
      this.entries.delete(key);
    }
    this.attemptStarts.clear();
  }
}

/** What {@link OutputGate.begin} needs about one output. */
export interface GateSubject {
  action: string;
  sources: CheckSources;
  toolCallId?: string;
  attemptNo?: number;
  nudges?: number;
  firstAttempt?: string;
  servedModel?: string;
  wireModel?: string;
}

/** One-line task descriptions for artifact checks (the `request` they are judged against). */
export const ARTIFACT_INSTRUCTIONS: Record<string, string> = {
  caption: "Describe the attached media in text for people who cannot see or hear it.",
  summary: "Summarize the chat conversation.",
  condense: "Condense lower-level summaries of a chat into one summary.",
  diary: "Write a first-person diary entry about the conversation.",
  session_record: "Write a handoff record of the work done in this session.",
};

function strongest(fired: readonly FiredCheck[]): { refusal?: FiredCheck; revise: FiredCheck[] } {
  let refusal: FiredCheck | undefined;
  for (const f of fired) {
    if (f.kind !== "refusal") continue;
    if (!refusal || (f.probability ?? 0) > (refusal.probability ?? 0)) refusal = f;
  }
  return { ...(refusal ? { refusal } : {}), revise: fired.filter((f) => f.remedy === "revise") };
}

function servedModelField(model: string | undefined): { servedModel?: string } {
  return model ? { servedModel: model } : {};
}

function emptyVerdict(): GateVerdict {
  return { evaluationIds: [], fired: [], revise: [], unjudged: false, latencyMs: 0 };
}

/**
 * Wrap the gated tools (spec §6.1) so each call passes the gate before it
 * executes. In observe mode the call runs at once; a blocking policy may hold
 * it and throw (a thrown error is the tool error the agent sees). Other tools
 * are returned unchanged; definitions are untouched (wire-stable).
 */
export function wrapToolsWithOutputGate(tools: readonly AgentTool[], gate: OutputGate): AgentTool[] {
  return tools.map((tool) => {
    if (!gatedCheckpoint(tool.name)) return tool;
    const original = tool.execute;
    const execute: typeof original = async (toolCallId, params, signal, onUpdate) => {
      let action: GateAction = { kind: "proceed" };
      try {
        action = await gate.gateCall(tool.name, toolCallId, params as Record<string, unknown> | undefined);
      } catch {
        // The gate never stops a send by failing (fail-open).
      }
      if (action.kind === "block") throw new Error(action.message);
      return original.call(tool, toolCallId, params, signal, onUpdate);
    };
    return { ...tool, execute };
  });
}

/** Judging internal tasks' outputs (spec §5.2.3–4), off the interactive path. */
export interface BackgroundChecks {
  /** An internal task's output: a caption, a summary or diary draft at finalize. */
  artifact(input: BackgroundArtifact): Promise<void>;
  /** A failed rollout (no output) before its re-run: the assistant-authored text of its last turns. */
  rollout(input: BackgroundRollout): Promise<void>;
}

export interface BackgroundJobScope {
  /** Internal site: summarize | condense | diary | caption | record_turn. */
  site: string;
  timelineKey: string | null;
  /** The owning agent; resolved from `timelineKey` when omitted. */
  agent?: string | null;
  sessionId?: string | null;
  sessionType?: string | null;
  servedModel?: string;
  wireModel?: string;
}

export interface BackgroundArtifact extends BackgroundJobScope {
  /** caption | summary | condense | diary | session_record (selects the task instruction). */
  kind: string;
  text: string;
}

export interface BackgroundRollout extends BackgroundJobScope {
  kind: string;
  /** The failed run's messages; only assistant-authored text is judged. */
  messages: readonly unknown[];
}

/**
 * {@link BackgroundChecks} over the shared evaluator. Each call judges with
 * the background deadline and is recorded when it completes (observe-only:
 * nothing waits on it; phase 4 routes a judged rollout refusal to the rules).
 * Never rejects.
 */
export function createBackgroundChecks(
  evaluator: CheckEvaluator,
  opts: { agentFor?: (timelineKey: string) => string | null; logger?: Logger } = {},
): BackgroundChecks {
  const run = async (job: BackgroundJobScope, checkpoint: Checkpoint, kind: string, sources: CheckSources) => {
    try {
      const agent = job.agent !== undefined ? job.agent : job.timelineKey ? (opts.agentFor?.(job.timelineKey) ?? null) : null;
      const scope: CheckScope = {
        agent,
        site: job.site,
        sessionId: job.sessionId ?? null,
        sessionType: job.sessionType ?? null,
        timelineKey: job.timelineKey,
        tasks: null,
      };
      const evaluation = evaluator.start(
        scope,
        {
          context: { checkpoint, request: [{ from: "task", text: ARTIFACT_INSTRUCTIONS[kind] ?? kind }], action: kind },
          sources,
          ...servedModelField(job.servedModel),
          ...(job.wireModel ? { wireModel: job.wireModel } : {}),
        },
        { checkpoint },
      );
      const result = await evaluation.done;
      const late = result.latencyMs > evaluation.deadlineMs;
      const verdict: GateVerdict = {
        evaluationIds: [],
        fired: result.fired,
        ...strongest(result.fired),
        unjudged: late || result.unjudgedReason !== undefined,
        latencyMs: result.latencyMs,
      };
      const info: GateCallInfo = { checkpoint, action: kind, scope };
      await evaluator.record(evaluation, {
        consequence: OBSERVE_POLICY.consequence(info, verdict, { held: false, late }),
        late,
        heldMs: 0,
      });
    } catch (error) {
      opts.logger?.warn("check_background_failed", {
        site: job.site,
        checkpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return {
    artifact: (input) =>
      input.text.trim() ? run(input, "artifact", input.kind, { artifact: input.text }) : Promise.resolve(),
    rollout: (input) => {
      const rollout = rolloutTexts(input.messages);
      return rollout.length > 0 ? run(input, "rollout", input.kind, { rollout }) : Promise.resolve();
    },
  };
}
