import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChatProvider, OutboundTarget } from "../types.js";
import type { AgentSessionRecord, SessionRunLifecycle } from "./session-manager.js";
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
 * request itself is fine). A `content` failure is deterministic on replay and
 * is parked without auto-retry; everything else (semantic run problems, aborts,
 * programming errors) is not improved by re-issuing the same request.
 */
export function isResumableRunError(error: unknown): boolean {
  return isLlmRunFailure(error) && error.llmClass === "environmental";
}

export interface SessionRunnerOptions {
  provider?: ChatProvider;
  target?: OutboundTarget;
  /**
   * Suppress the typing indicator for the whole run (ARCHITECTURE.md §9g).
   * Proactive sessions set this: the message should appear spontaneously, and a
   * `NO_REPLY` must leave no "tried and failed to type" artifact. `send_message`
   * delivers immediately, so a "type only while sending" variant would be
   * meaningless — typing is simply never started.
   */
  suppressTyping?: boolean;
}

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
  constructor(private readonly options: SessionRunnerOptions = {}) {}

  /**
   * Drive a session run to a terminal state. `kickoff` is the frozen final user
   * turn for a fresh session; `undefined` means **continue-mode** (resume-in-place,
   * spec §6.2): the transcript was seeded from the persisted record and the run
   * re-issues from its current tail via `agent.continue()` — redoing the exact
   * request that failed rather than starting a new turn.
   */
  async run(
    agent: Agent,
    session: AgentSessionRecord,
    maxRetries: number,
    kickoff: AgentMessage | undefined,
    lifecycle?: SessionRunLifecycle,
  ): Promise<SessionRunResult> {
    let retries = 0;
    let typingInterval: NodeJS.Timeout | undefined;
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
      await waitForAgentIdle(agent);
      throwIfLlmFailure(agent, lifecycle);

      while (
        !isTerminallyValid(agent.state.messages) &&
        retries < maxRetries &&
        // Authoritative termination signal: an operator Stop flips the session's
        // interrupt state (#1). Break even if the just-resolved turn settled
        // normally (`stopReason:"stop"`) a hair before the abort landed, so we
        // never issue an extra forced-completion turn after Stop.
        !lifecycle?.isInterrupted() &&
        // Fast path / fallback when no lifecycle is wired (e.g. summarization
        // path, unit tests): pi-agent-core resolves an aborted run with a
        // synthetic `stopReason:"aborted"` turn (#5). A drain-caused
        // scheduler-stop admission rejection (class-tagged `aborted` but with
        // `stopReason:"error"`) is handled one step earlier by
        // `throwIfLlmFailure`, which throws BEFORE this loop is entered (#2), so
        // it can never reach forced completion.
        !wasAborted(agent.state.messages)
      ) {
        retries += 1;
        await forceCompletion(agent);
        await waitForAgentIdle(agent);
        throwIfLlmFailure(agent, lifecycle);
      }

      const noReply = !isTerminallyValid(agent.state.messages) ||
        (isExplicitNoReply(agent.state.messages) && !hasSendMessageCall(agent.state.messages));
      return {
        sessionId: session.id,
        noReply,
        retries,
      };
    } finally {
      // The run has settled: clear the logically-running flag so a late Stop is
      // (correctly) reported as "not running" and defers to the terminal handler.
      lifecycle?.clearRunInProgress();
      if (typingInterval) clearInterval(typingInterval);
      if (this.options.provider && this.options.target && !this.options.suppressTyping) {
        await this.options.provider.setTyping(this.options.target, false).catch(() => undefined);
      }
    }
  }
}

async function forceCompletion(agent: Agent): Promise<void> {
  if (lastMessageRole(agent.state.messages) === "assistant") {
    const alreadySent = hasSendMessageCall(agent.state.messages);
    const content = alreadySent
      ? "You already sent a message but your turn did not end cleanly. Either:\n" +
        "- Call send_message again with your follow-up and final=true to end your turn, OR\n" +
        "- Output exactly NO_REPLY if you have nothing more to say.\n\n" +
        "Text you write outside of send_message is not visible to users."
      : "Your turn ended without sending a message. You must end every turn by either:\n" +
        "- Calling send_message with your response, OR\n" +
        "- Outputting exactly NO_REPLY if you have nothing to say.\n\n" +
        "Text you write outside of send_message is not visible to users.";
    await promptAgent(agent, {
      role: "user",
      content,
      timestamp: Date.now(),
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
    | { stopReason?: string }
    | undefined;
  const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
  if (stopReason === "aborted") return;
  const message = stripLlmRequestTag(errorMessage);
  // Prefer the class marker stamped at the surfacing point; fall back to
  // re-classifying the stripped message (e.g. errors tagged by older rows).
  const cls = extractLlmRequestClass(errorMessage) ?? classifyLlmError(message, stopReason);
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

  return false;
}

export function isExplicitNoReply(messages: unknown[]): boolean {
  return extractLastAssistantText(messages).trim() === "NO_REPLY";
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

