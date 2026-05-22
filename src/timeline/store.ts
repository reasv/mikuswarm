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

  enrich(eventId: string, updater: (event: CanonicalChatEvent) => CanonicalChatEvent): Promise<void> {
    return this.storage.updateTimelineEvent(eventId, updater);
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
