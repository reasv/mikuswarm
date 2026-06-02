import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChatProvider, OutboundTarget } from "../types.js";
import type { AgentSessionRecord, SessionRunLifecycle } from "./session-manager.js";

export interface SessionRunResult {
  sessionId: string;
  noReply: boolean;
  retries: number;
}

export class SessionRunnerError extends Error {
  constructor(
    message: string,
    readonly phase: "prompt" | "wait" | "force_completion",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionRunnerError";
  }
}

export interface SessionRunnerOptions {
  provider?: ChatProvider;
  target?: OutboundTarget;
}

const TYPING_KEEPALIVE_MS = 4_000;

export class SessionRunner {
  constructor(private readonly options: SessionRunnerOptions = {}) {}

  async run(
    agent: Agent,
    session: AgentSessionRecord,
    maxRetries: number,
    kickoff: AgentMessage,
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
      if (this.options.provider && this.options.target) {
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
      await promptAgent(agent, kickoff);
      await waitForAgentIdle(agent);

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
      if (this.options.provider && this.options.target) {
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

