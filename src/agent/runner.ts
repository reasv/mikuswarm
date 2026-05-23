import type { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CanonicalChatEvent, ChatProvider, OutboundTarget } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { wasAlreadySent } from "./dedupe.js";

export interface SessionRunResult {
  sessionId: string;
  text: string;
  noReply: boolean;
  retries: number;
}

export class SessionRunnerError extends Error {
  constructor(
    message: string,
    readonly phase: "prompt" | "wait" | "force_completion" | "delivery",
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

export class SessionRunner {
  constructor(
    private readonly store: TimelineStore,
    private readonly options: SessionRunnerOptions = {},
  ) {}

  async run(agent: Agent, session: AgentSessionRecord, maxRetries: number): Promise<SessionRunResult> {
    let retries = 0;
    try {
      if (this.options.provider && this.options.target) {
        await this.options.provider.setTyping(this.options.target, true);
      }
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "message_update" && this.options.provider && this.options.target) {
          void this.options.provider.setTyping(this.options.target, true);
        }
      });
      try {
        await promptAgent(agent, {
          type: "chatEvent",
          role: "user",
          content: session.trigger.event.body,
          event: session.trigger.event,
          timestamp: session.trigger.event.timestamp,
        });
        await waitForAgentIdle(agent);
      } finally {
        if (typeof unsubscribe === "function") unsubscribe();
      }

      let text = extractLastAssistantText(agent.state.messages);
      while (!text.trim() && retries < maxRetries) {
        retries += 1;
        await forceCompletion(agent);
        await waitForAgentIdle(agent);
        text = extractLastAssistantText(agent.state.messages);
      }

      const stripped = stripThinkingContamination(text);
      const noReply = /^\s*NO_REPLY\s*$/.test(stripped);
      const finalText = noReply ? "" : stripped.trim();
      if (!noReply && finalText && !wasAlreadySent(finalText, this.options.sentMessages ?? [])) {
        let deliveredExternalId: string | undefined;
        let deliveredAt = Date.now();
        if (this.options.provider && this.options.target) {
          const receipt = await this.options.provider
            .send(this.options.target, {
              body: finalText,
              agentSessionId: session.id,
            })
            .catch((error) => {
              throw new SessionRunnerError("Agent response delivery failed", "delivery", { cause: error });
            });
          deliveredExternalId = receipt.externalId;
          deliveredAt = receipt.deliveredAt;
        }
        await this.store.append(createAssistantTimelineEvent(session, finalText, deliveredAt, deliveredExternalId));
        this.options.sentMessages?.push(finalText);
      }
      return {
        sessionId: session.id,
        text: finalText,
        noReply: noReply || !finalText,
        retries,
      };
    } finally {
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
      content: "Your previous turn ended without visible text. Produce the final chat response now, or exactly NO_REPLY.",
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

function createAssistantTimelineEvent(
  session: AgentSessionRecord,
  body: string,
  timestamp: number,
  externalId?: string,
): CanonicalChatEvent {
  return {
    id: `assistant:${session.id}:${externalId ?? timestamp}`,
    externalId,
    timelineKey: session.timelineKey,
    provider: session.trigger.provider,
    agentSessionId: session.id,
    role: "assistant",
    sender: {
      id: "mikuswarm",
      displayName: "Miku",
      isSelf: true,
    },
    body,
    timestamp,
    receivedAt: Date.now(),
  };
}
