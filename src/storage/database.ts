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
      writer.exec(SCHEMA);
      runMigrations(writer, isFreshDatabase);
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
   * Last-write-wins on repeated edits (each call overwrites the body/attachments).
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
          `select id, event_json from timeline_events
           where provider = ? and external_id = ? and timeline_key = ? limit 1`,
        )
        .get(provider, targetExternalId, timelineKey) as
        | { id: string; event_json: string }
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
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id: row.id,
        body: updated.body,
        eventJson: JSON.stringify(updated),
        enrichmentStatus: status,
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
  ): EditReplacementContent | undefined {
    const row = db
      .prepare(
        `select body, attachments_json from pending_edits
         where provider = ? and target_external_id = ? and timeline_key = ?`,
      )
      .get(provider, externalId, timelineKey) as
      | { body: string; attachments_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      body: row.body,
      attachments: JSON.parse(row.attachments_json) as AttachmentMeta[],
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
      db.prepare(
        `insert into summaries (
          id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
          latest_event_id, event_count, token_count, model_id, status,
          backfill_job_id, generated_at, created_at
        ) values (
          @id, @timelineKey, @level, @content, @earliestTimestamp, @latestTimestamp,
          @latestEventId, @eventCount, @tokenCount, @modelId, @status,
          null, @generatedAt, @createdAt
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
  created_at integer not null
);

create index if not exists idx_summaries_timeline
  on summaries(timeline_key, latest_timestamp);

create index if not exists idx_summaries_level
  on summaries(timeline_key, level, earliest_timestamp);

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
`;

// Latest schema version. SCHEMA above defines version 1 in full; MIGRATIONS
// holds the ordered steps that advance an existing database from one version to
// the next. Bump this (and append a MIGRATIONS entry) whenever the schema
// changes.
const LATEST_SCHEMA_VERSION = 3;

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
];

// PRAGMA user_version-based migration runner. Runs inside open()'s write
// callback (single-writer queue), AFTER `writer.exec(SCHEMA)`.
//
//   - Fresh DB (`isFresh`): SCHEMA already created every table/index at the
//     latest shape. `user_version` is the default 0, but there is nothing to
//     migrate — we just stamp it to LATEST_SCHEMA_VERSION and apply NO steps.
//     (Running the additive ALTER steps here would fail, e.g. "duplicate column",
//     because SCHEMA already added the column the step targets.)
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
