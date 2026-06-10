import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChatProvider, OutboundTarget } from "../types.js";
import type { AgentSessionRecord, SessionRunLifecycle } from "./session-manager.js";
import { classifyLlmError } from "./request-retry.js";

export interface SessionRunResult {
  sessionId: string;
  noReply: boolean;
  retries: number;
}

export class SessionRunnerError extends Error {
  constructor(
    message: string,
    readonly phase: "prompt" | "wait" | "force_completion" | "mechanical",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionRunnerError";
  }
}

/**
 * True for the run failures Layer-2 resume-in-place can fix (spec
 * CONCURRENCY-AND-RATE-LIMITING §6.2): the runner surfaced a `"mechanical"`
 * SessionRunnerError — the model's turn died on a retryable transport/upstream
 * failure after Layer-1 exhausted. Everything else (semantic run problems,
 * aborts, programming errors) is not improved by re-issuing the same request.
 */
export function isResumableRunError(error: unknown): boolean {
  return error instanceof SessionRunnerError && error.phase === "mechanical";
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

const TYPING_KEEPALIVE_MS = 4_000;

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
      throwIfMechanicalFailure(agent, lifecycle);

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
        // synthetic `stopReason:"aborted"` turn (#5).
        !wasAborted(agent.state.messages)
      ) {
        retries += 1;
        await forceCompletion(agent);
        await waitForAgentIdle(agent);
        throwIfMechanicalFailure(agent, lifecycle);
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
        "- Call send_message again with your follow-up (it will end your turn by default), OR\n" +
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
 * Surface a mechanically failed run as a typed rejection (spec §6.2). pi-agent-core
 * RESOLVES a failed run — it synthesizes a `stopReason:"error"` assistant message
 * and records the failure in `AgentState.errorMessage` — so without this check a
 * live session whose upstream died (after Layer-1 retry exhausted) would settle as
 * a silent `NO_REPLY` completion. A retryable failure (transport/5xx/429) throws
 * `phase:"mechanical"`, which the app-level recovery routes to resume-in-place.
 * Intentional aborts (operator Stop, tool/turn caps) and fatal errors (auth,
 * malformed request) keep today's settle-in-place behaviour — re-issuing the same
 * request cannot help them.
 */
function throwIfMechanicalFailure(agent: Agent, lifecycle?: SessionRunLifecycle): void {
  const errorMessage = agent.state.errorMessage;
  if (!errorMessage || errorMessage.length === 0) return;
  if (lifecycle?.isInterrupted()) return;
  const last = findLastAssistantMessage(agent.state.messages) as
    | { stopReason?: string }
    | undefined;
  const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
  if (stopReason === "aborted") return;
  if (classifyLlmError(errorMessage, stopReason) !== "retryable") return;
  throw new SessionRunnerError(`agent run failed mechanically: ${errorMessage}`, "mechanical");
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

