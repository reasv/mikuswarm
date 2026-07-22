// Period cost limits / BudgetEngine (spec USAGE-COST-LIMITS §6). See ARCHITECTURE.md §8e.
export {
  BudgetEngine,
  makeRateLimitedClaimGate,
  makeChainClaimGate,
  makeAgentLoopChainClaimGate,
  type AdmissionResult,
  type BlockingRule,
  type BudgetHooks,
  type CheckResult,
  type LimitRule,
  type RuleSelector,
  type RuleStatus,
  type SpendDescriptor,
} from "./engine.js";
export { normalizeLimits, type NormalizeResult, type RawLimitRule } from "./normalize.js";
export { collectZeroCostModelIds, collectKnownModelIds } from "./zero-cost.js";
export { isValidTimeZone, parseDuration, resolveWindow, type WindowSpec } from "./window.js";
// Per-user cost limits & model selection (spec PER-USER-LIMITS). See ARCHITECTURE.md §8g.
export {
  UserLimitEngine,
  compileGlob,
  homeserverOf,
  renderPartition,
  type UserLimitContext,
  type UserLimitResolution,
  type ResolvedConstraint,
  type NormalizedUserLimitRule,
  type NormalizedConstraint,
  type AffordabilityEstimate,
  type AffordabilityResult,
  type ModelCostRates,
  type UserLimitStatus,
  type UserLimitSelection,
  type UserLimitEngineOptions,
} from "./user-limits.js";
export {
  normalizeUserLimits,
  type NormalizeUserLimitsResult,
  type RawUserLimitRule,
} from "./normalize-user-limits.js";
