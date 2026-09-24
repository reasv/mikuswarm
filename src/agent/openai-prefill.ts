/**
 * OpenAI Responses API prefill support.
 *
 * When a model has [models.<name>.prefill] enabled = true, every tool's JSON
 * schema is transformed to require an `analysis` string argument (first
 * property) whose value must match the configured prefix pattern. The wire
 * format uses strict JSON schema mode (strict = true) and tool_choice =
 * "required", so the model is forced to call a tool on every turn and to
 * start its arguments with the analysis prefix. The catalog no_reply tool
 * allows the model to signal silence without sending a message.
 *
 * Design rationale: the analysis argument form (vs a grammar wrapper) keeps
 * everything native -- native function calling, pi's parsing and validation,
 * native tool_search deferred loading, Bedrock cache breakpoints, fallback,
 * budgets. The analysis argument survives in stored transcripts as the
 * model's own past function-call arguments, which is the most in-distribution
 * replay form.
 *
 * This transform is applied per serving fallback member (not per chain head)
 * via the onPayload hook. The prefill option on a model descriptor is carried
 * in compat.prefillText: non-null means enabled, null means disabled.
 *
 * See spec/OPENAI-PREFILL.md and ARCHITECTURE.md section "Model-scoped OpenAI
 * prefill" for the full contract.
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

// Augment pi-ai's OpenAIResponsesCompat so createModelFromConfig can carry the
// prefill text on the wire Model descriptor. The onPayload injector reads it
// from the `model` arg to gate per serving member, not per chain head.
declare module "@earendil-works/pi-ai" {
  interface OpenAIResponsesCompat {
    /**
     * When non-null, this member has prefill enabled and the injector
     * applies the strict + analysis transform to all tools. The value
     * is the raw prefix text (not escaped).
     */
    prefillText?: string | null;
    /**
     * When true, strip native thinking blocks from outgoing assistant history.
     */
    dropReasoning?: boolean;
  }
}

/**
 * Escape a string for use as a literal in a JSON Schema `pattern`.
 * Escapes all characters with special meaning in ECMAScript regex.
 */
export function escapeForPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Build the `pattern` value for the analysis field: anchored to start,
 * then the escaped literal text, then [\s\S]* to allow any characters
 * including newlines.
 */
export function buildAnalysisPattern(text: string): string {
  return `^${escapeForPattern(text)}[\\s\\S]*`;
}

/**
 * Recursively transform a JSON schema to be strict-compatible:
 * - All optional properties become nullable (type union with null) and
 *   are added to required[]
 * - additionalProperties: false on every object
 * - Unsupported keywords removed: default, format, minimum, maximum,
 *   minLength, maxLength, minItems, maxItems, examples
 * - $defs, $ref, anyOf, enum, const preserved
 */
export function strictify(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(strictify);
  const s = { ...(schema as Record<string, unknown>) };
  for (const k of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(s[k])) s[k] = (s[k] as unknown[]).map(strictify);
  }
  if (s["items"]) s["items"] = strictify(s["items"]);
  if (s["$defs"]) {
    s["$defs"] = Object.fromEntries(
      Object.entries(s["$defs"] as Record<string, unknown>).map(([k, v]) => [k, strictify(v)])
    );
  }
  if (s["type"] === "object" || s["properties"]) {
    const props: Record<string, unknown> = {};
    const req = new Set<string>(Array.isArray(s["required"]) ? s["required"] as string[] : []);
    for (const [k, v] of Object.entries(s["properties"] as Record<string, unknown> ?? {})) {
      let p = strictify(v) as Record<string, unknown>;
      if (!req.has(k)) {
        if (p["type"] && !Array.isArray(p["type"])) {
          p = { ...p, type: [p["type"], "null"] };
        } else if (p["anyOf"]) {
          p = { anyOf: [...(p["anyOf"] as unknown[]), { type: "null" }] };
        } else {
          p = { anyOf: [p, { type: "null" }] };
        }
        req.add(k);
      }
      props[k] = p;
    }
    s["properties"] = props;
    s["required"] = [...req];
    s["additionalProperties"] = false;
  }
  for (const k of ["default", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "examples"]) {
    delete s[k];
  }
  return s;
}

/**
 * Transform a wire tool definition to add the analysis argument (first
 * property), strict = true, and the pattern constraint.
 * Does not mutate the input.
 */
function applyAnalysisToWireTool(tool: Record<string, unknown>, pattern: string): Record<string, unknown> {
  const params = strictify(
    (tool["parameters"] as Record<string, unknown>) ?? { type: "object", properties: {} }
  ) as Record<string, unknown>;
  // The canonical schema may already carry the optional `analysis` that
  // wrapToolWithAnalysisStripping adds (strictify has just made it nullable).
  // Drop that copy: the wire property must be the required, non-null,
  // pattern-constrained one, and it must come first.
  const { analysis: _canonical, ...props } = (params["properties"] as Record<string, unknown>) ?? {};
  const req = (params["required"] as string[]) ?? [];
  return {
    ...tool,
    strict: true,
    parameters: {
      ...params,
      properties: {
        analysis: { type: "string", pattern },
        ...props,
      },
      required: ["analysis", ...req.filter((r: string) => r !== "analysis")],
    },
  };
}

/**
 * Apply the prefill wire transform to an OpenAI Responses API params object.
 * - Transforms all tools in params.tools
 * - Transforms deferred tool definitions inside tool_search_output items in params.input
 * - Sets tool_choice = "required"
 * Returns a new object; does not mutate the input.
 */
export function applyPrefillToParams(params: Record<string, unknown>, prefillText: string): Record<string, unknown> {
  const pattern = buildAnalysisPattern(prefillText);
  const result = { ...params };

  // Transform params.tools
  if (Array.isArray(result["tools"])) {
    result["tools"] = (result["tools"] as unknown[]).map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const t = tool as Record<string, unknown>;
      if (t["type"] !== "function") return tool;
      return applyAnalysisToWireTool(t, pattern);
    });
  }

  // Transform deferred tool definitions in tool_search_output items
  if (Array.isArray(result["input"])) {
    result["input"] = (result["input"] as unknown[]).map((item) => {
      if (!item || typeof item !== "object") return item;
      const it = item as Record<string, unknown>;
      if (it["type"] !== "tool_search_output") return item;
      if (!Array.isArray(it["tools"])) return item;
      return {
        ...it,
        tools: (it["tools"] as unknown[]).map((tool) => {
          if (!tool || typeof tool !== "object") return tool;
          const t = tool as Record<string, unknown>;
          if (t["type"] !== "function") return tool;
          return applyAnalysisToWireTool(t, pattern);
        }),
      };
    });
  }

  result["tool_choice"] = "required";
  return result;
}

/**
 * Build the onPayload injector for the prefill transform. Gates on
 * model.compat.prefillText being non-null (set per serving member by
 * createModelFromConfig). Composes with the breakpoints injector by
 * running AFTER it (called with the already-breakpointed payload).
 */
export function makePrefillInjector(): (payload: unknown, model: unknown) => unknown {
  return (payload: unknown, model: unknown): unknown => {
    const compat = (model as Record<string, unknown> | undefined)?.["compat"] as
      | Record<string, unknown>
      | undefined;
    const prefillText = compat?.["prefillText"];
    if (!prefillText || typeof prefillText !== "string") return payload;
    if (!payload || typeof payload !== "object") return payload;
    return applyPrefillToParams(payload as Record<string, unknown>, prefillText);
  };
}

/**
 * Wrap a tool's execute function to strip the `analysis` argument before
 * calling the original execute. This allows `analysis` to be in the
 * canonical schema (so transcripts keep it) while the real tool never
 * receives it.
 */
export function wrapToolWithAnalysisStripping(tool: AgentTool): AgentTool {
  const originalExecute = tool.execute as (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ) => Promise<AgentToolResult<unknown>>;
  if (!originalExecute) return tool;
  return {
    ...tool,
    parameters: addOptionalAnalysisToSchema(tool.parameters),
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>) => {
      const { analysis: _dropped, ...rest } = params as Record<string, unknown>;
      return originalExecute(toolCallId, rest, signal, onUpdate);
    },
  } as unknown as AgentTool;
}

/**
 * Add an optional `analysis` string property to a tool's parameter schema.
 * Used so the canonical schema accepts `analysis` in arguments (validation
 * passes, transcript keeps it) without requiring it.
 */
function addOptionalAnalysisToSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (s["type"] !== "object" && !s["properties"]) return schema;
  const props = (s["properties"] as Record<string, unknown>) ?? {};
  if ("analysis" in props) return schema; // already present
  const req = Array.isArray(s["required"]) ? s["required"] as string[] : [];
  return {
    ...s,
    properties: {
      ...props,
      // Optional string — mark with Optional wrapper so pi's validator treats it as not required.
      analysis: { type: "string" },
    },
    required: req, // analysis is optional, do not add to required
  };
}

/**
 * Drop reasoning (thinking) blocks from a message's content array.
 * Creates a new array; does NOT mutate the original.
 * Used for drop_reasoning wire-side removal.
 */
export function dropReasoningBlocks(content: unknown[]): unknown[] {
  return content.filter((block) => {
    if (!block || typeof block !== "object") return true;
    const b = block as Record<string, unknown>;
    return b["type"] !== "thinking" && b["type"] !== "redacted_thinking";
  });
}

/**
 * Apply drop_reasoning to a Responses API params object:
 * removes thinking/redacted_thinking blocks from assistant input items.
 */
export function applyDropReasoningToParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(params["input"])) return params;
  return {
    ...params,
    input: (params["input"] as unknown[]).map((item) => {
      if (!item || typeof item !== "object") return item;
      const it = item as Record<string, unknown>;
      if (it["role"] !== "assistant") return item;
      if (!Array.isArray(it["content"])) return item;
      const filtered = dropReasoningBlocks(it["content"] as unknown[]);
      if (filtered.length === (it["content"] as unknown[]).length) return item;
      return { ...it, content: filtered };
    }),
  };
}

/**
 * Build the onPayload injector for drop_reasoning.
 */
export function makeDropReasoningInjector(): (payload: unknown, model: unknown) => unknown {
  return (payload: unknown, model: unknown): unknown => {
    const compat = (model as Record<string, unknown> | undefined)?.["compat"] as
      | Record<string, unknown>
      | undefined;
    if (!compat?.["dropReasoning"]) return payload;
    if (!payload || typeof payload !== "object") return payload;
    return applyDropReasoningToParams(payload as Record<string, unknown>);
  };
}
