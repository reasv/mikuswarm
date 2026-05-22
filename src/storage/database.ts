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

export interface TimelineCompactionState {
  schemaVersion: 1;
  timelineKey: string;
  compactStartEventId: string | null;
  richStartEventId: string | null;
  updatedAt: number;
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

  appendTimelineEvent(event: CanonicalChatEvent): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      db.prepare(
        `insert into timeline_events (
          id, external_id, timeline_key, provider, role, sender_id,
          sender_display_name, body, timestamp, received_at, agent_session_id,
          event_json, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @eventJson, @createdAt, @updatedAt
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
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_timeline_events_timeline_time
  on timeline_events(timeline_key, timestamp, received_at, id);

create index if not exists idx_timeline_events_external
  on timeline_events(provider, external_id)
  where external_id is not null;

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
`;
