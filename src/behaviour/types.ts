/**
 * Wire types of the model behaviour read API (spec REFUSAL-HANDLING §12.3, §12.4):
 * `GET /api/models/behaviour` and `GET /api/models/behaviour/incidents`. The
 * console mirrors them as Effect schemas (console/src/lib/schemas.ts).
 */

/** Typed change events (spec §12.4). */
export const BEHAVIOUR_CHANGE_KINDS = [
  "head_model_changed",
  "chain_changed",
  "preference_changed",
  "thinking_changed",
  "routing_task_changed",
  "rule_changed",
  "check_changed",
  "code_changed",
  "config_changed",
  "prompt_changed",
] as const;
export type BehaviourChangeKind = (typeof BEHAVIOUR_CHANGE_KINDS)[number];

/** A change event before it is stored. Empty `agents`/`sites`/`models` = touches every one. */
export interface BehaviourChangeDraft {
  kind: BehaviourChangeKind;
  sentence: string;
  path?: string;
  old?: unknown;
  new?: unknown;
  agents: string[];
  sites: string[];
  models: string[];
  detail?: Record<string, unknown>;
}

/** A stored change event, as served. */
export interface BehaviourChangeEvent {
  id: number;
  ts: number;
  kind: BehaviourChangeKind;
  sentence: string;
  path: string | null;
  /** Previous / new value (JSON-decoded); null when absent. */
  old: unknown;
  new: unknown;
  agents: string[];
  sites: string[];
  models: string[];
  /** `prompt_changed`: `{ prompt: "system" | "model", oldHash, newHash }`. */
  detail: Record<string, unknown> | null;
}

/** One chart marker: change events within a few minutes of each other (one deploy). */
export interface BehaviourMarker {
  /** Time of the first event. */
  ts: number;
  /** Time of the last event (== ts for a single event). */
  until: number;
  kinds: BehaviourChangeKind[];
  events: BehaviourChangeEvent[];
}

export type BehaviourWindow = "today" | "24h" | "7d" | "30d" | "month" | "all";
export type BehaviourGroupBy = "model" | "agent" | "site" | "task";

/** One scorecard cell: a headline rate over the window. */
export interface BehaviourRateCell {
  /** numerator / denominator × scale; null when the denominator is 0. */
  rate: number | null;
  /** Raw numerator count. */
  count: number;
  denominator: number;
  /** The same rate over the previous window of equal length; null for `all` or no data. */
  previousRate: number | null;
  /** rate − previousRate; null when either is null. */
  change: number | null;
  /** denominator < the rate's minSample: show greyed. */
  lowSample: boolean;
}

export interface BehaviourScorecardRow {
  /** Group value (model id, family, agent name, site or task). "" = unknown / legacy. */
  group: string;
  /** Under the family toggle: the config entries folded into this row. */
  members: string[];
  volume: { requests: number; sessions: number; messages: number };
  /** Keyed by headline rate id. */
  cells: Record<string, BehaviourRateCell>;
}

export interface BehaviourRateDefinition {
  id: string;
  label: string;
  numerator: string[];
  denominator: string;
  scale: number;
  minSample: number;
}

export interface BehaviourSeriesPoint {
  /** Bucket start (ms epoch, UTC-aligned). */
  bucket: number;
  group: string;
  count: number;
  denominator: number;
  rate: number | null;
}

/** One headline rate over the window, all groups combined, with its buckets (the overview chart). */
export interface BehaviourOverviewMetric {
  id: string;
  count: number;
  denominator: number;
  rate: number | null;
  /** Buckets with a denominator or a count, ascending. */
  points: Array<{ bucket: number; count: number; denominator: number; rate: number | null }>;
}

/** A metric the chart can plot, with its total in the window (0 = nothing recorded). */
export interface BehaviourChartOption {
  /** A headline rate id, or `mix:<family>` (a keyed family, one line per key). */
  id: string;
  label: string;
  kind: "rate" | "count";
  /** Rates: the numerator over every group; families: the family's total over the selected group. */
  count: number;
  /** Rates: the denominator over every group; null for families. */
  denominator: number | null;
}

/** A keyed family per scorecard group (e.g. failure types per model). */
export interface BehaviourMixTable {
  /** The family (`failure_type`, `after_correction`, `no_reply_intent`, `judged_refusal_reason`). */
  id: string;
  label: string;
  /** Keys present in the window, most frequent first. */
  keys: string[];
  /** One per scorecard row, in scorecard order. */
  rows: Array<{ group: string; total: number; counts: Record<string, number> }>;
}

/** A config entry's wire model id and configured family (null when unset or no longer configured). */
export interface BehaviourModelInfo {
  id: string | null;
  family: string | null;
}

/**
 * The offline audit's backlog, counted in the background by the audit worker (never
 * on the request path). `stages` in processing order: the send-contract
 * classification of sessions with nudges or a no_reply ending, then the refusal
 * checks of those sessions, then every other session.
 */
export interface AuditBacklogProgress {
  /** When the count finished (ms epoch). */
  countedAt: number;
  /** Settled, auditable sessions (generation sessions excluded). */
  sessions: number;
  /** Of which have nudges or ended with no_reply (the backlog's first stages). */
  prioritySessions: number;
  stages: Array<{ id: string; label: string; done: number; remaining: number }>;
  /** The backlog stage the worker is walking now; null when idle or between passes. */
  current: string | null;
}

export interface BehaviourCount {
  key: string;
  count: number;
}

export interface BehaviourCheckBreakdown {
  code: string;
  hits: number;
  revisions: number;
  overrides: number;
}

export interface BehaviourBreakdown {
  refusals: {
    hard: number;
    judged: number;
    redos: number;
    byReason: BehaviourCount[];
    bySite: BehaviourCount[];
    byMethod: BehaviourCount[];
    outcomes: BehaviourCount[];
    discardedBranchCostUsd: number;
  };
  contract: {
    nudgedSessions: number;
    failedAttempts: number;
    /** Nudges until recovery: "1", "2", "3" (3 or more), "after_redo", "gave_up", "exhausted". */
    untilRecovery: BehaviourCount[];
    failureTypes: BehaviourCount[];
    redos: number;
    discardedBranchCostUsd: number;
    /** What happened to the message after the nudges (`after_correction`, the offline audit's runs). */
    afterCorrection: BehaviourCount[];
    /** `no_reply_intent` choices of judged endings after a nudge (live gate and audit). */
    noReplyIntent: BehaviourCount[];
  };
  style: {
    hits: number;
    messagesWithHit: number;
    revisions: number;
    overrides: number;
    /** Style checks only. */
    perCheck: BehaviourCheckBreakdown[];
  };
  /** Every fired check code, any kind. */
  checks: BehaviourCheckBreakdown[];
}

export const INCIDENT_TYPES = ["refusal", "nudge", "redo", "revision", "ending"] as const;
export type BehaviourIncidentType = (typeof INCIDENT_TYPES)[number];

export interface BehaviourIncidentRow {
  sessionId: string;
  /** Session creation time. */
  ts: number;
  agent: string | null;
  timelineKey: string;
  /** Room label (room_metadata), else the timeline key. */
  roomLabel: string;
  site: string;
  /** Models the incidents are attributed to, in first-seen order. */
  models: string[];
  types: BehaviourIncidentType[];
  chips: { refused: number; redone: number; nudged: number; revised: number; overridden: number; endings: number };
  /** One-line outcome, e.g. "refused (distillation) by model_a, redone on model_b; nudged 2×, recovered". */
  outcome: string;
  /** Where the first incident happened: the conversation view's target. */
  link: { sessionId: string; branchNo: number; toolCallId: string | null; attemptNo: number | null };
}

export interface BehaviourIncidentPage {
  rows: BehaviourIncidentRow[];
  /** Pass back as `cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

export interface ModelBehaviourFilters {
  agent: string | null;
  site: string | null;
  task: string | null;
  /** The selected group value (scorecard click): scopes the breakdown and the incident log. */
  selected: string | null;
}

export interface ModelBehaviourResponse {
  window: BehaviourWindow;
  since: number;
  until: number;
  groupBy: BehaviourGroupBy;
  /** Group config entries by family (`[models.*].family`, else the wire model id; model grouping only). */
  family: boolean;
  filters: ModelBehaviourFilters;
  /** What the chart shows: a headline rate id, `mix:<family>`, or null for the overview. */
  metric: string | null;
  rates: BehaviourRateDefinition[];
  /** Every metric the chart can plot, with its total in the window. */
  charts: BehaviourChartOption[];
  scorecard: BehaviourScorecardRow[];
  /** Every headline rate over time, all groups combined (the default chart). */
  overview: { bucketMs: number; metrics: BehaviourOverviewMetric[] };
  /**
   * The chosen metric over time: for a rate one point per bucket and group; for a
   * family (`kind: "count"`) one point per bucket and key (`group` = the key, `rate`
   * = the count). Empty for the overview.
   */
  series: { metric: string | null; kind: "rate" | "count"; bucketMs: number; points: BehaviourSeriesPoint[] };
  breakdown: BehaviourBreakdown;
  /** Keyed families per scorecard group. */
  mix: BehaviourMixTable[];
  /** Wire id and configured family of each config entry shown (group by model). */
  models: Record<string, BehaviourModelInfo>;
  markers: BehaviourMarker[];
  incidents: BehaviourIncidentPage;
  /** Distinct values present in the window, for the filter menus. */
  facets: { agents: string[]; sites: string[]; models: string[]; tasks: string[] };
  /** Rollup hours still waiting for a recompute (0 = fully current). */
  pendingHours: number;
  /** The offline audit's backlog progress; null when the audit worker does not run. */
  audit: AuditBacklogProgress | null;
}
