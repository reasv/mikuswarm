/**
 * Model behaviour statistics DDL (spec REFUSAL-HANDLING §12.3 "Storage", §12.4).
 *
 * - `behaviour_snapshots` / `behaviour_changes`: the resolved behaviour-config
 *   snapshot recorded at every boot whose hash differs from the previous one, and
 *   the typed change events (config diffs and observed prompt changes) the model
 *   behaviour page draws as markers.
 * - `model_behaviour_rollups` / `model_behaviour_task_rollups`: hourly counters keyed
 *   by (hour, agent, site, model, metric), plus a task dimension table with one row
 *   per task label (labels overlap). A cache, never a source of truth:
 *   `ModelBehaviourRollups` (src/behaviour/rollups.ts) recomputes an hour from the
 *   raw tables.
 * - `model_behaviour_dirty_hours`: the hours whose rollups are stale. SQL triggers on
 *   the raw tables mark an hour dirty at write time (the pattern of
 *   `pipeline_counts`, but a mark instead of a counter delta: message tokens need the
 *   context tokenizer, which SQL cannot run); the rollup service recomputes dirty
 *   hours through the single-writer queue.
 *
 * Hour keying: everything that belongs to a session is keyed by the hour of the
 * session's `created_at`; sessionless rows (caption requests, caption refusals) by
 * their own `ts`. So a trigger on a session child table marks the session's hour,
 * falling back to the row's own time when the session row is missing.
 *
 * Trigger bodies name only columns that predate the refusal-handling migration (or
 * live in tables created with it): SQLite refuses to drop a column a trigger body
 * reads, and older-shape test fixtures drop the v25 columns. An `update of` column
 * list does not block a drop.
 */

export const MODEL_BEHAVIOUR_HOUR_MS = 3_600_000;

const hourOf = (expr: string) => `((${expr}) / ${MODEL_BEHAVIOUR_HOUR_MS}) * ${MODEL_BEHAVIOUR_HOUR_MS}`;
const sessionHour = (sessionIdExpr: string, fallbackTsExpr: string) =>
  hourOf(`coalesce((select created_at from agent_sessions where id = ${sessionIdExpr}), ${fallbackTsExpr})`);
// A guarded plain INSERT rather than INSERT OR IGNORE: inside a trigger, the outer
// statement's conflict policy (an UPSERT on the raw table, say) replaces the
// trigger's own, so OR IGNORE would not hold there.
const markDirty = (hourExpr: string) =>
  `insert into model_behaviour_dirty_hours (hour) select h from (select ${hourExpr} as h) as d
    where h is not null and not exists (select 1 from model_behaviour_dirty_hours where hour = d.h);`;

/** Tables and indexes owned by this feature (no dependency on other tables). */
export const MODEL_BEHAVIOUR_TABLES_SCHEMA = `
create table if not exists behaviour_snapshots (
  id integer primary key autoincrement,
  ts integer not null,
  hash text not null,
  code_version text not null,
  snapshot_json text not null
);

create table if not exists behaviour_changes (
  id integer primary key autoincrement,
  ts integer not null,
  snapshot_id integer,          -- the snapshot that introduced it; null for prompt_changed
  kind text not null,           -- head_model_changed|chain_changed|preference_changed|thinking_changed|
                                -- routing_task_changed|rule_changed|check_changed|code_changed|
                                -- config_changed|prompt_changed
  sentence text not null,
  path text,                    -- resolved snapshot path (config_changed and typed snapshot events)
  old_json text,
  new_json text,
  agents_json text not null default '[]',   -- touched agents; [] = every agent
  sites_json text not null default '[]',    -- touched sites; [] = every site
  models_json text not null default '[]',   -- touched models; [] = every model
  detail_json text              -- prompt_changed: { prompt, oldHash, newHash }
);
create index if not exists idx_behaviour_changes_ts on behaviour_changes(ts);

create table if not exists model_behaviour_rollups (
  hour integer not null,
  agent text not null,          -- '' = legacy single-agent mode or unattributable
  site text not null,
  model text not null,          -- logical model id; '' = unknown
  metric text not null,
  value real not null,
  primary key (hour, agent, site, model, metric)
) without rowid;

create table if not exists model_behaviour_task_rollups (
  hour integer not null,
  task text not null,
  agent text not null,
  site text not null,
  model text not null,
  metric text not null,
  value real not null,
  primary key (hour, task, agent, site, model, metric)
) without rowid;

create table if not exists model_behaviour_dirty_hours (
  hour integer primary key
) without rowid;
`;

/**
 * Indexes and dirty-marking triggers on the raw tables, each guarded by the table it
 * needs so the migration step can skip one whose table a very old database lacks
 * (SCHEMA creates it at the latest shape afterwards).
 */
export const MODEL_BEHAVIOUR_RAW_TABLE_DDL: ReadonlyArray<{ table: string; sql: string }> = [
  // Hour recompute and the incident log walk sessions by creation time.
  { table: "agent_sessions", sql: `create index if not exists idx_agent_sessions_created on agent_sessions(created_at, id);` },
  // Messages a session sent (the rollups' messages-sent and message-token metrics).
  {
    table: "timeline_events",
    sql: `create index if not exists idx_timeline_events_session on timeline_events(agent_session_id)
  where agent_session_id is not null;`,
  },
  {
    table: "agent_sessions",
    sql: `create trigger if not exists mbr_as_ai after insert on agent_sessions begin
  ${markDirty(hourOf("new.created_at"))}
end;`,
  },
  {
    table: "agent_sessions",
    // Only the columns the rollups read: the per-request usage aggregate updates
    // of a running session never touch its rollups (usage_events has its own trigger).
    sql: `create trigger if not exists mbr_as_au
  after update of contract_outcome, contract_nudges, initial_preloads, timeline_key, session_type, created_at
  on agent_sessions begin
  ${markDirty(hourOf("new.created_at"))}
end;`,
  },
  {
    table: "agent_sessions",
    sql: `create trigger if not exists mbr_as_ad after delete on agent_sessions begin
  ${markDirty(hourOf("old.created_at"))}
end;`,
  },
  {
    table: "usage_events",
    sql: `create trigger if not exists mbr_ue_ai after insert on usage_events
  when new.class in ('agent_loop', 'caption') begin
  ${markDirty(sessionHour("new.agent_session_id", "new.ts"))}
end;`,
  },
  {
    table: "usage_events",
    sql: `create trigger if not exists mbr_ue_ad after delete on usage_events
  when old.class in ('agent_loop', 'caption') begin
  ${markDirty(sessionHour("old.agent_session_id", "old.ts"))}
end;`,
  },
  ...(["insert", "update"] as const).map((op) => ({
    table: "refusal_events",
    sql: `create trigger if not exists mbr_re_a${op[0]} after ${op} on refusal_events begin
  ${markDirty(sessionHour("new.agent_session_id", "new.ts"))}
end;`,
  })),
  {
    table: "refusal_events",
    sql: `create trigger if not exists mbr_re_ad after delete on refusal_events begin
  ${markDirty(sessionHour("old.agent_session_id", "old.ts"))}
end;`,
  },
  ...(["insert", "update"] as const).map((op) => ({
    table: "contract_attempts",
    sql: `create trigger if not exists mbr_ca_a${op[0]} after ${op} on contract_attempts begin
  ${markDirty(sessionHour("new.agent_session_id", "coalesce(new.ts, 0)"))}
end;`,
  })),
  {
    table: "contract_attempts",
    sql: `create trigger if not exists mbr_ca_ad after delete on contract_attempts begin
  ${markDirty(sessionHour("old.agent_session_id", "coalesce(old.ts, 0)"))}
end;`,
  },
  ...(["insert", "update"] as const).map((op) => ({
    table: "agent_session_branches",
    sql: `create trigger if not exists mbr_sb_a${op[0]} after ${op} on agent_session_branches begin
  ${markDirty(sessionHour("new.session_id", "new.created_at"))}
end;`,
  })),
  ...(["insert", "update"] as const).map((op) => ({
    table: "decision_evaluations",
    sql: `create trigger if not exists mbr_de_a${op[0]} after ${op} on decision_evaluations
  when new.point = 'checks' begin
  ${markDirty(sessionHour("new.agent_session_id", "new.ts"))}
end;`,
  })),
  {
    table: "timeline_events",
    sql: `create trigger if not exists mbr_te_ai after insert on timeline_events
  when new.role = 'assistant' and new.agent_session_id is not null begin
  ${markDirty(sessionHour("new.agent_session_id", "new.received_at"))}
end;`,
  },
  {
    table: "timeline_events",
    sql: `create trigger if not exists mbr_te_au after update of body, agent_session_id on timeline_events
  when new.role = 'assistant' and new.agent_session_id is not null begin
  ${markDirty(sessionHour("new.agent_session_id", "new.received_at"))}
end;`,
  },
  {
    table: "timeline_events",
    sql: `create trigger if not exists mbr_te_ad after delete on timeline_events
  when old.role = 'assistant' and old.agent_session_id is not null begin
  ${markDirty(sessionHour("old.agent_session_id", "old.received_at"))}
end;`,
  },
];

/** The whole feature's DDL, appended to SCHEMA after every raw table it names. */
export const MODEL_BEHAVIOUR_SCHEMA = `${MODEL_BEHAVIOUR_TABLES_SCHEMA}
${MODEL_BEHAVIOUR_RAW_TABLE_DDL.map((d) => d.sql).join("\n")}
`;

/**
 * Mark every hour that has source rows (or existing rollup rows) dirty: the seed of
 * a migrated database with history, and the first step of a full rebuild. Each
 * statement reads one indexed column; the recompute itself runs later in chunks.
 */
export const MARK_ALL_MODEL_BEHAVIOUR_HOURS_DIRTY = `
insert or ignore into model_behaviour_dirty_hours (hour)
  select distinct ${hourOf("created_at")} from agent_sessions;
insert or ignore into model_behaviour_dirty_hours (hour)
  select distinct ${hourOf("ts")} from usage_events where class = 'caption' and agent_session_id is null;
insert or ignore into model_behaviour_dirty_hours (hour)
  select distinct ${hourOf("ts")} from refusal_events where agent_session_id is null;
insert or ignore into model_behaviour_dirty_hours (hour)
  select distinct hour from model_behaviour_rollups;
insert or ignore into model_behaviour_dirty_hours (hour)
  select distinct hour from model_behaviour_task_rollups;
`;
