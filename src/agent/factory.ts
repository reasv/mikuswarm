import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import type { ContextBuilder } from "../context/index.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
import { streamLlmGateway } from "./llm-gateway.js";

export interface AgentFactoryOptions {
  config: AppConfig;
  contextBuilder: ContextBuilder;
  getActiveSessions: (timelineKey: string) => AgentSessionRecord[];
}

export class AgentSessionFactory {
  constructor(private readonly options: AgentFactoryOptions) {}

  create(session: AgentSessionRecord, tools: AgentTool[] = []): Agent {
    const model = createModel(this.options.config);
    return new Agent({
      initialState: {
        systemPrompt: this.options.config.agent.system.prompt,
        model,
        tools,
      },
      transformContext: async () => {
        const built = await this.options.contextBuilder.build({
          timelineKey: session.timelineKey,
          trigger: session.trigger.event,
          activeSessions: this.options.getActiveSessions(session.timelineKey),
        });
        return built.messages.map((message) => {
          if (message.type === "runtimeInstructions") {
            return {
              type: "runtimeInstructions",
              content: message.content,
              imageBlocks: message.imageBlocks,
            };
          }
          if (message.type === "chatEvent") {
            return {
              type: "chatEvent",
              role: message.role === "assistant" ? "assistant" : "user",
              content: message.content,
              imageBlocks: message.imageBlocks,
            };
          }
          return {
            role: "user",
            content: message.content,
            timestamp: Date.now(),
          };
        });
      },
      convertToLlm,
      streamFn: streamLlmGateway as any,
      getApiKey: () => this.options.config.models.default.api_key,
      onPayload: (payload) => payload,
      steeringMode: "one-at-a-time",
      sessionId: session.timelineKey,
    });
  }
}

export function createModel(config: AppConfig): Model<"anthropic-messages"> {
  const model = config.models.default;
  return {
    id: model.id,
    name: model.id,
    api: "anthropic-messages",
    provider: model.provider,
    baseUrl: model.endpoint,
    reasoning: false,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: model.max_tokens,
    compat: {
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    },
  };
}
