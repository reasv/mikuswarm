import { randomBytes } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api } from "@earendil-works/pi-ai";
import type { Logger } from "../observability/logger.js";
import type { DynamicToolRegistry } from "./dynamic-tools.js";

/**
 * Harness-made message marker (CONTRACT decision 5).
 *
 * Carried on every assistant and toolResult message the harness synthesises,
 * and on the harness's own user turns (record turn, forced-completion nudges).
 * pi-agent-core ignores unknown top-level fields; the marker persists through
 * transcript serialisation and is available to the console and W6.
 */
export type HarnessMarker =
  | { kind: "injection"; decisionGroup?: string } // synthetic call/result at session start
  | { kind: "record_turn" }                       // the record-turn user prompt
  | { kind: "record_load" }                       // synthetic load of session_record_tool
  // A forced-completion corrective user turn (spec REFUSAL-HANDLING §7.1):
  // `attempt` = the nudge number n (the ending that follows is attempt n),
  // `variant` = which corrective prompt was sent.
  | { kind: "forced_completion"; attempt: number; variant: "not_sent" | "sent_not_final" };

/**
 * Specification for one synthetic tool call.
 *
 * `name` and `params` drive the execution.  `harness` is stamped onto both the
 * assistant message and the toolResult message the execution produces.
 */
export interface SyntheticCallSpec {
  name: string;
  params: Record<string, unknown>;
  harness: HarnessMarker;
}

/** A matched pair produced by one synthetic execution. */
export interface SyntheticCallPair {
  assistantMessage: AgentMessage;
  toolResultMessage: AgentMessage;
}

/** Wire model descriptor fields needed to build a synthetic assistant message. */
export interface SyntheticModelInfo {
  /** Wire API identifier (e.g. "anthropic-messages"). */
  api: Api | string;
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Wire model id string. */
  model: string;
}

/** Zero-cost Usage value for synthetic turns (no real request was made). */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function makeToolCallId(): string {
  return `synth_${randomBytes(8).toString("hex")}`;
}

/**
 * Build one synthetic assistant+toolResult pair from a caller-supplied result,
 * without executing any tool.
 *
 * W6 uses this to inject the record-turn load of `session_record_tool`: the
 * caller supplies the result content and `addedToolNames`, and this helper
 * builds the transcript-compatible message pair.  The registry is loaded
 * in-place when `addedToolNames` is set (keeping the loaded set consistent).
 */
export function buildSyntheticCallFromResult(
  spec: SyntheticCallSpec,
  result: {
    content: { type: "text"; text: string }[];
    addedToolNames?: string[];
    isError?: boolean;
  },
  modelInfo: SyntheticModelInfo,
  registry?: DynamicToolRegistry,
): SyntheticCallPair {
  const id = makeToolCallId();
  const now = Date.now();

  if (result.addedToolNames?.length && registry) {
    registry.load(result.addedToolNames);
  }

  const assistantMessage: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id, name: spec.name, arguments: spec.params }],
    api: modelInfo.api as Api,
    provider: modelInfo.provider,
    model: modelInfo.model,
    usage: { ...ZERO_USAGE },
    stopReason: "toolUse",
    timestamp: now,
    harness: spec.harness,
  } as AgentMessage;

  const toolResultMessage: AgentMessage = {
    role: "toolResult",
    toolCallId: id,
    toolName: spec.name,
    content: result.content,
    details: {},
    isError: result.isError ?? false,
    timestamp: now,
    harness: spec.harness,
    ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
  } as AgentMessage;

  return { assistantMessage, toolResultMessage };
}

/**
 * Execute a batch of synthetic tool calls in order, using the session's real
 * tool objects.  Each call produces an assistant `toolUse` message followed by
 * its `toolResult` message, shaped exactly as pi-agent-core's loop would shape
 * them.
 *
 * Side-effects:
 * - Tools whose results carry `addedToolNames` are loaded into `registry`
 *   (identical to a model-initiated `load_skill` call).
 * - `registry.onChange` fires normally for each load, so `agent.state.tools`
 *   and the token counter are updated before the first real LLM request.
 *
 * A tool execution error yields an `isError: true` toolResult (never a throw)
 * so one failing spec cannot abort the whole session.
 */
export async function executeSyntheticCalls(
  specs: SyntheticCallSpec[],
  tools: readonly AgentTool[],
  modelInfo: SyntheticModelInfo,
  options: {
    registry?: DynamicToolRegistry;
    logger?: Logger;
    sessionId?: string;
  } = {},
): Promise<AgentMessage[]> {
  if (specs.length === 0) return [];

  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages: AgentMessage[] = [];

  for (const spec of specs) {
    const id = makeToolCallId();
    const now = Date.now();

    const assistantMessage: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id, name: spec.name, arguments: spec.params }],
      api: modelInfo.api as Api,
      provider: modelInfo.provider,
      model: modelInfo.model,
      usage: { ...ZERO_USAGE },
      stopReason: "toolUse",
      timestamp: now,
      harness: spec.harness,
    } as AgentMessage;

    const tool = byName.get(spec.name);
    let resultContent: { type: "text"; text: string }[];
    let addedToolNames: string[] | undefined;
    let isError = false;
    let resultDetails: unknown = null;

    if (!tool) {
      isError = true;
      resultContent = [{ type: "text", text: `Tool ${spec.name} not found` }];
      options.logger?.warn("synthetic_call_tool_not_found", {
        sessionId: options.sessionId,
        tool: spec.name,
      });
    } else {
      try {
        const result = await tool.execute(id, spec.params as Parameters<typeof tool.execute>[1]);
        resultContent = (result.content ?? []).filter(
          (c): c is { type: "text"; text: string } => c.type === "text",
        );
        resultDetails = result.details ?? null;
        if (result.addedToolNames?.length) {
          addedToolNames = result.addedToolNames;
          if (options.registry) {
            options.registry.load(addedToolNames);
          }
        }
      } catch (error) {
        isError = true;
        resultContent = [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ];
        options.logger?.warn("synthetic_call_tool_error", {
          sessionId: options.sessionId,
          tool: spec.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const toolResultMessage: AgentMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: spec.name,
      content: resultContent,
      details: resultDetails,
      isError,
      timestamp: now,
      harness: spec.harness,
      ...(addedToolNames?.length ? { addedToolNames } : {}),
    } as AgentMessage;

    messages.push(assistantMessage, toolResultMessage);
  }

  return messages;
}
