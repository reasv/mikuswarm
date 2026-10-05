/**
 * `[[refusal_fallback]]` rules (spec REFUSAL-HANDLING §8.1): normalization,
 * first-match selection, and fail-fast startup validation.
 */
import type { AppConfig } from "../config/index.js";
import { catalogueReasons } from "../checks/catalogue.js";
import { BUILTIN_REFUSAL_REASONS, INTERNAL_SITES, type CheckCatalogue, type RefusalRule } from "../checks/types.js";
import { isDecisionModel } from "../decisions/config.js";

/** The rules in authored order (precedence: first match wins). */
export function normalizeRefusalRules(config: Pick<AppConfig, "refusal_fallback">): RefusalRule[] {
  return (config.refusal_fallback ?? []).map((raw, index) => {
    const rule: RefusalRule = {
      name: raw.name,
      models: [...raw.models],
      soft: raw.soft ?? "redo",
      onExhausted: raw.on_exhausted ?? "send_last",
      index,
    };
    if (raw.sites) rule.sites = [...raw.sites];
    if (raw.reasons) rule.reasons = [...raw.reasons];
    if (raw.from_models) rule.fromModels = [...raw.from_models];
    if (raw.agents) rule.agents = [...raw.agents];
    // An empty task list is no condition.
    if (raw.tasks && raw.tasks.length > 0) rule.tasks = [...raw.tasks];
    return rule;
  });
}

/** The session a refusal happened in: what a rule's scope conditions test. */
export interface RefusalRuleScope {
  /** Session type name, or an internal site. */
  site: string;
  agent?: string | null;
  /** The session's task keys; null/undefined = taskless. */
  tasks?: readonly string[] | null;
}

export interface RefusalRuleMatchInput extends RefusalRuleScope {
  /** Logical id of the member that refused. */
  fromModel?: string;
  reason: string;
  kind: "hard" | "soft";
}

function scopeMatches(rule: RefusalRule, scope: RefusalRuleScope): boolean {
  if (rule.sites && !rule.sites.includes(scope.site)) return false;
  if (rule.agents && (!scope.agent || !rule.agents.includes(scope.agent))) return false;
  // A rule with tasks never matches a taskless session.
  if (rule.tasks && !(scope.tasks ?? null)?.some((t) => rule.tasks!.includes(t))) return false;
  return true;
}

/**
 * The first rule matching a refusal, or undefined. Omitted conditions match
 * anything; a soft (judged) refusal only matches rules with `soft = "redo"`; a
 * rule with `from_models` needs the refusing model to be known and listed.
 */
export function matchRefusalRule(rules: readonly RefusalRule[], input: RefusalRuleMatchInput): RefusalRule | undefined {
  return rules.find((rule) => {
    if (input.kind === "soft" && rule.soft !== "redo") return false;
    if (!scopeMatches(rule, input)) return false;
    if (rule.reasons && !rule.reasons.includes(input.reason)) return false;
    if (rule.fromModels && (!input.fromModel || !rule.fromModels.includes(input.fromModel))) return false;
    return true;
  });
}

/**
 * The rules that can apply to a session at all (site, agent and tasks match),
 * whatever the reason and refusing model: the set whose models need model
 * prompts resolved, and whose soft = "redo" members decide whether a send is
 * worth holding (spec §6.3, §8.3).
 */
export function refusalRulesForSession(rules: readonly RefusalRule[], scope: RefusalRuleScope): RefusalRule[] {
  return rules.filter((rule) => scopeMatches(rule, scope));
}

/**
 * Fail-fast validation of `[[refusal_fallback]]` (project convention: in app
 * wiring, beside the other cross-field checks). Throws on the first problem.
 */
export function validateRefusalRules(config: AppConfig, catalogue: CheckCatalogue): void {
  const rules = config.refusal_fallback ?? [];
  if (rules.length === 0) return;
  const agentNames = Object.keys(config.agents ?? {});
  const reasons = new Set<string>([...BUILTIN_REFUSAL_REASONS, ...catalogueReasons(catalogue, agentNames)]);
  const proactiveType = config.proactive?.session_type ?? "proactive";
  const sites = new Set<string>([
    "default",
    proactiveType,
    ...Object.keys(config.agent?.session_types ?? {}),
    ...INTERNAL_SITES,
  ]);
  const names = new Set<string>();
  rules.forEach((rule, i) => {
    const where = `refusal_fallback[${i}]${rule.name ? ` ("${rule.name}")` : ""}`;
    if (!rule.name?.trim()) throw new Error(`${where}: name is required`);
    if (names.has(rule.name)) throw new Error(`${where}: duplicate rule name "${rule.name}"`);
    names.add(rule.name);
    if (!rule.models || rule.models.length === 0) throw new Error(`${where}: models must list at least one model`);
    for (const key of rule.models) {
      const model = config.models[key];
      if (!model) throw new Error(`${where}.models: "${key}" does not name a [models.*] block`);
      if (isDecisionModel(model)) {
        throw new Error(`${where}.models: "${key}" is a system-one decision model; a rule needs chat models`);
      }
    }
    for (const field of ["sites", "reasons", "from_models", "agents"] as const) {
      if (rule[field] !== undefined && rule[field]!.length === 0) {
        throw new Error(`${where}.${field}: must not be empty (omit it to match any)`);
      }
    }
    if (rule.tasks && rule.tasks.length > 0) {
      throw new Error(
        `${where}.tasks: the tasks condition is not available yet (it arrives with multi-label tasks, phase 4 of refusal handling); remove it`,
      );
    }
    for (const key of rule.from_models ?? []) {
      if (!config.models[key]) throw new Error(`${where}.from_models: "${key}" does not name a [models.*] block`);
    }
    for (const agent of rule.agents ?? []) {
      if (!agentNames.includes(agent)) {
        throw new Error(
          agentNames.length === 0
            ? `${where}.agents: "${agent}" names no agent (no [agents] table is configured)`
            : `${where}.agents: "${agent}" names no agent (known: ${agentNames.join(", ")})`,
        );
      }
    }
    for (const site of rule.sites ?? []) {
      if (!sites.has(site)) {
        throw new Error(`${where}.sites: unknown site "${site}" (known: ${[...sites].join(", ")})`);
      }
    }
    for (const reason of rule.reasons ?? []) {
      if (!reasons.has(reason)) {
        throw new Error(
          `${where}.reasons: unknown reason "${reason}" (known: ${[...reasons].join(", ")}; operator reasons come from [checks.<code>].reason)`,
        );
      }
    }
  });
}
