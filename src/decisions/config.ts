/**
 * `[decisions]` configuration: per-agent merge, per-point settings, decision
 * rate-limit groups, and fail-fast cross-field validation (ARCHITECTURE.md §8h).
 */

import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve as resolvePath } from "node:path";
import type { AppConfig } from "../config/index.js";
import type { DecisionsRawConfig } from "../config/schema.js";
import { DEFAULT_MIN_STATE_TOKENS } from "./client.js";

type ModelConfig = AppConfig["models"]["default"];

export const DECISION_API = "system-one";
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_STATE_MAX_TOKENS = 8000;

export type DecisionPointName = "routing" | "continuation";
export const DECISION_POINT_NAMES: readonly DecisionPointName[] = ["routing", "continuation"];

export function isDecisionModel(model: ModelConfig | undefined): boolean {
  return model?.api === DECISION_API;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const childPath = path ? `${path}.${key}` : key;
    // An agent's task map replaces the global one wholesale: a category list is
    // one design, not a set of independent keys to union.
    if (childPath === "routing.tasks") {
      out[key] = value;
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value, childPath);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The effective `[decisions]` table for an agent: the agent's
 * `[agents.<name>.decisions]` deep-merged over the global block (agent wins),
 * except `routing.tasks`, which the agent replaces. `null` agent (legacy
 * single-agent mode, or an unresolvable timeline) = the global block.
 */
export function decisionsFor(config: AppConfig, agentName: string | null): DecisionsRawConfig {
  const global = (config.decisions ?? {}) as Record<string, unknown>;
  const agent = agentName ? config.agents?.[agentName]?.decisions : undefined;
  if (!agent) return global as DecisionsRawConfig;
  return deepMerge(global, agent as Record<string, unknown>, "") as DecisionsRawConfig;
}

/** Resolved settings of one enabled point. */
export interface PointSettings {
  point: DecisionPointName;
  /** The decision chain head (`[models.*]` key). */
  model: string;
  timeoutMs: number;
  stateMaxTokens: number;
  minStateTokens: number;
  minConfidence: number;
  /** Per-member threshold overrides (`[decisions.calibration.<member>]`). */
  calibration: Record<string, Record<string, number>>;
  persona: string;
}

/**
 * Settings of `point` for an effective decisions table, or undefined when the
 * point does not run (master switch off, point off, or no model).
 */
export function pointSettings(decisions: DecisionsRawConfig, point: DecisionPointName): PointSettings | undefined {
  if (decisions.enabled !== true) return undefined;
  const raw = decisions[point];
  if (!raw || raw.enabled !== true) return undefined;
  const model = raw.model ?? decisions.model;
  if (!model) return undefined;
  return {
    point,
    model,
    timeoutMs: raw.timeout_ms ?? decisions.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    stateMaxTokens: raw.state_max_tokens ?? decisions.state_max_tokens ?? DEFAULT_STATE_MAX_TOKENS,
    minStateTokens: raw.min_state_tokens ?? DEFAULT_MIN_STATE_TOKENS,
    minConfidence: raw.min_confidence ?? decisions.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
    calibration: decisions.calibration ?? {},
    persona: decisions.persona ?? "",
  };
}

/**
 * A threshold for the member that served an answer: `[decisions.calibration.<member>]`
 * `"<point>.<name>"`, then its bare `<name>`, then the point's own value.
 */
export function calibratedThreshold(
  settings: PointSettings,
  servedLogicalId: string,
  name: string,
  pointValue: number,
): number {
  const overrides = settings.calibration[servedLogicalId];
  if (!overrides) return pointValue;
  return overrides[`${settings.point}.${name}`] ?? overrides[name] ?? pointValue;
}

/**
 * Give every decision model without an explicit `rate_limit_group` its own group
 * `decision:<key>` and declare it, so a decision model's 429 pauses only itself
 * and never chat traffic or the other decision members (ARCHITECTURE.md §8h).
 * Mutates `config` in place; returns the groups it created. Run before the
 * rate-limit-group validation and before the scheduler is built.
 */
export function applyDecisionRateLimitGroups(config: AppConfig): string[] {
  const created: string[] = [];
  for (const [key, model] of Object.entries(config.models)) {
    if (!isDecisionModel(model) || model.rate_limit_group) continue;
    const group = `decision:${key}`;
    model.rate_limit_group = group;
    config.rate_limits ??= {};
    config.rate_limits.llm ??= {};
    if (!config.rate_limits.llm[group]) {
      config.rate_limits.llm[group] = {};
      created.push(group);
    }
  }
  return created;
}

/** Every `[models.*]` key a chat-side config site references, with where (for errors). */
function collectChatModelRefs(config: AppConfig, decisionKeys: Set<string>): Array<{ key: string; path: string }> {
  const refs: Array<{ key: string; path: string }> = [];
  const MODEL_FIELDS = new Set(["model", "deep_model", "image", "video", "audio", "pro", "flash"]);
  const walk = (value: unknown, path: string, field: string | undefined): void => {
    if (typeof value === "string") {
      if (field !== undefined && (MODEL_FIELDS.has(field) || field === "models" || field === "session_types") && decisionKeys.has(value)) {
        refs.push({ key: value, path });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, field));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, key === "session_types" ? "session_types" : field === "session_types" ? "session_types" : key);
    }
  };
  for (const [top, value] of Object.entries(config as Record<string, unknown>)) {
    // `[models.*]` is the registry itself (fallback chains are checked
    // separately), `[decisions]` is where decision models belong, and
    // `[[limits]].models` is a budget selector that may name any model.
    if (top === "models" || top === "decisions" || top === "limits") continue;
    if (top === "agents" && isPlainObject(value)) {
      for (const [agentName, block] of Object.entries(value)) {
        if (!isPlainObject(block)) continue;
        for (const [k, v] of Object.entries(block)) {
          if (k === "decisions") continue;
          walk(v, `agents.${agentName}.${k}`, k);
        }
      }
      continue;
    }
    walk(value, top, top);
  }
  return refs;
}

export interface DecisionValidationOptions {
  /** Workspace root for an agent (null = legacy single-agent). */
  workspaceRootFor?: (agentName: string | null) => string | undefined;
  warn?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Fail-fast cross-field validation (project convention: in app wiring, next to
 * the other cross-field checks). Throws on the first problem.
 */
export function validateDecisionsConfig(config: AppConfig, opts: DecisionValidationOptions = {}): void {
  const models = config.models;
  const decisionKeys = new Set(Object.keys(models).filter((key) => isDecisionModel(models[key])));

  for (const [key, model] of Object.entries(models)) {
    const decision = isDecisionModel(model);
    if (model.decision && !decision) {
      throw new Error(`models.${key}: a [models.${key}.decision] block requires api = "system-one"`);
    }
    for (const member of model.fallback ?? []) {
      const memberIsDecision = decisionKeys.has(member);
      if (decision && models[member] && !memberIsDecision) {
        throw new Error(
          `models.${key}: fallback member "${member}" is a chat model; a system-one chain may only contain system-one models`,
        );
      }
      if (!decision && memberIsDecision) {
        throw new Error(
          `models.${key}: fallback member "${member}" is a system-one decision model; it cannot serve a chat model`,
        );
      }
    }
  }

  for (const ref of collectChatModelRefs(config, decisionKeys)) {
    throw new Error(
      `${ref.path} = "${ref.key}" names a system-one decision model; decision models can only be used from [decisions]`,
    );
  }

  const agentNames: Array<string | null> = [null, ...Object.keys(config.agents ?? {})];
  for (const agentName of agentNames) {
    const where = agentName ? `agents.${agentName}.decisions` : "decisions";
    if (agentName && !config.agents?.[agentName]?.decisions) continue;
    const decisions = decisionsFor(config, agentName);
    validateEffective(config, decisions, decisionKeys, where, agentName, opts);
  }
}

function requireDecisionModel(
  config: AppConfig,
  decisionKeys: Set<string>,
  key: string | undefined,
  path: string,
): void {
  if (key === undefined) return;
  if (!config.models[key]) throw new Error(`${path} = "${key}" does not name a [models.*] block`);
  if (!decisionKeys.has(key)) throw new Error(`${path} = "${key}" must name a model with api = "system-one"`);
}

function validateEffective(
  config: AppConfig,
  decisions: DecisionsRawConfig,
  decisionKeys: Set<string>,
  where: string,
  agentName: string | null,
  opts: DecisionValidationOptions,
): void {
  requireDecisionModel(config, decisionKeys, decisions.model, `${where}.model`);
  if (decisions.enabled === true && !decisions.model) {
    const pointWithoutModel = DECISION_POINT_NAMES.find((p) => decisions[p]?.enabled === true && !decisions[p]?.model);
    if (pointWithoutModel) {
      throw new Error(`${where}.${pointWithoutModel} is enabled but neither it nor ${where} names a decision model`);
    }
  }
  const chainMembers = new Set<string>();
  const addChain = (head: string | undefined) => {
    if (!head || !config.models[head]) return;
    chainMembers.add(head);
    for (const member of config.models[head]!.fallback ?? []) chainMembers.add(member);
  };
  addChain(decisions.model);
  for (const point of DECISION_POINT_NAMES) {
    requireDecisionModel(config, decisionKeys, decisions[point]?.model, `${where}.${point}.model`);
    addChain(decisions[point]?.model);
  }
  for (const member of Object.keys(decisions.calibration ?? {})) {
    if (!decisionKeys.has(member)) {
      throw new Error(`${where}.calibration.${member} does not name a system-one decision model`);
    }
    if (!chainMembers.has(member)) {
      opts.warn?.("decisions_calibration_unused", { where, member });
    }
  }

  const routing = decisions.routing;
  if (!routing) return;
  const chatModel = (key: string, path: string) => {
    if (!config.models[key]) throw new Error(`${path} = "${key}" does not name a [models.*] block`);
    if (decisionKeys.has(key)) throw new Error(`${path} = "${key}" is a decision model; routing needs a chat model`);
  };
  for (const [task, def] of Object.entries(routing.tasks ?? {})) {
    if (task === "other") throw new Error(`${where}.routing.tasks.other: "other" is the implicit no-match category`);
    if (def.model !== undefined && def.models !== undefined) {
      throw new Error(`${where}.routing.tasks.${task}: set model or models, not both`);
    }
    for (const key of def.models ?? (def.model ? [def.model] : [])) chatModel(key, `${where}.routing.tasks.${task}.models`);
    if (def.tail_files?.length) {
      const root = opts.workspaceRootFor?.(agentName);
      for (const file of def.tail_files) {
        if (isAbsolute(file) || normalize(file).startsWith("..")) {
          throw new Error(`${where}.routing.tasks.${task}.tail_files: "${file}" must be workspace-relative`);
        }
        if (routing.enabled === true && root !== undefined && !existsSync(resolvePath(root, file))) {
          throw new Error(`${where}.routing.tasks.${task}.tail_files: "${file}" does not exist under the workspace`);
        }
      }
    }
  }
  const difficulty = routing.difficulty;
  if (difficulty) {
    const levels = difficulty.levels.length;
    const checkIndex = (index: string, path: string) => {
      const n = Number(index);
      if (!Number.isInteger(n) || n < 0 || n >= levels) {
        throw new Error(`${path}.${index}: level index must be an integer in 0..${levels - 1}`);
      }
    };
    for (const [index, cascade] of Object.entries(difficulty.models ?? {})) {
      checkIndex(index, `${where}.routing.difficulty.models`);
      for (const key of cascade) chatModel(key, `${where}.routing.difficulty.models.${index}`);
    }
    for (const index of Object.keys(difficulty.thinking_levels ?? {})) {
      checkIndex(index, `${where}.routing.difficulty.thinking_levels`);
    }
  }
}

/** True when some point can run for some agent (the engine is built only then). */
export function anyDecisionPointEnabled(config: AppConfig): boolean {
  const agents: Array<string | null> = [null, ...Object.keys(config.agents ?? {})];
  return agents.some((agent) =>
    DECISION_POINT_NAMES.some((point) => pointSettings(decisionsFor(config, agent), point) !== undefined),
  );
}
