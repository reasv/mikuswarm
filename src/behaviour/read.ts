/**
 * Model behaviour read API (spec REFUSAL-HANDLING §12.3, §12.4): the scorecard, the
 * time series, the breakdown and the change markers read the hourly rollups; the
 * incident log and its click-through read the raw tables, one page of sessions at a
 * time. Every section follows the same filters.
 */

import type Database from "better-sqlite3";
import type { Storage } from "../storage/index.js";
import { MODEL_BEHAVIOUR_HOUR_MS } from "../storage/model-behaviour-schema.js";
import { listBehaviourChanges } from "./changes.js";
import {
  HEADLINE_RATES,
  MIX_FAMILIES,
  MODEL_BEHAVIOUR_METRIC_FAMILIES,
  headlineRate,
  mixMetricId,
  type HeadlineRate,
} from "./metrics.js";
import { firedChecks, sessionTasks } from "./rollups.js";
import type {
  AuditBacklogProgress,
  BehaviourBreakdown,
  BehaviourChartOption,
  BehaviourChangeEvent,
  BehaviourCheckBreakdown,
  BehaviourCount,
  BehaviourGroupBy,
  BehaviourIncidentPage,
  BehaviourIncidentRow,
  BehaviourIncidentType,
  BehaviourMarker,
  BehaviourMixTable,
  BehaviourModelInfo,
  BehaviourOverviewMetric,
  BehaviourRateCell,
  BehaviourScorecardRow,
  BehaviourSeriesPoint,
  BehaviourWindow,
  ModelBehaviourResponse,
} from "./types.js";

const HOUR_MS = MODEL_BEHAVIOUR_HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Change events this close to the previous one collapse into one marker (one deploy). */
export const MARKER_COLLAPSE_MS = 5 * 60_000;
/** Sessions examined per incident-log request before returning a partial page. */
export const INCIDENT_SCAN_CAP = 400;
const INCIDENT_BATCH = 200;
export const INCIDENT_PAGE_DEFAULT = 25;
export const INCIDENT_PAGE_MAX = 100;

export const BEHAVIOUR_WINDOWS: readonly BehaviourWindow[] = ["today", "24h", "7d", "30d", "month", "all"];
export const BEHAVIOUR_GROUP_BYS: readonly BehaviourGroupBy[] = ["model", "agent", "site", "task"];

export interface ModelBehaviourReadContext {
  storage: Storage;
  /** The family a config entry groups under: `[models.<key>].family`, else its wire model id, else the key. */
  familyOf(model: string): string;
  agentForTimelineKey(timelineKey: string | null): string | null;
  /** A config entry's wire model id and configured family, for the page's labels. */
  modelInfo?(model: string): BehaviourModelInfo;
  /** Kind of a check code (`style` feeds the style breakdown). */
  checkKind?(code: string): string | undefined;
  /** Dirty rollup hours left (a cheap count). */
  pendingHours?(): number;
  /** The offline audit's latest backlog count, when the worker runs (counted in the background). */
  auditProgress?(): AuditBacklogProgress | null;
}

export interface ModelBehaviourQuery {
  window: BehaviourWindow;
  groupBy: BehaviourGroupBy;
  family: boolean;
  agent?: string | null;
  site?: string | null;
  task?: string | null;
  selected?: string | null;
  /**
   * What the chart plots: a headline rate id (one line per group), `mix:<family>`
   * (one line per key of a keyed family, for the selected group or everything
   * under the filters), or absent for the overview (every headline rate, all
   * groups combined).
   */
  metric?: string | null;
  incidentType?: BehaviourIncidentType | null;
  cursor?: string | null;
  limit?: number;
  now?: number;
}

/** Window start (ms epoch). Rolling windows trail `now`; `today`/`month` align to UTC. */
export function behaviourWindowSince(window: BehaviourWindow, now: number): number {
  switch (window) {
    case "today": {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    case "24h":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "month": {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    case "all":
      return 0;
  }
}

/** Series bucket width: hourly up to a day, daily up to a month, weekly beyond. */
export function behaviourBucketMs(window: BehaviourWindow): number {
  if (window === "today" || window === "24h") return HOUR_MS;
  if (window === "all") return WEEK_MS;
  return DAY_MS;
}

const floorHour = (ts: number) => Math.floor(ts / HOUR_MS) * HOUR_MS;

/** Rollup scope: an hour range plus the filters. */
interface Scope {
  since: number;
  until: number;
  agent: string | null;
  site: string | null;
  task: string | null;
  /** Restrict one dimension to a set of values (the selected group). */
  restrict?: { dim: BehaviourGroupBy; values: string[] };
}

type Dim = "agent" | "site" | "model" | "task" | "bucket";

function rollupSums(
  db: Database.Database,
  scope: Scope,
  dims: Dim[],
  metrics: { names?: readonly string[]; prefixes?: readonly string[] },
  bucketMs = DAY_MS,
): Array<Record<string, string | number>> {
  const useTask = scope.task !== null || dims.includes("task") || scope.restrict?.dim === "task";
  const table = useTask ? "model_behaviour_task_rollups" : "model_behaviour_rollups";
  const where = ["hour >= @since", "hour < @until"];
  const params: Record<string, string | number> = { since: floorHour(scope.since), until: scope.until, bucketMs };
  if (scope.agent !== null) {
    where.push("agent = @agent");
    params.agent = scope.agent;
  }
  if (scope.site !== null) {
    where.push("site = @site");
    params.site = scope.site;
  }
  if (scope.task !== null) {
    where.push("task = @task");
    params.task = scope.task;
  }
  if (scope.restrict) {
    const names = scope.restrict.values.map((v, i) => {
      params[`r${i}`] = v;
      return `@r${i}`;
    });
    where.push(names.length > 0 ? `${scope.restrict.dim} in (${names.join(", ")})` : "0");
  }
  const metricClauses: string[] = [];
  (metrics.names ?? []).forEach((m, i) => {
    params[`m${i}`] = m;
    metricClauses.push(`metric = @m${i}`);
  });
  (metrics.prefixes ?? []).forEach((p, i) => {
    params[`p${i}`] = `${p}:%`;
    metricClauses.push(`metric like @p${i}`);
  });
  if (metricClauses.length > 0) where.push(`(${metricClauses.join(" or ")})`);
  // The cast floors: better-sqlite3 binds a JS number as REAL, so a bare
  // `hour / @bucketMs` is float division and every hour was its own bucket.
  const cols = dims.map((d) => (d === "bucket" ? `cast(hour / @bucketMs as integer) * @bucketMs as bucket` : d));
  const groups = dims.map((d) => (d === "bucket" ? "bucket" : d));
  const sql = `select ${[...cols, "metric", "sum(value) as value"].join(", ")}
                 from ${table} where ${where.join(" and ")}
                 group by ${[...groups, "metric"].join(", ")}`;
  return db.prepare(sql).all(params) as Array<Record<string, string | number>>;
}

/** Every counter a headline rate reads. */
const RATE_METRICS = [...new Set(HEADLINE_RATES.flatMap((r) => [...r.numerator, r.denominator]))];
const VOLUME_METRICS = ["requests", "sessions", "messages_sent"];

type Sums = Map<string, Map<string, number>>;

function foldSums(rows: Array<Record<string, string | number>>, groupOf: (row: Record<string, string | number>) => string): Sums {
  const out: Sums = new Map();
  for (const row of rows) {
    const g = groupOf(row);
    let m = out.get(g);
    if (!m) out.set(g, (m = new Map()));
    const metric = String(row.metric);
    m.set(metric, (m.get(metric) ?? 0) + Number(row.value));
  }
  return out;
}

function rateOf(rate: HeadlineRate, sums: Map<string, number> | undefined): { count: number; denominator: number; rate: number | null } {
  const count = rate.numerator.reduce((n, m) => n + (sums?.get(m) ?? 0), 0);
  const denominator = sums?.get(rate.denominator) ?? 0;
  return { count, denominator, rate: denominator > 0 ? (count / denominator) * rate.scale : null };
}

function rateCell(rate: HeadlineRate, cur: Map<string, number> | undefined, prev: Map<string, number> | undefined, hasPrev: boolean): BehaviourRateCell {
  const c = rateOf(rate, cur);
  const p = hasPrev ? rateOf(rate, prev).rate : null;
  return {
    rate: c.rate,
    count: c.count,
    denominator: c.denominator,
    previousRate: p,
    change: c.rate !== null && p !== null ? c.rate - p : null,
    lowSample: c.denominator < rate.minSample,
  };
}

const counts = (m: Map<string, number>): BehaviourCount[] =>
  [...m.entries()]
    .filter(([, n]) => n !== 0)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));

function breakdownFrom(totals: Map<string, number>, bySite: Map<string, number>, checkKind: (code: string) => string | undefined): BehaviourBreakdown {
  const get = (m: string) => totals.get(m) ?? 0;
  const family = (prefix: keyof typeof MODEL_BEHAVIOUR_METRIC_FAMILIES) => {
    const out = new Map<string, number>();
    for (const [metric, value] of totals) if (metric.startsWith(`${prefix}:`)) out.set(metric.slice(prefix.length + 1), value);
    return out;
  };
  const hits = family("check_hits");
  const revisions = family("check_revisions");
  const overrides = family("check_overrides");
  const codes = [...new Set([...hits.keys(), ...revisions.keys(), ...overrides.keys()])];
  const checks: BehaviourCheckBreakdown[] = codes
    .map((code) => ({ code, hits: hits.get(code) ?? 0, revisions: revisions.get(code) ?? 0, overrides: overrides.get(code) ?? 0 }))
    .sort((a, b) => b.hits - a.hits || (a.code < b.code ? -1 : 1));
  return {
    refusals: {
      hard: get("refusals_hard"),
      judged: get("refusals_judged"),
      redos: get("refusal_redos"),
      byReason: counts(family("refusal_reason")),
      bySite: counts(bySite),
      byMethod: counts(family("refusal_method")),
      outcomes: counts(family("refusal_outcome")),
      discardedBranchCostUsd: get("refusal_branch_cost_usd"),
    },
    contract: {
      nudgedSessions: get("sessions_nudged"),
      failedAttempts: get("contract_failed_attempts"),
      untilRecovery: [
        { key: "1", count: get("contract_recovered_1") },
        { key: "2", count: get("contract_recovered_2") },
        { key: "3", count: get("contract_recovered_3") },
        { key: "after_redo", count: get("contract_recovered_after_redo") },
        { key: "gave_up", count: get("contract_gave_up") },
        { key: "exhausted", count: get("contract_exhausted") },
      ],
      failureTypes: counts(family("failure_type")),
      redos: get("contract_redos"),
      discardedBranchCostUsd: get("contract_branch_cost_usd"),
      afterCorrection: counts(family("after_correction")),
      noReplyIntent: counts(family("no_reply_intent")),
    },
    style: {
      hits: get("style_hits"),
      messagesWithHit: get("messages_with_style_hit"),
      revisions: get("revisions"),
      overrides: get("overrides"),
      perCheck: checks.filter((c) => checkKind(c.code) === "style"),
    },
    checks,
  };
}

/** Does a change event touch the displayed agents / sites / models? Empty lists touch everything. */
function eventMatches(
  e: BehaviourChangeEvent,
  filter: { agents: string[] | null; sites: string[] | null; models: string[] | null },
  familyOf: (m: string) => string,
  family: boolean,
): boolean {
  const hit = (touched: string[], shown: string[] | null, map = (x: string) => x) =>
    shown === null || touched.length === 0 || touched.some((t) => shown.includes(map(t)));
  return (
    hit(e.agents, filter.agents) &&
    hit(e.sites, filter.sites) &&
    hit(e.models, filter.models, family ? familyOf : (x) => x)
  );
}

/** Collapse events (oldest first) whose gap to the previous is within {@link MARKER_COLLAPSE_MS}. */
export function collapseMarkers(events: BehaviourChangeEvent[], gapMs = MARKER_COLLAPSE_MS): BehaviourMarker[] {
  const out: BehaviourMarker[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && e.ts - last.until <= gapMs) {
      last.events.push(e);
      last.until = e.ts;
      if (!last.kinds.includes(e.kind)) last.kinds.push(e.kind);
    } else {
      out.push({ ts: e.ts, until: e.ts, kinds: [e.kind], events: [e] });
    }
  }
  return out;
}

/** Map the scorecard group to its raw dimension values (a family expands to its member models). */
function groupMembers(groupBy: BehaviourGroupBy, family: boolean, value: string, models: string[], familyOf: (m: string) => string): string[] {
  if (groupBy === "model" && family) return models.filter((m) => familyOf(m) === value);
  return [value];
}

/** The chart's metric: a headline rate, a mix family, or null (the overview). */
function chartMetric(metric: string | null | undefined): { id: string; rate: HeadlineRate } | { id: string; family: string } | null {
  if (!metric) return null;
  const rate = headlineRate(metric);
  if (rate) return { id: rate.id, rate };
  const mix = MIX_FAMILIES.find((f) => mixMetricId(f.family) === metric);
  return mix ? { id: metric, family: mix.family } : null;
}

export function readModelBehaviour(ctx: ModelBehaviourReadContext, query: ModelBehaviourQuery): ModelBehaviourResponse {
  const now = query.now ?? Date.now();
  const since = behaviourWindowSince(query.window, now);
  const until = now;
  const hasPrev = query.window !== "all";
  const prevSince = since - (until - since);
  const groupBy = query.groupBy;
  const family = query.family && groupBy === "model";
  const familyOf = (m: string) => (family ? ctx.familyOf(m) : m);
  const filters = {
    agent: query.agent ?? null,
    site: query.site ?? null,
    task: query.task ?? null,
    selected: query.selected ?? null,
  };
  const chosen = chartMetric(query.metric);
  const base: Scope = { since, until, agent: filters.agent, site: filters.site, task: filters.task };

  return ctx.storage.read((db) => {
    // Facets (distinct values present in the window, under the other filters).
    const facetRows = rollupSums(db, { ...base, agent: null, site: null, task: null }, ["agent", "site", "model"], { names: ["requests", "sessions"] });
    const taskRows = rollupSums(db, { ...base, agent: null, site: null, task: null }, ["task"], { names: ["requests", "sessions"] });
    const distinct = (rows: Array<Record<string, string | number>>, key: string) =>
      [...new Set(rows.map((r) => String(r[key])))].sort();
    const facetModels = distinct(facetRows, "model");
    const facets = {
      agents: distinct(facetRows, "agent"),
      sites: distinct(facetRows, "site"),
      models: facetModels,
      tasks: distinct(taskRows, "task"),
    };
    const restrict = filters.selected !== null
      ? { dim: groupBy, values: groupMembers(groupBy, family, filters.selected, facetModels, ctx.familyOf) }
      : undefined;

    // Scorecard: every rate's counters per group, now and over the previous window.
    const groupOf = (row: Record<string, string | number>) => (groupBy === "model" ? familyOf(String(row.model)) : String(row[groupBy]));
    const metricNames = [...new Set([...RATE_METRICS, ...VOLUME_METRICS])];
    const cur = foldSums(rollupSums(db, base, [groupBy], { names: metricNames }), groupOf);
    const prev = hasPrev
      ? foldSums(rollupSums(db, { ...base, since: prevSince, until: floorHour(since) }, [groupBy], { names: metricNames }), groupOf)
      : new Map<string, Map<string, number>>();
    const membersOf = new Map<string, Set<string>>();
    if (family) for (const m of facetModels) {
      const f = ctx.familyOf(m);
      if (!membersOf.has(f)) membersOf.set(f, new Set());
      membersOf.get(f)!.add(m);
    }
    const scorecard: BehaviourScorecardRow[] = [...cur.entries()]
      .filter(([, sums]) => [...sums.values()].some((v) => v !== 0))
      .map(([group, sums]) => ({
        group,
        members: family ? [...(membersOf.get(group) ?? [group])].sort() : [],
        volume: {
          requests: sums.get("requests") ?? 0,
          sessions: sums.get("sessions") ?? 0,
          messages: sums.get("messages_sent") ?? 0,
        },
        cells: Object.fromEntries(HEADLINE_RATES.map((r) => [r.id, rateCell(r, sums, prev.get(group), hasPrev)])),
      }))
      .sort((a, b) => b.volume.requests - a.volume.requests || b.volume.sessions - a.volume.sessions || (a.group < b.group ? -1 : 1));

    // Overview (the default chart): every headline rate per bucket, all groups combined.
    const bucketMs = behaviourBucketMs(query.window);
    const overviewSums = new Map<number, Map<string, number>>();
    for (const row of rollupSums(db, base, ["bucket"], { names: RATE_METRICS }, bucketMs)) {
      const bucket = Number(row.bucket);
      let m = overviewSums.get(bucket);
      if (!m) overviewSums.set(bucket, (m = new Map()));
      m.set(String(row.metric), (m.get(String(row.metric)) ?? 0) + Number(row.value));
    }
    const buckets = [...overviewSums.keys()].sort((a, b) => a - b);
    const allGroups = new Map<string, number>();
    for (const sums of cur.values()) for (const [m, v] of sums) allGroups.set(m, (allGroups.get(m) ?? 0) + v);
    const overview: BehaviourOverviewMetric[] = HEADLINE_RATES.map((r) => ({
      id: r.id,
      ...rateOf(r, allGroups),
      points: buckets
        .map((bucket) => ({ bucket, ...rateOf(r, overviewSums.get(bucket)) }))
        .filter((p) => p.denominator > 0 || p.count > 0),
    }));

    // Breakdown for the selected group (or everything under the filters).
    const scoped: Scope = { ...base, restrict };
    const totals = new Map<string, number>();
    for (const row of rollupSums(db, scoped, [], {})) totals.set(String(row.metric), Number(row.value));
    const bySite = new Map<string, number>();
    for (const row of rollupSums(db, scoped, ["site"], { names: ["refusals_hard", "refusals_judged"] })) {
      bySite.set(String(row.site), (bySite.get(String(row.site)) ?? 0) + Number(row.value));
    }
    const breakdown = breakdownFrom(totals, bySite, (code) => ctx.checkKind?.(code));
    const familyTotal = (family: string) => {
      let n = 0;
      for (const [metric, value] of totals) if (metric.startsWith(`${family}:`)) n += value;
      return n;
    };

    // Every plottable metric with its total in the window, so an empty one reads as empty.
    const charts: BehaviourChartOption[] = [
      ...overview.map((o) => ({
        id: o.id,
        label: headlineRate(o.id)!.label,
        kind: "rate" as const,
        count: o.count,
        denominator: o.denominator,
      })),
      ...MIX_FAMILIES.map((f) => ({
        id: mixMetricId(f.family),
        label: f.label,
        kind: "count" as const,
        count: familyTotal(f.family),
        denominator: null,
      })),
    ];

    // Series of the chosen metric: a rate per bucket and group (one line per group,
    // like the scorecard), or a keyed family's counts per bucket and key over the
    // selected group (or everything under the filters).
    let points: BehaviourSeriesPoint[] = [];
    if (chosen && "rate" in chosen) {
      const rate = chosen.rate;
      const seriesRows = rollupSums(db, base, ["bucket", groupBy], { names: [...rate.numerator, rate.denominator] }, bucketMs);
      const byBucket = new Map<string, { bucket: number; group: string; sums: Map<string, number> }>();
      for (const row of seriesRows) {
        const group = groupOf(row);
        const bucket = Number(row.bucket);
        const k = `${bucket}\u0000${group}`;
        let entry = byBucket.get(k);
        if (!entry) byBucket.set(k, (entry = { bucket, group, sums: new Map() }));
        const metric = String(row.metric);
        entry.sums.set(metric, (entry.sums.get(metric) ?? 0) + Number(row.value));
      }
      points = [...byBucket.values()]
        .map(({ bucket, group, sums }) => ({ bucket, group, ...rateOf(rate, sums) }))
        .sort((a, b) => a.bucket - b.bucket || (a.group < b.group ? -1 : 1));
    } else if (chosen) {
      const prefix = `${chosen.family}:`;
      const byKey = new Map<string, BehaviourSeriesPoint>();
      for (const row of rollupSums(db, scoped, ["bucket"], { prefixes: [chosen.family] }, bucketMs)) {
        const bucket = Number(row.bucket);
        const group = String(row.metric).slice(prefix.length);
        const k = `${bucket}\u0000${group}`;
        const p = byKey.get(k) ?? { bucket, group, count: 0, denominator: 0, rate: 0 };
        p.count += Number(row.value);
        p.rate = p.count;
        byKey.set(k, p);
      }
      points = [...byKey.values()]
        .filter((p) => p.count !== 0)
        .sort((a, b) => a.bucket - b.bucket || (a.group < b.group ? -1 : 1));
    }

    // Mix tables: each keyed family per scorecard group (how sends failed, what the
    // audit found after the correction, no_reply intent, judged refusal reasons).
    const mixSums = foldSums(rollupSums(db, base, [groupBy], { prefixes: MIX_FAMILIES.map((f) => f.family) }), groupOf);
    const mix: BehaviourMixTable[] = MIX_FAMILIES.map((f) => {
      const prefix = `${f.family}:`;
      const keyTotals = new Map<string, number>();
      const rows = scorecard.map(({ group }) => {
        const counts: Record<string, number> = {};
        let total = 0;
        for (const [metric, value] of mixSums.get(group) ?? []) {
          if (!metric.startsWith(prefix) || value === 0) continue;
          const key = metric.slice(prefix.length);
          counts[key] = (counts[key] ?? 0) + value;
          total += value;
          keyTotals.set(key, (keyTotals.get(key) ?? 0) + value);
        }
        return { group, total, counts };
      });
      const keys = [...keyTotals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
      return { id: f.family, label: f.label, keys, rows };
    });

    // Wire ids and families of the config entries on the page (the label switch).
    const models: Record<string, BehaviourModelInfo> = {};
    if (ctx.modelInfo) {
      const shown = [...facetModels, ...scorecard.flatMap((r) => r.members), ...(groupBy === "model" && !family ? scorecard.map((r) => r.group) : [])];
      for (const m of new Set(shown)) if (m !== "") models[m] = ctx.modelInfo(m);
    }

    // Markers touching what the chart displays (every scorecard group).
    const shownGroups = scorecard.map((r) => r.group);
    const markerFilter = {
      agents: filters.agent !== null ? [filters.agent] : groupBy === "agent" ? shownGroups : null,
      sites: filters.site !== null ? [filters.site] : groupBy === "site" ? shownGroups : null,
      models: groupBy === "model" ? shownGroups : null,
    };
    const markers = collapseMarkers(
      listBehaviourChanges(ctx.storage, since, until).filter((e) => eventMatches(e, markerFilter, ctx.familyOf, family)),
    );

    const incidents = listIncidentsInDb(db, ctx, {
      since,
      until,
      agent: filters.agent,
      site: filters.site,
      task: filters.task,
      restrict: restrict && groupBy !== "task" ? restrict : undefined,
      restrictTask: groupBy === "task" && filters.selected !== null ? filters.selected : null,
      type: query.incidentType ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit ?? INCIDENT_PAGE_DEFAULT,
    });

    return {
      window: query.window,
      since,
      until,
      groupBy,
      family,
      filters,
      metric: chosen?.id ?? null,
      rates: HEADLINE_RATES.map((r) => ({ ...r, numerator: [...r.numerator] })),
      charts,
      scorecard,
      overview: { bucketMs, metrics: overview },
      series: { metric: chosen?.id ?? null, kind: chosen && "family" in chosen ? "count" : "rate", bucketMs, points },
      breakdown,
      mix,
      models,
      markers,
      incidents,
      facets,
      pendingHours: ctx.pendingHours?.() ?? 0,
      audit: ctx.auditProgress?.() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Incident log
// ---------------------------------------------------------------------------

interface IncidentQuery {
  since: number;
  until: number;
  agent: string | null;
  site: string | null;
  task: string | null;
  restrict?: { dim: BehaviourGroupBy; values: string[] };
  restrictTask: string | null;
  type: BehaviourIncidentType | null;
  cursor: string | null;
  limit: number;
}

function parseCursor(cursor: string | null): { ts: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const ts = Number(cursor.slice(0, i));
  return Number.isFinite(ts) ? { ts, id: cursor.slice(i + 1) } : null;
}

interface CandidateRow {
  id: string; created_at: number; timeline_key: string; session_type: string; initial_preloads: string | null;
  contract_outcome: string | null; contract_nudges: number | null; room_label: string;
}

const OUTCOME_WORDS: Record<string, string> = {
  recovered: "recovered",
  redo_recovered: "recovered after a redo",
  gave_up_no_reply: "gave up (no reply)",
  exhausted: "exhausted",
};

const REFUSAL_OUTCOME_WORDS: Record<string, string> = {
  fallover: "fell over to the next chain member",
  failed: "failed",
  observed: "observed",
  exhausted_send_last: "rule exhausted, last attempt sent",
  exhausted_withheld: "rule exhausted, withheld",
  exhausted_parked: "rule exhausted, parked",
  exhausted_no_output: "rule exhausted, no output",
};

/** Build one incident row from a session's raw rows, or null when it has no incident. */
function incidentFor(db: Database.Database, ctx: ModelBehaviourReadContext, s: CandidateRow): BehaviourIncidentRow | null {
  const usage = db
    .prepare(
      `select ts, coalesce(nullif(logical_model_id, ''), model_id) as model from usage_events
        where agent_session_id = ? and class = 'agent_loop' order by ts, id`,
    )
    .all(s.id) as Array<{ ts: number; model: string }>;
  const modelAt = (ts: number | null): string | null => {
    if (usage.length === 0) return null;
    if (ts === null) return usage[usage.length - 1]!.model;
    let model = usage[0]!.model;
    for (const u of usage) {
      if (u.ts > ts) break;
      model = u.model;
    }
    return model;
  };
  const refusals = db
    .prepare(
      `select ts, branch_no, site, served_model, kind, reason, outcome, to_model, decision_evaluation_id
         from refusal_events where agent_session_id = ? order by ts, id`,
    )
    .all(s.id) as Array<{
    ts: number; branch_no: number; site: string; served_model: string | null; kind: string; reason: string;
    outcome: string; to_model: string | null; decision_evaluation_id: number | null;
  }>;
  const attempts = db
    .prepare(
      `select branch_no, redo_no, attempt_no, ts, served_model, primary_type from contract_attempts
        where agent_session_id = ? order by branch_no, redo_no, attempt_no`,
    )
    .all(s.id) as Array<{ branch_no: number; redo_no: number; attempt_no: number; ts: number | null; served_model: string | null; primary_type: string | null }>;
  const branches = db
    .prepare(`select branch_no, reason, from_model, to_model, created_at from agent_session_branches where session_id = ? order by branch_no`)
    .all(s.id) as Array<{ branch_no: number; reason: string; from_model: string | null; to_model: string | null; created_at: number }>;
  const decisions = db
    .prepare(
      `select id, ts, checkpoint, branch_no, tool_call_id, attempt_no, consequence, verdict_json
         from decision_evaluations where agent_session_id = ? and point = 'checks'
          and (consequence in ('revise', 'overridden') or checkpoint = 'ending') order by ts, id`,
    )
    .all(s.id) as Array<{
    id: number; ts: number; checkpoint: string | null; branch_no: number | null; tool_call_id: string | null;
    attempt_no: number | null; consequence: string | null; verdict_json: string | null;
  }>;
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const toolCallOf = (id: number | null) => {
    if (id === null) return null;
    const d = decisionById.get(id);
    if (d) return d.tool_call_id;
    const row = db.prepare(`select tool_call_id from decision_evaluations where id = ?`).get(id) as { tool_call_id: string | null } | undefined;
    return row?.tool_call_id ?? null;
  };

  const models: string[] = [];
  const touch = (m: string | null) => {
    if (m && !models.includes(m)) models.push(m);
  };
  type Anchor = { ts: number; branchNo: number; toolCallId: string | null; attemptNo: number | null };
  const anchors: Anchor[] = [];
  const parts: string[] = [];

  // Refusals.
  for (const r of refusals) {
    touch(r.served_model ?? modelAt(r.ts));
    anchors.push({ ts: r.ts, branchNo: r.branch_no, toolCallId: toolCallOf(r.decision_evaluation_id), attemptNo: null });
  }
  if (refusals.length === 1) {
    const r = refusals[0]!;
    const by = r.served_model ?? modelAt(r.ts);
    const next = r.outcome === "redo" ? `redone on ${r.to_model ?? "the rule's model"}` : REFUSAL_OUTCOME_WORDS[r.outcome] ?? r.outcome;
    parts.push(`${r.kind === "hard" ? "refused" : "judged a refusal"} (${r.reason})${by ? ` by ${by}` : ""}, ${next}`);
  } else if (refusals.length > 1) {
    const reasons = [...new Set(refusals.map((r) => r.reason))].join(", ");
    const last = refusals[refusals.length - 1]!;
    const lastWord = last.outcome === "redo" ? `last redone on ${last.to_model ?? "the rule's model"}` : `last ${REFUSAL_OUTCOME_WORDS[last.outcome] ?? last.outcome}`;
    parts.push(`refused ${refusals.length}× (${reasons}), ${lastWord}`);
  }

  // Send contract.
  const nudged = s.contract_nudges ?? attempts.filter((a) => a.redo_no === 0 && a.attempt_no > 0).length;
  const failed = attempts.filter((a) => a.primary_type !== null);
  for (const a of failed) {
    touch(a.served_model ?? modelAt(a.ts));
    anchors.push({ ts: a.ts ?? s.created_at, branchNo: a.branch_no, toolCallId: null, attemptNo: a.attempt_no });
  }
  if (nudged > 0) {
    const word = s.contract_outcome ? OUTCOME_WORDS[s.contract_outcome] : undefined;
    parts.push(`nudged ${nudged}×${word ? `, ${word}` : ""}`);
  }

  // Redos: hard-refusal redos have no branch; soft and contract redos fork one.
  const contractRedos = branches.filter((b) => b.reason === "contract_redo");
  for (const b of branches) {
    touch(b.from_model);
    anchors.push({ ts: b.created_at, branchNo: b.branch_no, toolCallId: null, attemptNo: null });
  }
  const redone = refusals.filter((r) => r.outcome === "redo").length + contractRedos.length;
  if (contractRedos.length > 0) parts.push(`send-contract redo${contractRedos.length > 1 ? ` ${contractRedos.length}×` : ""}`);

  // Revisions, overrides, judged endings (distinct per judged call).
  const revised = new Set<string>();
  const overridden = new Set<string>();
  const endings = new Map<string, string[]>();
  for (const d of decisions) {
    const anchor = `${d.branch_no ?? 0}|${d.checkpoint ?? ""}|${d.tool_call_id ?? ""}|${d.attempt_no ?? ""}`;
    const fired = firedChecks(d.verdict_json);
    let incident = false;
    if (d.consequence === "revise") {
      revised.add(anchor);
      incident = true;
    } else if (d.consequence === "overridden") {
      overridden.add(anchor);
      incident = true;
    }
    if (d.checkpoint === "ending" && fired.length > 0) {
      const codes = endings.get(anchor) ?? [];
      for (const f of fired) if (!codes.includes(f.code)) codes.push(f.code);
      endings.set(anchor, codes);
      incident = true;
    }
    if (incident) {
      touch(modelAt(d.ts));
      anchors.push({ ts: d.ts, branchNo: d.branch_no ?? 0, toolCallId: d.tool_call_id, attemptNo: d.attempt_no });
    }
  }
  if (revised.size > 0) parts.push(`revised ${revised.size}×`);
  if (overridden.size > 0) parts.push(`overridden ${overridden.size}×`);
  if (endings.size > 0) parts.push(`ending judged: ${[...new Set([...endings.values()].flat())].join(", ")}`);

  const types: BehaviourIncidentType[] = [];
  if (refusals.length > 0) types.push("refusal");
  if (nudged > 0 || failed.some((a) => a.attempt_no > 0)) types.push("nudge");
  if (redone > 0 || branches.length > 0) types.push("redo");
  if (revised.size + overridden.size > 0) types.push("revision");
  if (endings.size > 0) types.push("ending");
  if (types.length === 0) return null;

  anchors.sort((a, b) => a.ts - b.ts);
  const first = anchors[0];
  return {
    sessionId: s.id,
    ts: s.created_at,
    agent: ctx.agentForTimelineKey(s.timeline_key),
    timelineKey: s.timeline_key,
    roomLabel: s.room_label,
    site: s.session_type,
    models,
    types,
    chips: {
      refused: refusals.length,
      redone,
      nudged,
      revised: revised.size,
      overridden: overridden.size,
      endings: endings.size,
    },
    outcome: parts.join("; "),
    link: {
      sessionId: s.id,
      branchNo: first?.branchNo ?? 0,
      toolCallId: first?.toolCallId ?? null,
      attemptNo: first?.attemptNo ?? null,
    },
  };
}

/** A decision row's `verdict_json` names at least one fired check (`{ fired: [...] }` or a bare array). */
const FIRED_SQL = `(case when json_valid(d.verdict_json) then
     case json_type(d.verdict_json) when 'array' then json_array_length(d.verdict_json)
                                    when 'object' then coalesce(json_array_length(d.verdict_json, '$.fired'), 0)
                                    else 0 end
   else 0 end) > 0`;

/**
 * The SQL evidence of each incident type, so the candidate walk visits only
 * sessions that can match (a type filter narrows the scan itself, never just the
 * rows of a fixed-size scan). Mirrors {@link incidentFor}'s `types`.
 */
const INCIDENT_TYPE_SQL: Record<BehaviourIncidentType, string> = {
  refusal: `exists (select 1 from refusal_events r where r.agent_session_id = s.id)`,
  nudge: `(coalesce(s.contract_nudges, 0) > 0
           or exists (select 1 from contract_attempts a where a.agent_session_id = s.id and a.attempt_no > 0))`,
  redo: `(exists (select 1 from agent_session_branches b where b.session_id = s.id)
          or exists (select 1 from refusal_events r where r.agent_session_id = s.id and r.outcome = 'redo'))`,
  revision: `exists (select 1 from decision_evaluations d where d.agent_session_id = s.id and d.point = 'checks'
                       and d.consequence in ('revise', 'overridden'))`,
  // A judged ending counts only when it fired: the offline audit writes an unfired
  // row for nearly every ending, which must not make every session a candidate.
  ending: `exists (select 1 from decision_evaluations d where d.agent_session_id = s.id and d.point = 'checks'
                     and d.checkpoint = 'ending' and ${FIRED_SQL})`,
};

function listIncidentsInDb(db: Database.Database, ctx: ModelBehaviourReadContext, q: IncidentQuery): BehaviourIncidentPage {
  const limit = Math.min(Math.max(1, Math.floor(q.limit) || INCIDENT_PAGE_DEFAULT), INCIDENT_PAGE_MAX);
  let cursor = parseCursor(q.cursor);
  const rows: BehaviourIncidentRow[] = [];
  const evidence = q.type !== null
    ? INCIDENT_TYPE_SQL[q.type]
    : `(${Object.values(INCIDENT_TYPE_SQL).join("\n          or ")})`;
  const stmt = db.prepare(
    `select s.id, s.created_at, s.timeline_key, s.session_type, s.initial_preloads, s.contract_outcome, s.contract_nudges,
            coalesce((select m.display_name from room_metadata m where m.timeline_key = s.timeline_key), s.timeline_key) as room_label
       from agent_sessions s
      where s.created_at >= @since and s.created_at < @until
        and (@cts is null or s.created_at < @cts or (s.created_at = @cts and s.id < @cid))
        and ${evidence}
      order by s.created_at desc, s.id desc
      limit @batch`,
  );
  let scanned = 0;
  let exhausted = false;
  while (rows.length < limit && scanned < INCIDENT_SCAN_CAP) {
    const batch = stmt.all({
      since: q.since,
      until: q.until,
      cts: cursor?.ts ?? null,
      cid: cursor?.id ?? "",
      batch: INCIDENT_BATCH,
    }) as CandidateRow[];
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const s of batch) {
      scanned++;
      cursor = { ts: s.created_at, id: s.id };
      const agent = ctx.agentForTimelineKey(s.timeline_key);
      if (q.agent !== null && (agent ?? "") !== q.agent) continue;
      const tasks = sessionTasks(s.initial_preloads);
      if (q.task !== null && !tasks?.includes(q.task)) continue;
      if (q.restrictTask !== null && !tasks?.includes(q.restrictTask)) continue;
      if (q.restrict?.dim === "agent" && !q.restrict.values.includes(agent ?? "")) continue;
      const row = incidentFor(db, ctx, s);
      if (!row) continue;
      if (q.site !== null && row.site !== q.site && !siteTouched(db, s.id, q.site)) continue;
      if (q.restrict?.dim === "site" && !q.restrict.values.some((v) => v === row.site || siteTouched(db, s.id, v))) continue;
      if (q.restrict?.dim === "model" && !row.models.some((m) => q.restrict!.values.includes(m))) continue;
      if (q.type !== null && !row.types.includes(q.type)) continue;
      rows.push(row);
      if (rows.length >= limit) break;
    }
    if (batch.length < INCIDENT_BATCH && rows.length < limit) {
      exhausted = true;
      break;
    }
  }
  return { rows, nextCursor: exhausted || !cursor ? null : `${cursor.ts}:${cursor.id}` };
}

/** Whether a session has a refusal at `site` (a record turn inside a chat session). */
function siteTouched(db: Database.Database, sessionId: string, site: string): boolean {
  return !!db.prepare(`select 1 from refusal_events where agent_session_id = ? and site = ? limit 1`).get(sessionId, site);
}

/** One page of the incident log (the `/api/models/behaviour/incidents` route). */
export function readBehaviourIncidents(
  ctx: ModelBehaviourReadContext,
  query: ModelBehaviourQuery,
): BehaviourIncidentPage {
  const now = query.now ?? Date.now();
  const since = behaviourWindowSince(query.window, now);
  const family = query.family && query.groupBy === "model";
  return ctx.storage.read((db) => {
    let restrict: IncidentQuery["restrict"];
    let restrictTask: string | null = null;
    if (query.selected) {
      if (query.groupBy === "task") restrictTask = query.selected;
      else if (query.groupBy === "model" && family) {
        const models = (db
          .prepare(`select distinct model from model_behaviour_rollups where hour >= ?`)
          .all(floorHour(since)) as Array<{ model: string }>).map((r) => r.model);
        restrict = { dim: "model", values: groupMembers("model", true, query.selected, models, ctx.familyOf) };
      } else restrict = { dim: query.groupBy, values: [query.selected] };
    }
    return listIncidentsInDb(db, ctx, {
      since,
      until: now,
      agent: query.agent ?? null,
      site: query.site ?? null,
      task: query.task ?? null,
      restrict,
      restrictTask,
      type: query.incidentType ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit ?? INCIDENT_PAGE_DEFAULT,
    });
  });
}
