import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { shapeContentBlocks, TurnResultBudget } from "./tool-result-budget.js";
import { PER_IMAGE_TOKEN_ESTIMATE } from "./live-token-estimate.js";
import { estimateTokens } from "../context/tokens.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Payload delivered to `onTruncation` when a result was shaped. */
export interface TruncationInfo {
  tool: string;
  layer: "per-result" | "turn-budget";
  /** Original text-token total of the unshaped result. */
  fromTokens: number;
  /** Text tokens visible in the shaped result (marker tokens included). */
  toTokens: number;
  /** Turn-accumulated token count AFTER charging this result. */
  turnAccumulated: number;
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap each tool in `tools` with the two-layer result-shaping pass
 * (spec TOOL-RESULT-BUDGET §2–§4).
 *
 * For every settled `execute()` return value:
 *
 *  - **Layer 1 — per-result cap** (`resultMaxTokens`): if enabled (`> 0`), text
 *    is truncated to at most this many tokens regardless of remaining context.
 *    Use label `"per-result"`.
 *  - **Layer 2 — per-turn aggregate clamp** (`turnBudget`): the tighter
 *    allowance derived from `servingWindow − runningContext − reserve −
 *    accumulated`. Use label `"turn-budget"`.
 *  - The **tighter** of the two active limits fires; the marker carried in the
 *    result identifies which layer truncated. Image blocks pass through but are
 *    flat-charged against Layer 2.
 *  - **Error results are naturally exempt**: `execute()` throws on error by
 *    contract; thrown errors propagate through the wrapper without shaping.
 *  - **Concurrency**: allowance computation and accumulator consume happen
 *    synchronously after the `await tool.execute()` settle — no further `await`
 *    between them — so concurrent settlements cannot interleave within that
 *    critical section (single-threaded JS microtask guarantee).
 *
 * @param tools         Session tool set to wrap (post-`filterTools`).
 * @param opts.resultMaxTokens
 *   Layer-1 per-result token ceiling; `0` = Layer 1 disabled (Layer 2 still
 *   applies).
 * @param opts.turnBudget
 *   Layer-2 per-turn accumulator, shared by every tool in this session.
 *   Caller must call `turnBudget.reset()` at every `onRequestCommitted` seam.
 * @param opts.getRunningContext
 *   Returns the running-context estimate at settle time. Implementors should
 *   refresh their counter before returning (e.g. call `refreshRunningContext()`).
 *   Called synchronously; must not await.
 * @param opts.onTruncation
 *   Optional callback fired for each truncated result. The caller owns
 *   rate-limiting (fire this on every truncation; suppress inside the callback).
 */
export function wrapToolsWithResultBudget(
  tools: AgentTool[],
  opts: {
    resultMaxTokens: number;
    turnBudget: TurnResultBudget;
    getRunningContext: () => number;
    onTruncation?: (info: TruncationInfo) => void;
  },
): AgentTool[] {
  return tools.map((tool) => {
    // Cast to a generic execute signature — the original tool enforces its own
    // parameter schema; our wrapper is transparent for every call property.
    const originalExecute = tool.execute as (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => Promise<AgentToolResult<unknown>>;

    const wrappedExecute = async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> => {
      // If execute() throws the error propagates here unchanged.
      // No shaping occurs — error content is naturally exempt (spec §2).
      const result = await originalExecute(toolCallId, params, signal, onUpdate);

      // ---- ATOMIC SECTION ------------------------------------------------
      // No `await` between getRunningContext() and consume() so concurrent
      // settles cannot interleave within this section (JS single-threaded).

      // getRunningContext() is synchronous (caller refreshes the counter first).
      const runningCtx = opts.getRunningContext();

      // Layer 2: allowance from the per-turn accumulator.
      const layer2Allowance = opts.turnBudget.allowance(runningCtx);

      // Effective allowance: tighter of Layer-1 (when enabled) and Layer-2.
      let effectiveAllowance: number;
      let layer: "per-result" | "turn-budget";
      const layer1Cap = opts.resultMaxTokens > 0 ? opts.resultMaxTokens : null;
      if (layer1Cap === null || layer2Allowance <= layer1Cap) {
        // Layer 1 disabled, or Layer 2 is tighter (or equal).
        effectiveAllowance = layer2Allowance;
        layer = "turn-budget";
      } else {
        // Layer 1 is tighter.
        effectiveAllowance = layer1Cap;
        layer = "per-result";
      }

      // isError = false: a successfully-returned result is never an error result;
      // error results are reached via throw-propagation above, not here.
      const shaped = shapeContentBlocks(result.content, effectiveAllowance, layer, false);

      // Charge the accumulator: text tokens shown + flat image charge.
      const tokenCost = shaped.textTokensShown + shaped.imageCount * PER_IMAGE_TOKEN_ESTIMATE;
      opts.turnBudget.consume(tokenCost);

      // ---- END ATOMIC SECTION --------------------------------------------

      if (shaped.truncated && opts.onTruncation) {
        // Compute original text-token total for the log (M figure — same quantity
        // shapeContentBlocks measures internally for the marker text).
        const fromTokens = result.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .reduce((sum, b) => sum + estimateTokens(b.text), 0);
        opts.onTruncation({
          tool: tool.name,
          layer,
          fromTokens,
          toTokens: shaped.textTokensShown,
          turnAccumulated: opts.turnBudget.accumulated,
        });
      }

      return { ...result, content: shaped.content };
    };

    return { ...tool, execute: wrappedExecute } as unknown as AgentTool;
  });
}
