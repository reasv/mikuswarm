import type Database from "better-sqlite3";
import type { Storage, TimelineCompactionState } from "../storage/index.js";
import type { CanonicalChatEvent } from "../types.js";

export interface TimelineQuery {
  timelineKey: string;
  limit?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export class TimelineStore {
  constructor(private readonly storage: Storage) {}

  append(event: CanonicalChatEvent): Promise<void> {
    return this.storage.appendTimelineEvent(event);
  }

  enrich(eventId: string, updater: (event: CanonicalChatEvent) => CanonicalChatEvent): Promise<CanonicalChatEvent> {
    return this.storage.updateTimelineEvent(eventId, updater);
  }

  appendIfMissing(event: CanonicalChatEvent): Promise<{ event: CanonicalChatEvent; duplicate: boolean }> {
    return this.storage.readAndWrite((db) => {
      const existing = db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(event.id) as { event_json: string } | undefined;
      if (existing) {
        return { event: JSON.parse(existing.event_json) as CanonicalChatEvent, duplicate: true };
      }
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
        )`,
      ).run(timelineEventParams(event, now));
      return { event, duplicate: false };
    });
  }

  ingestAssistantEcho(event: CanonicalChatEvent): Promise<"enriched" | "appended"> {
    return this.storage.readAndWrite((db) => {
      const existing = findAssistantEchoCandidate(db, event);
      if (!existing) {
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
          )`,
        ).run(timelineEventParams(event, now));
        return "appended";
      }

      const updated: CanonicalChatEvent = {
        ...existing,
        externalId: event.externalId ?? existing.externalId,
        timestamp: event.timestamp,
        receivedAt: Math.min(existing.receivedAt, event.receivedAt),
      };
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
      ).run(timelineEventParams(updated, Date.now()));
      return "enriched";
    });
  }

  getById(eventId: string): CanonicalChatEvent | undefined {
    return this.storage.getTimelineEventById(eventId);
  }

  getByExternalId(provider: string, externalId: string): CanonicalChatEvent | undefined {
    return this.storage.getTimelineEventByExternalId(provider, externalId);
  }

  query(query: TimelineQuery): CanonicalChatEvent[] {
    return this.storage.read((db) => {
      const clauses = ["timeline_key = @timelineKey"];
      const params: Record<string, unknown> = {
        timelineKey: query.timelineKey,
        limit: query.limit ?? 200,
      };
      if (query.fromTimestamp !== undefined) {
        clauses.push("timestamp >= @fromTimestamp");
        params.fromTimestamp = query.fromTimestamp;
      }
      if (query.toTimestamp !== undefined) {
        clauses.push("timestamp <= @toTimestamp");
        params.toTimestamp = query.toTimestamp;
      }
      const rows = db
        .prepare(
          `select event_json
           from (
             select event_json, timestamp, received_at, id
             from timeline_events
             where ${clauses.join(" and ")}
             order by timestamp desc, received_at desc, id desc
             limit @limit
           )
           order by timestamp asc, received_at asc, id asc`,
        )
        .all(params) as Array<{ event_json: string }>;
      return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
    });
  }

  queryForContext(timelineKey: string, state?: TimelineCompactionState): CanonicalChatEvent[] {
    return this.storage.getTimelineEventsForContext(
      timelineKey,
      state?.compactStartEventId ?? state?.richStartEventId,
      1000,
    );
  }

  getCompactionState(timelineKey: string): TimelineCompactionState | undefined {
    return this.storage.getTimelineCompactionState(timelineKey);
  }

  saveCompactionState(state: TimelineCompactionState): Promise<void> {
    return this.storage.saveTimelineCompactionState(state);
  }
}

function findAssistantEchoCandidate(db: Database.Database, event: CanonicalChatEvent): CanonicalChatEvent | undefined {
  if (event.externalId) {
    const row = db
      .prepare(`select event_json from timeline_events where provider = ? and external_id = ? limit 1`)
      .get(event.provider, event.externalId) as { event_json: string } | undefined;
    const byExternalId = row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
    if (byExternalId?.role === "assistant" && byExternalId.sender.isSelf) return byExternalId;
  }

  const fromTimestamp = Math.max(0, event.timestamp - 5 * 60 * 1000);
  const toTimestamp = event.timestamp + 5 * 60 * 1000;
  const rows = db
    .prepare(
      `select event_json
       from (
         select event_json, timestamp, received_at, id
         from timeline_events
         where timeline_key = @timelineKey
           and role = 'assistant'
           and timestamp >= @fromTimestamp
           and timestamp <= @toTimestamp
         order by timestamp desc, received_at desc, id desc
         limit 100
       )
       order by timestamp asc, received_at asc, id asc`,
    )
    .all({
      timelineKey: event.timelineKey,
      fromTimestamp,
      toTimestamp,
    }) as Array<{ event_json: string }>;
  const candidates = rows
    .map((row) => JSON.parse(row.event_json) as CanonicalChatEvent)
    .filter((candidate) => candidate.sender.isSelf);

  if (event.externalId) {
    const byExternalId = candidates.find((candidate) => candidate.externalId === event.externalId);
    if (byExternalId) return byExternalId;
  }

  const normalizedBody = normalizeBody(event.body);
  if (!normalizedBody) return undefined;
  const fuzzyMatches = candidates.filter(
    (candidate) => !candidate.externalId && normalizeBody(candidate.body) === normalizedBody,
  );
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] : undefined;
}

function timelineEventParams(event: CanonicalChatEvent, now: number) {
  return {
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
  };
}

function normalizeBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
