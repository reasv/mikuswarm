/**
 * Memory-retrieval storage DDL added with the judged-retrieval pipeline
 * (ARCHITECTURE.md §9d "Judged retrieval", §9c "Memory filters"). Shared verbatim
 * by the fresh-DB SCHEMA (interpolated) and the v33→v34 migration step, so the
 * two can never drift.
 *
 * Every table keys on a block's `content_hash` (sha256 of the chunk text, the
 * same key as `memory_chunks.content_hash` and the embedding cache), never on a
 * chunk rowid: a block that moves inside its file keeps its tags, verdicts and
 * token vectors. `agent` is `''` in legacy single-agent mode.
 *
 * - `memory_block_provenance` / `memory_block_participants`: participant tags
 *   from provenance (§9d "Participant tags"). One provenance row per block once
 *   resolved (`tagged`, `none` for a legacy/header-less block or no matching
 *   summary range, `ambiguous` when several ranges match), and one participant
 *   row per human sender id of the block's source range, with message counts.
 * - `memory_filter_verdicts`: the lazy judged-filter cache (§9c "Memory
 *   filters"); `filter_hash` covers everything that defines the filter, so an
 *   edited filter's old verdicts are stale and ignored.
 * - `memory_filter_hits`: the audit trail of blocks a filter has hidden (judged
 *   and mechanical), for the console's filters page.
 * - `memory_late_vectors`: late-interaction token vectors (one blob per block
 *   and model; fp16 or int8 with per-token scales).
 * - `memory_index_failures`: per-index embedding/encoding failures for the
 *   indexes that have no status column of their own (the primary embedder's
 *   vector index, the late-interaction store), so a poison block is retried a
 *   bounded number of times instead of every poll.
 * - `memory_retrievals`: one row per auto-retrieval build (counts, source,
 *   timings, the per-candidate report) and the session's follow-up, if any.
 * - `idx_memory_chunks_content_hash` / `idx_memory_chunks_entry_ts`: lookups of
 *   blocks by content hash (candidate rows, the late-vector joins and prunes)
 *   and the newest-first walk of the late-interaction window.
 * - `idx_timeline_events_sender`: the display-name history lookup of the user
 *   lanes (distinct `sender_display_name` values of one sender id).
 */
export const MEMORY_RETRIEVAL_TABLES_SCHEMA = `
create table if not exists memory_block_provenance (
  agent         text not null default '',
  content_hash  text not null,
  status        text not null check(status in ('tagged','none','ambiguous')),
  summary_id    text,
  timeline_key  text,
  resolved_at   integer not null,
  primary key (agent, content_hash)
);

create table if not exists memory_block_participants (
  agent          text not null default '',
  content_hash   text not null,
  provider       text not null,
  sender_id      text not null,
  message_count  integer not null,
  primary key (agent, content_hash, provider, sender_id)
);
create index if not exists idx_memory_block_participants_sender
  on memory_block_participants(agent, provider, sender_id);

create table if not exists memory_filter_verdicts (
  agent           text not null default '',
  content_hash    text not null,
  filter_key      text not null,
  filter_hash     text not null,
  probability     real,
  hidden          integer not null,
  model           text,
  served_version  text,
  evaluated_at    integer not null,
  primary key (agent, content_hash, filter_key)
);

create table if not exists memory_filter_hits (
  agent            text not null default '',
  content_hash     text not null,
  filter_key       text not null,
  filter_hash      text not null,
  kind             text not null check(kind in ('keyword','pattern','judged')),
  detail           text,
  probability      real,
  path             text,
  start_line       integer,
  end_line         integer,
  surface          text not null,
  first_hidden_at  integer not null,
  last_hidden_at   integer not null,
  hide_count       integer not null default 1,
  primary key (agent, content_hash, filter_key)
);
create index if not exists idx_memory_filter_hits_filter
  on memory_filter_hits(filter_key, last_hidden_at);

create table if not exists memory_late_vectors (
  model         text not null,
  content_hash  text not null,
  dtype         text not null check(dtype in ('fp16','int8')),
  dim           integer not null,
  token_count   integer not null,
  vectors       blob not null,
  scales        blob,
  indexed_at    integer not null,
  primary key (model, content_hash)
);

create table if not exists memory_index_failures (
  index_name    text not null,
  content_hash  text not null,
  attempts      integer not null,
  last_error    text,
  updated_at    integer not null,
  primary key (index_name, content_hash)
);

create table if not exists memory_retrievals (
  id                text primary key,
  agent_session_id  text,
  agent             text,
  timeline_key      text,
  ts                integer not null,
  source            text not null,
  decision_group    text,
  candidates        integer not null,
  judged            integer not null,
  kept              integer not null,
  hidden            integer not null,
  tokens            integer not null,
  ms                integer not null,
  report_json       text,
  follow_up_at      integer,
  follow_up_kind    text
);
create index if not exists idx_memory_retrievals_session
  on memory_retrievals(agent_session_id);
create index if not exists idx_memory_retrievals_ts
  on memory_retrievals(ts);

create index if not exists idx_memory_chunks_content_hash
  on memory_chunks(content_hash);
create index if not exists idx_memory_chunks_entry_ts
  on memory_chunks(entry_ts);
`;

/** Index on `timeline_events`, created only where that table exists. */
export const MEMORY_RETRIEVAL_TIMELINE_INDEX = `
create index if not exists idx_timeline_events_sender
  on timeline_events(provider, sender_id, timestamp);
`;

export const MEMORY_RETRIEVAL_SCHEMA = `${MEMORY_RETRIEVAL_TABLES_SCHEMA}${MEMORY_RETRIEVAL_TIMELINE_INDEX}`;
