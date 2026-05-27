import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, completeSimple, createAssistantMessageEventStream, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import { dumpBuiltContext, type BuiltContext, type ContextBuilder } from "../context/index.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
import { loadWorkspace, renderSystemPrompt } from "../workspace/index.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";

const wrapCompleteAsStream: StreamFn = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  void completeSimple(model, context, options).then(
    (message) => {
      const reason = message.stopReason === "toolUse" ? "toolUse"
        : message.stopReason === "length" ? "length"
        : "stop";
      stream.push({ type: "done", reason, message });
      stream.end(message);
    },
    (err) => {
      const errorMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider ?? "unknown",
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: errorMessage });
      stream.end(errorMessage);
    },
  );
  return stream;
};

export interface AgentFactoryOptions {
  config: AppConfig;
  contextBuilder: ContextBuilder;
  getActiveSessions: (timelineKey: string) => AgentSessionRecord[];
}

export class AgentSessionFactory {
  constructor(private readonly options: AgentFactoryOptions) {}

  /**
   * Resolve the SessionTypeConfig for a given session type name.
   */
  resolveSessionType(sessionType: string): SessionTypeConfig | undefined {
    const types = this.options.config.agent.session_types;
    if (!types) return undefined;
    return types[sessionType] ?? types["default"];
  }

  /**
   * Create an Agent for the given session.
   *
   * Loads workspace content from disk (workspace files, tail instructions, skills)
   * and assembles the system prompt from it. The workspace content is also passed
   * to the context builder so the satellite block can be rendered at build time.
   */
  async create(session: AgentSessionRecord, tools: AgentTool[] = []): Promise<Agent> {
    const model = createModel(this.options.config);
    const modelConfig = this.options.config.models.default;
    const streamFn = (modelConfig.streaming ?? true) ? streamSimple : wrapCompleteAsStream;
    const workspaceRoot = this.options.config.workspace.root_dir;
    const sessionTypeConfig = this.resolveSessionType(session.sessionType);
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;

    // Load workspace files from disk at session creation time
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

    // Filter tools if the session type specifies a tool allowlist
    const filteredTools = filterTools(tools, sessionTypeConfig);

    // NOTE: System prompt is rendered identically here and in ContextBuilder.build().
    // Both are required: this one sets initialState.systemPrompt (used by pi-agent-core
    // on every API call), and the builder's version populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(workspace, fallbackPrompt);

    return new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: filteredTools,
      },
      transformContext: async (messages) => {
        const built = await this.options.contextBuilder.build({
          timelineKey: session.timelineKey,
          trigger: session.trigger.event,
          activeSessions: this.options.getActiveSessions(session.timelineKey),
          workspace,
          sessionType: sessionTypeConfig,
          fallbackPrompt,
        });
        await dumpBuiltContext(
          this.options.config.app.context_dump_dir,
          session.timelineKey,
          session.id,
          built,
          session.trigger.event.id,
        ).catch(() => undefined);
        return buildAgentContextMessages(built, messages);
      },
      convertToLlm,
      streamFn,
      getApiKey: () => modelConfig.api_key,
      onPayload: (payload) => payload,
      steeringMode: "one-at-a-time",
      sessionId: session.timelineKey,
    });
  }
}

/**
 * Filter tools based on session type config.
 * When no tool allowlist is specified, all tools are returned.
 */
export function filterTools(tools: AgentTool[], sessionType?: SessionTypeConfig): AgentTool[] {
  if (!sessionType?.tools) return tools;
  const allowed = new Set(sessionType.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function buildAgentContextMessages(
  built: BuiltContext,
  liveMessages: AgentMessage[] = [],
): AgentMessage[] {
    const baseMessages = built.messages.flatMap((message): AgentMessage[] => {
    if (message.type === "system") return [];
    if (message.type === "triggerGroup") {
      return [
        {
          type: "triggerGroup",
          content: message.content,
          imageBlocks: message.imageBlocks,
          timestamp: message.timestamp,
        },
      ];
    }
    if (message.type === "chatEvent") {
      return [
        {
          type: "chatEvent",
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
          imageBlocks: message.imageBlocks,
          timestamp: message.timestamp,
        },
      ];
    }
    return [];
  });

  return [...baseMessages, ...liveMessages.filter(isLiveRuntimeMessage)];
}

function isLiveRuntimeMessage(message: AgentMessage): boolean {
  const typed = message as any;
  if (!typed || typeof typed !== "object") return false;
  if (typed.type === "interjection") return true;
  if (typed.type === "chatEvent" || typed.type === "triggerGroup") return false;
  if (typed.role === "toolResult") return true;
  if (typed.role === "user") return true;
  if (typed.role === "assistant") {
    return Array.isArray(typed.content) && typed.content.some((block: any) => block?.type === "toolCall");
  }
  return false;
}

export function createModel(config: AppConfig): Model<"anthropic-messages"> {
  const model = config.models.default;
  return {
    id: model.id,
    name: model.id,
    api: "anthropic-messages",
    provider: model.provider,
    baseUrl: model.endpoint,
    reasoning: model.reasoning ?? true,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cache_read ?? 0,
      cacheWrite: model.cost?.cache_write ?? 0,
    },
    contextWindow: model.context_window ?? 128_000,
    maxTokens: model.max_tokens,
    compat: {
      supportsCacheControlOnTools: model.compat?.supports_cache_control_on_tools ?? false,
      supportsLongCacheRetention: model.compat?.supports_long_cache_retention ?? false,
      supportsEagerToolInputStreaming: model.compat?.supports_eager_tool_input_streaming,
      sendSessionAffinityHeaders: model.compat?.send_session_affinity_headers,
    },
  };
}
