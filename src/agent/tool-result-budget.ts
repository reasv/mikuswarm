import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { estimateTokens, truncateToTokens } from "../context/tokens.js";

/**
 * Tool-result context budget — per-result cap + per-turn aggregate clamp.
 * (spec TOOL-RESULT-BUDGET §2–§4)
 *
 * This module is the PURE result-shaping layer. It has no knowledge of sessions,
 * runners, or config loading. The wiring (step 2) imports from here and composes
 * the two layers inside buildSessionTools.
 *
 * Two exported surfaces:
 *   - `shapeContentBlocks` — truncates one result's content array to a token
 *     allowance, appending a layer-appropriate marker.
 *   - `TurnResultBudget` — per-session accumulator tracking turn consumption.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ContentBlock = TextContent | ImageContent;
type Layer = "per-result" | "turn-budget";

/**
 * Marker appended when Layer-1 (per-result cap) truncates a result.
 * The model sees how much survived and is told to refine the call.
 */
function makePerResultMarker(shownTokens: number, totalTokens: number): string {
  return (
    `\n[tool result truncated: showing ~${shownTokens} of ~${totalTokens} tokens (per-result cap).\n` +
    `Refine the call — narrower query, pagination, filters — to see more.]`
  );
}

/**
 * Marker appended when Layer-2 (turn-budget) truncates a result.
 * Distinct from the per-result marker so the model knows the cause.
 */
function makeTurnBudgetMarker(shownTokens: number, totalTokens: number): string {
  return (
    `\n[tool result truncated: showing ~${shownTokens} of ~${totalTokens} tokens — ` +
    `this turn's combined tool results exceeded the remaining context budget. ` +
    `Issue narrower calls, or work with what is shown.]`
  );
}

/**
 * Truncate `text` to at most `allowance` tokens at a UTF-8-safe boundary,
 * preferring the last newline within the final 5% of the budget.
 *
 * Returns only the truncated text — the caller appends the marker.
 * The 5% window is approximated as 5% × 4 chars/token of the token budget,
 * giving a generous but bounded search range without a second encode call.
 */
function truncateTextToAllowance(text: string, allowance: number): string {
  // truncateToTokens already performs a tokenizer round-trip so the result is
  // valid UTF-8 (the tokenizer encodes/decodes at real codepoint boundaries).
  let truncated = truncateToTokens(text, allowance);

  // Search for the last newline within the final 5% of the budget (as chars).
  // 5% of `allowance` tokens × 4 chars/token ≈ 20% of allowance chars from the end.
  const charWindow = Math.max(1, Math.floor(allowance * 0.2));
  const searchFrom = Math.max(0, truncated.length - charWindow);
  const nlIdx = truncated.lastIndexOf("\n", truncated.length - 1);
  if (nlIdx >= searchFrom) {
    truncated = truncated.slice(0, nlIdx + 1);
  }
  return truncated;
}

// ---------------------------------------------------------------------------
// Public shaping API
// ---------------------------------------------------------------------------

/**
 * Result of shaping one tool result's content blocks.
 *
 * The caller (wiring code in step 2) uses `textTokensShown` and `imageCount`
 * to charge the turn accumulator:
 *   `turnBudget.consume(textTokensShown + imageCount * PER_IMAGE_TOKEN_ESTIMATE)`
 *
 * `PER_IMAGE_TOKEN_ESTIMATE` is exported from `./live-token-estimate.ts`.
 */
export interface ShapedContent {
  /** The (possibly truncated) content blocks, ready to return as the tool result. */
  content: ContentBlock[];
  /**
   * Text tokens actually visible in the shaped result. Use this (plus the
   * per-image flat charge) when calling `TurnResultBudget.consume()`.
   */
  textTokensShown: number;
  /**
   * Number of image blocks in the result. Each charges `PER_IMAGE_TOKEN_ESTIMATE`
   * against the Layer-2 turn accumulator. Image blocks always pass through
   * untouched (slicing base64 corrupts them); their cost is flat-charged here.
   */
  imageCount: number;
  /** Whether any text content was truncated. */
  truncated: boolean;
}

/**
 * Shape a tool result's content blocks against a token allowance.
 *
 * ### Layer rules
 * - `isError = true` or `allowance <= 0`: exempt — content passes through
 *   unchanged. Error text is small and losing its tail is worse than its cost
 *   (spec §2). `allowance <= 0` is used by the wiring when Layer 1 is disabled
 *   (`result_max_tokens = 0`) or when the allowance was already honoured by the
 *   other layer.
 * - Text blocks are shaped across blocks in order: blocks that fit whole are
 *   kept; the first overflowing block is sliced at a UTF-8-safe newline-
 *   preferring boundary; later text blocks are dropped and counted into the
 *   marker's M.
 * - Image blocks always pass through untouched.
 *
 * ### Marker
 * A truncated result always carries a `[tool result truncated: showing ~N of
 * ~M tokens ...]` marker appended to the last visible text block (or added as
 * a new text block if no text survived). The marker text differs per layer to
 * help the model understand the cause.
 */
export function shapeContentBlocks(
  content: ContentBlock[],
  allowance: number,
  layer: Layer,
  isError: boolean,
): ShapedContent {
  // Count images first — they are always reported, even on the exempt paths.
  let imageCount = 0;
  for (const b of content) {
    if (b.type === "image") imageCount++;
  }

  // Exempt paths: pass through, but still measure text for accounting.
  if (isError || allowance <= 0) {
    let textTok = 0;
    for (const b of content) {
      if (b.type === "text") textTok += estimateTokens(b.text);
    }
    return { content, textTokensShown: textTok, imageCount, truncated: false };
  }

  // Measure total text tokens across ALL blocks for the M figure in the marker.
  let totalTextTokens = 0;
  for (const b of content) {
    if (b.type === "text") totalTextTokens += estimateTokens(b.text);
  }

  // Fast path: all text fits within the allowance.
  if (totalTextTokens <= allowance) {
    return { content, textTokensShown: totalTextTokens, imageCount, truncated: false };
  }

  // Shape: keep fitting text blocks, slice the first overflow, drop the rest.
  const makeMarker = layer === "per-result" ? makePerResultMarker : makeTurnBudgetMarker;
  const out: ContentBlock[] = [];
  let remaining = allowance;
  let textShown = 0;
  let didSlice = false;

  for (const block of content) {
    if (block.type === "image") {
      out.push(block); // images always pass through
      continue;
    }
    if (didSlice) {
      // Already past the overflow point — drop this text block (still counted in M).
      continue;
    }
    const blockTokens = estimateTokens(block.text);
    if (blockTokens <= remaining) {
      out.push(block);
      remaining -= blockTokens;
      textShown += blockTokens;
    } else {
      // First overflowing block: slice it and append the marker.
      const sliced = truncateTextToAllowance(block.text, remaining);
      const slicedTokens = estimateTokens(sliced);
      const marker = makeMarker(slicedTokens, totalTextTokens);
      out.push({ type: "text", text: sliced + marker });
      textShown += slicedTokens;
      didSlice = true;
    }
  }

  // Safety: if no text block survived (only images in content and all text
  // was... wait, that can't happen since totalTextTokens > 0 and we sliced
  // at least one block). But defend against edge case of `remaining = 0`
  // making the first block have 0 tokens sliced — in that case add a marker-
  // only text block so the model always gets the truncation notice.
  // Use a boolean to avoid TypeScript flow-narrowing out[] to ImageContent[].
  const hasTextBlock = out.some((b) => b.type === "text");
  if (didSlice && !hasTextBlock) {
    out.push({ type: "text", text: makeMarker(0, totalTextTokens) });
  }

  return { content: out, textTokensShown: textShown, imageCount, truncated: didSlice };
}

// ---------------------------------------------------------------------------
// Turn accumulator
// ---------------------------------------------------------------------------

/**
 * Per-turn context budget accumulator (spec TOOL-RESULT-BUDGET §4).
 *
 * One instance per session, constructed once at wiring time (inside
 * `buildSessionTools`, step 2). The three knobs come from `config.agent.tools`.
 *
 * ### Usage lifecycle (step 2 wiring)
 * ```
 * // at wiring time:
 * const turnBudget = new TurnResultBudget(servingWindow, reserveTokens, minTokens);
 *
 * // in each tool's wrapped execute(), after the result settles:
 * const shaped = shapeContentBlocks(result.content, turnBudget.allowance(runningContext()), "turn-budget", isError);
 * const tokenCost = shaped.textTokensShown + shaped.imageCount * PER_IMAGE_TOKEN_ESTIMATE;
 * turnBudget.consume(tokenCost);
 *
 * // in onRequestCommitted (the Layer-0 commit seam):
 * turnBudget.reset();
 * ```
 *
 * ### Settlement order
 * Parallel results consume the turn budget in the order they settle. The first
 * to settle gets the largest allowance; a late result in an over-budget batch
 * gets at most `result_min_tokens`. This is intentional (owner decision — spec
 * §4): fair-share splitting would require holding all results and adds latency.
 * `result_min_tokens` guarantees every result keeps a useful head.
 */
export class TurnResultBudget {
  private accumulated = 0;

  constructor(
    /**
     * The session's serving window — the largest operative context window across
     * all selectable models. With PER-MEMBER-CONTEXT-FITS, this is the max member
     * window; until that lands, the composite `operativeContextWindow`.
     */
    readonly servingWindow: number,
    /**
     * Headroom the clamp must not consume: the next request's output (max_tokens)
     * plus room for subsequent turns. A single knob rather than a derivation; the
     * default (32768) covers the shipped 16384 max_tokens twice.
     */
    readonly reserveTokens: number,
    /**
     * Minimum allowance any single result keeps regardless of the accumulator.
     * Ensures every result in an over-budget parallel batch still carries a useful
     * head. The floor may overshoot the budget by at most
     * `(N−1) × result_min_tokens`; the §8b enforcement backstop absorbs it.
     */
    readonly minTokens: number,
  ) {}

  /**
   * Compute the allowance for the NEXT result given the current running-context
   * estimate.
   *
   * `allowance = max(servingWindow − runningContext − reserveTokens − accumulated, minTokens)`
   *
   * When the budget is exhausted (accumulated ≥ budget), returns `minTokens` so
   * every result still keeps a useful head.
   */
  allowance(runningContext: number): number {
    const budget = this.servingWindow - runningContext - this.reserveTokens;
    return Math.max(budget - this.accumulated, this.minTokens);
  }

  /**
   * Record that `tokens` have been appended to the turn's tool results.
   * Call once per settled result: `textTokensShown + imageCount × PER_IMAGE_TOKEN_ESTIMATE`.
   */
  consume(tokens: number): void {
    this.accumulated += tokens;
  }

  /**
   * Reset the accumulator at the LLM-request-committed seam (`onRequestCommitted`).
   * Each committed request starts a fresh turn; tool results appended to it
   * start counting from zero again.
   */
  reset(): void {
    this.accumulated = 0;
  }
}
