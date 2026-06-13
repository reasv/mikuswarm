import type { CostRates } from "../agent/usage.js";

/**
 * A captioning `cost` config block (snake_case USD/1M tokens), shaped identically
 * to `ModelSchema.cost` / `CaptioningModelSchema.cost` (spec AUXILIARY-USAGE-TRACKING §7.1).
 */
export interface CaptionCostBlock {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ResolveCaptionCostArgs {
  /** The modality's own model id override, if any (`[captioning.<modality>.model].id`). */
  modalityModelId?: string;
  /** The modality's own cost block, if any (`[captioning.<modality>.model].cost`). */
  modalityCost?: CaptionCostBlock;
  /** The model id actually run for the shared/top-level caption model (`sharedModel.id`). */
  sharedModelId: string;
  /** Top-level cost block (`[captioning.model].cost`) — prices the shared model only. */
  topLevelCost?: CaptionCostBlock;
}

export interface CaptionCostResolution {
  /** Resolved rates, or `undefined` when this modality's cost is unknown/untracked. */
  rates?: CostRates;
  /**
   * True when the modality runs a *different* model than the shared one but defines
   * no cost of its own, while top-level pricing IS configured — i.e. the operator
   * opted into cost tracking but this override silently drops out of it. The caller
   * should warn so the gap is visible.
   */
  unpricedOverride: boolean;
}

function toRates(b: CaptionCostBlock): CostRates {
  return { input: b.input, output: b.output, cacheRead: b.cache_read, cacheWrite: b.cache_write };
}

/**
 * Resolve the cost rates for a captioning modality (spec AUXILIARY-USAGE-TRACKING §7.1).
 *
 * Cost is a property of a *specific model* and is **never inherited across models**:
 * the top-level `[captioning.model].cost` prices the shared caption model only, so it
 * applies to a modality only when that modality actually runs the shared model.
 *
 *   1. modality has its own `cost` block          → use it (prices the modality's model)
 *   2. modality runs the shared model (no id override, or same id) → top-level cost
 *   3. modality overrides the model to a *different* id, no cost of its own → unknown
 *      (untracked); flag `unpricedOverride` when top-level pricing exists so the caller
 *      can warn. The shared model's rates are NOT borrowed for a different model.
 */
export function resolveCaptionCost(args: ResolveCaptionCostArgs): CaptionCostResolution {
  const { modalityModelId, modalityCost, sharedModelId, topLevelCost } = args;

  // (1) A modality's own cost block always prices its own model.
  if (modalityCost) return { rates: toRates(modalityCost), unpricedOverride: false };

  // No modality cost block. Does this modality run a different model than the shared one?
  const overridesModel = modalityModelId != null && modalityModelId !== sharedModelId;
  if (overridesModel) {
    // (3) Different model, no cost of its own → unknown. Never borrow the shared
    // model's rates. Warn only when top-level pricing exists (tracking is active).
    return { rates: undefined, unpricedOverride: topLevelCost != null };
  }

  // (2) Runs the shared model → the top-level cost (if any) correctly prices it.
  return { rates: topLevelCost ? toRates(topLevelCost) : undefined, unpricedOverride: false };
}
