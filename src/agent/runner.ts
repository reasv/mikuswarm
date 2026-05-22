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
        await agent.prompt({
          type: "chatEvent",
          role: "user",
          content: session.trigger.event.body,
          event: session.trigger.event,
        });
        await agent.waitForIdle();
      } finally {
        if (typeof unsubscribe === "function") unsubscribe();
      }

      let text = extractLastAssistantText(agent.state.messages);
      while (!text.trim() && retries < maxRetries) {
        retries += 1;
        await forceCompletion(agent);
        await agent.waitForIdle();
        text = extractLastAssistantText(agent.state.messages);
      }

      const stripped = stripThinkingContamination(text);
      const noReply = /^\s*NO_REPLY\s*$/.test(stripped);
      const finalText = noReply ? "" : stripped.trim();
      if (!noReply && finalText && !wasAlreadySent(finalText, this.options.sentMessages ?? [])) {
        let deliveredExternalId: string | undefined;
        let deliveredAt = Date.now();
        if (this.options.provider && this.options.target) {
          const receipt = await this.options.provider.send(this.options.target, {
            body: finalText,
            agentSessionId: session.id,
          });
          deliveredExternalId = receipt.externalId;
          deliveredAt = receipt.deliveredAt;
        }
        await this.store.append(createAssistantTimelineEvent(session, finalText, deliveredAt, deliveredExternalId));
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
  try {
    await agent.continue();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cannot continue from message role: assistant")) {
      await agent.prompt({
        role: "user",
        content: "Your previous turn ended without visible text. Produce the final chat response now, or exactly NO_REPLY.",
        timestamp: Date.now(),
      });
      return;
    }
    throw error;
  }
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
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, "")
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
