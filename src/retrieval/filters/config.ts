/**
 * Operator memory filters: configuration (ARCHITECTURE.md §9c "Memory filters").
 *
 * `[retrieval.filters]` holds two settings (`pending`, `model`) and any number
 * of named filter tables; `[agents.<name>.retrieval.filters]` deep-merges over
 * it per key. A filter is judged (`description`), keyword (`keywords`), pattern
 * (`patterns`), or judged with a mechanical pre-gate (both), optionally scoped
 * to a time range (`after` inclusive, `before` exclusive; a bare date is the
 * start of that day in the agent timezone, a datetime without a zone is read in
 * the agent timezone).
 */
import { createHash } from "node:crypto";
import type { AppConfig } from "../../config/index.js";
import { compileCheckPattern, compileWordList } from "../../checks/catalogue.js";
import { getConfiguredTimezone, parseZonedWallClock } from "../../time/index.js";

export type FilterPending = "show" | "hide";
export type FilterKind = "judged" | "keyword" | "pattern";

export interface ResolvedMemoryFilter {
  key: string;
  enabled: boolean;
  description?: string;
  examplesHide: string[];
  examplesKeep: string[];
  /** Judged: hide at or above this probability. */
  threshold: number;
  keywords: string[];
  patternSources: string[];
  /** Compiled keyword list (whole words/phrases, case-insensitive). */
  keywordRe?: RegExp;
  patterns: RegExp[];
  after?: string;
  before?: string;
  /** sha256 over everything that defines the filter (cache staleness key). */
  hash: string;
}

export interface ResolvedMemoryFilters {
  pending: FilterPending;
  /** Decision chain head for judged filters; default the `memory` point's chain. */
  model?: string;
  filters: ResolvedMemoryFilter[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** True when a filter bound is a valid date or datetime. */
export function isValidFilterBound(value: string): boolean {
  return filterBoundTs(value, "UTC") !== null;
}

/**
 * A filter bound as epoch ms: a bare date is 00:00 of that day in `tz`; a
 * datetime with an explicit zone (`Z`, `+02:00`) is read in that zone, else in
 * `tz`. Null when it does not parse.
 */
export function filterBoundTs(value: string, tz: string = getConfiguredTimezone()): number | null {
  const v = value.trim();
  if (DATE_RE.test(v)) return parseZonedWallClock(`${v} 00:00`, tz);
  const m = DATETIME_RE.exec(v);
  if (!m) return null;
  const [, day, hm, sec, zone] = m;
  if (zone) {
    const iso = `${day}T${hm}:${sec ?? "00"}${zone.length === 5 && !zone.includes(":") ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`;
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? null : ts;
  }
  const base = parseZonedWallClock(`${day} ${hm}`, tz);
  return base === null ? null : base + Number(sec ?? 0) * 1000;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type RawFilter = {
  enabled?: boolean;
  description?: string;
  examples?: { hide?: string[]; keep?: string[] };
  threshold?: number;
  keywords?: string[];
  patterns?: string[];
  after?: string;
  before?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Resolve one effective `[retrieval.filters]` table; throws on a malformed one. */
export function resolveMemoryFilters(raw: Record<string, unknown> | undefined, where = "retrieval.filters"): ResolvedMemoryFilters {
  const out: ResolvedMemoryFilters = { pending: "show", filters: [] };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === "pending") {
      if (value !== "show" && value !== "hide") throw new Error(`${where}.pending must be "show" or "hide"`);
      out.pending = value;
      continue;
    }
    if (key === "model") {
      if (typeof value !== "string" || value.length === 0) throw new Error(`${where}.model must name a [models.*] block`);
      out.model = value;
      continue;
    }
    if (!isPlainObject(value)) {
      throw new Error(`${where}.${key}: a filter must be a table (only "pending" and "model" are plain settings)`);
    }
    out.filters.push(resolveOne(key, value as RawFilter, `${where}.${key}`));
  }
  return out;
}

function resolveOne(key: string, f: RawFilter, where: string): ResolvedMemoryFilter {
  const keywords = (f.keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  const patternSources = f.patterns ?? [];
  if (!f.description && keywords.length === 0 && patternSources.length === 0) {
    throw new Error(`${where}: a filter needs a description (judged), keywords, or patterns`);
  }
  if (f.examples && !f.description) throw new Error(`${where}: examples need a description (they are judged criteria)`);
  if (f.threshold !== undefined && !f.description) throw new Error(`${where}: threshold applies to a judged filter (set a description)`);
  const patterns = patternSources.map((source, i) => {
    try {
      return compileCheckPattern(source);
    } catch (error) {
      throw new Error(`${where}.patterns[${i}] is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  for (const bound of ["after", "before"] as const) {
    const v = f[bound];
    if (v !== undefined && !isValidFilterBound(v)) {
      throw new Error(`${where}.${bound} = "${v}": expected a date (YYYY-MM-DD) or a datetime (YYYY-MM-DDTHH:MM, optional zone)`);
    }
  }
  if (f.after && f.before && DATE_RE.test(f.after.trim()) && DATE_RE.test(f.before.trim()) && f.after.trim() >= f.before.trim()) {
    throw new Error(`${where}: the range is empty (after ${f.after} is not before ${f.before})`);
  }
  const threshold = f.threshold ?? 0.8;
  const examplesHide = f.examples?.hide ?? [];
  const examplesKeep = f.examples?.keep ?? [];
  const hash = createHash("sha256")
    .update(
      stableJson({
        description: f.description,
        examplesHide,
        examplesKeep,
        threshold: f.description ? threshold : undefined,
        keywords,
        patterns: patternSources,
        after: f.after,
        before: f.before,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return {
    key,
    enabled: f.enabled ?? true,
    ...(f.description ? { description: f.description } : {}),
    examplesHide,
    examplesKeep,
    threshold,
    keywords,
    patternSources,
    keywordRe: compileWordList(keywords),
    patterns,
    ...(f.after ? { after: f.after } : {}),
    ...(f.before ? { before: f.before } : {}),
    hash,
  };
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

/** An agent filter table that only switches a filter off (nothing that defines one). */
function onlyDisables(value: unknown): boolean {
  return isPlainObject(value) && value.enabled === false && Object.keys(value).every((k) => k === "enabled");
}

/**
 * Agent filter keys that only set `enabled = false` for a filter the global
 * table does not define: ignored by {@link mergeFilterTables}, reported at startup.
 */
export function unknownDisabledFilters(
  global: Record<string, unknown> | undefined,
  agent: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(agent ?? {})
    .filter(([key, value]) => onlyDisables(value) && !isPlainObject(global?.[key]))
    .map(([key]) => key);
}

/**
 * Deep-merge an agent's `[agents.<name>.retrieval.filters]` over the global
 * table, recursively (`examples.keep` alone keeps the global `examples.hide`).
 * An agent `enabled = false` for a filter the global table does not define is
 * ignored (validateMemoryFilters warns about it).
 */
export function mergeFilterTables(
  global: Record<string, unknown> | undefined,
  agent: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!agent) return global;
  const unknown = new Set(unknownDisabledFilters(global, agent));
  const over = Object.fromEntries(Object.entries(agent).filter(([key]) => !unknown.has(key)));
  return deepMerge(global ?? {}, over);
}

/** The effective filters of an agent (null = legacy / global only). */
export function filtersFor(config: AppConfig, agentName: string | null): ResolvedMemoryFilters {
  const global = config.retrieval?.filters as Record<string, unknown> | undefined;
  const agent = agentName ? (config.agents?.[agentName]?.retrieval?.filters as Record<string, unknown> | undefined) : undefined;
  const where = agentName && agent ? `agents.${agentName}.retrieval.filters` : "retrieval.filters";
  return resolveMemoryFilters(mergeFilterTables(global, agent), where);
}

/**
 * Startup validation of every agent's effective filters (throws on the first
 * problem); warns about an agent `enabled = false` naming no global filter.
 */
export function validateMemoryFilters(config: AppConfig, warn?: (event: string, fields: Record<string, unknown>) => void): void {
  filtersFor(config, null);
  const global = config.retrieval?.filters as Record<string, unknown> | undefined;
  for (const name of Object.keys(config.agents ?? {})) {
    filtersFor(config, name);
    const agent = config.agents?.[name]?.retrieval?.filters as Record<string, unknown> | undefined;
    for (const key of unknownDisabledFilters(global, agent)) {
      warn?.("memory_filter_disable_unknown", {
        where: `agents.${name}.retrieval.filters.${key}`,
        hint: `enabled = false switches off a filter of [retrieval.filters], which has no "${key}"; the entry is ignored`,
      });
    }
  }
}
