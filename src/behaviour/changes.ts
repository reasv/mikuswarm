/**
 * Behaviour change events (spec REFUSAL-HANDLING §12.4): the structured diff of two
 * resolved snapshots into typed, explainable events, and their storage.
 */

import type Database from "better-sqlite3";
import type { Storage } from "../storage/index.js";
import {
  canonicalJson,
  codeVersionString,
  LEGACY_AGENT_KEY,
  snapshotHash,
  type AgentBehaviour,
  type BehaviourSnapshot,
  type CheckBehaviour,
  type PreferenceListBehaviour,
  type RuleBehaviour,
  type SiteBehaviour,
  type TaskBehaviour,
} from "./snapshot.js";
import type { BehaviourChangeDraft, BehaviourChangeEvent, BehaviourChangeKind } from "./types.js";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "none");
const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x !== ""))];
const keysOf = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) =>
  [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();

/** Prefix naming the agent ("agent a, " — nothing in legacy mode). */
const agentPrefix = (agent: string) => (agent === LEGACY_AGENT_KEY ? "" : `agent ${agent}, `);
const agentList = (agent: string) => (agent === LEGACY_AGENT_KEY ? [] : [agent]);

function render(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

/** Leaf-level differences (arrays are leaves) under `path`. */
function leafDiffs(path: string, a: unknown, b: unknown, out: Array<{ path: string; old: unknown; new: unknown }>): void {
  if (same(a, b)) return;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const key of keysOf(a, b)) leafDiffs(`${path}.${key}`, a[key], b[key], out);
    return;
  }
  out.push({ path, old: a ?? null, new: b ?? null });
}

function configChanged(
  path: string,
  old: unknown,
  next: unknown,
  touch: { agents?: string[]; sites?: string[]; models?: string[] } = {},
): BehaviourChangeDraft {
  return {
    kind: "config_changed",
    sentence: `${path}: ${render(old)} → ${render(next)}`,
    path,
    old,
    new: next,
    agents: touch.agents ?? [],
    sites: touch.sites ?? [],
    models: touch.models ?? [],
  };
}

function diffSite(agent: string, site: string, a: SiteBehaviour | undefined, b: SiteBehaviour | undefined): BehaviourChangeDraft[] {
  const path = `agents.${agent}.sites.${site}`;
  const where = `${agentPrefix(agent)}${site}`;
  const base = { agents: agentList(agent), sites: [site], path };
  if (!a || !b) {
    const head = (b ?? a)!.head;
    return [{
      kind: "head_model_changed",
      sentence: b ? `${where}: head model ${head} (new site)` : `${where}: removed (head model was ${head})`,
      old: a ?? null,
      new: b ?? null,
      models: [head],
      ...base,
    }];
  }
  const out: BehaviourChangeDraft[] = [];
  if (a.head !== b.head) {
    const thinking = a.thinking !== b.thinking ? ` (thinking ${a.thinking} → ${b.thinking})` : "";
    out.push({
      kind: "head_model_changed",
      sentence: `${where}: head model ${a.head} → ${b.head}${thinking}`,
      old: a.head,
      new: b.head,
      models: [a.head, b.head],
      ...base,
    });
  } else if (a.thinking !== b.thinking) {
    out.push({
      kind: "thinking_changed",
      sentence: `${where} on ${b.head}: thinking ${a.thinking} → ${b.thinking}`,
      old: a.thinking,
      new: b.thinking,
      models: [b.head],
      ...base,
    });
  }
  if (!same(a.fallbacks, b.fallbacks)) {
    const changed = [...a.fallbacks.filter((m) => !b.fallbacks.includes(m)), ...b.fallbacks.filter((m) => !a.fallbacks.includes(m))];
    out.push({
      kind: "chain_changed",
      sentence: `${where}: fallbacks now ${list(b.fallbacks)} (was ${list(a.fallbacks)})`,
      old: a.fallbacks,
      new: b.fallbacks,
      models: uniq([b.head, ...(changed.length > 0 ? changed : b.fallbacks)]),
      ...base,
    });
  }
  return out;
}

function describeListChange(a: readonly string[], b: readonly string[]): string {
  if (a.length === b.length && a.every((m) => b.includes(m)) && a[0] !== b[0]) return `${b[0]} moved to first`;
  return `models now ${list(b)} (was ${list(a)})`;
}

function diffPreferences(agent: string, a: PreferenceListBehaviour[], b: PreferenceListBehaviour[]): BehaviourChangeDraft[] {
  if (same(a, b)) return [];
  const byRule = (xs: PreferenceListBehaviour[]) => new Map(xs.map((x) => [x.rule, x]));
  const ma = byRule(a);
  const mb = byRule(b);
  const parts: string[] = [];
  const models: string[] = [];
  for (const rule of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y)) {
    const x = ma.get(rule);
    const y = mb.get(rule);
    if (same(x, y)) continue;
    models.push(...(x?.models ?? []), ...(y?.models ?? []));
    const label = `list #${rule + 1}${(y ?? x)!.match === "*" ? "" : ` (${(y ?? x)!.match})`}`;
    if (!x) parts.push(`${label} added: ${list(y!.models)}`);
    else if (!y) parts.push(`${label} removed`);
    else if (!same(x.models, y.models)) parts.push(`${label}: ${describeListChange(x.models, y.models)}`);
    else parts.push(`${label}: match ${x.match} → ${y.match}`);
  }
  return [{
    kind: "preference_changed",
    sentence: `${agent === LEGACY_AGENT_KEY ? "" : `agent ${agent}: `}user preference list changed (${parts.join("; ")})`,
    path: `agents.${agent}.preferences`,
    old: a,
    new: b,
    agents: agentList(agent),
    sites: [],
    models: uniq(models),
  }];
}

function diffTask(agent: string, key: string, a: TaskBehaviour | undefined, b: TaskBehaviour | undefined): BehaviourChangeDraft[] {
  if (same(a, b)) return [];
  const parts: string[] = [];
  if (!a) parts.push(`added (models ${list(b!.models)})`);
  else if (!b) parts.push("removed");
  else {
    if (!same(a.models, b.models)) parts.push(`models now ${list(b.models)} (was ${list(a.models)})`);
    if (a.thinking !== b.thinking) parts.push(`thinking ${a.thinking ?? "default"} → ${b.thinking ?? "default"}`);
    if (!same(a.skills, b.skills)) parts.push(`skills now ${list(b.skills)}`);
    if (!same(a.tailFiles, b.tailFiles)) parts.push(`tail files now ${list(b.tailFiles)}`);
    if (a.threshold !== b.threshold) parts.push(`threshold ${a.threshold ?? "default"} → ${b.threshold ?? "default"}`);
  }
  return [{
    kind: "routing_task_changed",
    sentence: `${agentPrefix(agent)}task \`${key}\`: ${parts.join("; ")}`,
    path: `agents.${agent}.tasks.${key}`,
    old: a ?? null,
    new: b ?? null,
    agents: agentList(agent),
    sites: [],
    models: uniq([...(a?.models ?? []), ...(b?.models ?? [])]),
  }];
}

function diffCheck(agent: string, code: string, a: CheckBehaviour | undefined, b: CheckBehaviour | undefined): BehaviourChangeDraft[] {
  if (same(a, b)) return [];
  const parts: string[] = [];
  if (!a) parts.push(`enabled (${b!.kind}, remedy ${b!.remedy})`);
  else if (!b) parts.push("disabled");
  else {
    if (a.remedy !== b.remedy) parts.push(`remedy ${a.remedy} → ${b.remedy}`);
    if (!same(a.thresholds, b.thresholds)) {
      parts.push(
        a.thresholds.length === 1 && b.thresholds.length === 1
          ? `threshold ${a.thresholds[0]} → ${b.thresholds[0]}`
          : `thresholds ${list(a.thresholds.map(String))} → ${list(b.thresholds.map(String))}`,
      );
    }
    if (a.reason !== b.reason) parts.push(`reason ${a.reason ?? "none"} → ${b.reason ?? "none"}`);
    if (!same(a.checkpoints, b.checkpoints)) parts.push(`checkpoints now ${list(b.checkpoints)}`);
    if (a.minChars !== b.minChars) parts.push(`min chars ${a.minChars ?? "default"} → ${b.minChars ?? "default"}`);
    if (a.detection !== b.detection) parts.push("detection changed");
    if (a.kind !== b.kind) parts.push(`kind ${a.kind} → ${b.kind}`);
  }
  return [{
    kind: "check_changed",
    sentence: `${agentPrefix(agent)}check \`${code}\`: ${parts.join("; ")}`,
    path: `agents.${agent}.checks.${code}`,
    old: a ?? null,
    new: b ?? null,
    agents: agentList(agent),
    sites: [],
    models: [],
  }];
}

const entryList = (r: RuleBehaviour) => list(r.models.map((e) => (e.tries > 1 ? `${e.model}×${e.tries}` : e.model)));
const entryModels = (r: RuleBehaviour) => r.models.map((e) => e.model).filter((m) => m !== "@same");

function diffRule(name: string, a: RuleBehaviour | undefined, b: RuleBehaviour | undefined): BehaviourChangeDraft[] {
  if (same(a, b)) return [];
  const parts: string[] = [];
  if (!a) parts.push(`added (models ${entryList(b!)})`);
  else if (!b) parts.push("removed");
  else {
    if (!same(a.models, b.models)) parts.push(`models now ${entryList(b)} (was ${entryList(a)})`);
    for (const field of ["sites", "reasons", "fromModels", "agents", "tasks"] as const) {
      if (!same(a[field], b[field])) parts.push(`${field} now ${b[field] ? list(b[field]!) : "any"}`);
    }
    if (a.soft !== b.soft) parts.push(`soft ${a.soft} → ${b.soft}`);
    if (a.onExhausted !== b.onExhausted) parts.push(`on_exhausted ${a.onExhausted} → ${b.onExhausted}`);
    if (a.index !== b.index) parts.push(`precedence ${a.index + 1} → ${b.index + 1}`);
  }
  const both = [a, b].filter((r): r is RuleBehaviour => !!r);
  return [{
    kind: "rule_changed",
    sentence: `rule \`${name}\`: ${parts.join("; ")}`,
    path: `rules.${name}`,
    old: a ?? null,
    new: b ?? null,
    agents: both.some((r) => r.agents === null) ? [] : uniq(both.flatMap((r) => r.agents ?? [])),
    sites: both.some((r) => r.sites === null) ? [] : uniq(both.flatMap((r) => r.sites ?? [])),
    models: uniq(both.flatMap((r) => [...entryModels(r), ...(r.fromModels ?? [])])),
  }];
}

function diffAgent(agent: string, a: AgentBehaviour, b: AgentBehaviour): BehaviourChangeDraft[] {
  const out: BehaviourChangeDraft[] = [];
  for (const site of keysOf(a.sites, b.sites)) out.push(...(same(a.sites[site], b.sites[site]) ? [] : diffSite(agent, site, a.sites[site], b.sites[site])));
  out.push(...diffPreferences(agent, a.preferences, b.preferences));
  for (const key of keysOf(a.tasks, b.tasks)) out.push(...diffTask(agent, key, a.tasks[key], b.tasks[key]));
  for (const code of keysOf(a.checks, b.checks)) out.push(...diffCheck(agent, code, a.checks[code], b.checks[code]));
  // Everything else under the agent (decision chains, check knobs, the contract) is generic.
  const rest = (x: AgentBehaviour) => ({ decisions: x.decisions, checksKnobs: x.checksKnobs, contract: x.contract });
  const leaves: Array<{ path: string; old: unknown; new: unknown }> = [];
  leafDiffs(`agents.${agent}`, rest(a), rest(b), leaves);
  for (const leaf of leaves) {
    const models = /\.chain$/.test(leaf.path)
      ? uniq([...((leaf.old as string[] | null) ?? []), ...((leaf.new as string[] | null) ?? [])])
      : [];
    out.push(configChanged(leaf.path, leaf.old, leaf.new, { agents: agentList(agent), models }));
  }
  return out;
}

/** Models that head any site in the snapshot (their thinking and chain changes surface per site). */
function siteHeads(s: BehaviourSnapshot): Set<string> {
  const out = new Set<string>();
  for (const agent of Object.values(s.agents)) for (const site of Object.values(agent.sites)) out.add(site.head);
  return out;
}

/**
 * Diff two snapshots into typed events. A snapshot-format change (different
 * `version`) yields only the code change: its structural differences are not
 * behaviour changes.
 */
export function diffBehaviourSnapshots(prev: BehaviourSnapshot, next: BehaviourSnapshot): BehaviourChangeDraft[] {
  const out: BehaviourChangeDraft[] = [];
  if (!same(prev.code, next.code)) {
    out.push({
      kind: "code_changed",
      sentence: `deploy: ${codeVersionString(prev.code)} → ${codeVersionString(next.code)}`,
      path: "code",
      old: prev.code,
      new: next.code,
      agents: [],
      sites: [],
      models: [],
    });
  }
  if (prev.version !== next.version) return out;

  for (const agent of keysOf(prev.agents, next.agents)) {
    const a = prev.agents[agent];
    const b = next.agents[agent];
    if (!a || !b) {
      out.push({
        ...configChanged(`agents.${agent}`, a ? "present" : null, b ? "present" : null, { agents: agentList(agent) }),
        sentence: `agent ${agent === LEGACY_AGENT_KEY ? "(default)" : agent}: ${b ? "added" : "removed"}`,
      });
      continue;
    }
    out.push(...diffAgent(agent, a, b));
  }

  for (const name of keysOf(prev.rules, next.rules)) out.push(...diffRule(name, prev.rules[name], next.rules[name]));

  // Model blocks: a head's thinking and chain changes were reported per site above;
  // the same changes on a model no site heads (a rule, task or preference model) are
  // reported once here. Other fields are generic.
  const heads = new Set([...siteHeads(prev), ...siteHeads(next)]);
  for (const key of keysOf(prev.models, next.models)) {
    const a = prev.models[key];
    const b = next.models[key];
    if (!a || !b) continue; // reference-set changes are explained by the events that caused them
    if (a.thinking !== b.thinking && !heads.has(key)) {
      out.push({
        kind: "thinking_changed",
        sentence: `${key}: thinking ${a.thinking} → ${b.thinking}`,
        path: `models.${key}.thinking`,
        old: a.thinking,
        new: b.thinking,
        agents: [],
        sites: [],
        models: [key],
      });
    }
    if (!same(a.fallback, b.fallback) && !heads.has(key)) {
      out.push({
        kind: "chain_changed",
        sentence: `${key}: fallbacks now ${list(b.fallback)} (was ${list(a.fallback)})`,
        path: `models.${key}.fallback`,
        old: a.fallback,
        new: b.fallback,
        agents: [],
        sites: [],
        models: uniq([key, ...a.fallback, ...b.fallback]),
      });
    }
    const leaves: Array<{ path: string; old: unknown; new: unknown }> = [];
    const rest = (m: typeof a) => ({ id: m.id, provider: m.provider, api: m.api, family: m.family, thinkingMap: m.thinkingMap });
    leafDiffs(`models.${key}`, rest(a), rest(b), leaves);
    for (const leaf of leaves) out.push(configChanged(leaf.path, leaf.old, leaf.new, { models: [key] }));
  }
  return out;
}

export interface RecordSnapshotResult {
  snapshotId: number;
  hash: string;
  /** False when the snapshot equals the previous one (nothing written). */
  changed: boolean;
  events: BehaviourChangeDraft[];
}

function insertChangeEvents(db: Database.Database, ts: number, snapshotId: number | null, events: BehaviourChangeDraft[]): void {
  const insert = db.prepare(
    `insert into behaviour_changes
       (ts, snapshot_id, kind, sentence, path, old_json, new_json, agents_json, sites_json, models_json, detail_json)
     values (@ts, @snapshotId, @kind, @sentence, @path, @old, @new, @agents, @sites, @models, @detail)`,
  );
  for (const e of events) {
    insert.run({
      ts,
      snapshotId,
      kind: e.kind,
      sentence: e.sentence,
      path: e.path ?? null,
      old: e.old === undefined ? null : JSON.stringify(e.old),
      new: e.new === undefined ? null : JSON.stringify(e.new),
      agents: JSON.stringify(e.agents),
      sites: JSON.stringify(e.sites),
      models: JSON.stringify(e.models),
      detail: e.detail ? JSON.stringify(e.detail) : null,
    });
  }
}

/**
 * Store the boot snapshot when its hash differs from the latest stored one, with
 * the diff events against it (none for the very first snapshot). One write job.
 */
export function recordBehaviourSnapshot(storage: Storage, snapshot: BehaviourSnapshot, now = Date.now()): Promise<RecordSnapshotResult> {
  const hash = snapshotHash(snapshot);
  return storage.write((db) =>
    db.transaction((): RecordSnapshotResult => {
      const prev = db
        .prepare(`select id, hash, snapshot_json from behaviour_snapshots order by id desc limit 1`)
        .get() as { id: number; hash: string; snapshot_json: string } | undefined;
      if (prev?.hash === hash) return { snapshotId: prev.id, hash, changed: false, events: [] };
      let events: BehaviourChangeDraft[] = [];
      if (prev) {
        try {
          events = diffBehaviourSnapshots(JSON.parse(prev.snapshot_json) as BehaviourSnapshot, snapshot);
        } catch {
          events = [];
        }
      }
      const snapshotId = Number(
        db
          .prepare(`insert into behaviour_snapshots (ts, hash, code_version, snapshot_json) values (?, ?, ?, ?)`)
          .run(now, hash, codeVersionString(snapshot.code), canonicalJson(snapshot)).lastInsertRowid,
      );
      insertChangeEvents(db, now, snapshotId, events);
      return { snapshotId, hash, changed: true, events };
    })(),
  );
}

/** Store observed change events (prompt changes) outside a snapshot. */
export function recordBehaviourChanges(storage: Storage, events: BehaviourChangeDraft[], now = Date.now()): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  return storage.write((db) => db.transaction(() => insertChangeEvents(db, now, null, events))());
}

interface ChangeRow {
  id: number; ts: number; kind: string; sentence: string; path: string | null; old_json: string | null;
  new_json: string | null; agents_json: string; sites_json: string; models_json: string; detail_json: string | null;
}

const parseJson = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
const parseList = (s: string): string[] => {
  const v = parseJson(s);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** Change events in `[since, until)`, oldest first. */
export function listBehaviourChanges(storage: Storage, since: number, until: number): BehaviourChangeEvent[] {
  const rows = storage.read(
    (db) =>
      db
        .prepare(`select * from behaviour_changes where ts >= ? and ts < ? order by ts, id`)
        .all(since, until) as ChangeRow[],
  );
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind as BehaviourChangeKind,
    sentence: r.sentence,
    path: r.path,
    old: parseJson(r.old_json),
    new: parseJson(r.new_json),
    agents: parseList(r.agents_json),
    sites: parseList(r.sites_json),
    models: parseList(r.models_json),
    detail: (parseJson(r.detail_json) as Record<string, unknown> | null) ?? null,
  }));
}
