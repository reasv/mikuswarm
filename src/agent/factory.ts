import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, completeSimple, createAssistantMessageEventStream, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import { dumpBuiltContext, type BuiltContext, type ContextBuilder } from "../context/index.js";
import type { ContextMessage } from "../context/builder.js";
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

type ModelConfig = AppConfig["models"]["default"];

export interface CreateAgentOptions {
  /** When set, build context for a summarization session cut at this timestamp. */
  summarizationCutoff?: { endTimestamp: number };
  /**
   * Resume seam (designed-for, not yet wired — see §6 of spec/OBSERVABILITY-UI.md).
   * When set, `ContextBuilder.build()` is skipped entirely: `snapshot` is reused as the
   * frozen prefix and `transcript` seeds the live message array. The caller is expected
   * to append the awaited input as a new user turn before continuing.
   */
  resume?: { snapshot: AgentMessage[]; transcript?: AgentMessage[] };
}

export interface CreatedAgent {
  agent: Agent;
  /**
   * The final user turn — a rich `triggerGroup` (chat) or the cutoff `satellite`
   * (summarization) — popped off the frozen prefix (§2b). The caller kicks the loop
   * with it via `agent.prompt(...)`, making it the first turn of the live transcript.
   * Undefined in resume mode (the caller appends a new user turn instead).
   */
  finalTurn?: AgentMessage;
  /**
   * Frozen context **prefix** for persistence (spec §3 / §10a): `built.messages`
   * minus the final live user turn (the trailing `triggerGroup`/`satellite`).
   *
   * This DELIBERATELY retains the leading `system` ContextMessage and the
   * summary/compact/rich tiers WITH their `tier`/`tokenEstimate` metadata intact —
   * the verbatim renderer (§10a) needs the system block + tier metadata. Do NOT
   * reuse the runtime `frozenBase` here: that drops the system message and tier
   * metadata. Undefined in resume mode (no fresh build occurred).
   */
  snapshot?: ContextMessage[];
  /** Snapshot-level token totals copied verbatim from `BuiltContext` (§11 top bar). */
  tokenEstimate?: number;
  compactTokens?: number;
  richTokens?: number;
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

  /** Resolve the model id used by a session type (for summary record provenance). */
  resolveModelId(sessionType: string): string {
    const cfg = this.resolveSessionType(sessionType);
    const modelKey = cfg?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    return modelConfig.id;
  }

  /**
   * Create an Agent for the given session.
   *
   * Loads workspace content from disk (workspace files, tail instructions, skills)
   * and assembles the system prompt from it. The workspace content is also passed
   * to the context builder so the satellite block can be rendered at build time.
   */
  async create(
    session: AgentSessionRecord,
    tools: AgentTool[] = [],
    opts?: CreateAgentOptions,
  ): Promise<CreatedAgent> {
    const workspaceRoot = this.options.config.workspace.root_dir;
    const sessionTypeConfig = this.resolveSessionType(session.sessionType);
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;

    const modelKey = sessionTypeConfig?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    const model = createModelFromConfig(modelConfig);
    const streamFn = (modelConfig.streaming ?? true) ? streamSimple : wrapCompleteAsStream;

    // Load workspace files from disk at session creation time
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

    // Filter tools if the session type specifies a tool allowlist
    const filteredTools = filterTools(tools, sessionTypeConfig);

    // NOTE: System prompt is rendered identically here and in ContextBuilder.build().
    // Both are required: this one sets initialState.systemPrompt (used by pi-agent-core
    // on every API call), and the builder's version populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(workspace, fallbackPrompt);

    // Phase 0 — frozen sessions (§2b). Build the context ONCE, here at creation, and
    // freeze it. The prefix (`frozenBase`) is append-only thereafter; the final user
    // turn is popped off and returned so the caller can deliver it via
    // `agent.prompt(...)` as the first turn of the transcript. `transformContext`
    // never rebuilds — it only appends live runtime messages onto the frozen prefix.
    //
    // `frozenBase` is assigned exactly once below and then `Object.freeze`d: the
    // append-only/byte-stable invariant (spec §2b) is enforced, not merely observed.
    // `transformContext` only ever spreads it, so freezing is safe.
    let frozenBaseSeed: AgentMessage[];
    let finalTurn: AgentMessage | undefined;
    // Persistence snapshot surfaced to the caller (§3). Undefined in resume mode.
    let snapshot: ContextMessage[] | undefined;
    let snapshotTokenEstimate: number | undefined;
    let snapshotCompactTokens: number | undefined;
    let snapshotRichTokens: number | undefined;
    if (opts?.resume) {
      // Defensive copy: the resume snapshot is a persisted array owned by the caller
      // (parsed `context_snapshot_json`). Copying it keeps the live runtime prefix
      // from aliasing — and freezing — the caller's array (§6).
      frozenBaseSeed = [...opts.resume.snapshot];
    } else {
      const built = await this.options.contextBuilder.build({
        timelineKey: session.timelineKey,
        trigger: session.trigger.event,
        activeSessions: opts?.summarizationCutoff
          ? []
          : this.options.getActiveSessions(session.timelineKey),
        workspace,
        sessionType: sessionTypeConfig,
        fallbackPrompt,
        summarizationCutoff: opts?.summarizationCutoff,
      });
      await dumpBuiltContext(
        this.options.config.app.context_dump_dir,
        session.timelineKey,
        session.id,
        built,
        session.trigger.event.id,
      ).catch(() => undefined);
      // Single source of truth for the prefix/trigger boundary: `splitBuiltContext`
      // computes the trailing-live-turn cut once and returns BOTH the runtime prefix
      // (`frozenBase`) and the raw-`built.messages` persistence prefix (`snapshot`),
      // so the two cannot drift if the terminal-type detection ever changes (§3 / §10a).
      const split = splitBuiltContext(built);
      frozenBaseSeed = split.frozenBase;
      finalTurn = split.finalTurn;
      snapshot = split.snapshot;
      snapshotTokenEstimate = built.tokenEstimate;
      snapshotCompactTokens = built.compactTokens;
      snapshotRichTokens = built.richTokens;
    }

    // Freeze the prefix so accidental reassignment of an element or the array throws
    // in strict mode and any future write-back surfaces immediately (§2b invariant).
    const frozenBase: readonly AgentMessage[] = Object.freeze(frozenBaseSeed);

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: filteredTools,
      },
      transformContext: async (messages) => [
        ...frozenBase,
        ...messages.filter(isLiveRuntimeMessage),
      ],
      convertToLlm,
      streamFn,
      getApiKey: () => modelConfig.api_key,
      onPayload: (payload) => payload,
      steeringMode: "one-at-a-time",
      sessionId: session.timelineKey,
    });

    if (opts?.resume?.transcript?.length) {
      // Defensive copy: the agent loop mutates `agent.state.messages` in place every
      // turn. Assigning the caller's persisted transcript array by reference would
      // silently corrupt their parsed `transcript_json` (§6). Copy so live runtime
      // state never aliases a persisted array.
      agent.state.messages = [...opts.resume.transcript];
    }

    return {
      agent,
      finalTurn,
      snapshot,
      tokenEstimate: snapshotTokenEstimate,
      compactTokens: snapshotCompactTokens,
      richTokens: snapshotRichTokens,
    };
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

/**
 * Map a BuiltContext's messages into the agent's message vocabulary:
 * - `system` is dropped (it lives in `AgentState.systemPrompt`, not the array).
 * - `triggerGroup`/`satellite` are kept as-is.
 * - `summaryLayer` becomes a user `chatEvent`.
 * - historical `chatEvent`s keep their (assistant-or-user) role.
 */
export function mapBuiltMessages(built: BuiltContext): AgentMessage[] {
  return built.messages.flatMap((message): AgentMessage[] => {
    if (message.type === "system") return [];
    if (message.type === "triggerGroup" || message.type === "satellite") {
      return [
        {
          type: message.type,
          content: message.content,
          imageBlocks: message.imageBlocks,
          timestamp: message.timestamp,
        },
      ];
    }
    if (message.type === "summaryLayer") {
      return [
        {
          type: "chatEvent",
          role: "user",
          content: message.content,
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
}

/**
 * Split a frozen BuiltContext into the append-only prefix (`frozenBase`) and the
 * final user turn (`finalTurn`) — the last message, which the builder always emits
 * as a `triggerGroup` (chat) or `satellite` (summarization cutoff). The caller
 * delivers `finalTurn` via `agent.prompt(...)` so it becomes the first turn of the
 * live transcript (§2b of spec/OBSERVABILITY-UI.md), rather than living in the prefix.
 *
 * The "did the build end with a live final turn?" boundary is computed **once** here
 * and applied to both views of the prefix, so they cannot drift (§3 / §10a):
 * - `frozenBase` — the runtime prefix (mapped into the agent message vocabulary,
 *   system dropped), spread by `transformContext` on every turn.
 * - `snapshot` — the persistence prefix: the raw `built.messages` (system + tiers,
 *   with `tier`/`tokenEstimate` metadata intact) minus the same trailing final turn,
 *   surfaced for `context_snapshot_json` and the verbatim renderer.
 *
 * Both `frozenBase` and `snapshot` are trimmed by the **same** terminal-turn test,
 * so changing the set of "final live turn" types updates both in lockstep.
 */
export function splitBuiltContext(built: BuiltContext): {
  frozenBase: AgentMessage[];
  finalTurn: AgentMessage | undefined;
  snapshot: ContextMessage[];
} {
  const mapped = mapBuiltMessages(built);
  const lastSource = built.messages[built.messages.length - 1];
  // The runtime prefix is append-only from the moment it is split (spec §2b), so it is
  // frozen here — its single point of construction — making the invariant observable
  // and enforced regardless of caller. The factory freezes again for the resume path
  // (where the prefix originates from a stored snapshot, not from this helper).
  if (lastSource && (lastSource.type === "triggerGroup" || lastSource.type === "satellite")) {
    return {
      frozenBase: Object.freeze(mapped.slice(0, -1)) as AgentMessage[],
      finalTurn: mapped[mapped.length - 1],
      snapshot: built.messages.slice(0, -1),
    };
  }
  return {
    frozenBase: Object.freeze(mapped) as AgentMessage[],
    finalTurn: undefined,
    snapshot: built.messages.slice(),
  };
}

/**
 * Legacy combined render: the full built context (prefix + final turn) followed by
 * filtered live messages. Retained for tests and any non-frozen call site; the
 * factory uses {@link splitBuiltContext} + an append-only `transformContext` instead.
 */
export function buildAgentContextMessages(
  built: BuiltContext,
  liveMessages: AgentMessage[] = [],
): AgentMessage[] {
  return [...mapBuiltMessages(built), ...liveMessages.filter(isLiveRuntimeMessage)];
}

function isLiveRuntimeMessage(message: AgentMessage): boolean {
  const typed = message as any;
  if (!typed || typeof typed !== "object") return false;
  if (typed.type === "interjection") return true;
  // The trigger/satellite final turn is now delivered live via agent.prompt() as the
  // first transcript turn (§2b), so it must be KEPT. Historical chat events stay in the
  // frozen prefix and are dropped if they ever appear in the live array.
  if (typed.type === "triggerGroup" || typed.type === "satellite") return true;
  if (typed.type === "chatEvent") return false;
  if (typed.role === "toolResult") return true;
  if (typed.role === "user") return true;
  if (typed.role === "assistant") {
    return Array.isArray(typed.content) && typed.content.some((block: any) => block?.type === "toolCall");
  }
  return false;
}

export function createModel(config: AppConfig): Model<"anthropic-messages"> {
  return createModelFromConfig(config.models.default);
}

export function createModelFromConfig(model: ModelConfig): Model<"anthropic-messages"> {
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
