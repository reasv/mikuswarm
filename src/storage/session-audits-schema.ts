/**
 * Offline audit storage DDL (spec REFUSAL-HANDLING §7.6, §10.2; DECISION-MODEL
 * §5.8): one `session_audits` row per audit per audited session.
 *
 * - `audit` names the audit (`send_contract`, `refusal`).
 * - `event_id` is null for a whole-session row; per-message audits set the sent
 *   message's timeline event id (DECISION-MODEL §5.8 granularity).
 * - `status`: `done` (judged), `skipped` (nothing to audit, or not sampled),
 *   `unauditable` (no surviving transcript; never retried), `failed` (the
 *   decision chain kept failing; not retried).
 * - `verdict_json` holds the audit's result (src/audit/); `answers_json` the raw
 *   decision answers; `model_id` / `cost_usd` the member that served and the
 *   audit's spend (also in the `audit` ledger class).
 * - `version` is the audit implementation's version (src/audit/config.ts).
 *
 * The audit's per-message check verdicts are ordinary anchored
 * `decision_evaluations` rows and `refusal_events` rows; this table only says
 * which sessions were audited and holds the send-contract diagnosis.
 *
 * A write marks the session's rollup hour dirty (the send-contract diagnosis
 * feeds the model behaviour rollups, src/behaviour/rollups.ts).
 */
import { markSessionHourDirty } from "./model-behaviour-schema.js";

export const SESSION_AUDITS_TABLE_SCHEMA = `
create table if not exists session_audits (
  id integer primary key autoincrement,
  session_id text not null references agent_sessions(id) on delete cascade,
  audit text not null,              -- send_contract | refusal
  event_id text,                    -- per-message audits: the sent message's timeline event id
  status text not null,             -- done | skipped | unauditable | failed
  answers_json text,
  verdict_json text,
  confidence real,
  model_id text,
  cost_usd real,
  version integer not null,
  created_at integer not null
);
create unique index if not exists idx_session_audits_key
  on session_audits(session_id, audit, coalesce(event_id, ''));
create index if not exists idx_session_audits_created on session_audits(created_at);
`;

/** The dirty-hour triggers (need `model_behaviour_dirty_hours`, so they follow its DDL). */
export const SESSION_AUDITS_TRIGGER_SCHEMA = `
create trigger if not exists mbr_sa_ai after insert on session_audits begin
  ${markSessionHourDirty("new.session_id", "new.created_at")}
end;
create trigger if not exists mbr_sa_au after update on session_audits begin
  ${markSessionHourDirty("new.session_id", "new.created_at")}
end;
create trigger if not exists mbr_sa_ad after delete on session_audits begin
  ${markSessionHourDirty("old.session_id", "old.created_at")}
end;
`;

export const SESSION_AUDITS_SCHEMA = `${SESSION_AUDITS_TABLE_SCHEMA}
${SESSION_AUDITS_TRIGGER_SCHEMA}`;
