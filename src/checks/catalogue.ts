/**
 * The check catalogue (spec REFUSAL-HANDLING §4): built-in checks, overridden
 * field by field and extended by `[checks.<code>]`, then per agent by
 * `[agents.<name>.checks.<code>]`. Built and validated once at startup; every
 * problem is a startup error naming the config table.
 */
import type { AppConfig } from "../config/index.js";
import type { CheckRawConfig } from "../config/schema.js";
import { BUILTIN_CHECKS } from "./builtin/index.js";
import {
  CHECK_KINDS,
  CHECK_REMEDIES,
  CHECK_SOURCES,
  CHECKPOINTS,
  type CheckCatalogue,
  type CheckDefinition,
  type CheckKind,
  type CheckRemedy,
  type Checkpoint,
} from "./types.js";

/** Remedy of a check whose config sets none (spec §4.1). */
export const DEFAULT_REMEDY: Record<CheckKind, CheckRemedy> = {
  refusal: "redo",
  style: "revise",
  contract: "observe",
  duplicate: "revise",
};

/** Checkpoints of a check whose config sets none. */
export const DEFAULT_CHECKPOINTS: Record<CheckKind, readonly Checkpoint[]> = {
  refusal: CHECKPOINTS,
  style: ["send"],
  contract: ["ending"],
  duplicate: ["send"],
};

/**
 * Compile a configured pattern: a JS regular expression source, where a leading
 * `(?i)` makes it case-insensitive. Compiled with the `u` flag, so `\p{…}`
 * classes work (and stray identity escapes are errors).
 */
export function compileCheckPattern(source: string): RegExp {
  const insensitive = source.startsWith("(?i)");
  return new RegExp(insensitive ? source.slice(4) : source, insensitive ? "iu" : "u");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One case-insensitive regex for a word list, matching whole words or phrases
 * (no letter, digit or underscore on either side). Longest entries first, so a
 * phrase wins over a word it starts with. Undefined for an empty list.
 */
export function compileWordList(words: readonly string[]): RegExp | undefined {
  const entries = [...new Set(words.map((w) => w.trim()).filter((w) => w.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegExp(w).replace(/\s+/g, "\\s+"));
  if (entries.length === 0) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${entries.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

const wordListCache = new WeakMap<CheckDefinition, RegExp | null>();

/**
 * The first text a check's patterns or word list match, or undefined. A pattern
 * hit decides the check without a model call (spec §4.2); the matched text fills
 * `{matched}` in the agent-facing explanation.
 */
export function firstPatternMatch(check: CheckDefinition, text: string): string | undefined {
  for (const pattern of check.patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  if (check.words.length === 0) return undefined;
  let words = wordListCache.get(check);
  if (words === undefined) {
    words = compileWordList(check.words) ?? null;
    wordListCache.set(check, words);
  }
  return words ? text.match(words)?.[0] : undefined;
}

/**
 * Whether a check's questions may be asked over `text`: true without a
 * prefilter, else when one of its prefilter patterns matches. A prefilter only
 * gates the questions; it never decides the check.
 */
export function prefilterAllows(check: CheckDefinition, text: string): boolean {
  if (!check.prefilter || check.prefilter.length === 0) return true;
  return check.prefilter.some((pattern) => pattern.test(text));
}

function cloneCheck(check: CheckDefinition): CheckDefinition {
  return {
    ...check,
    checkpoints: [...check.checkpoints],
    apiSignals: check.apiSignals.map((s) => ({ ...s })),
    patterns: check.patterns.map((p) => new RegExp(p.source, p.flags)),
    ...(check.prefilter ? { prefilter: check.prefilter.map((p) => new RegExp(p.source, p.flags)) } : {}),
    words: [...check.words],
    questions: check.questions.map((q) => ({ ...q, criteria: { ...q.criteria } })),
  };
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string, where: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${where}: unknown ${what} "${value}" (expected ${allowed.join(" | ")})`);
  }
  return value as T;
}

/**
 * Apply one config entry over `base` (a built-in or the global entry; undefined
 * for a new code) and validate the result. Arrays replace wholesale.
 */
function applyCheckConfig(
  code: string,
  base: CheckDefinition | undefined,
  raw: CheckRawConfig,
  where: string,
): CheckDefinition {
  const kindValue = raw.kind ?? base?.kind;
  if (kindValue === undefined) {
    throw new Error(`${where}: kind is required for a new check (${CHECK_KINDS.join(" | ")})`);
  }
  const kind = oneOf(kindValue, CHECK_KINDS, "kind", where);
  if (base && kind !== base.kind) {
    throw new Error(`${where}: cannot change the kind of check "${code}" from ${base.kind} to ${kind}`);
  }
  const remedy = oneOf(raw.remedy ?? base?.remedy ?? DEFAULT_REMEDY[kind], CHECK_REMEDIES, "remedy", where);
  const checkpoints = (raw.checkpoints ?? base?.checkpoints ?? DEFAULT_CHECKPOINTS[kind]).map((c) =>
    oneOf(c, CHECKPOINTS, "checkpoint", where),
  );
  const compileAll = (sources: readonly string[], field: string) =>
    sources.map((source, i) => {
      try {
        return compileCheckPattern(source);
      } catch (err) {
        throw new Error(
          `${where}.${field}[${i}]: invalid regular expression ${JSON.stringify(source)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  const patterns = raw.patterns === undefined ? (base?.patterns ?? []) : compileAll(raw.patterns, "patterns");
  const prefilter = raw.prefilter === undefined ? base?.prefilter : compileAll(raw.prefilter, "prefilter");
  const questions =
    raw.questions === undefined
      ? (base?.questions ?? [])
      : raw.questions.map((q, i) => {
          const at = `${where}.questions[${i}]`;
          if (!(q.threshold >= 0 && q.threshold <= 1)) throw new Error(`${at}: threshold must be in 0..1`);
          if (!q.instructions?.trim()) throw new Error(`${at}: instructions must not be empty`);
          if (!q.criteria?.true?.trim() || !q.criteria?.false?.trim()) {
            throw new Error(`${at}: criteria needs non-empty true and false texts`);
          }
          return {
            ...(q.name !== undefined ? { name: q.name } : {}),
            source: oneOf(q.source, CHECK_SOURCES, "source", at),
            instructions: q.instructions,
            criteria: { true: q.criteria.true, false: q.criteria.false },
            threshold: q.threshold,
          };
        });
  // Per-question thresholds by question name (or source, for an unnamed one),
  // over whichever question list applies (the base's or the config's).
  const thresholded = raw.thresholds === undefined ? questions : applyThresholds(questions, raw.thresholds, where);
  const def: CheckDefinition = {
    code,
    kind,
    enabled: raw.enabled ?? base?.enabled ?? true,
    remedy,
    reason: raw.reason ?? base?.reason,
    description: raw.description ?? base?.description ?? code,
    agentExplanation: raw.agent_explanation ?? base?.agentExplanation,
    checkpoints,
    apiSignals:
      raw.api_signals === undefined
        ? (base?.apiSignals ?? [])
        : raw.api_signals.map((s) => ({
            ...(s.api !== undefined ? { api: s.api } : {}),
            stopReason: s.stop_reason,
            // TOML has no null: an empty category means "the response carried none".
            ...(s.category !== undefined ? { category: s.category === "" ? null : s.category } : {}),
          })),
    patterns,
    ...(prefilter && prefilter.length > 0 ? { prefilter } : {}),
    words: raw.words ?? base?.words ?? [],
    minChars: raw.min_chars ?? base?.minChars,
    questions: thresholded,
    builtin: base?.builtin ?? false,
  };
  if (def.agentExplanation === undefined) delete def.agentExplanation;
  if (def.reason === undefined) delete def.reason;
  if (def.minChars === undefined) delete def.minChars;
  validateCheck(def, where);
  return def;
}

/** `[checks.<code>].thresholds`: question name (or source) → threshold; an unknown key is an error. */
function applyThresholds(
  questions: readonly CheckDefinition["questions"][number][],
  thresholds: Record<string, number>,
  where: string,
): CheckDefinition["questions"] {
  const out = questions.map((q) => ({ ...q, criteria: { ...q.criteria } }));
  for (const [key, value] of Object.entries(thresholds)) {
    if (!(value >= 0 && value <= 1)) throw new Error(`${where}.thresholds.${key}: threshold must be in 0..1`);
    const matching = out.filter((q) => (q.name ?? q.source) === key);
    if (matching.length === 0) {
      const names = [...new Set(out.map((q) => q.name ?? q.source))];
      throw new Error(
        `${where}.thresholds.${key}: the check has no question named "${key}" (questions: ${names.join(", ") || "none"})`,
      );
    }
    for (const q of matching) q.threshold = value;
  }
  return out;
}

function validateCheck(def: CheckDefinition, where: string): void {
  if (def.kind === "refusal") {
    if (!def.reason) throw new Error(`${where}: a refusal check needs a reason`);
    if (def.remedy === "revise") {
      throw new Error(`${where}: remedy "revise" is not allowed on a refusal check (use "redo" or "observe")`);
    }
  } else {
    if (def.reason !== undefined) throw new Error(`${where}: reason applies only to refusal checks`);
    if (def.apiSignals.length > 0) throw new Error(`${where}: api_signals apply only to refusal checks`);
  }
  if (def.kind === "style" && def.remedy === "redo") {
    throw new Error(`${where}: remedy "redo" is not allowed on a style check (use "revise" or "observe")`);
  }
  if (def.minChars !== undefined && def.kind !== "style") {
    throw new Error(`${where}: min_chars applies only to style checks`);
  }
  if (def.prefilter && def.prefilter.length > 0 && def.questions.length === 0) {
    throw new Error(`${where}: prefilter gates questions; a check without questions cannot have one`);
  }
  if (def.checkpoints.length === 0) {
    throw new Error(`${where}: checkpoints must not be empty (set enabled = false to turn the check off)`);
  }
  if (def.kind === "duplicate") {
    // Judged against the same agent's unseen messages in the send's target
    // channel (ARCHITECTURE.md §8j "Duplicate sends"): only a model can see them.
    if (def.remedy === "redo") {
      throw new Error(`${where}: remedy "redo" is not allowed on a duplicate check (use "revise" or "observe")`);
    }
    if (def.patterns.length > 0 || def.words.length > 0) {
      throw new Error(`${where}: a duplicate check is judged against unseen messages; patterns and words do not apply`);
    }
    if (def.checkpoints.some((c) => c !== "send")) {
      throw new Error(`${where}: a duplicate check judges sends only (checkpoints = ["send"])`);
    }
    if (def.questions.some((q) => q.source !== "message")) {
      throw new Error(`${where}: a duplicate check's questions judge the draft (source = "message")`);
    }
  }
  const ids = new Set<string>();
  for (const q of def.questions) {
    if (q.name === undefined) continue;
    if (ids.has(q.name)) throw new Error(`${where}: two questions are named "${q.name}"`);
    ids.add(q.name);
  }
}

class Catalogue implements CheckCatalogue {
  constructor(
    private readonly global: ReadonlyMap<string, CheckDefinition>,
    private readonly perAgent: ReadonlyMap<string, ReadonlyMap<string, CheckDefinition>>,
  ) {}

  private checks(agent?: string | null): ReadonlyMap<string, CheckDefinition> {
    return (agent ? this.perAgent.get(agent) : undefined) ?? this.global;
  }

  all(agent?: string | null): CheckDefinition[] {
    return [...this.checks(agent).values()];
  }

  get(code: string, agent?: string | null): CheckDefinition | undefined {
    return this.checks(agent).get(code);
  }

  enabledFor(checkpoint: Checkpoint, agent?: string | null): CheckDefinition[] {
    return this.all(agent).filter((c) => c.enabled && c.checkpoints.includes(checkpoint));
  }
}

/**
 * Build the catalogue: built-ins, then `[checks.<code>]` (a built-in code is
 * overridden field by field, a new code is added), then each agent's
 * `[agents.<name>.checks.<code>]` over the global result (existing codes only).
 * Order: built-ins first, then new codes in config order. Throws on the first
 * invalid entry.
 */
export function buildCheckCatalogue(
  config: Pick<AppConfig, "checks" | "agents">,
  builtins: readonly CheckDefinition[] = BUILTIN_CHECKS,
): CheckCatalogue {
  const global = new Map<string, CheckDefinition>();
  for (const check of builtins) global.set(check.code, cloneCheck(check));
  for (const [code, raw] of Object.entries(config.checks ?? {})) {
    global.set(code, applyCheckConfig(code, global.get(code), raw, `[checks.${code}]`));
  }
  const perAgent = new Map<string, Map<string, CheckDefinition>>();
  for (const [agent, block] of Object.entries(config.agents ?? {})) {
    if (!block.checks) continue;
    const checks = new Map(global);
    for (const [code, raw] of Object.entries(block.checks)) {
      const where = `[agents.${agent}.checks.${code}]`;
      const base = global.get(code);
      if (!base) {
        throw new Error(`${where}: no check "${code}" exists; an agent can only override built-in or [checks.*] codes`);
      }
      checks.set(code, applyCheckConfig(code, base, raw, where));
    }
    perAgent.set(agent, checks);
  }
  return new Catalogue(global, perAgent);
}

/** Every refusal reason the catalogue knows, for any agent (built-in and operator-defined). */
export function catalogueReasons(catalogue: CheckCatalogue, agents: readonly string[]): Set<string> {
  const reasons = new Set<string>();
  for (const agent of [null, ...agents]) {
    for (const check of catalogue.all(agent)) {
      if (check.kind === "refusal" && check.reason) reasons.add(check.reason);
    }
  }
  return reasons;
}
