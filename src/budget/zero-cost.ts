// =============================================================================
// Zero-cost model collection (spec USAGE-COST-LIMITS §2.2).
//
// A model whose CONFIGURED cost rate is zero has $0 spend regardless of token
// count, so it bypasses every budget rule — it can never move a budget and is
// never blocked. The bypass keys on the configured rate (known before any call),
// so the BudgetEngine recognizes a free model by its id. This scans every config
// site that prices a model and returns the set of zero-rate model ids.
// =============================================================================

import type { AppConfig } from "../config/index.js";

/** True when a token-rate cost block is absent or every component is 0. */
function tokenRatesZero(
  cost: { input?: number; output?: number; cache_read?: number; cache_write?: number } | undefined,
): boolean {
  if (!cost) return true;
  return (
    (cost.input ?? 0) === 0 &&
    (cost.output ?? 0) === 0 &&
    (cost.cache_read ?? 0) === 0 &&
    (cost.cache_write ?? 0) === 0
  );
}

/**
 * Collect the ids of every configured model whose cost rate is zero (§2.2),
 * across the agent models, captioning, image-gen tiers, x_search, and the remote
 * embedding provider. A model present in more than one lane is zero-cost only
 * when ALL of its appearances price at zero (a paid appearance wins).
 */
export function collectZeroCostModelIds(config: AppConfig): Set<string> {
  const zero = new Set<string>();
  const paid = new Set<string>();
  const mark = (id: string | undefined, isZero: boolean): void => {
    if (!id) return;
    if (isZero) zero.add(id);
    else paid.add(id);
  };

  for (const model of Object.values(config.models ?? {})) {
    mark(model.id, tokenRatesZero(model.cost));
  }

  const cap = config.captioning;
  if (cap) {
    mark(cap.model?.id, tokenRatesZero(cap.model?.cost));
    for (const modality of [cap.image, cap.video, cap.audio]) {
      mark(modality?.model?.id, tokenRatesZero(modality?.model?.cost));
    }
  }

  const ig = config.image_gen;
  if (ig) {
    const proZero = tokenRatesZero(ig.costs?.pro) && (ig.costs?.pro?.per_image ?? 0) === 0;
    const flashZero = tokenRatesZero(ig.costs?.flash) && (ig.costs?.flash?.per_image ?? 0) === 0;
    mark(ig.models.pro, proZero);
    mark(ig.models.flash, flashZero);
  }

  const xs = config.x_search;
  if (xs) {
    const xsZero = tokenRatesZero(xs.cost);
    mark(xs.model, xsZero);
    mark(xs.deep_model, xsZero);
  }

  const remote = config.retrieval?.embedding?.remote;
  if (remote) mark(remote.id, (remote.cost_per_mtok ?? 0) === 0);

  // A paid appearance in any lane overrides a zero appearance elsewhere.
  for (const id of paid) zero.delete(id);
  return zero;
}
