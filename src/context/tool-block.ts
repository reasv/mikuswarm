import { estimateTokens } from "./tokens.js";

/**
 * The tool-definition block sent on the wire alongside the messages.
 *
 * Every LLM request carries, out-of-band from the message list, the full set of
 * tool definitions — each tool's name, description, and JSON-schema parameters.
 * For a real session that block is ~10–14k tokens (measured: ~13.5k for the full
 * 39-tool set under the GLM tokenizer), and it is the single largest contributor
 * to the gap between {@link BuiltContext.tokenEstimate} and the provider's actual
 * `input_tokens` — because the message-sum estimate historically ignored it.
 *
 * This module renders that block into the SAME shape the system prompt uses for
 * the console inspector: a whole-block estimate plus a per-tool breakdown. The
 * tool block is NOT a message — it is never placed in `messages[]` and never sent
 * to the model as content (the provider attaches it as the request's `tools`
 * field). It is a display + accounting artifact only.
 */

/** Structural subset of an `AgentTool` — what actually hits the wire. */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  /** TypeBox/JSON schema; serialized verbatim into the wire `tools[]` entry. */
  parameters: unknown;
}

/** One tool's token contribution within the block. */
export interface ToolSegment {
  name: string;
  /** Token estimate of the tool's wire entry (primary tokenizer). */
  tokenEstimate: number;
}

export interface ToolBlockSummary {
  /**
   * Estimate of the WHOLE serialized `tools[]` array — the number to add to the
   * request's input-token estimate. Cross-checked against real provider
   * `input_tokens` to within ~0.4% (see test/measure-context-overhead.ts).
   * Per-tool {@link segments} do not sum exactly to this (array punctuation +
   * BPE boundary effects), mirroring the system-prompt segment behaviour.
   */
  tokenEstimate: number;
  /** Per-tool contribution, in declaration order. */
  segments: ToolSegment[];
  /** Pretty-printed wire JSON of the tool definitions, for the inspector body. */
  text: string;
}

/**
 * OpenAI-completions wire form of one tool (the serialization pi-ai emits for the
 * configured GLM endpoint). The Anthropic dialect differs cosmetically
 * (`input_schema` vs `function.parameters`) but tokenizes within a handful of
 * tokens — this single form is the estimate basis for every dialect.
 */
function toWire(t: ToolDefinitionLike): unknown {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/**
 * Render the tool-definition block: whole-block estimate, per-tool breakdown, and
 * the serialized text. Returns `undefined`-friendly empties for an empty tool set
 * so callers can fold it in unconditionally.
 */
export function renderToolBlock(tools: ToolDefinitionLike[]): ToolBlockSummary {
  const wire = tools.map(toWire);
  const segments: ToolSegment[] = tools.map((t, i) => ({
    name: t.name,
    tokenEstimate: estimateTokens(JSON.stringify(wire[i])),
  }));
  return {
    tokenEstimate: tools.length > 0 ? estimateTokens(JSON.stringify(wire)) : 0,
    segments,
    text: tools.length > 0 ? JSON.stringify(wire, null, 2) : "",
  };
}
