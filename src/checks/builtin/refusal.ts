/**
 * Built-in refusal checks (spec REFUSAL-HANDLING §4.3, §5.1, §5.3): one per
 * built-in reason, carrying the provider refusal signals the supported APIs
 * document. Questions are filled by the judged-check phase.
 */
import type { CheckDefinition, Checkpoint } from "../types.js";

const ANTHROPIC = "anthropic-messages";
const ALL_CHECKPOINTS: Checkpoint[] = ["send", "ending", "artifact", "rollout"];

function refusalCheck(
  code: string,
  reason: string,
  description: string,
  apiSignals: CheckDefinition["apiSignals"] = [],
): CheckDefinition {
  return {
    code,
    kind: "refusal",
    enabled: true,
    remedy: "redo",
    reason,
    description,
    checkpoints: [...ALL_CHECKPOINTS],
    apiSignals,
    patterns: [],
    words: [],
    questions: [],
    builtin: true,
  };
}

export const BUILTIN_REFUSAL_CHECKS: readonly CheckDefinition[] = [
  refusalCheck(
    "refusal_distillation",
    "distillation",
    "Declined because the request looks like extracting the model's reasoning",
    [{ api: ANTHROPIC, stopReason: "refusal", category: "reasoning_extraction" }],
  ),
  refusalCheck("refusal_safety", "safety", "Declined on safety or harm-policy grounds, or stopped by a content filter", [
    { api: ANTHROPIC, stopReason: "refusal", category: "cyber" },
    { api: ANTHROPIC, stopReason: "refusal", category: "bio" },
    // Stop reasons that are unique to one API need no api restriction.
    { stopReason: "sensitive" }, // Anthropic safety-filter stop
    { stopReason: "content_filter" }, // OpenAI chat completions and compatible gateways
    { stopReason: "incomplete.content_filter" }, // OpenAI Responses
    { stopReason: "content_filtered" }, // Bedrock Converse
    { stopReason: "guardrail_intervened" }, // Bedrock Converse
    { stopReason: "SAFETY" }, // Google
    { stopReason: "PROHIBITED_CONTENT" }, // Google
    { stopReason: "BLOCKLIST" }, // Google
  ]),
  refusalCheck("refusal_privacy", "privacy", "Declined over personal or private information", [
    { stopReason: "SPII" }, // Google
  ]),
  refusalCheck("refusal_copyright", "copyright", "Declined over copyright or reproducing protected material"),
  refusalCheck("refusal_persona", "persona", "Declined to play the persona or role it was given"),
  refusalCheck("refusal_capability", "capability", "Declined as unable to do it (\"I can't do that\")"),
  // Lowest precedence (src/refusals/signals.ts): a `refusal` stop with no category,
  // or one no other check maps. The raw category is still recorded.
  refusalCheck("refusal_uncategorized", "unclear", "A refusal with no category, or one no other check maps", [
    { stopReason: "refusal" },
  ]),
];
