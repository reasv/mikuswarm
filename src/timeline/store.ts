import type Database from "better-sqlite3";
import type { Storage, TimelineCompactionState } from "../storage/index.js";
import type { CanonicalChatEvent, TimelineState } from "../types.js";

export interface TimelineQuery {
  timelineKey: string;
  limit?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export function needsEnrichment(event: CanonicalChatEvent): boolean {
  if (event.attachments && event.attachments.length > 0) return true;
  if (event.replyTo?.externalId) return true;
  if (event.body.includes("http")) return true;
  return false;
}

export class TimelineStore {
  constructor(private readonly storage: Storage) {}

  append(event: CanonicalChatEvent, enrichmentStatus?: string): Promise<void> {
    return this.storage.appendTimelineEvent(event, enrichmentStatus);
  }

  enrich(eventId: string, updater: (event: CanonicalChatEvent) => CanonicalChatEvent): Promise<CanonicalChatEvent> {
    return this.storage.updateTimelineEvent(eventId, updater);
  }

  appendIfMissing(event: CanonicalChatEvent, enrichmentStatus?: string): Promise<{ event: CanonicalChatEvent; duplicate: boolean }> {
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
          event_json, enrichment_status, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @eventJson, @enrichmentStatus, @createdAt, @updatedAt
        )`,
      ).run({ ...timelineEventParams(event, now), enrichmentStatus: enrichmentStatus ?? "pending" });
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
            event_json, enrichment_status, created_at, updated_at
          ) values (
            @id, @externalId, @timelineKey, @provider, @role, @senderId,
            @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
            @eventJson, @enrichmentStatus, @createdAt, @updatedAt
          )`,
        ).run({ ...timelineEventParams(event, now), enrichmentStatus: "skipped" });
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

  /** Events strictly after the given event (exclusive cursor); used when that event is covered by a summary. */
  queryAfterContext(timelineKey: string, afterEventId: string): CanonicalChatEvent[] {
    return this.storage.getTimelineEventsAfter(timelineKey, afterEventId, 1000);
  }

  getCompactionState(timelineKey: string): TimelineCompactionState | undefined {
    return this.storage.getTimelineCompactionState(timelineKey);
  }

  saveCompactionState(state: TimelineCompactionState): Promise<void> {
    return this.storage.saveTimelineCompactionState(state);
  }

  setEnrichmentStatus(eventId: string, status: string): Promise<void> {
    return this.storage.setEnrichmentStatus(eventId, status);
  }

  /**
   * Stored undecryptable (UTD) events, oldest first, for the re-decryption
   * sweeper. Rows past the re-decryption give-up ceiling are excluded so dead
   * rows can't starve newer decryptable ones (issue #1). Each entry carries the
   * row's current `attempts` count so the sweeper can prune its backoff map.
   */
  getUndecrypted(limit = 100): Array<{ event: CanonicalChatEvent; attempts: number }> {
    return this.storage.getUndecryptedEvents(limit);
  }

  /**
   * Replace a stored UTD event with its now-decrypted form: `updater` rebuilds
   * the canonical with `undecryptable` cleared and the real body/attachments, and
   * the row's `enrichment_status` is set to whatever `computeStatus` returns for
   * the decrypted event and its (possibly re-homed) timeline's live state (issues
   * #5/#6). Matched by event id. The decrypted relation may re-home the row to a
   * thread timeline (see {@link Storage.replaceUndecryptedEvent}). Returns
   * `{ event, replaced, status }` — `replaced` is `false` on the already-decrypted
   * no-op — or `undefined` when no row matches.
   */
  replaceUndecrypted(
    eventId: string,
    updater: (event: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<{ event: CanonicalChatEvent; replaced: boolean; status: string } | undefined> {
    return this.storage.replaceUndecryptedEvent(eventId, updater, computeStatus);
  }

  /** Persist a failed re-decryption probe (bump attempts). Returns the new count. */
  recordRedecryptFailure(eventId: string): Promise<number | undefined> {
    return this.storage.recordRedecryptFailure(eventId);
  }

  /** Permanently retire a UTD row from re-decryption rotation (no re-fetch possible). */
  retireUndecrypted(eventId: string): Promise<void> {
    return this.storage.retireUndecryptedEvent(eventId);
  }

  /** Delete a UTD row that decrypted to a non-renderable message (issue #9). */
  deleteUndecrypted(eventId: string): Promise<boolean> {
    return this.storage.deleteUndecryptedEvent(eventId);
  }

  /**
   * Apply a Matrix edit (`m.replace`) to its target message in place (issue #17).
   * Locates the target by `(provider, externalId)` and lets `updater` merge the
   * replacement body/attachments onto it (identity/timestamps/sender/role
   * preserved). `computeStatus` recomputes the target's `enrichment_status` from
   * the merged event and its timeline's live state, honoring inactive-timeline
   * gating. Returns `{ applied: true, event, status }`, or `{ applied: false }`
   * when no target row exists (the caller logs and skips — the edit is never
   * stored as a standalone message). See {@link Storage.applyEditToTarget}.
   */
  applyEdit(
    provider: string,
    targetExternalId: string,
    updater: (target: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<
    | { applied: true; event: CanonicalChatEvent; status: string }
    | { applied: false }
  > {
    return this.storage.applyEditToTarget(provider, targetExternalId, updater, computeStatus);
  }

  setTriggerGroup(triggerEventId: string, eventIds: string[]): Promise<void> {
    return this.storage.setTriggerGroup(triggerEventId, eventIds);
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
