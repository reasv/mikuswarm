/**
 * Hourly model behaviour rollups (spec REFUSAL-HANDLING §12.3 "Storage").
 *
 * Triggers on the raw tables mark the hour a write belongs to dirty
 * (src/storage/model-behaviour-schema.ts); {@link ModelBehaviourRollups} recomputes
 * dirty hours from the raw tables through the single-writer queue and replaces that
 * hour's rows. The maintenance path and {@link ModelBehaviourRollups.rebuild} run
 * the same per-hour computation ({@link computeHourRollups}), so a maintained table
 * and a rebuilt one are identical by construction.
 */

import type Database from "better-sqlite3";
import { excludedBranchNumbers } from "../agent/contract.js";
import { DUPLICATE_CHECK_CODE } from "../checks/builtin/duplicate.js";
import { estimateTokens } from "../context/tokens.js";
import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import { MARK_ALL_MODEL_BEHAVIOUR_HOURS_DIRTY, MODEL_BEHAVIOUR_HOUR_MS } from "../storage/model-behaviour-schema.js";
import { familyMetric, type ModelBehaviourMetric, type ModelBehaviourMetricFamily } from "./metrics.js";

export interface RollupContext {
  /** Owning agent of a timeline key; null in legacy mode or when unresolvable. */
  agentForTimelineKey(timelineKey: string | null): string | null;
  /** Kind of a check code for the agent (`style` counts toward the style metrics). */
  checkKind?(code: string, agent: string | null): string | undefined;
  /**
   * Remedy of a check code for the agent (`revise` checks are the ones a revise
   * or an override is about); unknown = judged by kind (a refusal never revises).
   */
  checkRemedy?(code: string, agent: string | null): string | undefined;
  /** Message tokenizer; defaults to the context tokenizer. */
  countTokens?(text: string): number;
}

export interface RollupRow {
  hour: number;
  agent: string;
  site: string;
  model: string;
  metric: string;
  value: number;
}

export interface TaskRollupRow extends RollupRow {
  task: string;
}

interface SessionRow {
  id: string;
  timeline_key: string;
  session_type: string;
  created_at: number;
  contract_outcome: string | null;
  contract_nudges: number | null;
  initial_preloads: string | null;
}

interface UsageRow { sid: string; ts: number; model: string; estimated: number | null }
interface AttemptRow {
  sid: string; branch_no: number; redo_no: number; attempt_no: number; ts: number | null;
  served_model: string | null; primary_type: string | null;
}
interface RefusalRow {
  sid: string | null; ts: number; branch_no: number; site: string; agent: string | null; timeline_key: string | null;
  tasks_json: string | null; served_model: string | null; kind: string; reason: string; method: string; outcome: string;
}
interface BranchRow {
  sid: string; branch_no: number; reason: string; from_model: string | null; cost_usd: number | null;
  fork_index: number; message_count: number | null;
}
interface DecisionRow {
  id: number; sid: string; ts: number; checkpoint: string | null; branch_no: number | null;
  tool_call_id: string | null; attempt_no: number | null; consequence: string | null; verdict_json: string | null;
}
interface MessageRow { id: string; sid: string; received_at: number; body: string }
interface AuditRow { sid: string; verdict_json: string | null }

/** Parse a JSON string array (task labels); null when absent or malformed. */
function parseStringArray(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Task labels of a session: `SessionRoutingState.tasks` in `initial_preloads`, when present. */
export function sessionTasks(initialPreloads: string | null): string[] | null {
  if (!initialPreloads) return null;
  try {
    const v = JSON.parse(initialPreloads) as { tasks?: unknown };
    if (!Array.isArray(v?.tasks)) return null;
    const tasks = v.tasks.filter((x): x is string => typeof x === "string");
    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

/**
 * The checks a decision row fired, read from `verdict_json`: `{ fired: [{ code,
 * kind? }] }` (the gate's `GateVerdict.fired`), a bare array of the same, or codes
 * as strings. Anything else fired nothing.
 */
export function firedChecks(verdictJson: string | null): Array<{ code: string; kind?: string }> {
  if (!verdictJson) return [];
  try {
    const v = JSON.parse(verdictJson) as unknown;
    const list = Array.isArray(v) ? v : Array.isArray((v as { fired?: unknown })?.fired) ? (v as { fired: unknown[] }).fired : [];
    const out: Array<{ code: string; kind?: string }> = [];
    for (const item of list) {
      if (typeof item === "string") out.push({ code: item });
      else if (item && typeof (item as { code?: unknown }).code === "string") {
        const kind = (item as { kind?: unknown }).kind;
        out.push({ code: (item as { code: string }).code, ...(typeof kind === "string" ? { kind } : {}) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The `no_reply_intent` choice of a decision row (spec REFUSAL-HANDLING §7.4), read
 * from the checks point's `verdict_json.results[]` (`{ id: "no_reply_intent__<source>",
 * choice }`); undefined when the row did not ask it.
 */
export function noReplyIntentChoice(verdictJson: string | null): string | undefined {
  if (!verdictJson) return undefined;
  try {
    const v = JSON.parse(verdictJson) as { results?: unknown };
    if (!Array.isArray(v?.results)) return undefined;
    for (const r of v.results as Array<{ id?: unknown; choice?: unknown }>) {
      if (typeof r?.id === "string" && r.id.startsWith("no_reply_intent__") && typeof r.choice === "string") return r.choice;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The per-run send-contract diagnoses of an audit row (src/audit/contract-audit.ts
 * `RunDiagnosis`): `verdict_json.runs[]` with `afterCorrection.choice`, the first
 * failed attempt's `servedModel` and `ts`. Malformed entries are skipped.
 */
export function afterCorrectionRuns(
  verdictJson: string | null,
): Array<{ choice: string; servedModel: string | null; ts: number | null }> {
  if (!verdictJson) return [];
  try {
    const v = JSON.parse(verdictJson) as { runs?: unknown };
    if (!Array.isArray(v?.runs)) return [];
    const out: Array<{ choice: string; servedModel: string | null; ts: number | null }> = [];
    for (const run of v.runs as Array<Record<string, unknown>>) {
      const choice = (run?.["afterCorrection"] as { choice?: unknown } | null | undefined)?.choice;
      if (typeof choice !== "string") continue;
      out.push({
        choice,
        servedModel: typeof run["servedModel"] === "string" ? (run["servedModel"] as string) : null,
        ts: typeof run["ts"] === "number" ? (run["ts"] as number) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** A later chunk of one message split across several events (`assistant:<session>:<id>:<n>`, n > 0). */
function isContinuationChunk(eventId: string): boolean {
  const m = /^assistant:.+:(\d+)$/.exec(eventId);
  return m !== null && Number(m[1]) > 0;
}

class Accumulator {
  private readonly rows = new Map<string, RollupRow>();
  private readonly taskRows = new Map<string, TaskRollupRow>();

  constructor(private readonly hour: number) {}

  add(agent: string | null, site: string, model: string | null, metric: string, value: number, tasks: string[] | null): void {
    if (value === 0) return;
    const a = agent ?? "";
    const m = model ?? "";
    const key = `${a}\u0000${site}\u0000${m}\u0000${metric}`;
    const row = this.rows.get(key);
    if (row) row.value += value;
    else this.rows.set(key, { hour: this.hour, agent: a, site, model: m, metric, value });
    for (const task of new Set(tasks ?? [])) {
      const tkey = `${task}\u0000${key}`;
      const trow = this.taskRows.get(tkey);
      if (trow) trow.value += value;
      else this.taskRows.set(tkey, { hour: this.hour, task, agent: a, site, model: m, metric, value });
    }
  }

  result(): { rows: RollupRow[]; taskRows: TaskRollupRow[] } {
    return { rows: [...this.rows.values()], taskRows: [...this.taskRows.values()] };
  }
}

function groupBySession<T extends { sid: string | null }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    if (row.sid === null) continue;
    const list = out.get(row.sid);
    if (list) list.push(row);
    else out.set(row.sid, [row]);
  }
  return out;
}

/**
 * Recompute one hour's rollup rows from the raw tables: the sessions created in the
 * hour (with all their child rows) plus the sessionless rows timed in it.
 */
export function computeHourRollups(
  db: Database.Database,
  hour: number,
  ctx: RollupContext,
): { rows: RollupRow[]; taskRows: TaskRollupRow[] } {
  const end = hour + MODEL_BEHAVIOUR_HOUR_MS;
  const acc = new Accumulator(hour);
  const countTokens = ctx.countTokens ?? estimateTokens;
  const inHour = `(select id from agent_sessions where created_at >= @hour and created_at < @end)`;
  const p = { hour, end };

  const sessions = db
    .prepare(
      `select id, timeline_key, session_type, created_at, contract_outcome, contract_nudges, initial_preloads
         from agent_sessions where created_at >= @hour and created_at < @end`,
    )
    .all(p) as SessionRow[];

  if (sessions.length > 0) {
    const usage = groupBySession(
      db
        .prepare(
          `select agent_session_id as sid, ts, coalesce(nullif(logical_model_id, ''), model_id) as model, estimated
             from usage_events where class = 'agent_loop' and agent_session_id in ${inHour}
             order by ts, id`,
        )
        .all(p) as UsageRow[],
    );
    const attempts = groupBySession(
      db
        .prepare(
          `select agent_session_id as sid, branch_no, redo_no, attempt_no, ts, served_model, primary_type
             from contract_attempts where agent_session_id in ${inHour}
             order by branch_no, redo_no, attempt_no`,
        )
        .all(p) as AttemptRow[],
    );
    const refusals = groupBySession(
      db
        .prepare(
          `select agent_session_id as sid, ts, branch_no, site, agent, timeline_key, tasks_json, served_model, kind, reason, method, outcome
             from refusal_events where agent_session_id in ${inHour} order by ts, id`,
        )
        .all(p) as RefusalRow[],
    );
    const branches = groupBySession(
      db
        .prepare(
          `select session_id as sid, branch_no, reason, from_model, cost_usd, fork_index,
                  case when json_valid(messages_json) then json_array_length(messages_json) end as message_count
             from agent_session_branches where session_id in ${inHour} order by branch_no`,
        )
        .all(p) as BranchRow[],
    );
    const decisions = groupBySession(
      db
        .prepare(
          `select id, agent_session_id as sid, ts, checkpoint, branch_no, tool_call_id, attempt_no, consequence, verdict_json
             from decision_evaluations where point = 'checks' and agent_session_id in ${inHour} order by ts, id`,
        )
        .all(p) as DecisionRow[],
    );
    const messages = groupBySession(
      db
        .prepare(
          `select id, agent_session_id as sid, received_at, body
             from timeline_events where role = 'assistant' and agent_session_id in ${inHour}
             order by received_at, id`,
        )
        .all(p) as MessageRow[],
    );
    const audits = groupBySession(
      db
        .prepare(
          `select session_id as sid, verdict_json from session_audits
            where audit = 'send_contract' and status = 'done' and event_id is null and session_id in ${inHour}`,
        )
        .all(p) as AuditRow[],
    );

    for (const s of sessions) {
      accumulateSession(acc, s, {
        usage: usage.get(s.id) ?? [],
        attempts: attempts.get(s.id) ?? [],
        refusals: refusals.get(s.id) ?? [],
        branches: branches.get(s.id) ?? [],
        decisions: decisions.get(s.id) ?? [],
        messages: messages.get(s.id) ?? [],
        audits: audits.get(s.id) ?? [],
      }, ctx, countTokens);
    }
  }

  // Sessionless rows: caption requests and caption (or other job) refusals.
  const captionRequests = db
    .prepare(
      `select timeline_key, coalesce(nullif(logical_model_id, ''), model_id) as model
         from usage_events where class = 'caption' and agent_session_id is null and ts >= @hour and ts < @end`,
    )
    .all(p) as Array<{ timeline_key: string | null; model: string }>;
  for (const r of captionRequests) {
    acc.add(ctx.agentForTimelineKey(r.timeline_key), "caption", r.model, "requests", 1, null);
  }
  const sessionlessRefusals = db
    .prepare(
      `select agent_session_id as sid, ts, branch_no, site, agent, timeline_key, tasks_json, served_model, kind, reason, method, outcome
         from refusal_events where agent_session_id is null and ts >= @hour and ts < @end order by ts, id`,
    )
    .all(p) as RefusalRow[];
  for (const r of sessionlessRefusals) {
    accumulateRefusal(acc, r, r.agent ?? ctx.agentForTimelineKey(r.timeline_key), r.served_model, parseStringArray(r.tasks_json));
  }

  return acc.result();
}

function accumulateRefusal(
  acc: Accumulator,
  r: RefusalRow,
  agent: string | null,
  model: string | null,
  tasks: string[] | null,
): void {
  acc.add(agent, r.site, model, r.kind === "hard" ? "refusals_hard" : "refusals_judged", 1, tasks);
  acc.add(agent, r.site, model, familyMetric("refusal_reason", r.reason), 1, tasks);
  if (r.kind !== "hard") acc.add(agent, r.site, model, familyMetric("judged_refusal_reason", r.reason), 1, tasks);
  acc.add(agent, r.site, model, familyMetric("refusal_method", r.method), 1, tasks);
  acc.add(agent, r.site, model, familyMetric("refusal_outcome", r.outcome), 1, tasks);
  if (r.outcome === "redo") acc.add(agent, r.site, model, "refusal_redos", 1, tasks);
}

function accumulateSession(
  acc: Accumulator,
  s: SessionRow,
  rows: {
    usage: UsageRow[];
    attempts: AttemptRow[];
    refusals: RefusalRow[];
    branches: BranchRow[];
    decisions: DecisionRow[];
    messages: MessageRow[];
    audits: AuditRow[];
  },
  ctx: RollupContext,
  countTokens: (text: string) => number,
): void {
  const agent = ctx.agentForTimelineKey(s.timeline_key);
  const site = s.session_type;
  const tasks = sessionTasks(s.initial_preloads);
  const add = (model: string | null, metric: ModelBehaviourMetric | `${ModelBehaviourMetricFamily}:${string}`, value = 1) =>
    acc.add(agent, site, model, metric, value, tasks);

  // The model that served the session's latest request at or before `ts` (the
  // first request's model before any; null for a session without requests).
  const modelAt = (ts: number | null): string | null => {
    if (rows.usage.length === 0) return null;
    if (ts === null) return rows.usage[rows.usage.length - 1]!.model;
    let model = rows.usage[0]!.model;
    for (const u of rows.usage) {
      if (u.ts > ts) break;
      model = u.model;
    }
    return model;
  };

  // Spans discarded by a late-input redo, a revival or an aborted turn are their
  // own outcome, never a behaviour sample (STATISTICS_EXCLUDED_BRANCH_REASONS):
  // refusals and check verdicts re-anchored to such a branch, or to an earlier
  // branch cut from inside its span, are skipped (the contract derivation's rule).
  const excludedBranches = excludedBranchNumbers(
    rows.branches.map((b) => ({ branchNo: b.branch_no, forkIndex: b.fork_index, reason: b.reason, messageCount: b.message_count ?? 0 })),
  );

  // Requests and sessions. An aborted request (an `estimated` row, §8b "Aborted
  // requests") is billed but is no sample of the model's behaviour.
  const served = new Set<string>();
  for (const u of rows.usage) {
    if (u.estimated === 1) continue;
    add(u.model, "requests");
    served.add(u.model);
  }
  for (const model of served) add(model, "sessions");

  // Send contract: attempts, then the session outcome on the first failing model.
  const failed = rows.attempts.filter((a) => a.primary_type !== null);
  for (const a of failed) {
    const model = a.served_model ?? modelAt(a.ts);
    add(model, "contract_failed_attempts");
    add(model, familyMetric("failure_type", a.primary_type!));
  }
  const nudges = s.contract_nudges ?? 0;
  const nudged = nudges > 0 || rows.attempts.some((a) => a.attempt_no > 0);
  const firstFailed = failed[0];
  const nudgedModel = firstFailed ? firstFailed.served_model ?? modelAt(firstFailed.ts) : modelAt(null);
  if (nudged) add(nudgedModel, "sessions_nudged");
  switch (s.contract_outcome) {
    case "recovered": {
      const k = Math.max(1, nudges || Math.max(0, ...rows.attempts.filter((a) => a.redo_no === 0).map((a) => a.attempt_no)));
      add(nudgedModel, k >= 3 ? "contract_recovered_3" : k === 2 ? "contract_recovered_2" : "contract_recovered_1");
      break;
    }
    case "redo_recovered":
      add(nudgedModel, "contract_recovered_after_redo");
      break;
    case "gave_up_no_reply":
      add(nudgedModel, "contract_gave_up");
      break;
    case "exhausted":
      add(nudgedModel, "contract_exhausted");
      break;
  }

  // Redo branches.
  for (const b of rows.branches) {
    if (excludedBranches.has(b.branch_no)) continue;
    if (b.reason === "contract_redo") {
      const model = b.from_model ?? nudgedModel;
      add(model, "contract_redos");
      if (b.cost_usd) add(model, "contract_branch_cost_usd", b.cost_usd);
    } else if (b.reason === "refusal_redo" && b.cost_usd) {
      add(b.from_model ?? modelAt(null), "refusal_branch_cost_usd", b.cost_usd);
    }
  }

  // Refusals: their own site (a record turn inside a chat session is site record_turn).
  for (const r of rows.refusals) {
    if (excludedBranches.has(r.branch_no)) continue;
    accumulateRefusal(acc, r, r.agent ?? agent, r.served_model ?? modelAt(r.ts), parseStringArray(r.tasks_json) ?? tasks);
  }

  // Check verdicts, deduplicated per judged call (split calls and pattern rows of one
  // evaluation share the anchor) and per (call, code).
  const seenCodes = new Set<string>();
  const styledAnchors = new Set<string>();
  // Per judged call: its outcome and the kinds of every check fired on it. A
  // duplicate block is no model style issue (another session posted first), so it
  // counts apart (`duplicate_revisions` / `duplicate_overrides`).
  // `revisable`: a check other than the duplicate check fired that a revise is
  // about (remedy `revise`; by kind, anything but a refusal, which never revises:
  // one fired beside a revise was observed, no rule acted on it).
  const outcomes = new Map<string, { model: string | null; revise: boolean; overridden: boolean; kinds: Set<string>; revisable: boolean }>();
  const intentAnchors = new Set<string>();
  for (const d of rows.decisions) {
    if (d.branch_no !== null && excludedBranches.has(d.branch_no)) continue;
    const anchor =
      d.tool_call_id !== null || d.attempt_no !== null
        ? `${d.branch_no ?? 0}|${d.checkpoint ?? ""}|${d.tool_call_id ?? ""}|${d.attempt_no ?? ""}`
        : `row:${d.id}`;
    const model = modelAt(d.ts);
    const intent = noReplyIntentChoice(d.verdict_json);
    if (intent !== undefined && !intentAnchors.has(anchor)) {
      intentAnchors.add(anchor);
      add(model, familyMetric("no_reply_intent", intent));
      add(model, "no_reply_intent_judged");
    }
    const fired = firedChecks(d.verdict_json);
    const outcome = outcomes.get(anchor) ?? { model, revise: false, overridden: false, kinds: new Set<string>(), revisable: false };
    outcomes.set(anchor, outcome);
    for (const f of fired) {
      const kind = f.kind ?? ctx.checkKind?.(f.code, agent) ?? (f.code === DUPLICATE_CHECK_CODE ? "duplicate" : undefined);
      outcome.kinds.add(kind ?? "");
      if (kind !== "duplicate") {
        const remedy = ctx.checkRemedy?.(f.code, agent);
        if (remedy !== undefined ? remedy === "revise" : kind !== "refusal") outcome.revisable = true;
      }
      const key = `${anchor}\u0000${f.code}`;
      if (seenCodes.has(key)) continue;
      seenCodes.add(key);
      add(model, familyMetric("check_hits", f.code));
      if (kind === "style") {
        add(model, "style_hits");
        if (!styledAnchors.has(anchor)) {
          styledAnchors.add(anchor);
          add(model, "messages_with_style_hit");
        }
      }
    }
    const consequence = d.consequence;
    if (consequence === "revise" || consequence === "overridden") {
      const family = consequence === "revise" ? "check_revisions" : "check_overrides";
      if (consequence === "revise") outcome.revise = true;
      else outcome.overridden = true;
      for (const f of fired) {
        const key = `${family}\u0000${anchor}\u0000${f.code}`;
        if (seenCodes.has(key)) continue;
        seenCodes.add(key);
        add(model, familyMetric(family, f.code));
      }
    }
  }

  for (const o of outcomes.values()) {
    const duplicate = o.kinds.has("duplicate");
    // The model's own output was revised: the duplicate check did not fire (or
    // nothing was recorded), or a revisable check fired beside it. An observed
    // refusal beside a duplicate block is no revision.
    const other = !duplicate || o.revisable;
    if (o.revise) {
      if (other) add(o.model, "revisions");
      if (duplicate) add(o.model, "duplicate_revisions");
    }
    if (o.overridden) {
      if (other) add(o.model, "overrides");
      if (duplicate) add(o.model, "duplicate_overrides");
    }
  }

  // What happened to the message after the nudges (offline audit, §7.3).
  for (const a of rows.audits) {
    for (const run of afterCorrectionRuns(a.verdict_json)) {
      add(run.servedModel ?? modelAt(run.ts), familyMetric("after_correction", run.choice));
    }
  }

  // Messages the session sent.
  for (const m of rows.messages) {
    const model = modelAt(m.received_at);
    if (!isContinuationChunk(m.id)) add(model, "messages_sent");
    add(model, "message_tokens", countTokens(m.body));
  }
}

/**
 * Version of what {@link computeHourRollups} counts. Bump it when a metric is added
 * or redefined: at start the service marks every hour that already has rollup rows
 * dirty once (stored as `model_behaviour_rollup_version` in `metadata`), so the
 * background drain recomputes history with the new definitions.
 */
export const MODEL_BEHAVIOUR_ROLLUP_VERSION = 4;
const ROLLUP_VERSION_KEY = "model_behaviour_rollup_version";

/**
 * Mark every computed hour dirty when the stored rollup version differs from
 * {@link MODEL_BEHAVIOUR_ROLLUP_VERSION}, then store the version. One index scan of
 * the rollup table's hours; hours never computed are dirty already. Returns
 * whether it re-marked.
 */
export function ensureRollupVersion(db: Database.Database, now = Date.now()): boolean {
  const row = db.prepare(`select value from metadata where key = ?`).get(ROLLUP_VERSION_KEY) as { value: string } | undefined;
  if (row?.value === String(MODEL_BEHAVIOUR_ROLLUP_VERSION)) return false;
  const fresh = db.prepare(`select 1 from model_behaviour_rollups limit 1`).get() === undefined;
  if (!fresh) {
    db.exec(`insert or ignore into model_behaviour_dirty_hours (hour) select distinct hour from model_behaviour_rollups`);
  }
  db.prepare(
    `insert into metadata (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ROLLUP_VERSION_KEY, String(MODEL_BEHAVIOUR_ROLLUP_VERSION), now);
  return !fresh;
}

/** Replace one hour's rollup rows (inside the caller's transaction). */
function writeHour(db: Database.Database, hour: number, result: { rows: RollupRow[]; taskRows: TaskRollupRow[] }): void {
  db.prepare(`delete from model_behaviour_rollups where hour = ?`).run(hour);
  db.prepare(`delete from model_behaviour_task_rollups where hour = ?`).run(hour);
  const insert = db.prepare(
    `insert into model_behaviour_rollups (hour, agent, site, model, metric, value)
     values (@hour, @agent, @site, @model, @metric, @value)`,
  );
  for (const row of result.rows) insert.run(row);
  const insertTask = db.prepare(
    `insert into model_behaviour_task_rollups (hour, task, agent, site, model, metric, value)
     values (@hour, @task, @agent, @site, @model, @metric, @value)`,
  );
  for (const row of result.taskRows) insertTask.run(row);
  db.prepare(`delete from model_behaviour_dirty_hours where hour = ?`).run(hour);
}

export interface ModelBehaviourRollupsOptions extends RollupContext {
  storage: Storage;
  logger?: Logger;
  /** Hours recomputed per write job (each job holds the writer and the main thread once). Default 1. */
  hoursPerJob?: number;
  /** Background drain interval. Default 30 s. */
  intervalMs?: number;
}

/**
 * The rollup maintenance service: drains the dirty-hour queue in bounded write jobs
 * (newest hour first, so the current period is fresh before history), on a timer and
 * before every read of the API.
 */
/** Hours one background tick recomputes at most (one hour per job, yielding between). */
const DRAIN_HOURS_PER_TICK = 24;

export class ModelBehaviourRollups {
  private readonly hoursPerJob: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<number> | undefined;

  constructor(private readonly options: ModelBehaviourRollupsOptions) {
    this.hoursPerJob = Math.max(1, options.hoursPerJob ?? 1);
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  /** Number of hours waiting for a recompute. */
  pendingHours(): number {
    return this.options.storage.read(
      (db) => (db.prepare(`select count(*) as n from model_behaviour_dirty_hours`).get() as { n: number }).n,
    );
  }

  /**
   * Recompute up to `maxHours` dirty hours (newest first), in write jobs of
   * `hoursPerJob`. Resolves to the number of hours recomputed.
   */
  async flush(maxHours = Number.POSITIVE_INFINITY): Promise<number> {
    let done = 0;
    while (done < maxHours) {
      const limit = Math.min(this.hoursPerJob, maxHours - done);
      const n = await this.options.storage.write((db) =>
        db.transaction(() => {
          const hours = db
            .prepare(`select hour from model_behaviour_dirty_hours order by hour desc limit ?`)
            .all(limit) as Array<{ hour: number }>;
          for (const { hour } of hours) writeHour(db, hour, computeHourRollups(db, hour, this.options));
          return hours.length;
        })(),
      );
      done += n;
      if (n < limit) break;
      // Yield between jobs so a long drain never starves the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return done;
  }

  /**
   * Recompute every hour from the raw tables (the history backfill's entry point):
   * marks every hour with source or rollup rows dirty, then drains the queue. Rows
   * stay readable throughout; an hour whose sources vanished ends with no rows.
   */
  async rebuild(): Promise<number> {
    await this.options.storage.write((db) => db.exec(MARK_ALL_MODEL_BEHAVIOUR_HOURS_DIRTY));
    return this.flush();
  }

  /** Start the background drain (idempotent); re-marks history once after a rollup version bump. */
  start(): void {
    if (this.timer) return;
    void this.options.storage
      .write((db) => ensureRollupVersion(db))
      .then((remarked) => {
        if (remarked) this.options.logger?.info("model_behaviour_rollups_remarked", { version: MODEL_BEHAVIOUR_ROLLUP_VERSION });
      })
      .catch((error: unknown) => {
        this.options.logger?.warn("model_behaviour_rollup_failed", { error: error instanceof Error ? error.message : String(error) });
      });
    this.timer = setInterval(() => void this.drainOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.drainOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private drainOnce(): Promise<number> {
    if (this.draining) return this.draining;
    const run = this.flush(DRAIN_HOURS_PER_TICK)
      .catch((error: unknown) => {
        this.options.logger?.warn("model_behaviour_rollup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      })
      .finally(() => {
        this.draining = undefined;
      });
    this.draining = run;
    return run;
  }
}
