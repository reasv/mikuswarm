import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateObjectTokens } from "../context/tokens.js";
import { externalizeImages } from "./session-capture.js";
import { convertToLlm } from "./convert.js";

/**
 * Flat per-image charge for the §5.3 running-input estimate: an upper-bound on
 * what providers actually bill per image block (Anthropic tiling tops out ≈1600
 * tokens; OpenAI high-detail ≈1100). Deliberately conservative — the counter is
 * a pre-flight bound, and the per-commit reconciliation against actuals erases
 * any residual error.
 *
 * Also used by the tool-result budget layer to flat-charge image blocks against
 * the Layer-2 turn accumulator (spec TOOL-RESULT-BUDGET §2).
 */
export const PER_IMAGE_TOKEN_ESTIMATE = 1600;

/** Count the {@link externalizeImages} refs in an already-externalized tree. */
function countImageRefs(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countImageRefs(v);
    return n;
  }
  const obj = value as Record<string, unknown>;
  let n = obj.__imageRef === true ? 1 : 0;
  for (const v of Object.values(obj)) n += countImageRefs(v);
  return n;
}

/**
 * Tokenize a live-message slice for the §5.3 running-input counter, charging
 * image blocks at a flat {@link PER_IMAGE_TOKEN_ESTIMATE} instead of their
 * serialized base64. Tokenizing the raw JSON counted every base64 character
 * (~1 token per 3 chars — ~100k phantom tokens for a single 200KB screenshot,
 * vs the ≤~2k a provider actually bills), so one image-bearing tool result
 * (browser screenshots, read_image, image_gen, …) blew the counter past every
 * model's operative window and the §4.2 fits check terminated healthy rollouts
 * ("no healthy model fits the accumulated context") at a real context far below
 * the ceiling. `externalizeImages` (the session-capture externalizer) already
 * replaces every base64 payload shape with a small ref marker; we tokenize the
 * externalized tree and add the flat charge per ref.
 */
export function estimateLiveSliceTokens(slice: AgentMessage[]): number {
  const externalized = externalizeImages(convertToLlm(slice));
  return estimateObjectTokens(externalized) + PER_IMAGE_TOKEN_ESTIMATE * countImageRefs(externalized);
}
