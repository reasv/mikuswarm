/**
 * `[decisions]` configuration: per-agent merge, per-point settings, decision
 * rate-limit groups, and fail-fast cross-field validation (ARCHITECTURE.md §8h).
 */

import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve as resolvePath } from "node:path";
import type { AppConfig } from "../config/index.js";
import type { DecisionsRawConfig } from "../config/schema.js";
import { DEFAULT_MIN_STATE_TOKENS } from "./client.js";
// The scheduler's per-group default: decision models get an implicit
// `decision:<key>` group with no settings, so this is their real cap.
import { DEFAULT_MAX_IN_FLIGHT } from "../agent/scheduler.js";
import { judgedPassageCap, resolveRetrievalConfig } from "../retrieval/config.js";

type ModelConfig = AppConfig["models"]["default"];

export const DECISION_API = "system-one";
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_STATE_MAX_TOKENS = 8000;

export type DecisionPointName =
  | "routing"
  | "records"
  | "checks"
  | "audit"
  | "late_addition"
  | "implicit_reply"
  | "memory";
export const DECISION_POINT_NAMES: readonly DecisionPointName[] = [
  "routing",
  "records",
  "checks",
  "audit",
  "late_addition",
  "implicit_reply",
  "memory",
];

/**
 * Points that run by default whenever `[decisions]` is on and a chain resolves
 * (`[decisions.<point>].enabled = false` turns one off). Every other point
 * needs `enabled = true`. The memory point is the spec's default for judged
 * retrieval (ARCHITECTURE.md §9d).
 */
const DEFAULT_ON_POINTS: ReadonlySet<DecisionPointName> = new Set(["memory"]);

/** True when a point is switched on in an effective decisions table. */
export function pointSwitchedOn(decisions: DecisionsRawConfig, point: DecisionPointName): boolean {
  const enabled = decisions[point]?.enabled;
  return DEFAULT_ON_POINTS.has(point) ? enabled !== false : enabled === true;
}

// Vision decision chain defaults (DECISION-MODEL §3.5).
export const DEFAULT_VISION_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_IMAGES = 4;
export const DEFAULT_IMAGE_MAX_PIXELS = 1_000_000;
export const DEFAULT_MAX_IMAGE_BYTES = 200_000;

/** When an evaluation of a point goes to the vision chain (DECISION-MODEL §3.5). */
export type VisionMode = "off" | "uncaptioned" | "always";

/**
 * Per-point default `vision` mode, used when `[decisions.<point>].vision` is
 * unset and a vision chain is configured. `late_addition` is `always`: its
 * media candidates have no caption yet by construction (spec LATE-INPUT §5.2).
 * Only a point that declares subject images (`DecisionPoint.images`) ever uses
 * the vision chain, whatever its mode.
 */
export const DEFAULT_VISION_MODES: Record<DecisionPointName, VisionMode> = {
  routing: "uncaptioned",
  records: "off",
  checks: "off",
  audit: "off",
  late_addition: "always",
  implicit_reply: "off",
  memory: "off",
};

// `[decisions.checks]` defaults (spec REFUSAL-HANDLING §6.3, §6.4, §16.2).
export const DEFAULT_CHECKS_SEND_DEADLINE_MS = 5000;
export const DEFAULT_CHECKS_ENDING_DEADLINE_MS = 15_000;
export const DEFAULT_CHECKS_BACKGROUND_DEADLINE_MS = 30_000;
export const DEFAULT_CHECKS_STYLE_MIN_CHARS = 40;
export const DEFAULT_CHECKS_REVISE_MAX_CONSECUTIVE = 2;
export const DEFAULT_CHECKS_REVISE_MAX_PER_SESSION = 6;
export const DEFAULT_CHECKS_RECENT_MESSAGES = 6;
export const DEFAULT_CHECKS_THINKING_TAIL_TOKENS = 800;

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
  /**
   * Records point only: resolved `inject_threshold` (config `[decisions.records].inject_threshold`).
   * Other points leave this undefined.
   */
  injectThreshold?: number;
  /**
   * `late_addition` / `implicit_reply`: the resolved `threshold` (defaults
   * 0.7 / 0.8). Other points leave this undefined.
   */
  threshold?: number;
  /** Per-member threshold overrides (`[decisions.calibration.<member>]`). */
  calibration: Record<string, Record<string, number>>;
  persona: string;
  /**
   * The vision decision chain of this point (DECISION-MODEL §3.5), or
   * undefined when the point never uses one: no `vision_model` configured
   * (`[decisions.<point>].vision_model` → `[decisions].vision_model`), or the
   * point's mode is `off`.
   */
  vision?: PointVisionSettings;
}

/** Resolved vision settings of one point (DECISION-MODEL §3.5). */
export interface PointVisionSettings {
  /** The vision chain head (`[models.*]` key, a system-one model with image input). */
  model: string;
  mode: Exclude<VisionMode, "off">;
  /** Hard timeout of a vision evaluation (whole chain). */
  timeoutMs: number;
  /** Most images per evaluation (further capped by a member's `decision.max_images`). */
  maxImages: number;
  /** Images are downscaled to at most this many pixels. */
  imageMaxPixels: number;
  /** ... and re-encoded as JPEG under this many bytes (min with a member's `decision.max_image_bytes`). */
  maxImageBytes: number;
}

/**
 * Settings of `point` for an effective decisions table, or undefined when the
 * point does not run (master switch off, point off, or no model).
 */
export function pointSettings(decisions: DecisionsRawConfig, point: DecisionPointName): PointSettings | undefined {
  if (decisions.enabled !== true) return undefined;
  if (!pointSwitchedOn(decisions, point)) return undefined;
  const raw = decisions[point] ?? {};
  const model = raw.model ?? decisions.model;
  if (!model) return undefined;
  const base: PointSettings = {
    point,
    model,
    timeoutMs: raw.timeout_ms ?? decisions.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    stateMaxTokens: raw.state_max_tokens ?? decisions.state_max_tokens ?? DEFAULT_STATE_MAX_TOKENS,
    minStateTokens: raw.min_state_tokens ?? DEFAULT_MIN_STATE_TOKENS,
    minConfidence: raw.min_confidence ?? decisions.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
    calibration: decisions.calibration ?? {},
    persona: decisions.persona ?? "",
  };
  if (point === "records") {
    // `inject_threshold` is records-specific; surface it for the point's resolve().
    const recordsRaw = raw as { inject_threshold?: number };
    if (recordsRaw.inject_threshold !== undefined) {
      base.injectThreshold = recordsRaw.inject_threshold;
    }
  }
  if (point === "memory") {
    base.threshold = (raw as { relevance_threshold?: number }).relevance_threshold ?? DEFAULT_MEMORY_RELEVANCE_THRESHOLD;
  }
  if (point === "late_addition" || point === "implicit_reply") {
    const thresholdRaw = (raw as { threshold?: number }).threshold;
    base.threshold =
      thresholdRaw ?? (point === "late_addition" ? DEFAULT_LATE_ADDITION_THRESHOLD : DEFAULT_IMPLICIT_REPLY_THRESHOLD);
  }
  const visionModel = raw.vision_model ?? decisions.vision_model;
  const mode = raw.vision ?? DEFAULT_VISION_MODES[point];
  if (visionModel && mode !== "off") {
    base.vision = {
      model: visionModel,
      mode,
      timeoutMs: decisions.vision_timeout_ms ?? DEFAULT_VISION_TIMEOUT_MS,
      maxImages: decisions.max_images ?? DEFAULT_MAX_IMAGES,
      imageMaxPixels: decisions.image_max_pixels ?? DEFAULT_IMAGE_MAX_PIXELS,
      maxImageBytes: decisions.max_image_bytes ?? DEFAULT_MAX_IMAGE_BYTES,
    };
  }
  return base;
}

// `[decisions.memory]` defaults (ARCHITECTURE.md §9d "Judged retrieval").
export const DEFAULT_MEMORY_RELEVANCE_THRESHOLD = 0.7;
export const DEFAULT_MEMORY_CONVERSATION_MESSAGES = 8;

/** The `[decisions.memory]` point-specific knobs, defaults applied. */
export interface MemoryPointKnobs {
  relevanceThreshold: number;
  conversationMessages: number;
}

export function memoryPointKnobs(decisions: DecisionsRawConfig): MemoryPointKnobs {
  const raw = decisions.memory ?? {};
  return {
    relevanceThreshold: raw.relevance_threshold ?? DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
    conversationMessages: raw.conversation_messages ?? DEFAULT_MEMORY_CONVERSATION_MESSAGES,
  };
}

// `[decisions.late_addition]` defaults (spec LATE-INPUT §5.2, §8, §11).
export const DEFAULT_LATE_ADDITION_THRESHOLD = 0.7;
export const DEFAULT_LATE_ADDITION_CANDIDATE_WINDOW_MS = 60_000;
export const DEFAULT_LATE_ADDITION_MAX_JUDGED = 8;
export const DEFAULT_LATE_ADDITION_MAX_FOLDED = 3;
export const DEFAULT_LATE_ADDITION_RECENT_MESSAGES = 5;

/** The `[decisions.late_addition]` point-specific knobs, defaults applied. */
export interface LateAdditionKnobs {
  threshold: number;
  candidateWindowMs: number;
  maxJudged: number;
  maxFolded: number;
  recentMessages: number;
}

/**
 * The late-addition knobs for an effective decisions table. Independent of
 * whether the point is enabled: the window and the limits bound eligibility
 * and folding with or without a judgement (spec LATE-INPUT §5.2).
 */
export function lateAdditionKnobs(decisions: DecisionsRawConfig): LateAdditionKnobs {
  const raw = decisions.late_addition ?? {};
  return {
    threshold: raw.threshold ?? DEFAULT_LATE_ADDITION_THRESHOLD,
    candidateWindowMs: raw.candidate_window_ms ?? DEFAULT_LATE_ADDITION_CANDIDATE_WINDOW_MS,
    maxJudged: raw.max_judged ?? DEFAULT_LATE_ADDITION_MAX_JUDGED,
    maxFolded: raw.max_folded ?? DEFAULT_LATE_ADDITION_MAX_FOLDED,
    recentMessages: raw.recent_messages ?? DEFAULT_LATE_ADDITION_RECENT_MESSAGES,
  };
}

// `[decisions.implicit_reply]` defaults (spec LATE-INPUT §6, §8).
export const DEFAULT_IMPLICIT_REPLY_THRESHOLD = 0.8;
export const DEFAULT_IMPLICIT_REPLY_MAX_MESSAGES_AFTER = 3;
export const DEFAULT_IMPLICIT_REPLY_MAX_AGE_MS = 120_000;
export const DEFAULT_IMPLICIT_REPLY_RECENT_MESSAGES = 6;

/** The `[decisions.implicit_reply]` point-specific knobs, defaults applied. */
export interface ImplicitReplyKnobs {
  threshold: number;
  maxMessagesAfter: number;
  maxAgeMs: number;
  recentMessages: number;
}

/** The implicit-reply knobs for an effective decisions table (enabled or not). */
export function implicitReplyKnobs(decisions: DecisionsRawConfig): ImplicitReplyKnobs {
  const raw = decisions.implicit_reply ?? {};
  return {
    threshold: raw.threshold ?? DEFAULT_IMPLICIT_REPLY_THRESHOLD,
    maxMessagesAfter: raw.max_messages_after ?? DEFAULT_IMPLICIT_REPLY_MAX_MESSAGES_AFTER,
    maxAgeMs: raw.max_age_ms ?? DEFAULT_IMPLICIT_REPLY_MAX_AGE_MS,
    recentMessages: raw.recent_messages ?? DEFAULT_IMPLICIT_REPLY_RECENT_MESSAGES,
  };
}

/** The `[decisions.checks]` point-specific knobs, defaults applied. */
export interface ChecksPointKnobs {
  sendDeadlineMs: number;
  endingDeadlineMs: number;
  backgroundDeadlineMs: number;
  styleMinChars: number;
  reviseMaxConsecutive: number;
  reviseMaxPerSession: number;
  recentMessages: number;
  thinkingTailTokens: number;
}

/**
 * The gate's knobs for an effective decisions table (spec REFUSAL-HANDLING §6).
 * Independent of whether the point is enabled: the revise bounds and the style
 * length floor also apply to pattern-only checks, which need no decision model.
 */
export function checksPointKnobs(decisions: DecisionsRawConfig): ChecksPointKnobs {
  const raw = decisions.checks ?? {};
  return {
    sendDeadlineMs: raw.send_deadline_ms ?? DEFAULT_CHECKS_SEND_DEADLINE_MS,
    endingDeadlineMs: raw.ending_deadline_ms ?? DEFAULT_CHECKS_ENDING_DEADLINE_MS,
    backgroundDeadlineMs: raw.background_deadline_ms ?? DEFAULT_CHECKS_BACKGROUND_DEADLINE_MS,
    styleMinChars: raw.style_min_chars ?? DEFAULT_CHECKS_STYLE_MIN_CHARS,
    reviseMaxConsecutive: raw.revise_max_consecutive ?? DEFAULT_CHECKS_REVISE_MAX_CONSECUTIVE,
    reviseMaxPerSession: raw.revise_max_per_session ?? DEFAULT_CHECKS_REVISE_MAX_PER_SESSION,
    recentMessages: raw.recent_messages ?? DEFAULT_CHECKS_RECENT_MESSAGES,
    thinkingTailTokens: raw.thinking_tail_tokens ?? DEFAULT_CHECKS_THINKING_TAIL_TOKENS,
  };
}

// `[decisions.checks.duplicate]` defaults (DECISION-MODEL §5.4).
export const DEFAULT_DUPLICATE_MAX_EARLIER = 5;
export const DEFAULT_DUPLICATE_EARLIER_MAX_TOKENS = 1500;

/** The duplicate-send check's knobs, defaults applied. */
export interface DuplicateKnobs {
  /**
   * Head of the chain the duplicate questions run on: `[decisions.checks.duplicate].model`,
   * else `[decisions].model`, else the checks point's own `model`.
   */
  model?: string;
  maxEarlier: number;
  earlierMaxTokens: number;
}

/** The duplicate check's knobs for an effective decisions table (enabled or not). */
export function duplicateKnobs(decisions: DecisionsRawConfig): DuplicateKnobs {
  const raw = decisions.checks?.duplicate ?? {};
  const model = raw.model ?? decisions.model ?? decisions.checks?.model;
  return {
    ...(model ? { model } : {}),
    maxEarlier: raw.max_earlier ?? DEFAULT_DUPLICATE_MAX_EARLIER,
    earlierMaxTokens: raw.earlier_max_tokens ?? DEFAULT_DUPLICATE_EARLIER_MAX_TOKENS,
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

/**
 * One trigger can send up to `candidates + 1` records requests (the reply
 * target plus `candidates` bot-message sessions) and one routing request, all
 * at once (spec SESSION-RECORDS §6.2 "Capacity"). Sum that demand per
 * rate-limit group of the chain heads and warn where a group's effective
 * `max_in_flight` is below it.
 */
function warnRecordsCapacity(
  config: AppConfig,
  decisions: DecisionsRawConfig,
  where: string,
  opts: DecisionValidationOptions,
): void {
  const demand = new Map<string, number>();
  const add = (head: string | undefined, requests: number) => {
    if (!head || !config.models[head]) return;
    const group = config.models[head]!.rate_limit_group ?? `decision:${head}`;
    demand.set(group, (demand.get(group) ?? 0) + requests);
  };
  const candidates = decisions.records?.candidates ?? 3;
  add(decisions.records?.model ?? decisions.model, candidates + 1);
  if (decisions.routing?.enabled === true) add(decisions.routing.model ?? decisions.model, 1);
  for (const [group, needed] of demand) {
    const maxInFlight = config.rate_limits?.llm?.[group]?.max_in_flight ?? DEFAULT_MAX_IN_FLIGHT;
    if (maxInFlight >= needed) continue;
    opts.warn?.("decisions_records_capacity_low", {
      where,
      group,
      maxInFlight,
      needed,
      hint: `raise [rate_limits.llm.${group}].max_in_flight to at least ${needed}`,
    });
  }
}

/**
 * One auto-retrieval build sends up to `judgedPassageCap` memory requests at
 * once, one per passage (ARCHITECTURE.md §9d), alongside routing. Warn when the
 * memory chain head's group cannot carry them in parallel: the excess waits
 * for a slot inside the point's timeout and may fall back.
 */
function warnMemoryCapacity(
  config: AppConfig,
  decisions: DecisionsRawConfig,
  where: string,
  opts: DecisionValidationOptions,
): void {
  const settings = pointSettings(decisions, "memory");
  if (!settings || !config.models[settings.model]) return;
  let needed: number;
  try {
    needed = judgedPassageCap(resolveRetrievalConfig(config.retrieval));
  } catch {
    return;
  }
  const group = config.models[settings.model]!.rate_limit_group ?? `decision:${settings.model}`;
  const maxInFlight = config.rate_limits?.llm?.[group]?.max_in_flight ?? DEFAULT_MAX_IN_FLIGHT;
  if (maxInFlight >= needed) return;
  opts.warn?.("decisions_memory_capacity_low", {
    where,
    group,
    maxInFlight,
    needed,
    hint: `raise [rate_limits.llm.${group}].max_in_flight to at least ${needed} so a build's passages are judged in parallel`,
  });
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

/**
 * A vision chain head: a system-one model whose every chain member declares
 * `"image"` in `input_modalities` (a text-only member given image parts answers
 * anyway, silently and wrongly, DECISION-MODEL §2).
 */
function requireVisionChain(
  config: AppConfig,
  decisionKeys: Set<string>,
  key: string | undefined,
  path: string,
): void {
  if (key === undefined) return;
  requireDecisionModel(config, decisionKeys, key, path);
  for (const member of [key, ...(config.models[key]!.fallback ?? [])]) {
    const model = config.models[member];
    if (!model) continue;
    if (!model.input_modalities.includes("image")) {
      throw new Error(
        `${path} = "${key}": vision chain member "${member}" does not declare "image" in input_modalities`,
      );
    }
  }
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
  requireDecisionModel(config, decisionKeys, decisions.checks?.duplicate?.model, `${where}.checks.duplicate.model`);
  addChain(decisions.checks?.duplicate?.model);
  // Vision chains (DECISION-MODEL §3.5): system-one, and every member reads images.
  requireVisionChain(config, decisionKeys, decisions.vision_model, `${where}.vision_model`);
  addChain(decisions.vision_model);
  for (const point of DECISION_POINT_NAMES) {
    requireVisionChain(config, decisionKeys, decisions[point]?.vision_model, `${where}.${point}.vision_model`);
    addChain(decisions[point]?.vision_model);
    const mode = decisions[point]?.vision;
    if (mode !== undefined && mode !== "off" && !(decisions[point]?.vision_model ?? decisions.vision_model)) {
      opts.warn?.("decisions_vision_without_chain", { where, point, vision: mode });
    }
  }
  for (const member of Object.keys(decisions.calibration ?? {})) {
    if (!decisionKeys.has(member)) {
      throw new Error(`${where}.calibration.${member} does not name a system-one decision model`);
    }
    if (!chainMembers.has(member)) {
      opts.warn?.("decisions_calibration_unused", { where, member });
    }
  }

  // Records point: validate ranges and emit a capacity warning when a decision
  // chain's rate-limit group is too narrow for the parallel load of one trigger.
  const records = decisions.records;
  if (records?.min_confidence !== undefined) {
    // The records point asks one `noul` question, whose answer is a probability
    // with no separate confidence: `inject_threshold` already gates it, so a
    // confidence floor would be a second knob for the same number.
    throw new Error(
      `${where}.records.min_confidence is not used by the records point; set ${where}.records.inject_threshold instead`,
    );
  }
  if (decisions.checks?.min_confidence !== undefined) {
    // Check questions are `noul` questions with a per-question threshold
    // ([checks.<code>.questions].threshold); there is no confidence floor.
    throw new Error(
      `${where}.checks.min_confidence is not used by the checks point; set each question's threshold under [checks.<code>] instead`,
    );
  }
  if (decisions.memory?.min_confidence !== undefined) {
    throw new Error(
      `${where}.memory.min_confidence is not used by the memory point; set ${where}.memory.relevance_threshold instead`,
    );
  }
  for (const point of ["late_addition", "implicit_reply"] as const) {
    if (decisions[point]?.min_confidence !== undefined) {
      // One `noul` question gated by `threshold`; a confidence floor would be a
      // second knob for the same number.
      throw new Error(
        `${where}.${point}.min_confidence is not used by the ${point} point; set ${where}.${point}.threshold instead`,
      );
    }
  }
  if (records?.enabled === true) {
    const inject = records.inject_threshold ?? 0.6;
    if (inject < 0 || inject > 1) {
      throw new Error(`${where}.records.inject_threshold must be in 0..1`);
    }
    warnRecordsCapacity(config, decisions, where, opts);
  }

  warnMemoryCapacity(config, decisions, where, opts);

  const routing = decisions.routing;
  if (!routing) return;
  const chatModel = (key: string, path: string) => {
    if (!config.models[key]) throw new Error(`${path} = "${key}" does not name a [models.*] block`);
    if (decisionKeys.has(key)) throw new Error(`${path} = "${key}" is a decision model; routing needs a chat model`);
  };
  for (const [task, def] of Object.entries(routing.tasks ?? {})) {
    if (task === "other") throw new Error(`${where}.routing.tasks.other: "other" is the implicit no-match category`);
    if (task === "proactive") {
      throw new Error(`${where}.routing.tasks.proactive: "proactive" is the built-in task of proactive sessions`);
    }
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
