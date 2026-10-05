/**
 * Model behaviour metrics (spec REFUSAL-HANDLING §12.3): the counters the hourly
 * rollups keep, and the headline rates the `/models` page derives from them.
 *
 * Every counter is attributed to the model that served the specific request or
 * attempt (the logical `[models.*]` id), never to the session's head; the hour is
 * the session's creation hour for session rows, the row's own time for sessionless
 * rows (src/storage/model-behaviour-schema.ts).
 */

export interface MetricDefinition {
  /** Where the counter comes from (raw table and predicate). */
  source: string;
  /** How the model is attributed. */
  model: string;
}

/**
 * Fixed counters. A counter is a sum; rates divide one counter (or the sum of a few)
 * by another (see {@link HEADLINE_RATES}).
 */
export const MODEL_BEHAVIOUR_METRICS = {
  requests: {
    source: "usage_events rows of class agent_loop (one per committed or refused request); class caption rows count at site caption",
    model: "the row's logical_model_id (the served chain member)",
  },
  sessions: {
    source: "agent_sessions: a session counts once for every model that served at least one of its agent_loop requests",
    model: "each serving model",
  },
  messages_sent: {
    source: "timeline_events with role assistant and an agent_session_id (continuation chunks of one split message excluded)",
    model: "the model of the session's latest agent_loop request at or before the message",
  },
  message_tokens: {
    source: "context-tokenizer count of the same messages' bodies (continuation chunks included)",
    model: "as messages_sent",
  },
  refusals_hard: {
    source: "refusal_events with kind hard",
    model: "served_model, else the session's model at the event",
  },
  refusals_judged: {
    source: "refusal_events with kind soft (judged or pattern detection)",
    model: "as refusals_hard",
  },
  refusal_redos: {
    source: "refusal_events with outcome redo (a rule entry took over)",
    model: "the refusing model (served_model)",
  },
  refusal_branch_cost_usd: {
    source: "agent_session_branches with reason refusal_redo: sum of cost_usd",
    model: "from_model",
  },
  sessions_nudged: {
    source: "sessions with contract_nudges > 0 or a contract attempt after a nudge",
    model: "the served model of the session's first failed attempt",
  },
  contract_recovered_1: { source: "sessions with contract_outcome recovered after 1 nudge", model: "as sessions_nudged" },
  contract_recovered_2: { source: "sessions with contract_outcome recovered after 2 nudges", model: "as sessions_nudged" },
  contract_recovered_3: { source: "sessions with contract_outcome recovered after 3 or more nudges", model: "as sessions_nudged" },
  contract_recovered_after_redo: { source: "sessions with contract_outcome redo_recovered", model: "as sessions_nudged" },
  contract_gave_up: { source: "sessions with contract_outcome gave_up_no_reply", model: "as sessions_nudged" },
  contract_exhausted: { source: "sessions with contract_outcome exhausted", model: "as sessions_nudged" },
  contract_redos: {
    source: "agent_session_branches with reason contract_redo",
    model: "from_model, else as sessions_nudged",
  },
  contract_branch_cost_usd: {
    source: "agent_session_branches with reason contract_redo: sum of cost_usd",
    model: "as contract_redos",
  },
  contract_failed_attempts: {
    source: "contract_attempts with a primary failure type",
    model: "the attempt's served_model, else the session's model at the attempt",
  },
  style_hits: {
    source: "decision_evaluations of point checks: distinct (judged call, check) pairs whose fired check is a style check",
    model: "the session's model at the evaluation",
  },
  messages_with_style_hit: {
    source: "distinct judged calls with at least one style hit",
    model: "as style_hits",
  },
  revisions: {
    source: "distinct judged calls with a decision row whose consequence is revise",
    model: "as style_hits",
  },
  overrides: {
    source: "distinct judged calls with a decision row whose consequence is overridden",
    model: "as style_hits",
  },
} as const satisfies Record<string, MetricDefinition>;

export type ModelBehaviourMetric = keyof typeof MODEL_BEHAVIOUR_METRICS;

/**
 * Keyed counter families: the metric name is `<prefix>:<key>` (e.g.
 * `refusal_reason:distillation`, `check_hits:style_delve`). They feed the
 * breakdown blocks; the keys are open vocabularies (operator reasons and checks).
 */
export const MODEL_BEHAVIOUR_METRIC_FAMILIES = {
  refusal_reason: { source: "refusal_events.reason (hard and judged)", model: "as refusals_hard" },
  refusal_method: { source: "refusal_events.method", model: "as refusals_hard" },
  refusal_outcome: { source: "refusal_events.outcome (rule outcomes)", model: "as refusals_hard" },
  failure_type: { source: "contract_attempts.primary_type", model: "as contract_failed_attempts" },
  check_hits: { source: "distinct (judged call, check) pairs per fired check code, every kind", model: "as style_hits" },
  check_revisions: { source: "fired codes of decision rows whose consequence is revise, per distinct judged call", model: "as style_hits" },
  check_overrides: { source: "fired codes of decision rows whose consequence is overridden, per distinct judged call", model: "as style_hits" },
  after_correction: {
    source:
      "session_audits (audit send_contract, status done): per nudged run, what happened to the message (§7.3: same, " +
      "minor_rewording, parts_removed, rewritten_same_substance, different_substance, switched_to_no_reply, nothing, " +
      "or uncertain below min_confidence)",
    model: "the served model of the run's first failed attempt, else the session's model at it",
  },
  no_reply_intent: {
    source: "decision rows of point checks: the no_reply_intent choice (§7.4), once per judged ending",
    model: "as style_hits",
  },
} as const satisfies Record<string, MetricDefinition>;

export type ModelBehaviourMetricFamily = keyof typeof MODEL_BEHAVIOUR_METRIC_FAMILIES;

export function familyMetric<F extends ModelBehaviourMetricFamily>(family: F, key: string): `${F}:${string}` {
  return `${family}:${key}`;
}

/** A headline rate: the sum of the numerator counters over the denominator counter. */
export interface HeadlineRate {
  id: string;
  label: string;
  numerator: readonly ModelBehaviourMetric[];
  denominator: ModelBehaviourMetric;
  /** Multiplier applied to the ratio (1000 for "per 1k tokens"). */
  scale: number;
  /** Rates over a smaller denominator are flagged `lowSample` (greyed on the page). */
  minSample: number;
}

/** The scorecard columns (spec §12.3 item 1), in display order. */
export const HEADLINE_RATES: readonly HeadlineRate[] = [
  { id: "refusals_hard_per_request", label: "Hard refusals per request", numerator: ["refusals_hard"], denominator: "requests", scale: 1, minSample: 50 },
  { id: "refusals_judged_per_request", label: "Judged refusals per request", numerator: ["refusals_judged"], denominator: "requests", scale: 1, minSample: 50 },
  { id: "nudged_per_session", label: "Sessions nudged", numerator: ["sessions_nudged"], denominator: "sessions", scale: 1, minSample: 20 },
  {
    id: "recovered_per_nudged",
    label: "Recovered after nudges",
    numerator: ["contract_recovered_1", "contract_recovered_2", "contract_recovered_3", "contract_recovered_after_redo"],
    denominator: "sessions_nudged",
    scale: 1,
    minSample: 5,
  },
  { id: "contract_redos_per_session", label: "Send-contract redos per session", numerator: ["contract_redos"], denominator: "sessions", scale: 1, minSample: 20 },
  { id: "contract_exhaustions_per_session", label: "Send-contract exhaustions per session", numerator: ["contract_exhausted"], denominator: "sessions", scale: 1, minSample: 20 },
  { id: "style_hits_per_1k_tokens", label: "Style hits per 1k message tokens", numerator: ["style_hits"], denominator: "message_tokens", scale: 1000, minSample: 2000 },
  { id: "messages_with_style_hit", label: "Messages with a style hit", numerator: ["messages_with_style_hit"], denominator: "messages_sent", scale: 1, minSample: 20 },
  { id: "refusal_redos_per_session", label: "Refusal redos per session", numerator: ["refusal_redos"], denominator: "sessions", scale: 1, minSample: 20 },
];

export function headlineRate(id: string): HeadlineRate | undefined {
  return HEADLINE_RATES.find((r) => r.id === id);
}
