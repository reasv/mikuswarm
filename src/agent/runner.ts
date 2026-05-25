import type { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChatProvider, OutboundTarget } from "../types.js";
import type { AgentSessionRecord } from "./session-manager.js";

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
  sentMessages?: string[];
}

const TYPING_KEEPALIVE_MS = 4_000;

export class SessionRunner {
  constructor(private readonly options: SessionRunnerOptions = {}) {}

  async run(agent: Agent, session: AgentSessionRecord, maxRetries: number): Promise<SessionRunResult> {
    let retries = 0;
    let typingInterval: NodeJS.Timeout | undefined;
    try {
      if (this.options.provider && this.options.target) {
        await this.options.provider.setTyping(this.options.target, true);
        const provider = this.options.provider;
        const target = this.options.target;
        typingInterval = setInterval(() => {
          void provider.setTyping(target, true).catch(() => undefined);
        }, TYPING_KEEPALIVE_MS);
      }

      await promptAgent(agent, {
        type: "chatEvent",
        role: "user",
        content: session.trigger.event.body,
        event: session.trigger.event,
        timestamp: session.trigger.event.timestamp,
      });
      await waitForAgentIdle(agent);

      const sentMessages = this.options.sentMessages ?? [];
      while (!isTerminallyValid(agent.state.messages, sentMessages) && retries < maxRetries) {
        retries += 1;
        await forceCompletion(agent);
        await waitForAgentIdle(agent);
      }

      const noReply = isExplicitNoReply(agent.state.messages) && sentMessages.length === 0;
      return {
        sessionId: session.id,
        noReply,
        retries,
      };
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (this.options.provider && this.options.target) {
        await this.options.provider.setTyping(this.options.target, false).catch(() => undefined);
      }
    }
  }
}

async function forceCompletion(agent: Agent): Promise<void> {
  if (lastMessageRole(agent.state.messages) === "assistant") {
    await promptAgent(agent, {
      role: "user",
      content:
        "Your turn ended without sending a message. You must end every turn by either:\n" +
        "- Calling send_message with your response, OR\n" +
        "- Outputting exactly NO_REPLY if you have nothing to say.\n\n" +
        "Text you write outside of send_message is not visible to users.",
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
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function findLastAssistantMessage(messages: unknown[]): Partial<AssistantMessage> | undefined {
  for (const message of [...messages].reverse()) {
    const candidate = message as Partial<AssistantMessage>;
    if (candidate.role === "assistant" && Array.isArray(candidate.content)) return candidate;
  }
  return undefined;
}

export function isTerminallyValid(messages: unknown[], sentMessages: string[]): boolean {
  const last = findLastAssistantMessage(messages);
  if (!last) return false;
  const blocks = last.content as Array<{ type: string; name?: string; text?: string }>;
  if (!blocks.length) return false;

  const lastBlock = blocks.at(-1)!;
  if (lastBlock.type === "toolCall" && lastBlock.name === "send_message") return true;

  if (isExplicitNoReply(messages)) return true;

  if (sentMessages.length > 0) {
    const text = extractTextFromBlocks(blocks).trim();
    if (!text || /^\s*NO_REPLY\s*$/.test(text)) return true;
  }

  return false;
}

export function isExplicitNoReply(messages: unknown[]): boolean {
  const text = extractLastAssistantText(messages).trim();
  return /^\s*NO_REPLY\s*$/.test(text);
}

