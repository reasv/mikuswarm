import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { IChatProvider, OutboundTarget } from "../types.js";
import type { AgentSessionRecord, SessionRunLifecycle } from "./session-manager.js";
import type { Logger } from "../observability/logger.js";
import type { RedoRequest, SessionRedoControl } from "./redo-signal.js";
import { isPostingTool } from "../tools/side-effects.js";
import { FORCED_COMPLETION_PROMPTS, currentContractAttempt, type ForcedCompletionMarker } from "./contract.js";
import {
  classifyLlmError,
  extractLlmRequestClass,
  isLlmRequestError,
  stripLlmRequestTag,
  type LlmErrorClass,
} from "./request-retry.js";

export interface SessionRunResult {
  sessionId: string;
  noReply: boolean;
  retries: number;
  /** The request was cancelled by a late-input step (its trigger was deleted). */
  cancelled?: boolean;
  /** The agent the run ended on (a redo from scratch replaces the initial one). */
  agent?: Agent;
}

export class SessionRunnerError extends Error {
  /** Failure class (spec LLM-FAILURE-HANDLING §3); set only for `phase:"llm"`. */
  readonly llmClass?: LlmErrorClass;

  constructor(
    message: string,
    readonly phase: "prompt" | "wait" | "force_completion" | "llm",
    options?: { cause?: unknown; llmClass?: LlmErrorClass },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SessionRunnerError";
    this.llmClass = options?.llmClass;
  }
}

/**
 * True when the run failed at the LLM request layer (spec LLM-FAILURE-HANDLING
 * §8): the runner surfaced a `phase:"llm"` SessionRunnerError. These failures
 * never destroy the session (P5) — `launchSession` parks them
 * `failed-resumable` with the error recorded, for manual console resume.
 */
export function isLlmRunFailure(error: unknown): error is SessionRunnerError & { phase: "llm" } {
  return error instanceof SessionRunnerError && error.phase === "llm";
}

/**
 * True for the run failures resume-in-place can fix by re-issuing the same
 * request: an *environmental* LLM-layer failure (the upstream was unwell; the
 * request itself is fine). A `content` or `refusal` failure is deterministic on
 * replay and is parked without auto-retry; everything else (semantic run problems, aborts,
 * programming errors) is not improved by re-issuing the same request.
 */
export function isResumableRunError(error: unknown): boolean {
  return isLlmRunFailure(error) && error.llmClass === "environmental";
}

export interface SessionRunnerOptions {
  provider?: IChatProvider;
  target?: OutboundTarget;
  /**
   * Suppress the typing indicator for the whole run (ARCHITECTURE.md §9g).
   * Proactive sessions set this: the message should appear spontaneously, and a
   * `NO_REPLY` must leave no "tried and failed to type" artifact. `send_message`
   * delivers immediately, so a "type only while sending" variant would be
   * meaningless — typing is simply never started.
   */
  suppressTyping?: boolean;
  /**
   * Session redo (spec REFUSAL-HANDLING §8.4): after every settle the runner
   * takes a pending request from `control` (before the send-contract check) and
   * hands it to `onRedo`, which forks the session (and, for a refusal, pins the
   * redo model); on `continue` the runner resets the nudge budget and continues
   * the agent from the forked transcript. A redo-requesting tool also aborts the
   * run; that abort is never read as an operator Stop. Absent = no redo.
   */
  redo?: {
    control: SessionRedoControl;
    onRedo(req: RedoRequest, agent: Agent): Promise<RedoOutcome>;
  };
  /**
   * `[agent.sessions].forced_completion_redo` (spec §7.5): when the nudges run
   * out, request a same-model `contract` redo through `redo.onRedo`, once per
   * failure point (the span since the last delivered message). Needs `redo`.
   */
  contractRedo?: boolean;
  logger?: Logger;
  /**
   * Endings without a send tool (spec REFUSAL-HANDLING §5.4): told when the run
   * ends with the literal `NO_REPLY` text or with its forced-completion nudges
   * exhausted (the `no_reply` call is judged by the tool itself). The output
   * gate implements it; observe-only, it returns without waiting.
   */
  endings?: SessionEndingHook;
  /**
   * Late input (ARCHITECTURE.md §8 "Late input"): consulted at every idle point
   * before the run's state is read. A step either continues the run (a redo
   * from scratch hands over a rebuilt agent and its kickoff; an abort-and-
   * interject continues the same agent, whose aborted turn the step removed),
   * or ends it (a cancelled request).
   */
  lateInput?: {
    next(agent: Agent): Promise<LateInputStep | undefined>;
  };
}

/** What the runner does with a late-input step. */
export type LateInputStep =
  | {
      kind: "continue";
      agent: Agent;
      /** Prompted on `agent` (a restart's kickoff); absent = `agent.continue()`. */
      kickoff?: AgentMessage | AgentMessage[];
      /** The new agent's redo handler and ending hook (a restart). */
      redo?: SessionRunnerOptions["redo"];
      endings?: SessionEndingHook;
    }
  | { kind: "end"; noReply: boolean; cancelled?: boolean };

/** A run that ended without a send tool, as the runner reports it. */
export interface SessionEnding {
  /** `NO_REPLY` = the literal text marker; `exhausted` = the nudges ran out without a valid ending. */
  kind: "NO_REPLY" | "exhausted";
  /** Forced-completion nudges of this run. */
  nudges: number;
}

export interface SessionEndingHook {
  onEnding(ending: SessionEnding): void | Promise<void>;
}

/**
 * What the runner does after `onRedo` (CONTRACT "Redo loop"). `park` ends the
 * run as a refusal-class LLM failure (parked `failed-resumable`, like a hard
 * refusal): a soft refusal whose rule is exhausted with `on_exhausted = "park"`.
 */
export type RedoOutcome =
  | { action: "continue" }
  | { action: "give_up"; noReply: boolean }
  | { action: "park"; message: string };

// matrix-sdk sends typing notices to the homeserver with a fixed 4s server-side
// expiry (`TYPING_NOTICE_TIMEOUT`), and internally dedups repeated calls,
// only actually re-sending once ≥3s have elapsed since the last send
// (`TYPING_NOTICE_RESEND_TIMEOUT`). That leaves a narrow (3s, 4s) window in
// which a refresh must land to keep the indicator continuous. A keepalive equal
// to the 4s expiry systematically lands the refresh *after* the server already
// dropped the indicator (interval drift + NAPI/network latency push it past 4s),
// producing the "typing flickers on and off / barely shows" symptom. Poll well
// inside the window so matrix-sdk's own resend fires as soon as its 3s gate opens
// (~3s elapsed), comfortably before the 4s server expiry. The sub-window calls
// are cheap: matrix-sdk dedups them, so only ~one real request per ~3.5s hits the
// wire regardless of how often we poll.
const TYPING_KEEPALIVE_MS = 1_000;

export class SessionRunner {
  /** The redo handler and ending hook in use; a redo from scratch replaces them. */
  private redoBinding: SessionRunnerOptions["redo"];
  private endingsBinding: SessionEndingHook | undefined;

  constructor(private readonly options: SessionRunnerOptions = {}) {
    this.redoBinding = options.redo;
    this.endingsBinding = options.endings;
  }

  /**
   * Drive a session run to a terminal state. `kickoff` is the frozen final user
   * turn for a fresh session (or an array of `[finalTurn, ...syntheticMessages]`
   * when W5 synthetic injections are present); `undefined` means
   * **continue-mode** (resume-in-place, spec §6.2): the transcript was seeded
   * from the persisted record and the run re-issues from its current tail via
   * `agent.continue()` — redoing the exact request that failed rather than
   * starting a new turn.
   */
  async run(
    initialAgent: Agent,
    session: AgentSessionRecord,
    maxRetries: number,
    kickoff: AgentMessage | AgentMessage[] | undefined,
    lifecycle?: SessionRunLifecycle,
  ): Promise<SessionRunResult> {
    let agent = initialAgent;
    let retries = 0;
    let nudges = 0;
    let typingInterval: NodeJS.Timeout | undefined;
    // Failure points (index after the last delivered message) a send-contract
    // redo already covered: one redo each (spec §7.5, owner decision 14).
    const contractRedone = new Set<number>();
    // Mark the session logically running for the WHOLE duration of run() — not
    // just while a prompt is streaming. `interrupt()` gates on this so a Stop
    // landing in the inter-turn gap (where `agent.signal` is transiently absent)
    // is still honored (#2). Cleared in finally once the run settles.
    lifecycle?.markRunInProgress();
    try {
      if (this.options.provider && this.options.target && !this.options.suppressTyping) {
        await this.options.provider.setTyping(this.options.target, true);
        const provider = this.options.provider;
        const target = this.options.target;
        typingInterval = setInterval(() => {
          void provider.setTyping(target, true).catch(() => undefined);
        }, TYPING_KEEPALIVE_MS);
      }

      // Kick the loop with the frozen final user turn (the rich `triggerGroup` popped
      // off the prefix by the factory, §2b). It becomes the first turn of the
      // transcript — delivered once, not echoed as a separate raw user message.
      // Continue-mode (resume, §6.2): no new turn — re-issue from the seeded
      // transcript's tail.
      if (kickoff !== undefined) {
        await promptAgent(agent, kickoff);
      } else {
        await continueAgent(agent);
      }

      // Hand a redo request to `onRedo` and apply its outcome: undefined =
      // continue the loop (the agent was continued from the forked transcript),
      // else the run's result. A `park` outcome throws.
      const applyRedo = async (req: RedoRequest): Promise<SessionRunResult | undefined> => {
        const outcome = await this.redo(req, agent, session);
        if (outcome.action === "give_up") return { sessionId: session.id, noReply: outcome.noReply, retries: nudges };
        if (outcome.action === "park") {
          throw new SessionRunnerError(`agent run failed at the LLM layer (refusal): ${outcome.message}`, "llm", {
            llmClass: "refusal",
          });
        }
        // The nudge counter resets on a refusal redo; a contract redo starts its
        // own budget (spec §8.4 "Forced completion", §7.5).
        retries = 0;
        await continueAgent(agent);
        return undefined;
      };
      // A redo the ending hook filed (a refusal judged at an ending, spec §5.4).
      const takeRedo = (): RedoRequest | undefined =>
        !lifecycle?.isInterrupted() ? this.redoBinding?.control.take() : undefined;

      // Late input (§8 "Late input"): a pending step is applied before anything
      // reads the settled turn. Returns a result to end the run with, true to
      // re-enter the loop, or false when nothing was pending.
      const applyLateInput = async (): Promise<SessionRunResult | boolean> => {
        if (!this.options.lateInput || lifecycle?.isInterrupted()) return false;
        const step = await this.options.lateInput.next(agent);
        if (!step) return false;
        if (step.kind === "end") {
          return { sessionId: session.id, noReply: step.noReply, retries: nudges, cancelled: step.cancelled, agent };
        }
        if (step.agent !== agent) {
          agent = step.agent;
          if (step.redo) this.redoBinding = step.redo;
          this.endingsBinding = step.endings;
          contractRedone.clear();
        }
        retries = 0;
        if (step.kickoff !== undefined) await promptAgent(agent, step.kickoff);
        else await continueAgent(agent);
        return true;
      };

      for (;;) {
        await waitForAgentIdle(agent);

        const late = await applyLateInput();
        if (late === true) continue;
        if (late) return late;

        // A redo request filed during the run (the gate, spec §8.4) is taken
        // before anything reads the settled turn: the run stopped on purpose
        // and its tail is about to be discarded. An operator Stop still wins.
        const pending = takeRedo();
        if (pending) {
          const result = await applyRedo(pending);
          if (result) return result;
          continue;
        }

        throwIfLlmFailure(agent, lifecycle);
        if (
          isTerminallyValid(agent.state.messages) ||
          // Authoritative termination signal: an operator Stop flips the session's
          // interrupt state (#1). Break even if the just-resolved turn settled
          // normally (`stopReason:"stop"`) a hair before the abort landed, so we
          // never issue an extra forced-completion turn after Stop.
          lifecycle?.isInterrupted() ||
          // Fast path / fallback when no lifecycle is wired (e.g. summarization
          // path, unit tests): pi-agent-core resolves an aborted run with a
          // synthetic `stopReason:"aborted"` turn (#5). A drain-caused
          // scheduler-stop admission rejection (class-tagged `aborted` but with
          // `stopReason:"error"`) is handled one step earlier by
          // `throwIfLlmFailure`, which throws BEFORE this check (#2), so it can
          // never reach forced completion.
          wasAborted(agent.state.messages)
        ) {
          // An ending without a send is judged (spec §5.4); a refusal there
          // discards it and redoes the turn on the rule's model (§8.4).
          await reportEnding(this.endingsBinding, agent, nudges, lifecycle);
          const endingRedo = takeRedo();
          if (endingRedo) {
            const result = await applyRedo(endingRedo);
            if (result) return result;
            continue;
          }
          // A correction that landed while the ending settled still applies.
          const lateAtEnd = await applyLateInput();
          if (lateAtEnd === true) continue;
          if (lateAtEnd) return lateAtEnd;
          break;
        }

        this.logFailedAttempt(agent, session);
        if (retries < maxRetries) {
          retries += 1;
          nudges += 1;
          await forceCompletion(agent, retries);
          continue;
        }

        // Nudges exhausted. The ending is judged first (spec §5.4, §8.4): a
        // judged refusal with a matching rule redoes the turn on the rule's
        // model; otherwise one same-model contract redo per failure point (§7.5);
        // a second exhaustion in the same span gives up as before.
        await reportEnding(this.endingsBinding, agent, nudges, lifecycle);
        const refusalRedo = takeRedo();
        if (refusalRedo) {
          const result = await applyRedo(refusalRedo);
          if (result) return result;
          continue;
        }
        if (this.options.contractRedo && this.redoBinding) {
          const point = failurePoint(agent.state.messages);
          if (!contractRedone.has(point)) {
            contractRedone.add(point);
            const result = await applyRedo({ kind: "contract" });
            if (result) return result;
            continue;
          }
        }
        this.options.logger?.info("contract_exhausted", {
          sessionId: session.id,
          nudges,
          redone: contractRedone.size > 0,
        });
        break;
      }

      const noReply = !isTerminallyValid(agent.state.messages) ||
        (isExplicitNoReply(agent.state.messages) && !hasSendMessageCall(agent.state.messages));
      return {
        sessionId: session.id,
        noReply,
        retries: nudges,
        agent,
      };
    } finally {
      // A redo nobody took (an operator Stop won) must not outlive the run: it
      // would stop the record turn's loop after its first turn.
      this.redoBinding?.control.take();
      // The run has settled: clear the logically-running flag so a late Stop is
      // (correctly) reported as "not running" and defers to the terminal handler.
      lifecycle?.clearRunInProgress();
      if (typingInterval) clearInterval(typingInterval);
      if (this.options.provider && this.options.target && !this.options.suppressTyping) {
        await this.options.provider.setTyping(this.options.target, false).catch(() => undefined);
      }
    }
  }

  /** Hand a redo request to `onRedo`; a throwing handler gives up silently (logged). */
  private async redo(req: RedoRequest, agent: Agent, session: AgentSessionRecord): Promise<RedoOutcome> {
    const handler = this.redoBinding;
    if (!handler) return { action: "give_up", noReply: true };
    try {
      return await handler.onRedo(req, agent);
    } catch (error) {
      this.options.logger?.error("redo_failed", {
        sessionId: session.id,
        kind: req.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "give_up", noReply: true };
    }
  }

  /** `contract_attempt`: one line per failed send-contract attempt (spec §7.1). */
  private logFailedAttempt(agent: Agent, session: AgentSessionRecord): void {
    const logger = this.options.logger;
    if (!logger) return;
    try {
      const attempt = currentContractAttempt(agent.state.messages);
      if (!attempt || attempt.primaryType === null) return;
      logger.info("contract_attempt", {
        sessionId: session.id,
        attempt: attempt.attemptNo,
        variant: attempt.variant,
        type: attempt.primaryType,
        types: attempt.failureTypes,
        model: attempt.servedModel ?? attempt.wireModel,
      });
    } catch {
      /* diagnostics only */
    }
  }
}

/**
 * Tell the ending hook about a run that ended without a send tool: the literal
 * `NO_REPLY` text, or nudges exhausted. An interrupted or aborted run, a
 * `no_reply` call and a send are not reported. Never throws.
 */
async function reportEnding(
  hook: SessionEndingHook | undefined,
  agent: Agent,
  nudges: number,
  lifecycle: SessionRunLifecycle | undefined,
): Promise<void> {
  if (!hook || lifecycle?.isInterrupted() || wasAborted(agent.state.messages)) return;
  const messages = agent.state.messages;
  // Harness-made endings are policy outcomes, not model output to judge again.
  const terminal = findLastAssistantMessage(messages) as { harness?: unknown } | undefined;
  if (terminal?.harness) return;
  let kind: SessionEnding["kind"];
  if (!isTerminallyValid(messages)) {
    kind = "exhausted";
  } else {
    const last = findLastAssistantMessage(messages);
    const blocks = (last?.content ?? []) as Array<{ type: string; name?: string }>;
    const toolEnded = blocks.some((b) => b.type === "toolCall" && (b.name === "send_message" || b.name === "no_reply"));
    if (toolEnded || extractLastAssistantText(messages).trim() !== "NO_REPLY") return;
    kind = "NO_REPLY";
  }
  try {
    await hook.onEnding({ kind, nudges });
  } catch {
    /* observe-only: the hook can never affect the run */
  }
}

/**
 * Inject corrective nudge `attempt` (1-based within the current budget). The
 * prompt texts are the shared constants of `contract.ts`, and the turn carries a
 * `forced_completion` harness marker so the send-contract derivation reads it
 * exactly (spec REFUSAL-HANDLING §7.1).
 */
async function forceCompletion(agent: Agent, attempt: number): Promise<void> {
  if (lastMessageRole(agent.state.messages) === "assistant") {
    const variant = hasSendMessageCall(agent.state.messages) ? "sent_not_final" : "not_sent";
    const harness: ForcedCompletionMarker = { kind: "forced_completion", attempt, variant };
    await promptAgent(agent, {
      role: "user",
      content: FORCED_COMPLETION_PROMPTS.current[variant],
      timestamp: Date.now(),
      harness,
    });
    return;
  }
  await agent.continue().catch((error) => {
    throw new SessionRunnerError("Agent forced completion failed", "force_completion", { cause: error });
  });
}

async function promptAgent(agent: Agent, message: unknown): Promise<void> {
  await agent.prompt(message as any).catch((error) => {
    throw new SessionRunnerError("Agent prompt failed", "prompt", { cause: error });
  });
}

async function continueAgent(agent: Agent): Promise<void> {
  await agent.continue().catch((error) => {
    throw new SessionRunnerError("Agent continue failed", "prompt", { cause: error });
  });
}

/**
 * Surface a run that failed at the LLM request layer as a typed rejection (spec
 * LLM-FAILURE-HANDLING §8.1). pi-agent-core RESOLVES a failed run — it
 * synthesizes a `stopReason:"error"` assistant message and records the failure
 * in `AgentState.errorMessage` — so without this check a live session whose
 * upstream died would enter the forced-completion loop (doomed paid re-prompts
 * against an API failure) and finally settle as a silent `NO_REPLY` completion
 * with no error recorded anywhere (audit defect #1).
 *
 * EVERY tagged LLM failure throws here — environmental (Layer-0 budget
 * exhausted) and content (oversized/malformed request) alike — BEFORE
 * `isTerminallyValid` or the forced-completion loop is consulted. Forced
 * completion fires only for *clean* turns with invalid output, its original
 * output-contract purpose (P1/P2). The thrown error carries the §3 class so
 * `launchSession` can park the session with an accurate record.
 *
 * Only errors TAGGED at the Layer-0 seam count (Decision C / #14):
 * pi-agent-core's `handleRunFailure` flattens ANY executor throw — including
 * programming errors in `transformContext`/tool plumbing — into the same
 * `errorMessage` string. `withRequestRetry` appends
 * `LLM_REQUEST_FAILURE_MARKER` (+ the class marker) to every terminal error
 * that genuinely originated in the LLM request layer (provider/SDK failures
 * and scheduler-admission failures alike); an untagged error is our own code
 * throwing and settles as a plain failure. Genuine in-turn aborts — operator
 * Stop (`lifecycle.isInterrupted()`) and tool/turn caps (the synthetic turn
 * carries `stopReason:"aborted"`) — keep today's settle-in-place behaviour.
 *
 * A drain-caused scheduler-stop admission rejection is the exception (#2): it
 * is class-tagged `aborted` but lands on a synthetic turn with
 * `stopReason:"error"` (no operator interrupt), so it reaches the final branch
 * below. The maintainer chose PARK-over-discard for it (it's an environmental-
 * adjacent shutdown event, the pending user message must survive), so it THROWS
 * `phase:"llm"` like every other tagged failure — `launchSession` then parks it
 * `failed-resumable`. Re-entering forced completion against a stopped gate that
 * can only reject again would add a P1-violating user turn per iteration and
 * finally mask the drop as a `NO_REPLY` completion.
 */
function throwIfLlmFailure(agent: Agent, lifecycle?: SessionRunLifecycle): void {
  const errorMessage = agent.state.errorMessage;
  if (!errorMessage || errorMessage.length === 0) return;
  if (lifecycle?.isInterrupted()) return;
  if (!isLlmRequestError(errorMessage)) return;
  const last = findLastAssistantMessage(agent.state.messages) as
    | { stopReason?: string; rawStopReason?: string }
    | undefined;
  const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
  const rawStopReason = typeof last?.rawStopReason === "string" ? last.rawStopReason : undefined;
  if (stopReason === "aborted") return;
  const message = stripLlmRequestTag(errorMessage);
  // Prefer the class marker stamped at the surfacing point; fall back to
  // re-classifying the stripped message (e.g. errors tagged by older rows).
  const cls = extractLlmRequestClass(errorMessage) ?? classifyLlmError(message, stopReason, rawStopReason);
  throw new SessionRunnerError(`agent run failed at the LLM layer (${cls}): ${message}`, "llm", {
    llmClass: cls,
  });
}

async function waitForAgentIdle(agent: Agent): Promise<void> {
  await agent.waitForIdle().catch((error) => {
    throw new SessionRunnerError("Agent waitForIdle failed", "wait", { cause: error });
  });
}

function lastMessageRole(messages: unknown[]): string | undefined {
  const last = messages.at(-1) as { role?: unknown } | undefined;
  return typeof last?.role === "string" ? last.role : undefined;
}

export function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    const candidate = message as Partial<AssistantMessage>;
    if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
    return candidate.content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

export function stripThinkingContamination(text: string): string {
  return text
    .replace(/<(?:thinking|antThinking|reasoning|thoughts?|internal_reasoning)>[\s\S]*?<\/(?:thinking|antThinking|reasoning|thoughts?|internal_reasoning)>/gi, "")
    .trim();
}

function extractTextFromBlocks(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The current send-contract failure point (spec §7.5): the index just after
 * the last delivered message (a posting tool call with a non-error result), or
 * 0. Indices before a fork point never move, so the key survives the redo.
 */
function failurePoint(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; isError?: unknown; toolName?: unknown };
    if (m?.role === "toolResult" && m.isError !== true && typeof m.toolName === "string" && isPostingTool(m.toolName)) {
      return i + 1;
    }
  }
  return 0;
}

function hasSendMessageCall(messages: unknown[]): boolean {
  for (const message of messages) {
    const candidate = message as Partial<AssistantMessage>;
    if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
    if (candidate.content.some((b: any) => b?.type === "toolCall" && b?.name === "send_message")) return true;
  }
  return false;
}

function findLastAssistantMessage(messages: unknown[]): Partial<AssistantMessage> | undefined {
  for (const message of [...messages].reverse()) {
    const candidate = message as Partial<AssistantMessage>;
    if (candidate.role === "assistant" && Array.isArray(candidate.content)) return candidate;
  }
  return undefined;
}

export function isTerminallyValid(messages: unknown[]): boolean {
  const last = findLastAssistantMessage(messages);
  if (!last) return false;
  const blocks = last.content as Array<{ type: string; name?: string; text?: string }>;
  if (!blocks.length) return false;

  if (extractTextFromBlocks(blocks).trim() === "NO_REPLY") return true;
  if (blocks.some((b) => b.type === "toolCall" && b.name === "send_message")) return true;
  if (blocks.some((b) => b.type === "toolCall" && b.name === "no_reply")) return true;

  return false;
}

export function isExplicitNoReply(messages: unknown[]): boolean {
  const text = extractLastAssistantText(messages).trim();
  if (text === "NO_REPLY") return true;
  const last = findLastAssistantMessage(messages);
  if (!last) return false;
  const blocks = last.content as Array<{ type: string; name?: string }>;
  return blocks.some((b) => b.type === "toolCall" && b.name === "no_reply");
}

/** How many trailing assistant messages `wasAborted` scans for an abort marker. */
const ABORT_TAIL_SCAN = 5;

/**
 * True when a recent assistant turn was produced by an aborted run.
 * pi-agent-core resolves (does not reject) an aborted run, appending a synthetic
 * assistant message with `stopReason: "aborted"`. The force-completion loop must
 * break on this rather than re-prompting an agent whose run has been cancelled —
 * see {@link SessionManager.interrupt}.
 *
 * Scans the recent assistant-message *tail* (not only the final message): if the
 * transcript ever gains a trailing assistant turn after the synthetic aborted one
 * (#5), inspecting only the last message would wrongly report `false` and let the
 * loop re-prompt a cancelled agent. The authoritative termination signal is the
 * session's interrupt state (see the loop in {@link SessionRunner.run}); this
 * remains as a robust fast path / fallback when no lifecycle is wired.
 */
function wasAborted(messages: unknown[]): boolean {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < ABORT_TAIL_SCAN; i -= 1) {
    const candidate = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
    if (candidate?.role !== "assistant") continue;
    seen += 1;
    if (candidate.stopReason === "aborted") return true;
  }
  return false;
}

