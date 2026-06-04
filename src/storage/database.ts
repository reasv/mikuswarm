import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/index.js";
import type { AttachmentMeta, CanonicalChatEvent, TimelineState } from "../types.js";

/**
 * The resolved replacement content an edit carries: the post-edit body and the
 * serialized attachments. Mirrors `EditReplacement` in `src/timeline/edits.ts`
 * but lives here so the storage layer (pending-edit persistence, issue #12) does
 * not depend on the timeline layer. Kept structurally identical.
 */
export interface EditReplacementContent {
  body: string;
  attachments: AttachmentMeta[];
}

export interface StorageOptions {
  databasePath: string;
  logger?: Logger;
}

/**
 * Re-decryption give-up ceiling (issue #1). A UTD row whose `redecrypt_attempts`
 * reaches this count is excluded from `getUndecryptedEvents`, so permanently-dead
 * events (megolm keys that will never arrive — e.g. messages sent before the bot
 * joined) leave the oldest-first candidate window and stop starving newer,
 * decryptable rows. At the default sweep interval with exponential backoff this
 * spans well over a day of real-time retries before a row is retired.
 */
export const MAX_REDECRYPT_ATTEMPTS = 12;

/**
 * Sentinel `redecrypt_attempts` value marking a row permanently retired from the
 * re-decryption rotation regardless of {@link MAX_REDECRYPT_ATTEMPTS} (e.g. a UTD
 * row with no resolvable room/event id, which can never be re-fetched). Chosen
 * far above the ceiling so it always falls outside the candidate query.
 */
export const REDECRYPT_RETIRED = 1_000_000;

type WriteJob<T> = {
  run: (db: Database.Database) => T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export interface TimelineEventRow {
  id: string;
  external_id: string | null;
  timeline_key: string;
  provider: string;
  role: string;
  sender_id: string;
  sender_display_name: string | null;
  body: string;
  timestamp: number;
  received_at: number;
  agent_session_id: string | null;
  event_json: string;
  created_at: number;
  updated_at: number;
}

export interface ReplyContextRow {
  event_id: string;
  reply_external_id?: string | null;
  sender_id?: string | null;
  sender_display_name?: string | null;
  body?: string | null;
  html_body?: string | null;
  timestamp?: number | null;
  created_at: number;
}

export interface LinkPreviewRow {
  id: string;
  event_id: string;
  context: string;
  url: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  source_kind?: string | null;
  preview_index: number;
  fetched_at?: number | null;
  fetch_status: string;
  error?: string | null;
  created_at: number;
}

export interface MediaAssetRow {
  id: string;
  event_id: string;
  role: string;
  source_index?: number | null;
  link_preview_id?: string | null;
  local_path?: string | null;
  mime_type?: string | null;
  media_type: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  original_filename?: string | null;
  detected_content?: string | null;
  detected_metadata_json?: string | null;
  caption?: string | null;
  caption_model?: string | null;
  caption_status: string;
  caption_error?: string | null;
  download_status: string;
  download_error?: string | null;
  created_at: number;
}

export interface TimelineCompactionState {
  schemaVersion: 1;
  timelineKey: string;
  compactStartEventId: string | null;
  richStartEventId: string | null;
  updatedAt: number;
}

export type SummaryStatus = "complete" | "truncated" | "superseded";

export interface Summary {
  id: string;
  timelineKey: string;
  level: number;
  content: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  latestEventId: string;
  eventCount: number;
  tokenCount: number;
  modelId: string | null;
  status: SummaryStatus;
  backfillJobId: string | null;
  generatedAt: number;
  createdAt: number;
}

export type SummarizationJobStatus = "pending" | "processing" | "complete" | "failed";

export interface SummarizationJob {
  id: string;
  timelineKey: string;
  level: number;
  status: SummarizationJobStatus;
  inputStartId: string;
  inputEndId: string;
  inputTokenCount: number | null;
  targetTokenCount: number;
  attempts: number;
  maxRetries: number;
  bestEffortDraft: string | null;
  error: string | null;
  resultSummaryId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Diary queue state on a level-1 summary row (ARCHITECTURE.md §9c). */
export type DiaryStatus = "pending" | "processing" | "done" | "skipped" | "failed";

/**
 * A claimed diary job: the level-1 summary whose participation range the diary
 * session writes about. Carries just what the worker needs — the lineage events
 * are loaded separately via {@link Storage.getSummaryLineage}.
 */
export interface DiaryJob {
  summaryId: string;
  timelineKey: string;
  level: number;
  earliestTimestamp: number;
  latestTimestamp: number;
  /** Persisted attempt count, post-increment at claim time. */
  attempts: number;
}

/**
 * A memory-retrieval chunk as produced by the indexer (ARCHITECTURE.md §9d). The
 * storage layer accepts this structurally for reconciliation; the canonical shape
 * (with docs) lives in `src/retrieval/chunk.ts` as `MemoryChunk`.
 */
export interface MemoryChunkInput {
  id: string;
  path: string;
  ordinal: number;
  source: string;
  startLine: number;
  endLine: number;
  room: string | null;
  entryTs: number;
  text: string;
  tokenCount: number;
  contentHash: string;
}

/** Net effect of one reconcile pass over a file (for logging). */
export interface ReconcileResult {
  inserted: number;
  updated: number;
  deleted: number;
  /** rowids of chunks removed this pass — so the caller can prune their vectors. */
  deletedRowids: number[];
}

/** One lexical (FTS5/BM25) search hit, pre-ranking. */
export interface LexicalHit {
  rowid: number;
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  room: string | null;
  entryTs: number;
  text: string;
  /** Raw SQLite bm25() cost — lower (more negative) is a better match. */
  bm25: number;
}

/** Sort key for events/summaries: (timestamp, received_at, id) ascending. */
export interface TimelineCursor {
  timestamp: number;
  receivedAt: number;
  id: string;
}

interface SummaryRow {
  id: string;
  timeline_key: string;
  level: number;
  content: string;
  earliest_timestamp: number;
  latest_timestamp: number;
  latest_event_id: string;
  event_count: number;
  token_count: number;
  model_id: string | null;
  status: SummaryStatus;
  backfill_job_id: string | null;
  generated_at: number;
  created_at: number;
}

interface SummarizationJobRow {
  id: string;
  timeline_key: string;
  level: number;
  status: SummarizationJobStatus;
  input_start_id: string;
  input_end_id: string;
  input_token_count: number | null;
  target_token_count: number;
  attempts: number;
  max_retries: number;
  best_effort_draft: string | null;
  error: string | null;
  result_summary_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapSummaryRow(row: SummaryRow): Summary {
  return {
    id: row.id,
    timelineKey: row.timeline_key,
    level: row.level,
    content: row.content,
    earliestTimestamp: row.earliest_timestamp,
    latestTimestamp: row.latest_timestamp,
    latestEventId: row.latest_event_id,
    eventCount: row.event_count,
    tokenCount: row.token_count,
    modelId: row.model_id,
    status: row.status,
    backfillJobId: row.backfill_job_id,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

function mapJobRow(row: SummarizationJobRow): SummarizationJob {
  return {
    id: row.id,
    timelineKey: row.timeline_key,
    level: row.level,
    status: row.status,
    inputStartId: row.input_start_id,
    inputEndId: row.input_end_id,
    inputTokenCount: row.input_token_count,
    targetTokenCount: row.target_token_count,
    attempts: row.attempts,
    maxRetries: row.max_retries,
    bestEffortDraft: row.best_effort_draft,
    error: row.error,
    resultSummaryId: row.result_summary_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parameters for inserting a completed or truncated summary with its lineage. */
export interface SummaryInsert {
  id: string;
  timelineKey: string;
  level: number;
  content: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  latestEventId: string;
  eventCount: number;
  tokenCount: number;
  modelId: string | null;
  status: SummaryStatus;
  generatedAt: number;
  /** Ordered leaf event IDs (level 1 only). */
  eventIds?: string[];
  /** Ordered parent summary IDs (level 2+ only). */
  parentIds?: string[];
  /** Job to mark complete with this summary as its result. */
  jobId: string;
}

export interface SummarizationJobInsert {
  id: string;
  timelineKey: string;
  level: number;
  inputStartId: string;
  inputEndId: string;
  inputTokenCount: number | null;
  targetTokenCount: number;
  maxRetries: number;
}

/**
 * Lifecycle status of a durable session record (spec §4 status model).
 *   - `created`     placeholder made, not yet run (in-memory)
 *   - `running`     actively executing (in-memory)
 *   - `completed`   finished normally, incl. no_reply (terminal, default)
 *   - `discarded`   failed/aborted (terminal)
 *   - `interrupted` process stopped mid-run; healed on startup (reserved)
 *   - `suspended`   paused awaiting external input (reserved, future §7)
 */
export type AgentSessionStatus =
  | "created"
  | "running"
  | "completed"
  | "discarded"
  | "interrupted"
  | "suspended";

/**
 * Initial-insert shape for an `agent_sessions` row (spec §4, §5). The runner
 * creates the placeholder at `created`; the snapshot/transcript/timestamp
 * columns are filled in later by the dedicated save/update methods. `status` is
 * supplied by the caller (typically `'created'`).
 *
 * `startedAt` is optional: the chat path inserts at `created` and leaves it
 * null until `markRunning` sets it. Callers that insert directly at `running`
 * (e.g. the summarization worker, which bypasses `created → markRunning`) pass
 * `startedAt` so the row carries a non-null start time from the outset.
 */
export interface AgentSessionInsert {
  id: string;
  timelineKey: string;
  sessionType: string;
  status: AgentSessionStatus;
  modelId?: string | null;
  triggerEventId?: string | null;
  triggerExternalId?: string | null;
  triggerBody?: string | null;
  createdAt: number;
  startedAt?: number | null;
  updatedAt: number;
}

/**
 * A persisted `agent_sessions` row as stored (snake_case columns). Read-side
 * shape returned by {@link Storage.getAgentSession}; mirrors the table in
 * spec §4 verbatim so the console can render snapshot + transcript directly.
 */
export interface AgentSessionRow {
  id: string;
  timeline_key: string;
  session_type: string;
  status: AgentSessionStatus;
  model_id: string | null;
  trigger_event_id: string | null;
  trigger_external_id: string | null;
  trigger_body: string | null;
  context_snapshot_json: string | null;
  context_dump_path: string | null;
  transcript_json: string | null;
  token_estimate: number | null;
  no_reply: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
}

/**
 * One row per timeline for the observability console's room list (spec §8,
 * `GET /api/rooms`). Aggregated from `timeline_events` with correlated counts;
 * read-only. `display_name` falls back to `timeline_key` (no room-name column
 * exists in the schema today).
 */
export interface RoomSummaryRow {
  timeline_key: string;
  display_name: string;
  timeline_state: TimelineState;
  last_activity_at: number;
  event_count: number;
  session_count: number;
}

/**
 * Backing data for a summary in the console detail column (spec §12): the raw
 * timeline events it covers (level-1, via `summary_events`) and/or the child
 * summaries it condenses (level-2+, via `summary_parents`). Both are returned;
 * a given summary populates one or the other depending on its level.
 */
export interface SummaryLineage {
  events: CanonicalChatEvent[];
  children: Summary[];
}

export class Storage {
  readonly db: Database.Database;
  private readonly queue: Array<WriteJob<any>> = [];
  private draining = false;
  private closed = false;
  private readonly logger?: Logger;

  private constructor(db: Database.Database, logger?: Logger) {
    this.db = db;
    this.logger = logger;
  }

  static async open(options: StorageOptions): Promise<Storage> {
    await mkdir(path.dirname(options.databasePath), { recursive: true });
    const db = new Database(options.databasePath);
    const storage = new Storage(db, options.logger);
    await storage.write((writer) => {
      writer.pragma("journal_mode = WAL");
      writer.pragma("foreign_keys = ON");
      // Wait up to 5s on a locked database rather than failing immediately with
      // SQLITE_BUSY. The single-writer queue avoids self-contention, but external
      // readers (the observability console reads the DB directly) and the WAL
      // checkpoint can still briefly hold a lock; without busy_timeout a transient
      // lock would surface as a swallowed fire-and-forget write failure.
      writer.pragma("busy_timeout = 5000");
      // Distinguish a brand-new database from an existing one BEFORE applying
      // SCHEMA (which uses `if not exists` and so leaves no trace of which case we
      // are in). A fresh DB has no user tables yet; SCHEMA then builds the full
      // latest shape and runMigrations only stamps the version — it must NOT run
      // the additive ALTER steps, which target legacy DBs that predate a column.
      const isFreshDatabase =
        (
          writer
            .prepare(
              `select count(*) as n from sqlite_master where type = 'table' and name = 'timeline_events'`,
            )
            .get() as { n: number }
        ).n === 0;
      if (isFreshDatabase) {
        // Fresh build must be all-or-nothing (issue #7): wrap the full-schema
        // build AND the version stamp in one transaction so a crash mid-build
        // cannot leave a partial set of tables that the next open()'s
        // `timeline_events`-presence probe would misclassify as fresh (skipping
        // the additive ALTER steps). runMigrations(fresh) here only stamps
        // user_version and opens NO inner transaction, so there is no nested
        // BEGIN. The existing-DB upgrade path keeps its own transaction inside
        // runMigrations (better-sqlite3 forbids nested transactions), so it must
        // NOT be wrapped here.
        writer.transaction(() => {
          writer.exec(SCHEMA);
          runMigrations(writer, true);
        })();
      } else {
        // Existing DB: run the additive migrations FIRST, then SCHEMA. SCHEMA is
        // the latest (vN) shape and its index/table DDL references columns that
        // only the ALTER steps add (e.g. idx_timeline_events_undecryptable keys on
        // redecrypt_attempts); running SCHEMA against an un-migrated legacy table
        // would raise "no such column" before the steps could add it. runMigrations
        // brings the legacy tables up to the current column shape under its own
        // transaction; the subsequent `create table/index if not exists` in SCHEMA
        // is then harmless (every referenced column now exists) and creates any
        // genuinely-new tables/indexes that no migration step covers.
        runMigrations(writer, false);
        writer.exec(SCHEMA);
      }
    });
    return storage;
  }

  write<T>(run: (db: Database.Database) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Storage is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this.drainQueue();
    });
  }

  read<T>(run: (db: Database.Database) => T): T {
    if (this.closed) throw new Error("Storage is closed");
    return run(this.db);
  }

  readAndWrite<T>(run: (db: Database.Database) => T): Promise<T> {
    return this.write((db) => db.transaction(() => run(db))());
  }

  appendTimelineEvent(event: CanonicalChatEvent, enrichmentStatus?: string): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      db.prepare(
        `insert into timeline_events (
          id, external_id, timeline_key, provider, role, sender_id,
          sender_display_name, body, timestamp, received_at, agent_session_id,
          event_json, enrichment_status, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @eventJson, @enrichmentStatus, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          external_id = excluded.external_id,
          timeline_key = excluded.timeline_key,
          provider = excluded.provider,
          role = excluded.role,
          sender_id = excluded.sender_id,
          sender_display_name = excluded.sender_display_name,
          body = excluded.body,
          timestamp = excluded.timestamp,
          received_at = excluded.received_at,
          agent_session_id = excluded.agent_session_id,
          event_json = excluded.event_json,
          enrichment_status = excluded.enrichment_status,
          created_at = timeline_events.created_at,
          updated_at = excluded.updated_at`,
      ).run({
        id: event.id,
        externalId: event.externalId ?? null,
        timelineKey: event.timelineKey,
        provider: event.provider,
        role: event.role,
        senderId: event.sender.id,
        senderDisplayName: event.sender.displayName ?? null,
        body: event.body,
        timestamp: event.timestamp,
        receivedAt: event.receivedAt,
        agentSessionId: event.agentSessionId ?? null,
        eventJson: JSON.stringify(event),
        enrichmentStatus: enrichmentStatus ?? "pending",
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  getTimelineEvents(timelineKey: string, limit = 200): CanonicalChatEvent[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from (
             select event_json, timestamp, received_at, id
             from timeline_events
             where timeline_key = ?
             order by timestamp desc, received_at desc, id desc
             limit ?
           )
           order by timestamp asc, received_at asc, id asc`,
        )
        .all(timelineKey, limit) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getTimelineEventsForContext(
    timelineKey: string,
    retainedStartEventId: string | null | undefined,
    limit = 1000,
  ): CanonicalChatEvent[] {
    if (!retainedStartEventId) return this.getTimelineEvents(timelineKey, limit);

    const cursor = this.read((db) =>
      db
        .prepare(
          `select timestamp, received_at, id
           from timeline_events
           where timeline_key = ? and id = ?`,
        )
        .get(timelineKey, retainedStartEventId) as
        | { timestamp: number; received_at: number; id: string }
        | undefined,
    );
    if (!cursor) return this.getTimelineEvents(timelineKey, limit);

    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @timestamp
               or (timestamp = @timestamp and received_at > @receivedAt)
               or (timestamp = @timestamp and received_at = @receivedAt and id >= @id)
             )
           order by timestamp asc, received_at asc, id asc
           limit @limit`,
        )
        .all({
          timelineKey,
          timestamp: cursor.timestamp,
          receivedAt: cursor.received_at,
          id: cursor.id,
          limit,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getTimelineEventById(id: string): CanonicalChatEvent | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(id) as { event_json: string } | undefined,
    );
    return row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
  }

  /** Current enrichment_status of a stored event, or undefined if absent. */
  getEnrichmentStatus(id: string): string | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select enrichment_status from timeline_events where id = ?`)
        .get(id) as { enrichment_status: string } | undefined,
    );
    return row?.enrichment_status;
  }

  getTimelineCompactionState(timelineKey: string): TimelineCompactionState | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select state_json from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { state_json: string } | undefined,
    );
    return row ? (JSON.parse(row.state_json) as TimelineCompactionState) : undefined;
  }

  saveTimelineCompactionState(state: TimelineCompactionState): Promise<void> {
    return this.write((db) => {
      // The on-conflict path deliberately omits `timeline_state` from the SET
      // list, so a summarization-pipeline save never clobbers the lifecycle
      // state owned by `setTimelineState`/activation. Symmetric to the note on
      // `setTimelineState` (which conversely leaves `state_json`/the compaction
      // cursors untouched): the two writers update disjoint columns of the same
      // row and never regress each other.
      //
      // The bare insert branch (no existing row) deliberately omits
      // `timeline_state` too, falling back to the column default `'inactive'`.
      // That default is only correct because the sole caller — the summarization
      // pipeline — runs exclusively for already-active timelines, which always
      // already have a row written by `setTimelineState('active')` during
      // activation. So this call always hits the UPDATE path; the insert branch
      // is effectively unreachable today. A FUTURE caller that wrote compaction
      // state before activation would insert with `timeline_state='inactive'`
      // while carrying real cursors, and `pruneInactiveTimelineEvents` would
      // treat the timeline as prunable — so such a caller must seed the
      // lifecycle state explicitly rather than rely on this insert.
      db.prepare(
        `insert into timeline_compaction_state (
          timeline_key, compact_start_event_id, rich_start_event_id, state_json, updated_at
        ) values (
          @timelineKey, @compactStartEventId, @richStartEventId, @stateJson, @updatedAt
        )
        on conflict(timeline_key) do update set
          compact_start_event_id = excluded.compact_start_event_id,
          rich_start_event_id = excluded.rich_start_event_id,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
      ).run({
        timelineKey: state.timelineKey,
        compactStartEventId: state.compactStartEventId,
        richStartEventId: state.richStartEventId,
        stateJson: JSON.stringify(state),
        updatedAt: state.updatedAt,
      });
    });
  }

  /**
   * Current lifecycle state of a timeline. A missing `timeline_compaction_state`
   * row means the channel has never been triggered, i.e. `'inactive'` (§2).
   */
  getTimelineState(timelineKey: string): TimelineState {
    const row = this.read((db) =>
      db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { timeline_state: TimelineState } | undefined,
    );
    return row?.timeline_state ?? "inactive";
  }

  /**
   * Set a timeline's lifecycle state, upserting the compaction-state row. The
   * insert seeds a minimal valid `state_json`; the on-conflict path touches only
   * `timeline_state`/`updated_at`, preserving the compaction cursors and any
   * existing serialized state written by the summarization pipeline.
   */
  setTimelineState(timelineKey: string, state: TimelineState): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      // Minimal seed written only on first insert. The on-conflict path below
      // deliberately leaves `state_json` untouched, so this never clobbers real
      // compaction cursors. Keep this shape in sync with the
      // `TimelineCompactionState` written by `saveTimelineCompactionState` — both
      // sites construct the same serialized shape.
      const seedState: TimelineCompactionState = {
        schemaVersion: 1,
        timelineKey,
        compactStartEventId: null,
        richStartEventId: null,
        updatedAt: now,
      };
      db.prepare(
        `insert into timeline_compaction_state (
          timeline_key, compact_start_event_id, rich_start_event_id, state_json,
          timeline_state, updated_at
        ) values (
          @timelineKey, null, null, @stateJson, @state, @updatedAt
        )
        on conflict(timeline_key) do update set
          timeline_state = excluded.timeline_state,
          updated_at = excluded.updated_at`,
      ).run({
        timelineKey,
        stateJson: JSON.stringify(seedState),
        state,
        updatedAt: now,
      });
    });
  }

  /**
   * Flip every `'inactive'` event in a timeline to `'pending'` so the enrichment
   * and caption pools pick them up after activation (§4 step 4). Returns the
   * number of rows updated.
   */
  activateTimelineEvents(timelineKey: string): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_events set enrichment_status = 'pending', updated_at = ?
           where timeline_key = ? and enrichment_status = 'inactive'`,
        )
        .run(Date.now(), timelineKey);
      return result.changes;
    });
  }

  /**
   * Reset timelines stranded in `'activating'` (process crashed mid-activation)
   * back to `'inactive'` so the next trigger re-runs activation. Called on
   * startup, mirroring the stale-claim resets for enrichment/captions/jobs.
   * Returns the number of rows reset.
   *
   * NOTE (#9): this only heals timelines stuck in `'activating'`. It does NOT
   * touch `'active'` timelines. Combined with the retention sweep
   * (`pruneInactiveTimelineEvents`) only touching INACTIVE timelines, this means
   * the activation path's bulk `'inactive'`→`'pending'` flip
   * (`activateTimelineEvents`) MUST happen before the `setTimelineState('active')`
   * promotion: any `'inactive'` event rows left under an `'active'` timeline would
   * be invisible to both recovery paths and thus never enriched or pruned. See
   * the matching comment in `ActivationCoordinator.activateTimeline`.
   */
  resetStaleActivations(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_compaction_state set timeline_state = 'inactive', updated_at = ?
           where timeline_state = 'activating'`,
        )
        .run(Date.now());
      return result.changes;
    });
  }

  /**
   * Prune events that belong to *inactive* timelines and are older than
   * `olderThanMs` (a millisecond cutoff: rows with `timestamp < olderThanMs` are
   * deleted). Implements the Phase 8 retention job (spec §3,§13).
   *
   * A timeline is "inactive" when it has no `timeline_compaction_state` row (a
   * never-engaged channel — see `getTimelineState` semantics) OR its row's
   * `timeline_state = 'inactive'`. Events belonging to timelines in any non-
   * inactive state (`activating`/`active`/`backfilling`) are NEVER pruned — only
   * those whose `timeline_key` is absent from the set of non-inactive rows.
   *
   * Returns the number of rows deleted. Runs through the single-writer queue.
   *
   * Ordering invariant: prune treats "no `timeline_compaction_state` row =
   * prunable", which stays safe only because `activateTimeline` writes the
   * `'activating'` state (via `setTimelineState`, which inserts the row) BEFORE
   * storing any backfilled events. Both writes serialize through the
   * single-writer queue, so a concurrent prune can never see backfilled rows
   * while their timeline still lacks a non-`inactive` row (which would delete
   * them out from under an in-flight activation).
   */
  pruneInactiveTimelineEvents(olderThanMs: number): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `delete from timeline_events
           where timestamp < ?
             and timeline_key not in (
               select timeline_key from timeline_compaction_state
               where timeline_state != 'inactive'
             )`,
        )
        .run(olderThanMs);
      return result.changes;
    });
  }

  // Scoped by timeline_key (issue #3): two bot accounts sharing a room store the
  // same Matrix event as two rows differing only by canonical id, so an unscoped
  // `(provider, external_id)` lookup would return an arbitrary account's row. The
  // existing `(provider, external_id)` index still serves the query — timeline_key
  // just filters the tiny matched set.
  getTimelineEventByExternalId(
    provider: string,
    externalId: string,
    timelineKey: string,
  ): CanonicalChatEvent | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select event_json from timeline_events
           where provider = ? and external_id = ? and timeline_key = ? limit 1`,
        )
        .get(provider, externalId, timelineKey) as { event_json: string } | undefined,
    );
    return row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
  }

  /**
   * Resolve the ACTUAL stored timeline_key of an edit target (issue #4). A
   * re-decrypted `m.replace` placeholder always lands on the room/DM key (its
   * thread relation was megolm-encrypted at store time), but the target original,
   * once decrypted, may live on a thread key (`…:thread:<root>`). Looking the edit
   * up under the placeholder's room key alone would miss a thread target and park
   * the edit under the wrong key, where replay never matches — silent edit loss.
   *
   * Scope: the target is the same Matrix event in the same room/account as the
   * placeholder, so we match `(provider, external_id)` constrained to the
   * placeholder's room base — either the room key itself or any of its thread keys
   * (`<roomKey>:thread:%`). The room base embeds `matrix:<account>:room:<roomId>`,
   * so this preserves the multi-account scoping that the room-key lookup has
   * (issue #3): a different account's row lives under a different base and is never
   * matched. Returns the target's stored timeline_key, or undefined if no target
   * is stored under this room base (caller falls back to the room key → parks).
   * Prefers an exact room-key match (the common room-target case) over a thread one.
   */
  resolveEditTargetTimelineKey(
    provider: string,
    externalId: string,
    roomTimelineKey: string,
  ): string | undefined {
    const row = this.read(
      (db) =>
        db
          .prepare(
            `select timeline_key from timeline_events
             where provider = ? and external_id = ?
               and (timeline_key = @roomKey
                    or timeline_key like @threadPrefix escape '\\')
             order by case when timeline_key = @roomKey then 0 else 1 end,
                      timeline_key
             limit 1`,
          )
          .get(provider, externalId, {
            roomKey: roomTimelineKey,
            // SQLite LIKE: escape %/_/\ in the room key so a roomId containing them
            // can't broaden the match. `:thread:` keys append the root after this.
            threadPrefix: `${roomTimelineKey.replace(/[\\%_]/g, "\\$&")}:thread:%`,
          }) as { timeline_key: string } | undefined,
    );
    return row?.timeline_key;
  }

  updateTimelineEvent(
    id: string,
    updater: (event: CanonicalChatEvent) => CanonicalChatEvent,
  ): Promise<CanonicalChatEvent> {
    return this.write((db) => {
      const row = db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(id) as { event_json: string } | undefined;
      if (!row) throw new Error(`Timeline event not found: ${id}`);
      const updated = updater(JSON.parse(row.event_json) as CanonicalChatEvent);
      db.prepare(
        `update timeline_events
         set external_id = @externalId,
             timeline_key = @timelineKey,
             provider = @provider,
             role = @role,
             sender_id = @senderId,
             sender_display_name = @senderDisplayName,
             body = @body,
             timestamp = @timestamp,
             received_at = @receivedAt,
             agent_session_id = @agentSessionId,
             event_json = @eventJson,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id,
        externalId: updated.externalId ?? null,
        timelineKey: updated.timelineKey,
        provider: updated.provider,
        role: updated.role,
        senderId: updated.sender.id,
        senderDisplayName: updated.sender.displayName ?? null,
        body: updated.body,
        timestamp: updated.timestamp,
        receivedAt: updated.receivedAt,
        agentSessionId: updated.agentSessionId ?? null,
        eventJson: JSON.stringify(updated),
        updatedAt: Date.now(),
      });
      return updated;
    });
  }

  /**
   * Stored undecryptable (UTD) events, oldest first, capped at `limit`. Backed
   * by the `is_undecryptable` generated column + partial index, so this is cheap
   * even with a large timeline. Used by the re-decryption sweeper.
   *
   * Rows whose `redecrypt_attempts` have reached {@link MAX_REDECRYPT_ATTEMPTS}
   * (or the {@link REDECRYPT_RETIRED} sentinel) are excluded (issue #1): a wall of
   * permanently-dead OLD rows must not consume the oldest-first window and starve
   * newer, decryptable rows. Each returned event carries its current attempt count
   * so the sweeper can prune its in-memory backoff map and persist increments.
   */
  getUndecryptedEvents(limit = 100): Array<{ event: CanonicalChatEvent; attempts: number }> {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json, redecrypt_attempts
           from timeline_events
           where is_undecryptable = 1 and redecrypt_attempts < @max
           order by timestamp asc
           limit @limit`,
        )
        .all({ limit, max: MAX_REDECRYPT_ATTEMPTS }) as Array<{
        event_json: string;
        redecrypt_attempts: number;
      }>,
    );
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as CanonicalChatEvent,
      attempts: row.redecrypt_attempts,
    }));
  }

  /**
   * Persist a failed re-decryption probe: bump `redecrypt_attempts` by one (so the
   * row eventually crosses {@link MAX_REDECRYPT_ATTEMPTS} and drops out of the
   * candidate set) while the row is still UTD. Guarded on `is_undecryptable = 1`
   * so a row that decrypted via a concurrent path is not bumped. Returns the new
   * attempt count (or `undefined` if the row no longer exists / is no longer UTD).
   */
  recordRedecryptFailure(eventId: string): Promise<number | undefined> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_events
             set redecrypt_attempts = redecrypt_attempts + 1, updated_at = ?
           where id = ? and is_undecryptable = 1`,
        )
        .run(Date.now(), eventId);
      if (result.changes === 0) return undefined;
      const row = db
        .prepare(`select redecrypt_attempts from timeline_events where id = ?`)
        .get(eventId) as { redecrypt_attempts: number } | undefined;
      return row?.redecrypt_attempts;
    });
  }

  /**
   * Permanently retire a UTD row from the re-decryption rotation by stamping its
   * `redecrypt_attempts` to the {@link REDECRYPT_RETIRED} sentinel (issue #1).
   * Used for rows that can never be re-fetched (no resolvable room/event id). The
   * row stays UTD (content unchanged) but `getUndecryptedEvents` will never return
   * it again. Guarded on `is_undecryptable = 1` so a decrypted row is untouched.
   */
  retireUndecryptedEvent(eventId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update timeline_events
           set redecrypt_attempts = ?, updated_at = ?
         where id = ? and is_undecryptable = 1`,
      ).run(REDECRYPT_RETIRED, Date.now(), eventId);
    });
  }

  /**
   * Delete a UTD row outright (issue #9). Used when a re-decryption probe shows
   * the event decrypted to a non-renderable message (sticker / poll / reaction):
   * the native summary comes back `null` *without throwing*, which the live append
   * path never stores, so removing the placeholder matches live parity. Guarded on
   * `is_undecryptable = 1` so a row that became a real decrypted message via a
   * concurrent path is never deleted. Returns `true` when a row was removed.
   */
  deleteUndecryptedEvent(eventId: string): Promise<boolean> {
    return this.write((db) => {
      const result = db
        .prepare(`delete from timeline_events where id = ? and is_undecryptable = 1`)
        .run(eventId);
      return result.changes > 0;
    });
  }

  /**
   * Replace a stored UTD event with its decrypted form. Rebuilds body/event_json
   * from `updater` (which must clear `undecryptable` and set the real
   * body/attachments), sets `enrichment_status` to the value `computeStatus`
   * returns, and bumps `updated_at`. Matched by event id.
   *
   * `computeStatus(updated, timelineState)` decides the post-decrypt enrichment
   * status (issues #5/#6). It is evaluated *inside* the write transaction with the
   * decrypted event and the live `timeline_state` of the row's (possibly re-homed)
   * timeline, so the sweeper and the persisted row agree without the sweeper
   * needing its own read. The chosen status is returned to the caller so its
   * notify decisions match exactly what was stored. The status must be a legal
   * `enrichment_status` value: typically `'inactive'` for inactive timelines, else
   * `'pending'` / `'skipped'` per `needsEnrichment`.
   *
   * The decrypted relation can move the event off the room timeline (a thread
   * message stored UTD has its `m.thread` relation encrypted at store time): the
   * `updater` may return a different `timelineKey`/`threadId`, which is persisted
   * here — the row is re-homed, and the timeline state is read for the NEW key.
   * The canonical id (dedup key) is never changed.
   *
   * Returns `{ event, replaced, status }`. `replaced` is `false` when the row was
   * already non-UTD (the sweeper races backfill/message_summary touches): nothing
   * is written, the existing row is returned, and `status` is its current stored
   * status so the caller can skip re-arming enrichment and the misleading
   * "replaced" log. Returns `undefined` only when no row exists for the id.
   */
  replaceUndecryptedEvent(
    eventId: string,
    updater: (event: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<{ event: CanonicalChatEvent; replaced: boolean; status: string } | undefined> {
    return this.write((db) => {
      const row = db
        .prepare(`select event_json, enrichment_status from timeline_events where id = ?`)
        .get(eventId) as { event_json: string; enrichment_status: string } | undefined;
      if (!row) return undefined;
      const existing = JSON.parse(row.event_json) as CanonicalChatEvent;
      if (!existing.undecryptable) {
        // Already replaced; no-op. Report the existing stored status.
        return { event: existing, replaced: false, status: row.enrichment_status };
      }
      const updated = updater(existing);
      // Resolve the timeline state of the (possibly re-homed) destination key. A
      // missing compaction-state row means the channel was never engaged →
      // 'inactive' (mirrors getTimelineState).
      const stateRow = db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(updated.timelineKey) as { timeline_state: TimelineState } | undefined;
      const timelineState: TimelineState = stateRow?.timeline_state ?? "inactive";
      const status = computeStatus(updated, timelineState);
      db.prepare(
        `update timeline_events
         set external_id = @externalId,
             timeline_key = @timelineKey,
             provider = @provider,
             role = @role,
             sender_id = @senderId,
             sender_display_name = @senderDisplayName,
             body = @body,
             timestamp = @timestamp,
             received_at = @receivedAt,
             agent_session_id = @agentSessionId,
             event_json = @eventJson,
             enrichment_status = @enrichmentStatus,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id: eventId,
        externalId: updated.externalId ?? null,
        timelineKey: updated.timelineKey,
        provider: updated.provider,
        role: updated.role,
        senderId: updated.sender.id,
        senderDisplayName: updated.sender.displayName ?? null,
        body: updated.body,
        timestamp: updated.timestamp,
        receivedAt: updated.receivedAt,
        agentSessionId: updated.agentSessionId ?? null,
        eventJson: JSON.stringify(updated),
        enrichmentStatus: status,
        updatedAt: Date.now(),
      });
      return { event: updated, replaced: true, status };
    });
  }

  /**
   * Apply a Matrix edit (`m.replace`) to its target message in place (issue #17),
   * mirroring what a normal client shows: the original message is updated, not a
   * new row inserted. The target is located by `(provider, externalId)`; `updater`
   * rebuilds the canonical with the replacement body/attachments while preserving
   * identity (id, timelineKey, role, sender, timestamps) — see
   * {@link applyEditToCanonical}.
   *
   * `enrichment_status` is recomputed via `computeStatus(updated, timelineState)`
   * (the same callback shape as {@link replaceUndecryptedEvent}), evaluated inside
   * the write transaction against the target row's live `timeline_state` so an
   * edit landing on an inactive timeline keeps `'inactive'` and never nudges the
   * pools (issue #6 gating). The chosen status is returned so the caller's notify
   * decisions match exactly what was stored.
   *
   * Returns `{ applied: true, event, status }` on success, or
   * `{ applied: false }` when no target row exists for `(provider, externalId)` —
   * the caller logs and skips, never inserting the edit as a standalone message.
   * Latest-by-origin_server_ts wins on repeated edits (issue #3): the row tracks
   * `last_edit_timestamp`, and an incoming edit older than it is a no-op (returns
   * the already-stored event/status). Equal-or-newer timestamps apply. This
   * mirrors the pending_edits `>=` guard, so the applied and parked paths agree.
   */
  applyEditToTarget(
    provider: string,
    targetExternalId: string,
    timelineKey: string,
    replacement: EditReplacementContent,
    editTimestamp: number,
    updater: (target: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<
    | { applied: true; event: CanonicalChatEvent; status: string }
    | { applied: false; pending: true }
  > {
    return this.write((db) => {
      // Scoped by timeline_key (issue #3): in a multi-account shared room the same
      // Matrix event is stored once per bot account (rows differ only by canonical
      // id), so an unscoped `(provider, external_id)` lookup could edit the wrong
      // account's row. An edit is always same-room/account as its target, so the
      // caller's timelineKey is the correct scope.
      const row = db
        .prepare(
          `select id, event_json, last_edit_timestamp from timeline_events
           where provider = ? and external_id = ? and timeline_key = ? limit 1`,
        )
        .get(provider, targetExternalId, timelineKey) as
        | { id: string; event_json: string; last_edit_timestamp: number | null }
        | undefined;
      if (!row) {
        // The target isn't stored yet (out-of-order sync / backfill). Park the
        // resolved replacement so the append path replays it once the target
        // lands (issue #12). Latest edit wins: insert-or-replace on the PK keeps
        // the newest by edit_timestamp.
        db.prepare(
          `insert into pending_edits (
             provider, target_external_id, timeline_key,
             body, attachments_json, edit_timestamp, created_at
           ) values (
             @provider, @targetExternalId, @timelineKey,
             @body, @attachmentsJson, @editTimestamp, @createdAt
           )
           on conflict(provider, target_external_id, timeline_key) do update set
             body = excluded.body,
             attachments_json = excluded.attachments_json,
             edit_timestamp = excluded.edit_timestamp,
             created_at = excluded.created_at
           where excluded.edit_timestamp >= pending_edits.edit_timestamp`,
        ).run({
          provider,
          targetExternalId,
          timelineKey,
          body: replacement.body,
          attachmentsJson: JSON.stringify(replacement.attachments),
          editTimestamp,
          createdAt: Date.now(),
        });
        return { applied: false, pending: true };
      }

      const existing = JSON.parse(row.event_json) as CanonicalChatEvent;
      // Latest-by-origin_server_ts wins (issue #3): if a newer edit has already
      // been applied to this row, an older incoming edit is a no-op. Without this
      // guard the applied path was last-arrival-wins (unlike the pending_edits
      // path, which has always been latest-wins), so a re-decrypted older edit
      // arriving after a newer live edit could clobber the newer body. Return the
      // already-stored event/status so the caller (e.g. the redecryption sweeper,
      // which retires its placeholder on `applied`) sees a stable result and does
      // not re-arm pools for a stale edit. Equal timestamps still apply (mirrors
      // the pending_edits `>=` guard) — a benign re-application of the same edit.
      if (row.last_edit_timestamp !== null && editTimestamp < row.last_edit_timestamp) {
        const storedStatusRow = db
          .prepare(`select enrichment_status from timeline_events where id = ?`)
          .get(row.id) as { enrichment_status: string } | undefined;
        return {
          applied: true,
          event: existing,
          status: storedStatusRow?.enrichment_status ?? "skipped",
        };
      }
      const updated = updater(existing);
      // The edit-application path never re-homes the target: it edits an existing
      // row by its own timeline. Resolve the target's timeline state for gating.
      const stateRow = db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(updated.timelineKey) as { timeline_state: TimelineState } | undefined;
      const timelineState: TimelineState = stateRow?.timeline_state ?? "inactive";
      const status = computeStatus(updated, timelineState);
      db.prepare(
        `update timeline_events
         set body = @body,
             event_json = @eventJson,
             enrichment_status = @enrichmentStatus,
             last_edit_timestamp = @lastEditTimestamp,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id: row.id,
        body: updated.body,
        eventJson: JSON.stringify(updated),
        enrichmentStatus: status,
        lastEditTimestamp: editTimestamp,
        updatedAt: Date.now(),
      });
      return { applied: true, event: updated, status };
    });
  }

  /**
   * Look up a parked pending edit for a just-stored event (issue #12), if any,
   * scoped by `(provider, target_external_id, timeline_key)`. Used by the append
   * path to replay an edit that arrived before its target. Read-only; the caller
   * applies it and then calls {@link deletePendingEdit} in the same transaction.
   */
  getPendingEdit(
    db: Database.Database,
    provider: string,
    externalId: string,
    timelineKey: string,
  ): (EditReplacementContent & { editTimestamp: number }) | undefined {
    const row = db
      .prepare(
        `select body, attachments_json, edit_timestamp from pending_edits
         where provider = ? and target_external_id = ? and timeline_key = ?`,
      )
      .get(provider, externalId, timelineKey) as
      | { body: string; attachments_json: string; edit_timestamp: number }
      | undefined;
    if (!row) return undefined;
    return {
      body: row.body,
      attachments: JSON.parse(row.attachments_json) as AttachmentMeta[],
      editTimestamp: row.edit_timestamp,
    };
  }

  /** Delete a replayed pending edit (issue #12). Runs inside the caller's write. */
  deletePendingEdit(
    db: Database.Database,
    provider: string,
    externalId: string,
    timelineKey: string,
  ): void {
    db.prepare(
      `delete from pending_edits
       where provider = ? and target_external_id = ? and timeline_key = ?`,
    ).run(provider, externalId, timelineKey);
  }

  claimPendingEnrichment(limit: number): Promise<string[]> {
    return this.write((db) => {
      const rows = db.prepare(
        `select id from timeline_events
         where enrichment_status = 'pending'
         order by timestamp desc
         limit ?`,
      ).all(limit) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const update = db.prepare(
        `update timeline_events set enrichment_status = 'processing', updated_at = ?
         where id = ? and enrichment_status = 'pending'`,
      );
      const now = Date.now();
      const claimed: string[] = [];
      for (const row of rows) {
        const result = update.run(now, row.id);
        if (result.changes > 0) claimed.push(row.id);
      }
      return claimed;
    });
  }

  setEnrichmentStatus(eventId: string, status: string, error?: string, retries?: number): Promise<void> {
    return this.write((db) => {
      if (retries != null) {
        db.prepare(
          `update timeline_events set enrichment_status = ?, enrichment_retries = ?, updated_at = ? where id = ?`,
        ).run(status, retries, Date.now(), eventId);
      } else {
        db.prepare(
          `update timeline_events set enrichment_status = ?, updated_at = ? where id = ?`,
        ).run(status, Date.now(), eventId);
      }
    });
  }

  getEnrichmentRetries(eventId: string): number {
    return this.read((db) => {
      const row = db.prepare(
        `select enrichment_retries from timeline_events where id = ?`,
      ).get(eventId) as { enrichment_retries: number } | undefined;
      return row?.enrichment_retries ?? 0;
    });
  }

  resetStaleEnrichment(): Promise<number> {
    return this.write((db) => {
      const result = db.prepare(
        `update timeline_events set enrichment_status = 'pending'
         where enrichment_status = 'processing'`,
      ).run();
      return result.changes;
    });
  }

  setTriggerGroup(triggerEventId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return Promise.resolve();
    return this.write((db) => {
      const placeholders = eventIds.map(() => "?").join(", ");
      db.prepare(
        `update timeline_events set trigger_group_id = ?, updated_at = ?
         where id in (${placeholders})`,
      ).run(triggerEventId, Date.now(), ...eventIds);
    });
  }

  insertReplyContext(row: ReplyContextRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into reply_contexts (
          event_id, reply_external_id, sender_id, sender_display_name,
          body, html_body, timestamp, created_at
        ) values (
          @eventId, @replyExternalId, @senderId, @senderDisplayName,
          @body, @htmlBody, @timestamp, @createdAt
        )`,
      ).run({
        eventId: row.event_id,
        replyExternalId: row.reply_external_id ?? null,
        senderId: row.sender_id ?? null,
        senderDisplayName: row.sender_display_name ?? null,
        body: row.body ?? null,
        htmlBody: row.html_body ?? null,
        timestamp: row.timestamp ?? null,
        createdAt: row.created_at,
      });
    });
  }

  insertLinkPreview(row: LinkPreviewRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into link_previews (
          id, event_id, context, url, title, description, site_name,
          source_kind, preview_index, fetched_at, fetch_status, error, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error, @createdAt
        )`,
      ).run({
        id: row.id,
        eventId: row.event_id,
        context: row.context,
        url: row.url,
        title: row.title ?? null,
        description: row.description ?? null,
        siteName: row.site_name ?? null,
        sourceKind: row.source_kind ?? null,
        previewIndex: row.preview_index,
        fetchedAt: row.fetched_at ?? null,
        fetchStatus: row.fetch_status,
        error: row.error ?? null,
        createdAt: row.created_at,
      });
    });
  }

  insertMediaAsset(row: MediaAssetRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into media_assets (
          id, event_id, role, source_index, link_preview_id, local_path,
          mime_type, media_type, size_bytes, width, height, duration_seconds,
          original_filename, detected_content, detected_metadata_json,
          caption, caption_model, caption_status, caption_error,
          download_status, download_error, created_at
        ) values (
          @id, @eventId, @role, @sourceIndex, @linkPreviewId, @localPath,
          @mimeType, @mediaType, @sizeBytes, @width, @height, @durationSeconds,
          @originalFilename, @detectedContent, @detectedMetadataJson,
          @caption, @captionModel, @captionStatus, @captionError,
          @downloadStatus, @downloadError, @createdAt
        )`,
      ).run({
        id: row.id,
        eventId: row.event_id,
        role: row.role,
        sourceIndex: row.source_index ?? null,
        linkPreviewId: row.link_preview_id ?? null,
        localPath: row.local_path ?? null,
        mimeType: row.mime_type ?? null,
        mediaType: row.media_type,
        sizeBytes: row.size_bytes ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        durationSeconds: row.duration_seconds ?? null,
        originalFilename: row.original_filename ?? null,
        detectedContent: row.detected_content ?? null,
        detectedMetadataJson: row.detected_metadata_json ?? null,
        caption: row.caption ?? null,
        captionModel: row.caption_model ?? null,
        captionStatus: row.caption_status,
        captionError: row.caption_error ?? null,
        downloadStatus: row.download_status,
        downloadError: row.download_error ?? null,
        createdAt: row.created_at,
      });
    });
  }

  persistEnrichmentResults(
    eventId: string,
    result: {
      replyContext: ReplyContextRow | null;
      linkPreviews: LinkPreviewRow[];
      mediaAssets: MediaAssetRow[];
    },
  ): Promise<void> {
    return this.readAndWrite((db) => {
      db.prepare(`delete from media_assets where event_id = ?`).run(eventId);
      db.prepare(`delete from link_previews where event_id = ?`).run(eventId);
      db.prepare(`delete from reply_contexts where event_id = ?`).run(eventId);

      if (result.replyContext) {
        db.prepare(
          `insert or replace into reply_contexts (
            event_id, reply_external_id, sender_id, sender_display_name,
            body, html_body, timestamp, created_at
          ) values (
            @eventId, @replyExternalId, @senderId, @senderDisplayName,
            @body, @htmlBody, @timestamp, @createdAt
          )`,
        ).run({
          eventId: result.replyContext.event_id,
          replyExternalId: result.replyContext.reply_external_id ?? null,
          senderId: result.replyContext.sender_id ?? null,
          senderDisplayName: result.replyContext.sender_display_name ?? null,
          body: result.replyContext.body ?? null,
          htmlBody: result.replyContext.html_body ?? null,
          timestamp: result.replyContext.timestamp ?? null,
          createdAt: result.replyContext.created_at,
        });
      }

      const insertPreview = db.prepare(
        `insert or replace into link_previews (
          id, event_id, context, url, title, description, site_name,
          source_kind, preview_index, fetched_at, fetch_status, error, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error, @createdAt
        )`,
      );
      for (const lp of result.linkPreviews) {
        insertPreview.run({
          id: lp.id,
          eventId: lp.event_id,
          context: lp.context,
          url: lp.url,
          title: lp.title ?? null,
          description: lp.description ?? null,
          siteName: lp.site_name ?? null,
          sourceKind: lp.source_kind ?? null,
          previewIndex: lp.preview_index,
          fetchedAt: lp.fetched_at ?? null,
          fetchStatus: lp.fetch_status,
          error: lp.error ?? null,
          createdAt: lp.created_at,
        });
      }

      const insertAsset = db.prepare(
        `insert or replace into media_assets (
          id, event_id, role, source_index, link_preview_id, local_path,
          mime_type, media_type, size_bytes, width, height, duration_seconds,
          original_filename, detected_content, detected_metadata_json,
          caption, caption_model, caption_status, caption_error,
          download_status, download_error, created_at
        ) values (
          @id, @eventId, @role, @sourceIndex, @linkPreviewId, @localPath,
          @mimeType, @mediaType, @sizeBytes, @width, @height, @durationSeconds,
          @originalFilename, @detectedContent, @detectedMetadataJson,
          @caption, @captionModel, @captionStatus, @captionError,
          @downloadStatus, @downloadError, @createdAt
        )`,
      );
      for (const ma of result.mediaAssets) {
        insertAsset.run({
          id: ma.id,
          eventId: ma.event_id,
          role: ma.role,
          sourceIndex: ma.source_index ?? null,
          linkPreviewId: ma.link_preview_id ?? null,
          localPath: ma.local_path ?? null,
          mimeType: ma.mime_type ?? null,
          mediaType: ma.media_type,
          sizeBytes: ma.size_bytes ?? null,
          width: ma.width ?? null,
          height: ma.height ?? null,
          durationSeconds: ma.duration_seconds ?? null,
          originalFilename: ma.original_filename ?? null,
          detectedContent: ma.detected_content ?? null,
          detectedMetadataJson: ma.detected_metadata_json ?? null,
          caption: ma.caption ?? null,
          captionModel: ma.caption_model ?? null,
          captionStatus: ma.caption_status,
          captionError: ma.caption_error ?? null,
          downloadStatus: ma.download_status,
          downloadError: ma.download_error ?? null,
          createdAt: ma.created_at,
        });
      }

      db.prepare(
        `update timeline_events set enrichment_status = 'complete', updated_at = ? where id = ?`,
      ).run(Date.now(), eventId);
    });
  }

  getEnrichmentData(eventIds: string[]): {
    replyContexts: Map<string, ReplyContextRow>;
    linkPreviews: Map<string, LinkPreviewRow[]>;
    mediaAssets: Map<string, MediaAssetRow[]>;
  } {
    if (eventIds.length === 0) {
      return { replyContexts: new Map(), linkPreviews: new Map(), mediaAssets: new Map() };
    }
    return this.read((db) => {
      const replyContexts = new Map<string, ReplyContextRow>();
      const linkPreviews = new Map<string, LinkPreviewRow[]>();
      const mediaAssets = new Map<string, MediaAssetRow[]>();

      const batchSize = 500;
      for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");

        const rcRows = db.prepare(
          `select * from reply_contexts where event_id in (${placeholders})`,
        ).all(...batch) as ReplyContextRow[];
        for (const row of rcRows) replyContexts.set(row.event_id, row);

        const lpRows = db.prepare(
          `select * from link_previews where event_id in (${placeholders})
           order by event_id, context, preview_index`,
        ).all(...batch) as LinkPreviewRow[];
        for (const row of lpRows) {
          const list = linkPreviews.get(row.event_id) ?? [];
          list.push(row);
          linkPreviews.set(row.event_id, list);
        }

        const maRows = db.prepare(
          `select * from media_assets where event_id in (${placeholders})
           order by event_id, role, source_index`,
        ).all(...batch) as MediaAssetRow[];
        for (const row of maRows) {
          const list = mediaAssets.get(row.event_id) ?? [];
          list.push(row);
          mediaAssets.set(row.event_id, list);
        }
      }

      return { replyContexts, linkPreviews, mediaAssets };
    });
  }

  claimPendingCaptions(limit: number, captionAll: boolean, captionAssistantMessages = false): Promise<MediaAssetRow[]> {
    return this.write((db) => {
      const rows = db.prepare(
        `select ma.* from media_assets ma
         join timeline_events te on ma.event_id = te.id
         where ma.caption_status = 'pending'
           and ma.download_status = 'complete'
           and ma.media_type in ('image', 'video', 'audio')
           and (te.trigger_group_id is not null or ? = 1 or (te.role = 'assistant' and ? = 1))
         order by
           case when te.trigger_group_id is not null then 0 else 1 end,
           te.timestamp desc
         limit ?`,
      ).all(captionAll ? 1 : 0, captionAssistantMessages ? 1 : 0, limit) as MediaAssetRow[];

      if (rows.length === 0) return [];

      const update = db.prepare(
        `update media_assets set caption_status = 'processing'
         where id = ? and caption_status = 'pending'`,
      );
      const claimed: MediaAssetRow[] = [];
      for (const row of rows) {
        const result = update.run(row.id);
        if (result.changes > 0) claimed.push({ ...row, caption_status: "processing" });
      }
      return claimed;
    });
  }

  updateCaptionResult(assetId: string, caption: string, model: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update media_assets
         set caption = ?, caption_model = ?, caption_status = 'complete'
         where id = ?`,
      ).run(caption, model, assetId);
    });
  }

  setCaptionStatus(assetId: string, status: string, error?: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update media_assets set caption_status = ?${error ? ", caption_error = ?" : ""} where id = ?`,
      ).run(...(error ? [status, error, assetId] : [status, assetId]));
    });
  }

  resetStaleCaptions(): Promise<number> {
    return this.write((db) => {
      const result = db.prepare(
        `update media_assets set caption_status = 'pending'
         where caption_status = 'processing'`,
      ).run();
      return result.changes;
    });
  }

  countPendingCaptions(eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    return this.read((db) => {
      let total = 0;
      const batchSize = 500;
      for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");
        const row = db.prepare(
          `select count(*) as remaining from media_assets
           where event_id in (${placeholders})
             and caption_status in ('pending', 'processing')
             and media_type in ('image', 'video', 'audio')`,
        ).get(...batch) as { remaining: number };
        total += row.remaining;
      }
      return total;
    });
  }

  getMediaAssetsForTriggerGroup(triggerEventId: string): MediaAssetRow[] {
    return this.read((db) => {
      return db.prepare(
        `select ma.* from media_assets ma
         where ma.event_id in (
           select id from timeline_events where trigger_group_id = ?
         )
         and ma.media_type in ('image', 'video', 'audio')
         and ma.download_status = 'complete'
         order by ma.event_id, ma.role, ma.source_index`,
      ).all(triggerEventId) as MediaAssetRow[];
    });
  }

  // ── Metadata key-value accessors ──────────────────────────────────

  getMetadata(key: string): string | null {
    const row = this.read((db) =>
      db.prepare(`select value from metadata where key = ?`).get(key) as
        | { value: string }
        | undefined,
    );
    return row ? row.value : null;
  }

  setMetadata(key: string, value: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into metadata (key, value, updated_at)
         values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, value, Date.now());
    });
  }

  // ── Exclusive-cursor timeline query ───────────────────────────────

  /**
   * Like getTimelineEventsForContext, but the cursor event is EXCLUDED
   * (id > cursor, not id >=). Used when the cursor event is covered by a
   * summary and must not also render raw.
   *
   * **Fallback on missing cursor (invariant violation):** When the cursor event
   * is not found in `timeline_events`, this method falls back to
   * `getTimelineEvents()` (recent events, no cursor filtering). This is
   * intentional degradation — throwing would be worse than degraded rendering,
   * since the missing cursor requires data corruption or an out-of-order delete
   * to trigger. However, the fallback may return events that are already covered
   * by a summary, potentially causing double-rendering (an event appears both in
   * the summary layer and as a raw event). The warning log emitted in this path
   * is the primary signal for investigation. Callers should not rely on the
   * returned events being disjoint from summary coverage when the warning fires.
   */
  getTimelineEventsAfter(
    timelineKey: string,
    afterEventId: string,
    limit = 1000,
  ): CanonicalChatEvent[] {
    const cursor = this.getEventCursor(timelineKey, afterEventId);
    if (!cursor) {
      if (this.logger) {
        this.logger.warn(
          "getTimelineEventsAfter: cursor event not found, falling back to recent events",
          { timelineKey, afterEventId },
        );
      }
      return this.getTimelineEvents(timelineKey, limit);
    }

    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @timestamp
               or (timestamp = @timestamp and received_at > @receivedAt)
               or (timestamp = @timestamp and received_at = @receivedAt and id > @id)
             )
           order by timestamp asc, received_at asc, id asc
           limit @limit`,
        )
        .all({
          timelineKey,
          timestamp: cursor.timestamp,
          receivedAt: cursor.receivedAt,
          id: cursor.id,
          limit,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getEventCursor(timelineKey: string, eventId: string): TimelineCursor | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select timestamp, received_at, id from timeline_events
           where timeline_key = ? and id = ?`,
        )
        .get(timelineKey, eventId) as
        | { timestamp: number; received_at: number; id: string }
        | undefined,
    );
    return row ? { timestamp: row.timestamp, receivedAt: row.received_at, id: row.id } : undefined;
  }

  /**
   * Events within the inclusive cursor range [start, end], ordered by
   * (timestamp, received_at, id) ascending. IDs are not chronologically
   * sortable, so callers resolve to cursors first.
   */
  getTimelineEventsBetween(
    timelineKey: string,
    start: TimelineCursor,
    end: TimelineCursor,
  ): CanonicalChatEvent[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @startTs
               or (timestamp = @startTs and received_at > @startRcv)
               or (timestamp = @startTs and received_at = @startRcv and id >= @startId)
             )
             and (
               timestamp < @endTs
               or (timestamp = @endTs and received_at < @endRcv)
               or (timestamp = @endTs and received_at = @endRcv and id <= @endId)
             )
           order by timestamp asc, received_at asc, id asc`,
        )
        .all({
          timelineKey,
          startTs: start.timestamp,
          startRcv: start.receivedAt,
          startId: start.id,
          endTs: end.timestamp,
          endRcv: end.receivedAt,
          endId: end.id,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  // ── Summary queries ───────────────────────────────────────────────

  /**
   * Candidate summaries for context selection: status in (complete,
   * truncated), ordered by earliest_timestamp ASC. When beforeTimestamp is
   * set, only summaries whose coverage ends at or before it (inclusive).
   * The inclusive bound prevents a coverage gap when a summary's
   * latestTimestamp exactly equals an event's timestamp (millisecond
   * collision from Matrix batch sends — §6).
   */
  getSummaryCandidates(timelineKey: string, beforeTimestamp?: number): Summary[] {
    const rows = this.read((db) => {
      if (beforeTimestamp != null) {
        return db
          .prepare(
            `select * from summaries
             where timeline_key = ? and status in ('complete', 'truncated')
               and latest_timestamp <= ?
             order by earliest_timestamp asc`,
          )
          .all(timelineKey, beforeTimestamp) as SummaryRow[];
      }
      return db
        .prepare(
          `select * from summaries
           where timeline_key = ? and status in ('complete', 'truncated')
           order by earliest_timestamp asc`,
        )
        .all(timelineKey) as SummaryRow[];
    });
    return rows.map(mapSummaryRow);
  }

  getSummaryById(id: string, timelineKey?: string): Summary | undefined {
    const row = this.read((db) => {
      if (timelineKey) {
        return db
          .prepare(`select * from summaries where id = ? and timeline_key = ?`)
          .get(id, timelineKey) as SummaryRow | undefined;
      }
      return db.prepare(`select * from summaries where id = ?`).get(id) as SummaryRow | undefined;
    });
    return row ? mapSummaryRow(row) : undefined;
  }

  /** Summaries at a given level, status in (complete, truncated), ordered by earliest_timestamp ASC. */
  getSummariesByLevel(timelineKey: string, level: number): Summary[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summaries
           where timeline_key = ? and level = ? and status in ('complete', 'truncated')
           order by earliest_timestamp asc`,
        )
        .all(timelineKey, level) as SummaryRow[],
    );
    return rows.map(mapSummaryRow);
  }

  /**
   * Summaries in the inclusive earliest_timestamp range bounded by two summary
   * IDs (resolved internally), ordered by earliest_timestamp ASC (tie-broken by id).
   * When `level` is provided, only summaries at that level are returned.
   */
  getSummariesBetween(timelineKey: string, startId: string, endId: string, level?: number): Summary[] {
    const start = this.getSummaryById(startId, timelineKey);
    const end = this.getSummaryById(endId, timelineKey);
    if (!start || !end) return [];

    // Precondition: boundary summaries must have a status that passes the range
    // query's `status in ('complete', 'truncated')` filter. A superseded boundary
    // would be found here (getSummaryById has no status filter) but excluded from
    // the range results, silently producing incomplete output.
    const validStatuses = new Set<string>(["complete", "truncated"]);
    if (!validStatuses.has(start.status)) {
      throw new Error(
        `getSummariesBetween: start boundary summary "${startId}" has status "${start.status}" ` +
        `which is excluded by the range query (requires 'complete' or 'truncated')`,
      );
    }
    if (!validStatuses.has(end.status)) {
      throw new Error(
        `getSummariesBetween: end boundary summary "${endId}" has status "${end.status}" ` +
        `which is excluded by the range query (requires 'complete' or 'truncated')`,
      );
    }
    const levelFilter = level != null ? "and level = @level" : "";
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summaries
           where timeline_key = @timelineKey and status in ('complete', 'truncated')
             ${levelFilter}
             and (
               earliest_timestamp > @startTs
               or (earliest_timestamp = @startTs and id >= @startId)
             )
             and (
               earliest_timestamp < @endTs
               or (earliest_timestamp = @endTs and id <= @endId)
             )
           order by earliest_timestamp asc, id asc`,
        )
        .all({
          timelineKey,
          ...(level != null ? { level } : {}),
          startTs: start.earliestTimestamp,
          startId: start.id,
          endTs: end.earliestTimestamp,
          endId: end.id,
        }) as SummaryRow[],
    );
    return rows.map(mapSummaryRow);
  }

  /** True if any summary at level >= minLevel falls between two timestamps (inclusive). */
  hasSummaryBetween(
    timelineKey: string,
    minLevel: number,
    afterTimestamp: number,
    beforeTimestamp: number,
  ): boolean {
    const row = this.read((db) =>
      db
        .prepare(
          `select 1 from summaries
           where timeline_key = ? and level >= ? and status in ('complete', 'truncated')
             and earliest_timestamp >= ? and latest_timestamp <= ?
           limit 1`,
        )
        .get(timelineKey, minLevel, afterTimestamp, beforeTimestamp) as { 1: number } | undefined,
    );
    return row != null;
  }

  /**
   * Insert a completed/truncated summary, its lineage rows, and mark the source
   * job complete — all in one transaction. No floor is persisted (the coverage
   * cursor is derived from latest_event_id).
   */
  insertSummaryWithLineage(insert: SummaryInsert): Promise<void> {
    return this.readAndWrite((db) => {
      const hasEventIds = insert.eventIds != null && insert.eventIds.length > 0;
      const hasParentIds = insert.parentIds != null && insert.parentIds.length > 0;
      if (hasEventIds && hasParentIds) {
        throw new Error("Summary cannot have both eventIds and parentIds");
      }
      if (insert.level === 1 && !hasEventIds) {
        throw new Error("Level-1 summary must have eventIds");
      }
      if (insert.level > 1 && !hasParentIds) {
        throw new Error("Level 2+ summary must have parentIds");
      }
      const now = Date.now();
      // Diary queue (ARCHITECTURE.md §9c): every LEVEL-1 summary gets queued for a
      // diary entry, unconditionally (NOT gated on [diary].enabled — when the
      // feature is off the pool simply doesn't drain, so rows accumulate as
      // 'pending' and flush when it's turned on). Level 2+ summaries get NULL: the
      // diary is written from raw participation, never from condensed summaries.
      const diaryStatus = insert.level === 1 ? "pending" : null;
      db.prepare(
        `insert into summaries (
          id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
          latest_event_id, event_count, token_count, model_id, status,
          backfill_job_id, generated_at, created_at, diary_status, diary_attempts
        ) values (
          @id, @timelineKey, @level, @content, @earliestTimestamp, @latestTimestamp,
          @latestEventId, @eventCount, @tokenCount, @modelId, @status,
          null, @generatedAt, @createdAt, @diaryStatus, 0
        )`,
      ).run({
        id: insert.id,
        timelineKey: insert.timelineKey,
        level: insert.level,
        content: insert.content,
        earliestTimestamp: insert.earliestTimestamp,
        latestTimestamp: insert.latestTimestamp,
        latestEventId: insert.latestEventId,
        eventCount: insert.eventCount,
        tokenCount: insert.tokenCount,
        modelId: insert.modelId,
        status: insert.status,
        generatedAt: insert.generatedAt,
        createdAt: now,
        diaryStatus,
      });

      if (insert.eventIds && insert.eventIds.length > 0) {
        const stmt = db.prepare(
          `insert into summary_events (summary_id, event_id, ordinal) values (?, ?, ?)`,
        );
        insert.eventIds.forEach((eventId, ordinal) => stmt.run(insert.id, eventId, ordinal));
      }

      if (insert.parentIds && insert.parentIds.length > 0) {
        const stmt = db.prepare(
          `insert into summary_parents (summary_id, parent_id, ordinal) values (?, ?, ?)`,
        );
        insert.parentIds.forEach((parentId, ordinal) => stmt.run(insert.id, parentId, ordinal));
      }

      const jobUpdate = db.prepare(
        `update summarization_jobs set status = 'complete', result_summary_id = ?, updated_at = ?
         where id = ?`,
      ).run(insert.id, now, insert.jobId);
      if (jobUpdate.changes !== 1) {
        throw new Error(
          `insertSummaryWithLineage: expected to update exactly 1 job row for "${insert.jobId}", ` +
          `but ${jobUpdate.changes} rows matched — rolling back`,
        );
      }
    });
  }

  // ── Summarization job queue ───────────────────────────────────────

  insertSummarizationJob(job: SummarizationJobInsert): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      db.prepare(
        `insert into summarization_jobs (
          id, timeline_key, level, status, input_start_id, input_end_id,
          input_token_count, target_token_count, attempts, max_retries,
          created_at, updated_at
        ) values (
          @id, @timelineKey, @level, 'pending', @inputStartId, @inputEndId,
          @inputTokenCount, @targetTokenCount, 0, @maxRetries, @createdAt, @updatedAt
        )`,
      ).run({
        id: job.id,
        timelineKey: job.timelineKey,
        level: job.level,
        inputStartId: job.inputStartId,
        inputEndId: job.inputEndId,
        inputTokenCount: job.inputTokenCount,
        targetTokenCount: job.targetTokenCount,
        maxRetries: job.maxRetries,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  getSummarizationJobById(id: string): SummarizationJob | undefined {
    const row = this.read((db) =>
      db.prepare(`select * from summarization_jobs where id = ?`).get(id) as
        | SummarizationJobRow
        | undefined,
    );
    return row ? mapJobRow(row) : undefined;
  }

  /** Active (pending or processing) jobs for a timeline + level. */
  getActiveSummarizationJobs(timelineKey: string, level: number): SummarizationJob[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summarization_jobs
           where timeline_key = ? and level = ? and status in ('pending', 'processing')
           order by created_at asc`,
        )
        .all(timelineKey, level) as SummarizationJobRow[],
    );
    return rows.map(mapJobRow);
  }

  /** All processing jobs for a timeline (any level). */
  getProcessingSummarizationJobs(timelineKey: string): SummarizationJob[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summarization_jobs
           where timeline_key = ? and status = 'processing'
           order by created_at asc`,
        )
        .all(timelineKey) as SummarizationJobRow[],
    );
    return rows.map(mapJobRow);
  }

  /**
   * Claim the oldest pending job via CAS (pending → processing). The SAME
   * transaction increments attempts (first claim => attempts = 1), bounding
   * crash-loops. Returns the claimed job (post-update) or undefined.
   */
  claimNextSummarizationJob(): Promise<SummarizationJob | undefined> {
    return this.readAndWrite((db) => {
      const row = db
        .prepare(
          `select * from summarization_jobs
           where status = 'pending'
           order by created_at asc
           limit 1`,
        )
        .get() as SummarizationJobRow | undefined;
      if (!row) return undefined;
      const now = Date.now();
      const result = db
        .prepare(
          `update summarization_jobs
           set status = 'processing', attempts = attempts + 1, updated_at = ?
           where id = ? and status = 'pending'`,
        )
        .run(now, row.id);
      if (result.changes === 0) return undefined;
      return mapJobRow({ ...row, status: "processing", attempts: row.attempts + 1, updated_at: now });
    });
  }

  /** Set a job back to pending for retry, recording the error. */
  retrySummarizationJob(jobId: string, error: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set status = 'pending', error = ?, updated_at = ? where id = ?`,
      ).run(error, Date.now(), jobId);
    });
  }

  failSummarizationJob(jobId: string, error: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set status = 'failed', error = ?, updated_at = ? where id = ?`,
      ).run(error, Date.now(), jobId);
    });
  }

  saveBestEffortDraft(jobId: string, draft: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set best_effort_draft = ?, updated_at = ? where id = ?`,
      ).run(draft, Date.now(), jobId);
    });
  }

  /** Reset stale 'processing' claims to 'pending' on startup (attempts left as-is). */
  resetStaleSummarizationJobs(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update summarization_jobs set status = 'pending', updated_at = ?
           where status = 'processing'`,
        )
        .run(Date.now());
      return result.changes;
    });
  }

  // ── Diary queue (ARCHITECTURE.md §9c) ─────────────────────────────
  //
  // The `diary_status` column on level-1 summary rows IS the queue — identical
  // to the enrichment_status / caption_status / summarization_jobs.status idiom.
  // No separate job/queue table. Only 'pending' rows are ever claimed → the DB
  // is the sole idempotency authority (correctness never depends on file state).

  /**
   * Claim the oldest pending diary job via CAS (pending → processing). The SAME
   * transaction increments+persists `diary_attempts` (first claim => attempts =
   * 1), so a crash un-sticks the row (via {@link resetStaleDiary}) without
   * refunding its retry budget. Returns the claimed job (post-update) or
   * undefined.
   */
  claimNextDiaryJob(): Promise<DiaryJob | undefined> {
    return this.readAndWrite((db) => {
      const row = db
        .prepare(
          `select id, timeline_key, level, earliest_timestamp, latest_timestamp, diary_attempts
           from summaries
           where level = 1 and diary_status = 'pending'
           order by latest_timestamp asc
           limit 1`,
        )
        .get() as
        | {
            id: string;
            timeline_key: string;
            level: number;
            earliest_timestamp: number;
            latest_timestamp: number;
            diary_attempts: number;
          }
        | undefined;
      if (!row) return undefined;
      const result = db
        .prepare(
          `update summaries
           set diary_status = 'processing', diary_attempts = diary_attempts + 1
           where id = ? and diary_status = 'pending'`,
        )
        .run(row.id);
      if (result.changes === 0) return undefined;
      return {
        summaryId: row.id,
        timelineKey: row.timeline_key,
        level: row.level,
        earliestTimestamp: row.earliest_timestamp,
        latestTimestamp: row.latest_timestamp,
        attempts: row.diary_attempts + 1,
      };
    });
  }

  /** Set a level-1 summary's diary status (done / skipped / failed / pending-retry). */
  setDiaryStatus(summaryId: string, status: DiaryStatus): Promise<void> {
    return this.write((db) => {
      db.prepare(`update summaries set diary_status = ? where id = ?`).run(status, summaryId);
    });
  }

  /**
   * Reset stale 'processing' diary claims to 'pending' on startup (attempts left
   * as-is, so a crash doesn't refund the retry budget). Mirrors
   * resetStaleEnrichment / resetStaleCaptions / resetStaleSummarizationJobs.
   */
  resetStaleDiary(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(`update summaries set diary_status = 'pending' where diary_status = 'processing'`)
        .run();
      return result.changes;
    });
  }

  // ── Memory retrieval index (ARCHITECTURE.md §9d) ──────────────────
  // `memory_chunks` is the corpus index; reconciliation is a content-hash set-diff
  // per file (§7). The DB — keyed on chunk `id = hash(path+text)` — is the sole
  // idempotency authority; correctness never depends on when a file write happened.

  /**
   * Reconcile a single file's chunks against the index (§7). New/changed-hash
   * chunks (a different `id`) are inserted with `embed_status='pending'`; chunks no
   * longer present are deleted; chunks present in both with shifted line/ordinal
   * metadata are updated in place (text identical → embedding preserved). FTS rows
   * follow via triggers. Runs in one transaction so a search never sees a torn diff.
   */
  /**
   * Reconcile a file's chunks into the index (§7). `newChunkStatus` is the
   * `embed_status` stamped on freshly-inserted chunks: `'pending'` in the normal
   * (provider-present) path so the embed worker picks them up, or `'skip'` in the
   * lexical-only path (no active provider) so the pending queue doesn't grow
   * unbounded (#2). `resetAllEmbeddings()` re-queues `'skip'` rows when a provider
   * later becomes active, keeping the round-trip consistent (§5a).
   */
  reconcileMemoryChunks(
    path: string,
    chunks: MemoryChunkInput[],
    newChunkStatus: "pending" | "skip" = "pending",
  ): Promise<ReconcileResult> {
    return this.readAndWrite((db) => {
      const existing = db
        .prepare(`select rowid, id, ordinal, start_line, end_line from memory_chunks where path = ?`)
        .all(path) as Array<{
        rowid: number;
        id: string;
        ordinal: number;
        start_line: number;
        end_line: number;
      }>;
      const existingById = new Map(existing.map((r) => [r.id, r]));
      const now = Date.now();
      const insertStmt = db.prepare(
        `insert into memory_chunks (
           id, path, ordinal, source, start_line, end_line, room, entry_ts,
           text, token_count, content_hash, embed_status, indexed_at
         ) values (
           @id, @path, @ordinal, @source, @startLine, @endLine, @room, @entryTs,
           @text, @tokenCount, @contentHash, @embedStatus, @now
         )`,
      );
      const updateStmt = db.prepare(
        `update memory_chunks set ordinal = @ordinal, start_line = @startLine, end_line = @endLine
         where id = @id`,
      );
      const deleteStmt = db.prepare(`delete from memory_chunks where id = ?`);

      let inserted = 0;
      let updated = 0;
      const deletedRowids: number[] = [];
      const seen = new Set<string>();
      for (const c of chunks) {
        seen.add(c.id);
        const prev = existingById.get(c.id);
        if (!prev) {
          insertStmt.run({
            id: c.id,
            path: c.path,
            ordinal: c.ordinal,
            source: c.source,
            startLine: c.startLine,
            endLine: c.endLine,
            room: c.room,
            entryTs: c.entryTs,
            text: c.text,
            tokenCount: c.tokenCount,
            contentHash: c.contentHash,
            embedStatus: newChunkStatus,
            now,
          });
          inserted += 1;
        } else if (
          prev.ordinal !== c.ordinal ||
          prev.start_line !== c.startLine ||
          prev.end_line !== c.endLine
        ) {
          updateStmt.run({
            id: c.id,
            ordinal: c.ordinal,
            startLine: c.startLine,
            endLine: c.endLine,
          });
          updated += 1;
        }
      }
      for (const r of existing) {
        if (!seen.has(r.id)) {
          deleteStmt.run(r.id);
          deletedRowids.push(r.rowid);
        }
      }
      return { inserted, updated, deleted: deletedRowids.length, deletedRowids };
    });
  }

  /** All distinct file paths currently represented in the index (for sweep pruning). */
  listMemoryChunkPaths(): string[] {
    return this.read((db) => {
      const rows = db
        .prepare(`select distinct path from memory_chunks`)
        .all() as Array<{ path: string }>;
      return rows.map((r) => r.path);
    });
  }

  /** Drop every chunk for a path (a file deleted out from under the index). */
  deleteMemoryChunksForPath(path: string): Promise<number> {
    return this.write((db) => {
      return db.prepare(`delete from memory_chunks where path = ?`).run(path).changes;
    });
  }

  /**
   * Lexical (FTS5/BM25) candidate search (§4/§8a). `match` is a pre-built FTS5 MATCH
   * expression (the tool sanitizes free text into it). Optional room/time filters
   * apply to the joined `memory_chunks` metadata. Ordered best-first (bm25 ascending).
   */
  searchMemoryLexical(opts: {
    match: string;
    limit: number;
    room?: string;
    afterTs?: number;
    beforeTs?: number;
  }): LexicalHit[] {
    return this.read((db) => {
      const clauses: string[] = ["memory_chunks_fts match @match"];
      const params: Record<string, unknown> = { match: opts.match, limit: opts.limit };
      if (opts.room !== undefined) {
        clauses.push("c.room = @room");
        params.room = opts.room;
      }
      if (opts.afterTs !== undefined) {
        clauses.push("c.entry_ts >= @afterTs");
        params.afterTs = opts.afterTs;
      }
      if (opts.beforeTs !== undefined) {
        // Exclusive: `beforeTs` is the start of the day AFTER the `before` filter, so
        // the `before` day is fully inclusive (review issue #12).
        clauses.push("c.entry_ts < @beforeTs");
        params.beforeTs = opts.beforeTs;
      }
      const rows = db
        .prepare(
          `select c.rowid as rowid, c.id as id, c.path as path, c.start_line as startLine,
                  c.end_line as endLine, c.room as room, c.entry_ts as entryTs, c.text as text,
                  bm25(memory_chunks_fts) as bm25
           from memory_chunks_fts
           join memory_chunks c on c.rowid = memory_chunks_fts.rowid
           where ${clauses.join(" and ")}
           order by bm25 asc
           limit @limit`,
        )
        .all(params) as LexicalHit[];
      return rows;
    });
  }

  /**
   * Fetch chunk metadata + text by rowid (for vector-only hits that weren't in the
   * lexical candidate set, §8a). Optional room/time filters mirror the lexical query
   * so the same constraints apply to the semantic half.
   */
  getChunksByRowids(
    rowids: number[],
    filters?: { room?: string; afterTs?: number; beforeTs?: number },
  ): LexicalHit[] {
    if (rowids.length === 0) return [];
    return this.read((db) => {
      const placeholders = rowids.map(() => "?").join(",");
      const clauses = [`rowid in (${placeholders})`];
      const params: unknown[] = [...rowids];
      if (filters?.room !== undefined) {
        clauses.push("room = ?");
        params.push(filters.room);
      }
      if (filters?.afterTs !== undefined) {
        clauses.push("entry_ts >= ?");
        params.push(filters.afterTs);
      }
      if (filters?.beforeTs !== undefined) {
        // Exclusive start-of-next-day bound (review issue #12); mirrors searchMemoryLexical.
        clauses.push("entry_ts < ?");
        params.push(filters.beforeTs);
      }
      const rows = db
        .prepare(
          `select rowid, id, path, start_line as startLine, end_line as endLine, room,
                  entry_ts as entryTs, text, 0 as bm25
           from memory_chunks where ${clauses.join(" and ")}`,
        )
        .all(...params) as LexicalHit[];
      return rows;
    });
  }

  /** Read a single `index_meta` value (active model id/dim, corpus signature). */
  getIndexMeta(key: string): string | undefined {
    return this.read((db) => {
      const row = db.prepare(`select value from index_meta where key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    });
  }

  /** Upsert a single `index_meta` value. */
  setIndexMeta(key: string, value: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into index_meta (key, value) values (?, ?)
         on conflict(key) do update set value = excluded.value`,
      ).run(key, value);
    });
  }

  // ── Embedding queue (the `embed_status` column IS the queue, §7) ───
  // Mirrors the enrichment/caption/diary worker idiom: poll 'pending' → CAS-claim a
  // batch to 'processing' (attempts++) → embed → 'done' (or 'failed'/'skip').

  /** Claim up to `limit` pending chunks for embedding (CAS pending→processing). */
  claimPendingEmbedChunks(limit: number): Promise<
    Array<{
      rowid: number;
      id: string;
      contentHash: string;
      text: string;
      source: string;
      /** Attempt count AFTER this claim's increment. */
      attempts: number;
    }>
  > {
    return this.readAndWrite((db) => {
      const rows = db
        .prepare(
          `select rowid, id, content_hash as contentHash, text, source, embed_attempts as attempts
           from memory_chunks where embed_status = 'pending'
           order by indexed_at asc limit ?`,
        )
        .all(limit) as Array<{
        rowid: number;
        id: string;
        contentHash: string;
        text: string;
        source: string;
        attempts: number;
      }>;
      if (rows.length === 0) return [];
      const claim = db.prepare(
        `update memory_chunks set embed_status = 'processing', embed_attempts = embed_attempts + 1
         where rowid = ? and embed_status = 'pending'`,
      );
      return rows
        .filter((r) => claim.run(r.rowid).changes > 0)
        .map((r) => ({ ...r, attempts: r.attempts + 1 }));
    });
  }

  /** Reset stale 'processing' embed claims to 'pending' on startup (§7). */
  resetStaleEmbedding(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(`update memory_chunks set embed_status = 'pending' where embed_status = 'processing'`)
          .run().changes,
    );
  }

  /**
   * Delete `memory_vec` rows whose `chunk_id` no longer has a `memory_chunks` row
   * (#8). A chunk deleted by reconcile *after* `pruneVectors` but *before* the embed
   * worker's `upsert` leaves an orphan vector with no owning chunk — harmless to
   * correctness (search filters unmatched KNN hits) but an unbounded space leak.
   * Run at startup alongside `resetStaleEmbedding`. No-op (returns 0) if `memory_vec`
   * doesn't exist yet (lexical-only / semantic half never came up).
   */
  sweepOrphanVectors(): Promise<number> {
    return this.write((db) => {
      const exists =
        (
          db
            .prepare(
              `select count(*) as n from sqlite_master where type = 'table' and name = 'memory_vec'`,
            )
            .get() as { n: number }
        ).n > 0;
      if (!exists) return 0;
      return db
        .prepare(
          `delete from memory_vec
           where chunk_id not in (select rowid from memory_chunks)`,
        )
        .run().changes;
    });
  }

  /** Mark a chunk embedded: status='done', record the model it was embedded with. */
  setEmbedDone(rowid: number, modelId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(`update memory_chunks set embed_status = 'done', model_id = ? where rowid = ?`).run(
        modelId,
        rowid,
      );
    });
  }

  /**
   * Set a chunk's embed status (failed-retry → 'pending', exhausted → 'failed', or
   * 'skip' when embeddings are disabled). `maxRetries` chooses pending vs failed.
   */
  setEmbedFailed(rowid: number, attempts: number, maxRetries: number): Promise<void> {
    const status = attempts > maxRetries ? "failed" : "pending";
    return this.write((db) => {
      db.prepare(`update memory_chunks set embed_status = ? where rowid = ?`).run(status, rowid);
    });
  }

  /** Mark chunks 'skip' (embeddings intentionally off — lexical-only chunk, §6). */
  skipPendingEmbedding(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(`update memory_chunks set embed_status = 'skip' where embed_status = 'pending'`)
          .run().changes,
    );
  }

  /**
   * Invalidate the vector index for a model switch (§5a): every embedded/failed/skip
   * chunk goes back to 'pending' and loses its `model_id`, so the worker re-embeds
   * with the new active model. The lexical index is untouched. Returns the count.
   */
  resetAllEmbeddings(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(
            `update memory_chunks set embed_status = 'pending', model_id = null
             where embed_status in ('done', 'failed', 'skip')`,
          )
          .run().changes,
    );
  }

  /** Count chunks still awaiting embedding (for worker idle detection / logs). */
  countPendingEmbedding(): number {
    return this.read(
      (db) =>
        (
          db
            .prepare(`select count(*) as n from memory_chunks where embed_status = 'pending'`)
            .get() as { n: number }
        ).n,
    );
  }

  /** Document-embedding cache lookup (§5e): identical text+model never re-embeds. */
  getCachedEmbedding(textHash: string, modelId: string): Buffer | undefined {
    return this.read((db) => {
      const row = db
        .prepare(`select embedding from embedding_cache where text_hash = ? and model_id = ?`)
        .get(textHash, modelId) as { embedding: Buffer } | undefined;
      return row?.embedding;
    });
  }

  /** Store a document embedding in the cache (§5e). */
  putCachedEmbedding(textHash: string, modelId: string, embedding: Buffer): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into embedding_cache (text_hash, model_id, embedding) values (?, ?, ?)
         on conflict(text_hash, model_id) do update set embedding = excluded.embedding`,
      ).run(textHash, modelId, embedding);
    });
  }

  // ── Agent sessions (durable session record) ───────────────────────
  // Spec §3–§5: a session's durable record is the frozen context prefix
  // (snapshot, written once) plus its transcript (rewritten atomically at each
  // turn boundary). The snapshot and transcript live in separate columns so the
  // large immutable prefix is NOT re-serialized through the single-writer queue
  // on every cheap transcript flush.

  /** Insert the initial `agent_sessions` placeholder row (spec §5, status='created'). */
  insertAgentSession(row: AgentSessionInsert): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into agent_sessions (
          id, timeline_key, session_type, status, model_id,
          trigger_event_id, trigger_external_id, trigger_body,
          no_reply, created_at, started_at, updated_at
        ) values (
          @id, @timelineKey, @sessionType, @status, @modelId,
          @triggerEventId, @triggerExternalId, @triggerBody,
          0, @createdAt, @startedAt, @updatedAt
        )`,
      ).run({
        id: row.id,
        timelineKey: row.timelineKey,
        sessionType: row.sessionType,
        status: row.status,
        modelId: row.modelId ?? null,
        triggerEventId: row.triggerEventId ?? null,
        triggerExternalId: row.triggerExternalId ?? null,
        triggerBody: row.triggerBody ?? null,
        createdAt: row.createdAt,
        startedAt: row.startedAt ?? null,
        updatedAt: row.updatedAt,
      });
    });
  }

  /**
   * Surface a no-op `agent_sessions` write. The session save/update methods all
   * target `where id = @id`; if that id does not exist the UPDATE silently
   * affects zero rows and the caller is none the wiser. A zero-change write here
   * means a wiring bug (the placeholder insert failed, or the row was deleted)
   * is losing snapshot/transcript/status data. We log a structured warning so
   * the no-op is visible, but deliberately do NOT throw: these run on the
   * fire-and-forget flush path (single-writer queue), and throwing could
   * destabilize it or reject unrelated queued writes.
   */
  private warnIfNoSessionRow(method: string, id: string, changes: number): void {
    if (changes === 0 && this.logger) {
      this.logger.warn(`${method}: no agent_sessions row matched id`, {
        method,
        sessionId: id,
      });
    }
  }

  /**
   * Update a session's status and any of the lifecycle timestamps/flags. Only
   * the fields provided in `opts` are written; `updated_at` is always bumped
   * (defaulting to now). Mirrors `markRunning/markCompleted/markDiscarded` from
   * spec §5.
   *
   * `started_at`/`completed_at` are forward-only (write-once in practice): the
   * lifecycle sets each exactly once (`markRunning`, `markCompleted`/
   * `markDiscarded`), and callers never rewind them. This is intentional — the
   * timestamps record when the session first entered each phase.
   */
  updateAgentSessionStatus(
    id: string,
    status: AgentSessionStatus,
    opts: {
      startedAt?: number;
      completedAt?: number;
      noReply?: boolean;
      error?: string | null;
      updatedAt?: number;
    } = {},
  ): Promise<void> {
    return this.write((db) => {
      const sets: string[] = ["status = @status", "updated_at = @updatedAt"];
      const params: Record<string, unknown> = {
        id,
        status,
        updatedAt: opts.updatedAt ?? Date.now(),
      };
      if (opts.startedAt !== undefined) {
        sets.push("started_at = @startedAt");
        params.startedAt = opts.startedAt;
      }
      if (opts.completedAt !== undefined) {
        sets.push("completed_at = @completedAt");
        params.completedAt = opts.completedAt;
      }
      if (opts.noReply !== undefined) {
        sets.push("no_reply = @noReply");
        params.noReply = opts.noReply ? 1 : 0;
      }
      if (opts.error !== undefined) {
        sets.push("error = @error");
        params.error = opts.error;
      }
      const result = db
        .prepare(`update agent_sessions set ${sets.join(", ")} where id = @id`)
        .run(params);
      this.warnIfNoSessionRow("updateAgentSessionStatus", id, result.changes);
    });
  }

  /**
   * Persist the frozen context snapshot for a session (spec §3). Written ONCE,
   * when the build completes at session creation: the snapshot prefix, its
   * on-disk dump path, and the snapshot token estimate.
   */
  saveAgentSessionSnapshot(
    id: string,
    snapshot: {
      snapshotJson: string;
      dumpPath: string | null;
      tokenEstimate: number | null;
      updatedAt?: number;
    },
  ): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set
            context_snapshot_json = @snapshotJson,
            context_dump_path = @dumpPath,
            token_estimate = @tokenEstimate,
            updated_at = @updatedAt
           where id = @id`,
        )
        .run({
          id,
          snapshotJson: snapshot.snapshotJson,
          dumpPath: snapshot.dumpPath ?? null,
          tokenEstimate: snapshot.tokenEstimate ?? null,
          updatedAt: snapshot.updatedAt ?? Date.now(),
        });
      this.warnIfNoSessionRow("saveAgentSessionSnapshot", id, result.changes);
    });
  }

  /**
   * Flush the session transcript (spec §3). Cheap, repeated at each turn
   * boundary — it touches ONLY `transcript_json` + `updated_at` and never
   * re-serializes the large immutable snapshot columns.
   */
  saveAgentSessionTranscript(
    id: string,
    transcriptJson: string,
    updatedAt?: number,
  ): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set transcript_json = @transcriptJson, updated_at = @updatedAt
           where id = @id`,
        )
        .run({
          id,
          transcriptJson,
          updatedAt: updatedAt ?? Date.now(),
        });
      this.warnIfNoSessionRow("saveAgentSessionTranscript", id, result.changes);
    });
  }

  /**
   * Startup healing (spec §4): flip any session left mid-flight (`running` or
   * `created`) to `interrupted`, before the provider delivers events. No
   * auto-resume. Mirrors `resetStaleActivations`/`resetStaleSummarizationJobs`.
   * Returns the number of rows healed.
   */
  resetStaleSessions(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set status = 'interrupted', updated_at = ?
           where status in ('running', 'created')`,
        )
        .run(Date.now());
      return result.changes;
    });
  }

  /** Read a single session record by id (spec §4), or undefined if absent. */
  getAgentSession(id: string): AgentSessionRow | undefined {
    return this.read((db) =>
      db.prepare(`select * from agent_sessions where id = ?`).get(id) as
        | AgentSessionRow
        | undefined,
    );
  }

  /**
   * Sessions for a timeline, reverse-chron by creation (spec §8,
   * `GET /api/rooms/:key/sessions`). The `idx_agent_sessions_timeline`
   * index covers this ordering. Read-only.
   */
  getAgentSessionsByTimeline(timelineKey: string, limit = 100): AgentSessionRow[] {
    return this.read((db) =>
      db
        .prepare(
          `select * from agent_sessions
           where timeline_key = ?
           order by created_at desc
           limit ?`,
        )
        .all(timelineKey, limit) as AgentSessionRow[],
    );
  }

  /**
   * One row per timeline for the console room list (spec §8, `GET /api/rooms`),
   * reverse-chron by latest activity. The anchor set is the UNION of timelines
   * that have `timeline_events` OR have `agent_sessions` rows (issue #6): a
   * timeline whose events were pruned (§13 delete-events / retention sweep) but
   * whose sessions persist must still appear so its sessions stay reachable via
   * room→session drill-down. Session counts and lifecycle state are correlated
   * subqueries; `last_activity_at` is the max event timestamp, falling back to
   * the latest session activity (`max(created_at, updated_at)`) when no events
   * survive, so reverse-chron ordering stays sensible. Pure read.
   */
  listConsoleRooms(limit = 500): RoomSummaryRow[] {
    return this.read((db) =>
      db
        .prepare(
          `select
             tk.timeline_key as timeline_key,
             tk.timeline_key as display_name,
             coalesce(
               (select c.timeline_state from timeline_compaction_state c
                 where c.timeline_key = tk.timeline_key),
               'inactive'
             ) as timeline_state,
             coalesce(
               (select max(te.timestamp) from timeline_events te
                  where te.timeline_key = tk.timeline_key),
               (select max(max(s.created_at, s.updated_at)) from agent_sessions s
                  where s.timeline_key = tk.timeline_key),
               0
             ) as last_activity_at,
             (select count(*) from timeline_events te
                where te.timeline_key = tk.timeline_key) as event_count,
             (select count(*) from agent_sessions s
                where s.timeline_key = tk.timeline_key) as session_count
           from (
             select timeline_key from timeline_events
             union
             select timeline_key from agent_sessions
           ) tk
           order by last_activity_at desc
           limit ?`,
        )
        .all(limit) as RoomSummaryRow[],
    );
  }

  /**
   * Backing data for a summary (spec §12 detail column): the raw timeline events
   * it covers (`summary_events`, ordered) and the child summaries it condenses
   * (`summary_parents`, ordered). Returns both arrays; one is typically empty
   * depending on the summary's level. Pure read.
   */
  getSummaryLineage(id: string): SummaryLineage {
    return this.read((db) => {
      const eventRows = db
        .prepare(
          `select te.event_json as event_json
             from summary_events se
             join timeline_events te on te.id = se.event_id
            where se.summary_id = ?
            order by se.ordinal asc`,
        )
        .all(id) as Array<{ event_json: string }>;
      const childRows = db
        .prepare(
          `select s.* from summary_parents sp
             join summaries s on s.id = sp.parent_id
            where sp.summary_id = ?
            order by sp.ordinal asc`,
        )
        .all(id) as SummaryRow[];
      return {
        events: eventRows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent),
        children: childRows.map(mapSummaryRow),
      };
    });
  }

  /**
   * A single media asset by its id (= `${eventId}:attach:${index}`, which is
   * also the `attachmentId` carried in externalized image refs — see
   * `mediaAssetToAttachmentMeta`). Backs `GET /api/media/:ref`. Pure read.
   */
  getMediaAssetById(id: string): MediaAssetRow | undefined {
    return this.read((db) =>
      db.prepare(`select * from media_assets where id = ?`).get(id) as
        | MediaAssetRow
        | undefined,
    );
  }

  close(): void {
    this.closed = true;
    this.rejectPendingWrites();
    this.db.close();
  }

  async waitForIdle(): Promise<void> {
    while (!this.closed && (this.draining || this.queue.length > 0)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private rejectPendingWrites(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job?.reject(new Error("Storage is closed"));
    }
  }

  private drainQueue(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) continue;
        try {
          job.resolve(job.run(this.db));
        } catch (error) {
          job.reject(error);
        }
      }
      this.draining = false;
      if (this.queue.length > 0) this.drainQueue();
    });
  }
}

// Memory-retrieval index DDL (ARCHITECTURE.md §9d). Shared verbatim by the
// fresh-DB SCHEMA (interpolated below) and the v6→v7 migration step, so the two
// can never drift. Plain SQLite + built-in FTS5 only — NO extension load is
// required here. The `sqlite-vec` `memory_vec` virtual table is NOT created here:
// it depends on the extension being loaded on the connection and on the active
// embedding model's dimension, so it is created at retrieval-subsystem init time
// (§5b), leaving lexical search fully functional with zero native deps.
const RETRIEVAL_SCHEMA = `
create table if not exists memory_chunks (
  -- AUTOINCREMENT so a deleted chunk's rowid is NEVER reused: the vector index
  -- (memory_vec) keys on this rowid, and a reused rowid could otherwise bind a
  -- stale vector to a different chunk (§9d). Orphaned vec rows are also pruned on
  -- delete, but the no-reuse guarantee makes a mismatch impossible regardless.
  rowid         integer primary key autoincrement,
  id            text unique not null,
  path          text not null,
  ordinal       integer not null,
  source        text not null default 'memory',
  start_line    integer not null,
  end_line      integer not null,
  room          text,
  entry_ts      integer not null,
  text          text not null,
  token_count   integer not null,
  content_hash  text not null,
  model_id      text,
  embed_status  text not null default 'pending'
                  check(embed_status in ('pending','processing','done','failed','skip')),
  embed_attempts integer not null default 0,
  indexed_at    integer not null
);

create index if not exists idx_chunks_embed on memory_chunks(embed_status)
  where embed_status in ('pending','processing');
create index if not exists idx_chunks_path on memory_chunks(path);

-- Lexical index: external-content FTS5 over memory_chunks (unicode61, English).
create virtual table if not exists memory_chunks_fts using fts5(
  text, room, content='memory_chunks', content_rowid='rowid'
);

-- Triggers mirror memory_chunks → FTS. External-content tables require the special
-- 'delete' command (with the old column values) to retract a row before re-add.
create trigger if not exists memory_chunks_ai after insert on memory_chunks begin
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;
create trigger if not exists memory_chunks_ad after delete on memory_chunks begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
end;
create trigger if not exists memory_chunks_au after update on memory_chunks begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;

-- Document-embedding cache (§5e): identical text under the same model never
-- re-embeds. Keyed by content_hash (= hash(text)) + model_id.
create table if not exists embedding_cache (
  text_hash text not null,
  model_id  text not null,
  embedding blob not null,
  primary key (text_hash, model_id)
);

-- Single-key/value metadata: active embedding model + dim, corpus signature (§6).
create table if not exists index_meta (
  key   text primary key,
  value text not null
);
`;

// Canonical schema, version 1. This is the COMPLETE current schema with every
// constraint baked in from the start — there is no patch-an-old-DB step (this
// software has never been deployed, so there are no legacy databases to
// migrate). A fresh database executes this block and is stamped
// `user_version = 1` by `runMigrations`. Any future schema change adds an
// ordered step to MIGRATIONS (see below) rather than mutating this block.
const SCHEMA = `
create table if not exists timeline_events (
  id text primary key,
  external_id text,
  timeline_key text not null,
  provider text not null,
  role text not null check(role in ('user', 'assistant')),
  sender_id text not null,
  sender_display_name text,
  body text not null,
  timestamp integer not null,
  received_at integer not null,
  agent_session_id text,
  event_json text not null,
  enrichment_status text not null default 'pending'
    check(enrichment_status in ('inactive', 'pending', 'processing', 'complete', 'failed', 'skipped')),
  enrichment_retries integer not null default 0,
  -- origin_server_ts of the most recent edit (m.replace) applied to this row, or
  -- NULL if the row has never been edited. The edit-application paths use this to
  -- enforce latest-by-origin_server_ts wins (issue #3): an incoming edit whose
  -- timestamp is older than this is a no-op, so an out-of-order delivery (notably a
  -- re-decrypted older edit arriving after a newer live edit across the
  -- live/redecryption boundary) can never clobber a newer edit. Mirrors the
  -- pending_edits latest-wins guard for the not-yet-stored-target case.
  last_edit_timestamp integer,
  -- Count of re-decryption probe attempts that did not yield decrypted content
  -- (still-UTD or unfetchable). The re-decryption sweeper increments this per
  -- failed probe and excludes rows at/above a ceiling from its candidate query
  -- so permanently-dead UTD rows (keys will never arrive) can't starve the
  -- oldest-first window and stall recovery of newer decryptable events. A large
  -- sentinel value marks a row permanently retired (e.g. missing room/event id).
  redecrypt_attempts integer not null default 0,
  trigger_group_id text,
  created_at integer not null,
  updated_at integer not null,
  -- Generated from event_json so undecryptable (UTD) events are cheaply
  -- queryable by the re-decryption sweeper without scanning every row's JSON.
  -- VIRTUAL (computed on read/index): the partial index below makes lookups
  -- O(matches) without storing a redundant column per row. This column is
  -- created here by the canonical SCHEMA on a fresh DB; no migration ADDs it
  -- (the only generated-column-related migration, v1->v2, adds the separate
  -- redecrypt_attempts column and rebuilds the partial index — see MIGRATIONS).
  -- Derived from event_json, so late keys still resolve old rows across restarts
  -- (vs an in-memory UTD set).
  is_undecryptable integer generated always as
    (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
);

create index if not exists idx_timeline_events_timeline_time
  on timeline_events(timeline_key, timestamp, received_at, id);

-- Partial index over the is_undecryptable generated column so the re-decryption
-- sweeper finds stored UTD events cheaply (O(matches), no full JSON scan).
-- redecrypt_attempts is carried in the index so the sweeper's candidate query
-- (is_undecryptable = 1 and redecrypt_attempts < :max, ordered by timestamp)
-- skips exhausted rows without touching the heap.
create index if not exists idx_timeline_events_undecryptable
  on timeline_events(is_undecryptable, redecrypt_attempts, timestamp)
  where is_undecryptable = 1;

create index if not exists idx_timeline_events_external
  on timeline_events(provider, external_id)
  where external_id is not null;

create index if not exists idx_timeline_events_enrichment
  on timeline_events(enrichment_status, timestamp desc)
  where enrichment_status in ('pending', 'processing');

create index if not exists idx_timeline_events_trigger_group
  on timeline_events(trigger_group_id)
  where trigger_group_id is not null;

create table if not exists metadata (
  key text primary key,
  value text not null,
  updated_at integer not null
);

create table if not exists timeline_compaction_state (
  timeline_key text primary key,
  compact_start_event_id text,
  rich_start_event_id text,
  state_json text not null,
  timeline_state text not null default 'inactive'
    check(timeline_state in ('inactive', 'activating', 'active', 'backfilling')),
  backfill_fence_timestamp integer,
  updated_at integer not null
);

create table if not exists reply_contexts (
  event_id text primary key references timeline_events(id) on delete cascade,
  reply_external_id text,
  sender_id text,
  sender_display_name text,
  sender_username text,
  body text,
  html_body text,
  timestamp integer,
  created_at integer not null
);

create table if not exists link_previews (
  id text primary key,
  event_id text not null references timeline_events(id) on delete cascade,
  context text not null,
  url text not null,
  title text,
  description text,
  site_name text,
  source_kind text,
  preview_index integer not null,
  fetched_at integer,
  fetch_status text not null,
  error text,
  created_at integer not null
);

create index if not exists idx_link_previews_event
  on link_previews(event_id, context, preview_index);

create table if not exists media_assets (
  id text primary key,
  event_id text not null references timeline_events(id) on delete cascade,
  role text not null,
  source_index integer,
  link_preview_id text references link_previews(id) on delete cascade,
  local_path text,
  mime_type text,
  media_type text not null,
  size_bytes integer,
  width integer,
  height integer,
  duration_seconds real,
  original_filename text,
  detected_content text,
  detected_metadata_json text,
  caption text,
  caption_model text,
  caption_status text not null default 'pending'
    check(caption_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
  caption_error text,
  download_status text not null default 'complete'
    check(download_status in ('complete', 'failed')),
  download_error text,
  created_at integer not null
);

create index if not exists idx_media_assets_event
  on media_assets(event_id, role, source_index);

create index if not exists idx_media_assets_preview
  on media_assets(link_preview_id)
  where link_preview_id is not null;

create index if not exists idx_media_assets_caption_eligible
  on media_assets(caption_status, download_status, media_type)
  where caption_status in ('pending', 'processing');

create table if not exists summaries (
  id text primary key,
  timeline_key text not null,
  level integer not null,
  content text not null,
  earliest_timestamp integer not null,
  latest_timestamp integer not null,
  latest_event_id text not null,
  event_count integer not null,
  token_count integer not null,
  model_id text,
  status text not null default 'complete'
    check(status in ('complete', 'truncated', 'superseded')),
  backfill_job_id text,
  generated_at integer not null,
  created_at integer not null,
  -- Diary queue (ARCHITECTURE.md §9c). Set to 'pending' on every LEVEL-1 summary
  -- insert (unconditionally, regardless of [diary].enabled); NULL for level 2+.
  -- The DiaryWorkerPool drains 'pending' rows, mirroring the
  -- enrichment_status/caption_status/summarization_jobs.status idiom. NULL passes
  -- the CHECK (level 2+ never gets a diary entry).
  diary_status text
    check(diary_status in ('pending', 'processing', 'done', 'skipped', 'failed')),
  diary_attempts integer not null default 0
);

create index if not exists idx_summaries_timeline
  on summaries(timeline_key, latest_timestamp);

create index if not exists idx_summaries_level
  on summaries(timeline_key, level, earliest_timestamp);

-- Diary claim path: oldest pending level-1 summary first.
create index if not exists idx_summaries_diary
  on summaries(diary_status, latest_timestamp)
  where diary_status in ('pending', 'processing');

create table if not exists summary_events (
  summary_id text not null references summaries(id) on delete cascade,
  event_id text not null,
  ordinal integer not null,
  primary key (summary_id, event_id)
);

create index if not exists idx_summary_events_event
  on summary_events(event_id);

create table if not exists summary_parents (
  summary_id text not null references summaries(id) on delete cascade,
  parent_id text not null references summaries(id) on delete cascade,
  ordinal integer not null,
  primary key (summary_id, parent_id)
);

create index if not exists idx_summary_parents_parent
  on summary_parents(parent_id);

create table if not exists summarization_jobs (
  id text primary key,
  timeline_key text not null,
  level integer not null,
  status text not null default 'pending'
    check(status in ('pending', 'processing', 'complete', 'failed')),
  input_start_id text not null,
  input_end_id text not null,
  input_token_count integer,
  target_token_count integer not null,
  attempts integer not null default 0,
  max_retries integer not null default 2,
  best_effort_draft text,
  error text,
  result_summary_id text references summaries(id) on delete set null,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_summarization_jobs_status
  on summarization_jobs(status, created_at)
  where status in ('pending', 'processing');

create index if not exists idx_summarization_jobs_timeline
  on summarization_jobs(timeline_key, level, status);

-- Edits (m.replace) that arrived/decrypted BEFORE their target message was
-- stored (plausible during backfill or out-of-order sync). The live/decrypt edit
-- path applies an edit to its target in place; when the target is missing it
-- parks the resolved replacement here instead of dropping it, and the append path
-- replays it once the target lands (issue #12). Keyed by
-- (provider, target_external_id, timeline_key) — scoped by timeline_key for the
-- same multi-account-shared-room reason as the edit lookup (issue #3): two bot
-- accounts in one room store the same Matrix event as two rows differing only by
-- canonical id, so a pending edit must target the right account's row. Latest
-- edit wins (insert-or-replace on the PK keeps the newest by edit_timestamp).
create table if not exists pending_edits (
  provider text not null,
  target_external_id text not null,
  timeline_key text not null,
  -- Resolved replacement content (post-edit body + serialized AttachmentMeta[]),
  -- already extracted from m.new_content so apply-time needs no re-parse.
  body text not null,
  attachments_json text not null,
  -- Origin timestamp of the edit event, used for latest-wins when several edits
  -- target the same not-yet-stored message.
  edit_timestamp integer not null,
  created_at integer not null,
  primary key (provider, target_external_id, timeline_key)
);

-- Durable session record (spec §3-§5): the frozen context prefix (snapshot,
-- written once at session creation) plus the appended transcript (rewritten
-- atomically at each turn boundary). Together context_snapshot_json ++
-- transcript_json reconstruct the exact sequence the model saw. The persisted
-- record outlives SessionManager's in-memory eviction; the console reads it
-- from here. See the status model in spec section 4.
create table if not exists agent_sessions (
  id text primary key,
  timeline_key text not null,
  session_type text not null default 'default',
  status text not null
    check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended')),
  model_id text,
  trigger_event_id text,
  trigger_external_id text,
  trigger_body text,
  context_snapshot_json text,
  context_dump_path text,
  transcript_json text,
  token_estimate integer,
  no_reply integer not null default 0,
  error text,
  created_at integer not null,
  started_at integer,
  updated_at integer not null,
  completed_at integer
);

create index if not exists idx_agent_sessions_timeline
  on agent_sessions(timeline_key, created_at desc);

create index if not exists idx_agent_sessions_status
  on agent_sessions(status, updated_at desc);
${RETRIEVAL_SCHEMA}`;

// Latest schema version. SCHEMA above defines version 1 in full; MIGRATIONS
// holds the ordered steps that advance an existing database from one version to
// the next. Bump this (and append a MIGRATIONS entry) whenever the schema
// changes.
export const LATEST_SCHEMA_VERSION = 7;

// Ordered, additive migration steps. The runner's loop consults
// `MIGRATIONS[version]` for each `version` from the DB's current version up to
// LATEST, so the step at index `i` migrates a database at `user_version = i` up
// to `user_version = i + 1`. Fresh DBs are built directly at the latest shape by
// SCHEMA and NEVER run any step (see runMigrations). Each step runs inside the
// version-bump transaction and only ever runs once per DB. To add a future
// migration:
//   1. bump LATEST_SCHEMA_VERSION to N,
//   2. set MIGRATIONS[N-1] to the step that takes a v(N-1) DB to vN,
//   3. update SCHEMA so a fresh DB is created directly at vN.
const MIGRATIONS: Array<((db: Database.Database) => void) | undefined> = [
  // index 0 (v0 -> v1): unused. v1 is the original canonical SCHEMA; there are no
  // real v0 databases (a fresh DB is built at the latest shape and skips steps).
  undefined,
  // index 1 (v1 -> v2): add `redecrypt_attempts` to `timeline_events`
  // (re-decryption give-up counter, issue #1) and rebuild the UTD partial index
  // to carry it. `ALTER TABLE ADD COLUMN` with a NOT NULL default backfills
  // existing rows to 0; dropping/recreating the index picks up the new key
  // column. Fresh DBs get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(
      `alter table timeline_events
         add column redecrypt_attempts integer not null default 0;
       drop index if exists idx_timeline_events_undecryptable;
       create index if not exists idx_timeline_events_undecryptable
         on timeline_events(is_undecryptable, redecrypt_attempts, timestamp)
         where is_undecryptable = 1;`,
    );
  },
  // index 2 (v2 -> v3): add the `pending_edits` table that parks edits whose
  // target message hasn't been stored yet, so the append path can replay them
  // once the target lands (issue #12). `create table if not exists` is harmless
  // if a forward path already created it. Fresh DBs get this directly from SCHEMA
  // above and never run this step.
  (db) => {
    db.exec(
      `create table if not exists pending_edits (
         provider text not null,
         target_external_id text not null,
         timeline_key text not null,
         body text not null,
         attachments_json text not null,
         edit_timestamp integer not null,
         created_at integer not null,
         primary key (provider, target_external_id, timeline_key)
       );`,
    );
  },
  // index 3 (v3 -> v4): add `last_edit_timestamp` to `timeline_events`, the
  // origin_server_ts of the most recently applied edit. The edit-application
  // paths use it to enforce latest-by-origin_server_ts wins (issue #3). Nullable
  // with no default: existing rows backfill to NULL ("never edited"), so the next
  // edit always applies. Fresh DBs get this directly from SCHEMA above and never
  // run this step.
  (db) => {
    db.exec(`alter table timeline_events add column last_edit_timestamp integer;`);
  },
  // index 4 (v4 -> v5): add the `agent_sessions` table — the durable session
  // record (spec §3–§5): frozen context snapshot (written once) + appended
  // transcript (flushed at each turn boundary), the status model, and the two
  // lookup indexes (by timeline reverse-chron, and by status for startup
  // healing). `create table/index if not exists` is harmless if a forward path
  // already created it. Fresh DBs get this directly from SCHEMA above and never
  // run this step.
  (db) => {
    db.exec(
      `create table if not exists agent_sessions (
         id text primary key,
         timeline_key text not null,
         session_type text not null default 'default',
         status text not null
           check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended')),
         model_id text,
         trigger_event_id text,
         trigger_external_id text,
         trigger_body text,
         context_snapshot_json text,
         context_dump_path text,
         transcript_json text,
         token_estimate integer,
         no_reply integer not null default 0,
         error text,
         created_at integer not null,
         started_at integer,
         updated_at integer not null,
         completed_at integer
       );
       create index if not exists idx_agent_sessions_timeline
         on agent_sessions(timeline_key, created_at desc);
       create index if not exists idx_agent_sessions_status
         on agent_sessions(status, updated_at desc);`,
    );
  },
  // index 5 (v5 -> v6): add the diary queue columns to `summaries` — `diary_status`
  // (the per-level-1 diary queue: pending/processing/done/skipped/failed, NULL for
  // level 2+) and `diary_attempts` (claim-time retry counter, mirroring
  // summarization_jobs.attempts) — plus the claim index (ARCHITECTURE.md §9c). The
  // ADD COLUMNs are nullable / NOT NULL-with-default so existing rows backfill
  // cleanly (diary_status → NULL = "no diary queued"; diary_attempts → 0). Fresh
  // DBs get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(
      `alter table summaries
         add column diary_status text
           check(diary_status in ('pending', 'processing', 'done', 'skipped', 'failed'));
       alter table summaries
         add column diary_attempts integer not null default 0;
       create index if not exists idx_summaries_diary
         on summaries(diary_status, latest_timestamp)
         where diary_status in ('pending', 'processing');`,
    );
  },
  // index 6 (v6 -> v7): add the memory-retrieval index (ARCHITECTURE.md §9d) —
  // `memory_chunks` (+ embed-queue/path indexes), the external-content FTS5 table
  // `memory_chunks_fts` with its sync triggers, `embedding_cache`, and `index_meta`.
  // All plain SQLite + built-in FTS5; the `sqlite-vec` `memory_vec` table is created
  // at runtime (it needs the extension + active-model dim), not here. `create ... if
  // not exists` is harmless if a forward path already created any object. Fresh DBs
  // get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(RETRIEVAL_SCHEMA);
  },
];

// PRAGMA user_version-based migration runner. Runs inside open()'s write
// callback (single-writer queue). Ordering relative to `writer.exec(SCHEMA)`
// differs by case (see Storage.open):
//   - Fresh DB: SCHEMA runs FIRST (builds every table/index at the latest
//     shape), then runMigrations(isFresh=true) only STAMPS the version and
//     applies NO steps. (Running the additive ALTER steps would fail, e.g.
//     "duplicate column", because SCHEMA already added the targeted columns.)
//   - Existing DB: runMigrations runs FIRST (additive ALTERs bring legacy tables
//     up to the current column shape), then SCHEMA runs to create any new
//     tables/indexes. SCHEMA must NOT precede the steps: its latest-shape DDL
//     references columns that only the steps add (e.g. the undecryptable index
//     keys on redecrypt_attempts), so running it against an un-migrated table
//     raises "no such column".
//
//   - Fresh DB (`isFresh`): stamp to LATEST_SCHEMA_VERSION, apply NO steps.
//   - Existing DB at version V < LATEST: apply MIGRATIONS[V], MIGRATIONS[V+1],
//     ... in order, advancing user_version to LATEST.
//   - Existing DB already at LATEST: no steps, idempotent no-op.
//
// `create table/index if not exists` in SCHEMA makes re-running open() on an
// up-to-date database harmless.
function runMigrations(db: Database.Database, isFresh: boolean): void {
  const current = Number((db.pragma("user_version", { simple: true }) as number) ?? 0);

  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${LATEST_SCHEMA_VERSION}). ` +
        `Refusing to open to avoid corrupting forward-versioned data.`,
    );
  }
  if (current === LATEST_SCHEMA_VERSION) {
    // Already at the latest version. Idempotent no-op.
    return;
  }

  // A fresh DB reports user_version = 0 but its tables were just built at the
  // latest shape by SCHEMA — there is no legacy column to add, so skip the steps
  // and only stamp the version.
  if (isFresh) {
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
    return;
  }

  // Existing DB below LATEST: apply each ordered step from `current` up to LATEST
  // in one transaction. A step at index i migrates a v(i) DB up to v(i+1).
  db.transaction(() => {
    for (let version = current; version < LATEST_SCHEMA_VERSION; version++) {
      const step = MIGRATIONS[version];
      if (step) step(db);
    }
    // PRAGMA does not accept bound parameters; LATEST_SCHEMA_VERSION is a
    // compile-time integer constant, so interpolation here is safe.
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  })();
}
