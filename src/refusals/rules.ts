/**
 * `[[refusal_fallback]]` rules (spec REFUSAL-HANDLING §8.1): normalization,
 * first-match selection, and fail-fast startup validation.
 */
import type { AppConfig } from "../config/index.js";
import { catalogueReasons } from "../checks/catalogue.js";
import {
  BUILTIN_REFUSAL_REASONS,
  INTERNAL_SITES,
  MAX_RULE_ENTRY_TRIES,
  SAME_MODEL_KEY,
  type CheckCatalogue,
  type RefusalRule,
  type RefusalRuleEntry,
} from "../checks/types.js";
import { decisionsFor, isDecisionModel } from "../decisions/config.js";
import { RESERVED_ROUTING_TASKS } from "../decisions/points/routing.js";

/** The rules in authored order (precedence: first match wins). */
export function normalizeRefusalRules(config: Pick<AppConfig, "refusal_fallback">): RefusalRule[] {
  return (config.refusal_fallback ?? []).map((raw, index) => {
    const rule: RefusalRule = {
      name: raw.name,
      models: raw.models.map(normalizeRuleEntry),
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

/** A raw `models` entry (key or `{ model, tries }`) as a {@link RefusalRuleEntry}; tries default 1. */
export function normalizeRuleEntry(raw: string | { model: string; tries?: number }): RefusalRuleEntry {
  return typeof raw === "string" ? { model: raw, tries: 1 } : { model: raw.model, tries: raw.tries ?? 1 };
}

/** The `[models.*]` keys a rule names (`@same` excluded, each once). */
export function ruleModelKeys(rule: Pick<RefusalRule, "models">): string[] {
  return [...new Set(rule.models.map((entry) => entry.model).filter((model) => model !== SAME_MODEL_KEY))];
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
  if (config.models[SAME_MODEL_KEY]) {
    throw new Error(`models.${SAME_MODEL_KEY}: "${SAME_MODEL_KEY}" is reserved (a refusal rule's "the model that refused"); rename the model`);
  }
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
    for (const [j, raw] of rule.models.entries()) {
      const { model: key, tries } = normalizeRuleEntry(raw);
      if (!Number.isInteger(tries) || tries < 1 || tries > MAX_RULE_ENTRY_TRIES) {
        throw new Error(`${where}.models[${j}]: tries must be an integer from 1 to ${MAX_RULE_ENTRY_TRIES} (got ${tries})`);
      }
      if (key === SAME_MODEL_KEY) continue;
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
    if (rule.tasks && rule.tasks.length > 0) validateRuleTasks(config, rule.tasks, rule.agents, agentNames, where);
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

/**
 * A rule's `tasks` (spec §8.1): every key must be a routing task of each agent
 * the rule applies to (its `agents`, else every agent; the global
 * `[decisions.routing]` in legacy mode), or a reserved key (`other`, the
 * built-in `proactive`). Agents may replace their task list.
 */
function validateRuleTasks(
  config: AppConfig,
  tasks: readonly string[],
  ruleAgents: readonly string[] | undefined,
  agentNames: readonly string[],
  where: string,
): void {
  const agents: Array<string | null> = ruleAgents ? [...ruleAgents] : agentNames.length > 0 ? [...agentNames] : [null];
  for (const agent of agents) {
    const known = new Set<string>([
      ...Object.keys(decisionsFor(config, agent).routing?.tasks ?? {}),
      ...RESERVED_ROUTING_TASKS,
    ]);
    for (const task of tasks) {
      if (known.has(task)) continue;
      const owner = agent ? `agent "${agent}"'s routing tasks` : "[decisions.routing.tasks]";
      throw new Error(`${where}.tasks: "${task}" is not one of ${owner} (known: ${[...known].join(", ")})`);
    }
  }
}

/**
 * One refusal point's walk through a rule's entries (spec §8.1 "Tries and
 * same-model retries"): each entry is tried `tries` times before the next one
 * applies; `@same` resolves to the model that refused when the walk started; an
 * entry that fails the caller's gates is skipped whole. A walk lasts for one
 * refusal point (the span since the last delivered message); the next point
 * starts a new walk from the first entry.
 */
export class RefusalRuleWalk {
  private index = 0;
  private used = 0;
  /** The model of the last try handed out. */
  last: string | undefined;

  constructor(
    readonly rule: RefusalRule,
    /** What `@same` means for this walk: the model that refused first. */
    readonly same: string,
  ) {}

  /** The next try's model, or undefined when every entry (every try) is spent. */
  next(usable: (model: string) => boolean, onSkip?: (model: string) => void): string | undefined {
    while (this.index < this.rule.models.length) {
      const entry = this.rule.models[this.index]!;
      if (this.used >= entry.tries) {
        this.index += 1;
        this.used = 0;
        continue;
      }
      const model = entry.model === SAME_MODEL_KEY ? this.same : entry.model;
      if (!usable(model)) {
        onSkip?.(model);
        this.index += 1;
        this.used = 0;
        continue;
      }
      this.used += 1;
      this.last = model;
      return model;
    }
    return undefined;
  }
}

/** The rule with its `from_models` dropped: does it still admit this refusal? (Walk continuation.) */
export function ruleAdmitsIgnoringFromModels(
  rule: RefusalRule,
  input: Omit<RefusalRuleMatchInput, "fromModel">,
): boolean {
  const { fromModels: _fromModels, ...rest } = rule;
  return matchRefusalRule([rest], input) !== undefined;
}
