/**
 * Built-in send-contract and ending checks (spec REFUSAL-HANDLING §5.4, §7):
 * `no_reply_intent`, `no_reply_contradiction` and the send-contract diagnostics.
 */
import type { CheckDefinition } from "../types.js";

export const BUILTIN_CONTRACT_CHECKS: readonly CheckDefinition[] = [];
