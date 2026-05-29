import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CanonicalChatEvent } from "../types.js";

export interface StorageOptions {
  databasePath: string;
}

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

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async open(options: StorageOptions): Promise<Storage> {
    await mkdir(path.dirname(options.databasePath), { recursive: true });
    const db = new Database(options.databasePath);
    const storage = new Storage(db);
    await storage.write((writer) => {
      writer.pragma("journal_mode = WAL");
      writer.pragma("foreign_keys = ON");
      writer.exec(SCHEMA);
      runMigrations(writer);
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

  getTimelineEventByExternalId(provider: string, externalId: string): CanonicalChatEvent | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select event_json from timeline_events where provider = ? and external_id = ? limit 1`)
        .get(provider, externalId) as { event_json: string } | undefined,
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
   */
  getTimelineEventsAfter(
    timelineKey: string,
    afterEventId: string,
    limit = 1000,
  ): CanonicalChatEvent[] {
    const cursor = this.getEventCursor(timelineKey, afterEventId);
    if (!cursor) return [];

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
   * set, only summaries whose coverage ends strictly before it.
   */
  getSummaryCandidates(timelineKey: string, beforeTimestamp?: number): Summary[] {
    const rows = this.read((db) => {
      if (beforeTimestamp != null) {
        return db
          .prepare(
            `select * from summaries
             where timeline_key = ? and status in ('complete', 'truncated')
               and latest_timestamp < ?
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

  getSummaryById(id: string): Summary | undefined {
    const row = this.read((db) =>
      db.prepare(`select * from summaries where id = ?`).get(id) as SummaryRow | undefined,
    );
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
    const start = this.getSummaryById(startId);
    const end = this.getSummaryById(endId);
    if (!start || !end) return [];
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

  /** True if any summary at level >= minLevel falls strictly between two timestamps. */
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
             and earliest_timestamp > ? and latest_timestamp < ?
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
      if (insert.level === 1 && (!insert.eventIds || insert.eventIds.length === 0)) {
        throw new Error("Level-1 summary must have eventIds");
      }
      if (insert.level > 1 && (!insert.parentIds || insert.parentIds.length === 0)) {
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

      db.prepare(
        `update summarization_jobs set status = 'complete', result_summary_id = ?, updated_at = ?
         where id = ?`,
      ).run(insert.id, now, insert.jobId);
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
    check(enrichment_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
  enrichment_retries integer not null default 0,
  trigger_group_id text,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_timeline_events_timeline_time
  on timeline_events(timeline_key, timestamp, received_at, id);

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
`;

function runMigrations(db: Database.Database): void {
  const columns = db.prepare("pragma table_info(timeline_events)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("enrichment_status")) {
    db.exec(`alter table timeline_events add column enrichment_status text not null default 'skipped'`);
  }
  if (!columnNames.has("trigger_group_id")) {
    db.exec(`alter table timeline_events add column trigger_group_id text`);
  }
  if (!columnNames.has("enrichment_retries")) {
    db.exec(`alter table timeline_events add column enrichment_retries integer not null default 0`);
  }

  const maColumns = db.prepare("pragma table_info(media_assets)").all() as Array<{ name: string }>;
  const maColumnNames = new Set(maColumns.map((c) => c.name));
  if (!maColumnNames.has("caption_error")) {
    db.exec(`alter table media_assets add column caption_error text`);
  }
}
