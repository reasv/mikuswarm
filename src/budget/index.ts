// Period cost limits / BudgetEngine (spec USAGE-COST-LIMITS §6). See ARCHITECTURE.md §8e.
export {
  BudgetEngine,
  makeRateLimitedClaimGate,
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
