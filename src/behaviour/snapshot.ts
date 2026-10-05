/**
 * Resolved behaviour snapshot (spec REFUSAL-HANDLING §12.4 source 1).
 *
 * Built once at boot from the effective config (after file merge, `${VAR}`
 * templating and `[agents.<name>.…]` overrides), restricted to what shapes model
 * behaviour, and never containing credentials or endpoints: every field is copied
 * from an allow-list. The structure is resolved per agent and site, so a moved
 * file, a renamed variable or a reordered table produces the same snapshot, and a
 * one-line change in a shared block shows up under every agent and site it reaches.
 */

import { createHash } from "node:crypto";
import type { AppConfig } from "../config/index.js";
import { buildAgentModelOverrides } from "../agent/agent-model-overrides.js";
import type { CheckCatalogue, CheckDefinition } from "../checks/types.js";
import {
  checksPointKnobs,
  DECISION_POINT_NAMES,
  decisionsFor,
  type DecisionPointName,
} from "../decisions/config.js";
import { normalizeRefusalRules } from "../refusals/rules.js";

/** Bumped when the snapshot's structure changes; a version change suppresses diff events. */
export const BEHAVIOUR_SNAPSHOT_VERSION = 1;

/** Agent key of legacy single-agent mode (no `[agents]` table). */
export const LEGACY_AGENT_KEY = "";

export interface CodeVersion {
  /** package.json version. */
  version: string;
  /** Build revision baked into the image (`MIKUSWARM_BUILD_REVISION`), the git HEAD in development, else "unknown". */
  revision: string;
}

export interface ModelBehaviour {
  /** Upstream wire id. */
  id: string;
  provider: string;
  api: string;
  family: string | null;
  /** The model's own `thinking_level` (default "off"). */
  thinking: string;
  thinkingMap: Record<string, string | null> | null;
  /** Fallback chain members after the model itself. */
  fallback: string[];
}

export interface SiteBehaviour {
  head: string;
  fallbacks: string[];
  /** Thinking level the head requests (its `thinking_level`, default "off"). */
  thinking: string;
}

export interface PreferenceListBehaviour {
  /** Position of the `[[user_limits]]` rule. */
  rule: number;
  /** The rule's match dimensions, rendered (`user=…;room=…;space=…`), "*" when none. */
  match: string;
  models: string[];
}

export interface TaskBehaviour {
  models: string[];
  thinking: string | null;
  skills: string[];
  tailFiles: string[];
}

export interface CheckBehaviour {
  kind: string;
  remedy: string;
  reason: string | null;
  checkpoints: string[];
  /** Per-question thresholds, in question order. */
  thresholds: number[];
  minChars: number | null;
  /** Short hash of the detection metadata (API signals, patterns, words, question texts). */
  detection: string;
}

export interface DecisionPointBehaviour {
  enabled: boolean;
  /** The decision chain (head first); empty when the point has no model. */
  chain: string[];
}

export interface AgentBehaviour {
  sites: Record<string, SiteBehaviour>;
  preferences: PreferenceListBehaviour[];
  tasks: Record<string, TaskBehaviour>;
  /** Enabled checks only. */
  checks: Record<string, CheckBehaviour>;
  decisions: { enabled: boolean; points: Record<string, DecisionPointBehaviour> };
  checksKnobs: { styleMinChars: number; reviseMaxConsecutive: number; reviseMaxPerSession: number };
  contract: { forcedCompletionRetries: number; forcedCompletionRedo: boolean };
}

/** One rule entry: a model key (or `@same`, the refusing model) and its tries. */
export interface RuleEntryBehaviour {
  model: string;
  tries: number;
}

export interface RuleBehaviour {
  index: number;
  sites: string[] | null;
  reasons: string[] | null;
  fromModels: string[] | null;
  agents: string[] | null;
  tasks: string[] | null;
  models: RuleEntryBehaviour[];
  soft: string;
  onExhausted: string;
}

export interface BehaviourSnapshot {
  version: number;
  code: CodeVersion;
  /** Every model the agents, rules, tasks and preference lists reference (with their chains). */
  models: Record<string, ModelBehaviour>;
  /** Keyed by agent name; legacy single-agent mode uses {@link LEGACY_AGENT_KEY}. */
  agents: Record<string, AgentBehaviour>;
  /** `[[refusal_fallback]]` rules by name. */
  rules: Record<string, RuleBehaviour>;
}

const sortKeys = <T>(rec: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v as Record<string, unknown>) : v,
  );
}

export function snapshotHash(snapshot: BehaviourSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex").slice(0, 16);
}

/** `version+revision`, the form the `code_changed` sentence shows. */
export function codeVersionString(code: CodeVersion): string {
  return `${code.version}+${code.revision}`;
}

function detectionHash(check: CheckDefinition): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        apiSignals: check.apiSignals,
        patterns: check.patterns.map((p) => `${p.source}/${p.flags}`),
        words: check.words,
        questions: check.questions.map((q) => ({ source: q.source, instructions: q.instructions, criteria: q.criteria })),
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

/** Account key → agent name, over every chat provider's accounts. */
function accountAgents(config: AppConfig): Map<string, string> {
  const out = new Map<string, string>();
  const providers = [config.matrix?.accounts, config.discord?.accounts, config.irc?.accounts] as Array<
    Record<string, { agent?: string }> | undefined
  >;
  for (const accounts of providers) {
    for (const [key, account] of Object.entries(accounts ?? {})) out.set(key, account.agent ?? key);
  }
  return out;
}

function renderMatch(rule: { user?: string | string[]; room?: string | string[]; space?: string | string[] }): string {
  const parts: string[] = [];
  for (const dim of ["user", "room", "space"] as const) {
    const v = rule[dim];
    if (v === undefined) continue;
    parts.push(`${dim}=${Array.isArray(v) ? v.join(",") : v}`);
  }
  return parts.length > 0 ? parts.join(";") : "*";
}

/**
 * Session sites of an agent: `default`, the proactive session type, every declared
 * `[agent.session_types]` key and the worker session types.
 */
export function snapshotSites(config: AppConfig): string[] {
  const sites = new Set<string>([
    "default",
    config.proactive?.session_type ?? "proactive",
    ...Object.keys(config.agent?.session_types ?? {}),
    "summarize",
    "condense",
    "diary",
  ]);
  return [...sites].sort();
}

export interface BuildBehaviourSnapshotOptions {
  config: AppConfig;
  catalogue: CheckCatalogue;
  code: CodeVersion;
}

/** Build the resolved behaviour snapshot. Pure and deterministic for a given config. */
export function buildBehaviourSnapshot({ config, catalogue, code }: BuildBehaviourSnapshotOptions): BehaviourSnapshot {
  const overrides = buildAgentModelOverrides(config);
  const referenced = new Set<string>();
  const modelThinking = (key: string) => config.models[key]?.thinking_level ?? "off";
  const fallbacksOf = (key: string) => [...(config.models[key]?.fallback ?? [])];
  const reference = (key: string) => {
    if (!config.models[key] || referenced.has(key)) return;
    referenced.add(key);
    for (const member of fallbacksOf(key)) referenced.add(member);
  };

  const agentNames = config.agents && Object.keys(config.agents).length > 0 ? Object.keys(config.agents) : [null];
  const accountToAgent = accountAgents(config);
  const sites = snapshotSites(config);
  const retries = config.agent.sessions.forced_completion_retries;
  // `forced_completion_redo` lives under [agent] or [agent.sessions] depending on the
  // release; read whichever is set.
  const redo =
    (config.agent.sessions as { forced_completion_redo?: boolean }).forced_completion_redo ??
    (config.agent as { forced_completion_redo?: boolean }).forced_completion_redo ??
    false;

  const agents: Record<string, AgentBehaviour> = {};
  for (const agent of agentNames) {
    const siteMap: Record<string, SiteBehaviour> = {};
    for (const site of sites) {
      const head = overrides.resolveSessionTypeModelRef(agent, site);
      reference(head);
      siteMap[site] = { head, fallbacks: fallbacksOf(head), thinking: modelThinking(head) };
    }
    if (config.captioning) {
      // The caption site's chain is the image modality's (the common case); the
      // other modalities appear as caption_video / caption_audio.
      for (const modality of ["image", "video", "audio"] as const) {
        const head = overrides.resolveCaptionModelRef(agent, modality);
        reference(head);
        siteMap[modality === "image" ? "caption" : `caption_${modality}`] = {
          head,
          fallbacks: fallbacksOf(head),
          thinking: modelThinking(head),
        };
      }
    }

    const preferences: PreferenceListBehaviour[] = [];
    (config.user_limits ?? []).forEach((rule, index) => {
      if (!rule.models || rule.models.length === 0) return;
      const ruleAgent = rule.agent ?? (rule.account ? accountToAgent.get(rule.account) : undefined);
      if (agent !== null && ruleAgent !== undefined && ruleAgent !== agent) return;
      for (const m of rule.models) reference(m);
      preferences.push({ rule: index, match: renderMatch(rule), models: [...rule.models] });
    });

    const decisions = decisionsFor(config, agent);
    const tasks: Record<string, TaskBehaviour> = {};
    for (const [key, task] of Object.entries(decisions.routing?.tasks ?? {})) {
      const models = task.models ? [...task.models] : task.model ? [task.model] : [];
      for (const m of models) reference(m);
      tasks[key] = {
        models,
        thinking: task.thinking_level ?? null,
        skills: [...(task.skills ?? [])],
        tailFiles: [...(task.tail_files ?? [])],
      };
    }

    const checks: Record<string, CheckBehaviour> = {};
    for (const check of catalogue.all(agent)) {
      if (!check.enabled) continue;
      checks[check.code] = {
        kind: check.kind,
        remedy: check.remedy,
        reason: check.reason ?? null,
        checkpoints: [...check.checkpoints],
        thresholds: check.questions.map((q) => q.threshold),
        minChars: check.minChars ?? null,
        detection: detectionHash(check),
      };
    }

    const points: Record<string, DecisionPointBehaviour> = {};
    for (const point of DECISION_POINT_NAMES as readonly DecisionPointName[]) {
      const raw = decisions[point] as { enabled?: boolean; model?: string } | undefined;
      const head = raw?.model ?? decisions.model;
      if (head) reference(head);
      points[point] = {
        enabled: decisions.enabled === true && raw?.enabled === true,
        chain: head ? [head, ...fallbacksOf(head)] : [],
      };
    }
    const knobs = checksPointKnobs(decisions);

    agents[agent ?? LEGACY_AGENT_KEY] = {
      sites: siteMap,
      preferences,
      tasks,
      checks,
      decisions: { enabled: decisions.enabled === true, points },
      checksKnobs: {
        styleMinChars: knobs.styleMinChars,
        reviseMaxConsecutive: knobs.reviseMaxConsecutive,
        reviseMaxPerSession: knobs.reviseMaxPerSession,
      },
      contract: { forcedCompletionRetries: retries, forcedCompletionRedo: redo },
    };
  }

  const rules: Record<string, RuleBehaviour> = {};
  for (const rule of normalizeRefusalRules(config)) {
    // Entries are model keys, or `{ model, tries }` once per-entry tries exist.
    const entries = (rule.models as unknown[]).map((e): RuleEntryBehaviour =>
      typeof e === "string"
        ? { model: e, tries: 1 }
        : { model: String((e as { model: unknown }).model), tries: Number((e as { tries?: unknown }).tries ?? 1) },
    );
    for (const e of entries) reference(e.model);
    rules[rule.name] = {
      index: rule.index,
      sites: rule.sites ?? null,
      reasons: rule.reasons ?? null,
      fromModels: rule.fromModels ?? null,
      agents: rule.agents ?? null,
      tasks: rule.tasks ?? null,
      models: entries,
      soft: rule.soft,
      onExhausted: rule.onExhausted,
    };
  }

  const models: Record<string, ModelBehaviour> = {};
  for (const key of referenced) {
    const m = config.models[key];
    if (!m) continue;
    models[key] = {
      id: m.id,
      provider: m.provider,
      api: m.api ?? "anthropic-messages",
      family: m.family ?? null,
      thinking: modelThinking(key),
      thinkingMap: (m.thinking_level_map as Record<string, string | null> | undefined) ?? null,
      fallback: fallbacksOf(key),
    };
  }

  // Round-trip through canonical JSON: sorted keys, no undefined, stable to hash.
  return JSON.parse(
    canonicalJson({ version: BEHAVIOUR_SNAPSHOT_VERSION, code, models, agents, rules }),
  ) as BehaviourSnapshot;
}
