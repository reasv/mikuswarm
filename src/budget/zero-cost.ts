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

  // Agent models are keyed by their LOGICAL id (config block name; spec
  // MODEL-FALLBACK §2.2) — that is what the agent-loop ledger row stamps and what
  // the budget selector matches, distinct from the upstream `model.id`.
  for (const [logicalId, model] of Object.entries(config.models ?? {})) {
    // An image model can price purely per-image (zero token rates), so the flat
    // `per_image` charge counts toward "is this model free?" (spec MODEL-FALLBACK §2.3).
    const zeroCost = tokenRatesZero(model.cost) && (model.cost?.per_image ?? 0) === 0;
    mark(logicalId, zeroCost);
  }

  // captioning + image_gen + x_search reference `[models.*]` by name (spec MODEL-FALLBACK §2.3),
  // so their models — and per_image pricing on `[models.*].cost` — are already
  // covered by the agent-models loop above.

  const remote = config.retrieval?.embedding?.remote;
  if (remote) mark(remote.id, (remote.cost_per_mtok ?? 0) === 0);

  // A paid appearance in any lane overrides a zero appearance elsewhere.
  for (const id of paid) zero.delete(id);
  return zero;
}

/**
 * The union of EVERY configured model id (zero-cost ∪ paid), scanned across the
 * same config sites as {@link collectZeroCostModelIds}. Used by the `[[limits]]`
 * cross-field validation (spec §5.2 / review #11) to soft-warn on a `models`
 * selector naming an id that exists nowhere in config — a dead, never-matching
 * rule. `models` stays free-form (the warning never fails startup).
 */
export function collectKnownModelIds(config: AppConfig): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | undefined): void => {
    if (id) ids.add(id);
  };

  // Agent models contribute their LOGICAL id (config block name; spec
  // MODEL-FALLBACK §2.2) — the id a `[[limits]].models` selector matches.
  for (const logicalId of Object.keys(config.models ?? {})) add(logicalId);

  // captioning / image_gen / x_search reference `[models.*]` by name (spec
  // MODEL-FALLBACK §2.3) — already counted as known via the agent-models loop above.

  add(config.retrieval?.embedding?.remote?.id);
  return ids;
}
