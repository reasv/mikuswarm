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
    /** What happened to the message (`after_correction`, offline audit): not yet derived, always []. */
    afterCorrection: BehaviourCount[];
    /** `no_reply_intent` after a nudge: not yet derived, always []. */
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
  /** Group by `[models.*].family` instead of the config entry (model grouping only). */
  family: boolean;
  filters: ModelBehaviourFilters;
  /** The selected headline rate id the series shows. */
  metric: string;
  rates: BehaviourRateDefinition[];
  scorecard: BehaviourScorecardRow[];
  series: { metric: string; bucketMs: number; points: BehaviourSeriesPoint[] };
  breakdown: BehaviourBreakdown;
  markers: BehaviourMarker[];
  incidents: BehaviourIncidentPage;
  /** Distinct values present in the window, for the filter menus. */
  facets: { agents: string[]; sites: string[]; models: string[]; tasks: string[] };
  /** Rollup hours still waiting for a recompute (0 = fully current). */
  pendingHours: number;
}
