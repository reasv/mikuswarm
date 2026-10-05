/**
 * The built-in check catalogue (spec REFUSAL-HANDLING §4.3). Each kind lives in
 * its own module; config overrides them field by field (src/checks/catalogue.ts).
 */
import type { CheckDefinition } from "../types.js";
import { BUILTIN_CONTRACT_CHECKS } from "./contract.js";
import { BUILTIN_REFUSAL_CHECKS } from "./refusal.js";
import { BUILTIN_STYLE_CHECKS } from "./style.js";

export { BUILTIN_CONTRACT_CHECKS, BUILTIN_REFUSAL_CHECKS, BUILTIN_STYLE_CHECKS };

export const BUILTIN_CHECKS: readonly CheckDefinition[] = [
  ...BUILTIN_REFUSAL_CHECKS,
  ...BUILTIN_STYLE_CHECKS,
  ...BUILTIN_CONTRACT_CHECKS,
];
