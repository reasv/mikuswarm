import type Database from "better-sqlite3";
import type { Storage, TimelineCompactionState, TimelineCursor } from "../storage/index.js";
import type { CanonicalChatEvent, TimelineState } from "../types.js";
import { applyEditToCanonical, editStatus, type EditReplacement } from "./edits.js";

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

  /**
   * Insert an event only if no row for the same message exists yet (dedup on
   * resume/replay). Existence is checked by canonical id first, then — for events
   * carrying an `externalId` — by `(provider, external_id, timeline_key)`: a bot
   * self-message is stored under an `assistant:{session}:{eventId}:{chunk}`
   * canonical id by `send_message`, while re-fetched history keys the same Matrix
   * event `matrix:{account}:{eventId}`, so an id-only check can never see the
   * match and would duplicate every self-sent message it re-fetches.
   * `options.isBackfetch` marks the row as message-only backfetch
   * provenance (spec MESSAGE-BACKFETCH §5) — set only by the backfetch coordinator
   * so the enrichment worker defers its captioning and the row is excluded from the
   * first-class pipeline by the context floor.
   */
  appendIfMissing(
    event: CanonicalChatEvent,
    enrichmentStatus?: string,
    options?: { isBackfetch?: boolean },
  ): Promise<{ event: CanonicalChatEvent; duplicate: boolean }> {
    return this.storage.readAndWrite((db) => {
      const existing = db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(event.id) as { event_json: string } | undefined;
      if (existing) {
        return { event: JSON.parse(existing.event_json) as CanonicalChatEvent, duplicate: true };
      }
      // Scoped by timeline_key (not just provider+external_id) so two accounts
      // sharing a room — same Matrix event id, different timeline keys — never
      // dedup against each other's rows.
      if (event.externalId) {
        const byExternal = db
          .prepare(
            `select event_json from timeline_events
             where provider = ? and external_id = ? and timeline_key = ?
             limit 1`,
          )
          .get(event.provider, event.externalId, event.timelineKey) as
          | { event_json: string }
          | undefined;
        if (byExternal) {
          return { event: JSON.parse(byExternal.event_json) as CanonicalChatEvent, duplicate: true };
        }
      }
      const now = Date.now();
      db.prepare(
        `insert into timeline_events (
          id, external_id, timeline_key, provider, role, sender_id,
          sender_display_name, body, timestamp, received_at, agent_session_id,
          agent_session_generation, event_json, enrichment_status, is_backfetch,
          sender_is_bot, sender_is_webhook, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @agentSessionGeneration, @eventJson, @enrichmentStatus, @isBackfetch,
          @senderIsBot, @senderIsWebhook, @createdAt, @updatedAt
        )`,
      ).run({
        ...timelineEventParams(event, now),
        enrichmentStatus: enrichmentStatus ?? "pending",
        isBackfetch: options?.isBackfetch ? 1 : 0,
      });

      // Replay a pending edit that arrived before this target was stored (issue
      // #12). Scoped by (provider, externalId, timelineKey) for the same
      // multi-account reason as the edit lookup (issue #3). Same transaction as
      // the insert, so the target never renders its pre-edit body. Honors the
      // same inactive-timeline gating as the live edit path (editStatus).
      const replayed = event.externalId
        ? this.#applyPendingEdit(db, event)
        : undefined;
      return { event: replayed ?? event, duplicate: false };
    });
  }

  /**
   * Apply a parked pending edit to a just-inserted target, in the caller's write
   * transaction (issue #12). Returns the edited event when one was replayed, or
   * undefined when there was no pending edit. Mirrors the live edit path: merges
   * the replacement body/attachments onto the target and recomputes
   * `enrichment_status` from the merged event and its timeline's live state.
   */
  #applyPendingEdit(
    db: Database.Database,
    event: CanonicalChatEvent,
  ): CanonicalChatEvent | undefined {
    const externalId = event.externalId;
    if (!externalId) return undefined;
    const pending = this.storage.getPendingEdit(db, event.provider, externalId, event.timelineKey);
    if (!pending) return undefined;

    // Latest-by-origin_server_ts wins (issue #3), consistent with the live edit
    // path. The freshly-inserted target normally has last_edit_timestamp = NULL
    // (never edited), so the parked edit applies; the guard only blocks if a newer
    // edit had somehow already landed on this row. Always retire the parked edit
    // afterward — it is stale by definition once a newer edit is present.
    const targetRow = db
      .prepare(`select last_edit_timestamp from timeline_events where id = ?`)
      .get(event.id) as { last_edit_timestamp: number | null } | undefined;
    if (
      targetRow?.last_edit_timestamp != null &&
      pending.editTimestamp < targetRow.last_edit_timestamp
    ) {
      this.storage.deletePendingEdit(db, event.provider, externalId, event.timelineKey);
      return undefined;
    }

    const updated = applyEditToCanonical(event, pending);
    const stateRow = db
      .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
      .get(updated.timelineKey) as { timeline_state: TimelineState } | undefined;
    const timelineState: TimelineState = stateRow?.timeline_state ?? "inactive";
    const status = editStatus(updated, timelineState);
    db.prepare(
      `update timeline_events
       set body = @body,
           event_json = @eventJson,
           enrichment_status = @enrichmentStatus,
           last_edit_timestamp = @lastEditTimestamp,
           updated_at = @updatedAt
       where id = @id`,
    ).run({
      id: updated.id,
      body: updated.body,
      eventJson: JSON.stringify(updated),
      enrichmentStatus: status,
      lastEditTimestamp: pending.editTimestamp,
      updatedAt: Date.now(),
    });
    this.storage.deletePendingEdit(db, event.provider, externalId, event.timelineKey);
    return updated;
  }

  /**
   * Persist a just-sent assistant message (send_message's post-send append) —
   * the reverse direction of {@link ingestAssistantEcho}. The Matrix sync echo
   * races the send tool's own append: when the echo wins, `ingestAssistantEcho`
   * finds no assistant row and appends a `matrix:{account}:{eventId}` row, and a
   * plain append here would then store the same event a second time under its
   * `assistant:{session}:{eventId}:{chunk}` id. So the send merges into an
   * existing self-sent row for the same `(provider, external_id)` when one
   * exists: the stored row keeps its canonical id and server timestamp (mirroring
   * the echo-second merge, where the echo contributes exactly those), and adopts
   * the send's body/html, session attribution, and timeline key (the send's
   * target key is authoritative — a DM self-echo can derive a mismatched key,
   * see `findAssistantEchoCandidate`). Exactly one row per Matrix event, whichever
   * side wins the race. The lookup is unscoped by timeline key for the same
   * DM-mismatch reason, but only merges into a self-sent assistant row — another
   * account's received copy of the event (role `user`, not self) never matches.
   */
  ingestAssistantSend(event: CanonicalChatEvent): Promise<"merged" | "appended"> {
    return this.storage.readAndWrite((db) => {
      let existing: CanonicalChatEvent | undefined;
      if (event.externalId) {
        const row = db
          .prepare(`select event_json from timeline_events where provider = ? and external_id = ? limit 1`)
          .get(event.provider, event.externalId) as { event_json: string } | undefined;
        const candidate = row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
        if (candidate?.role === "assistant" && candidate.sender.isSelf) existing = candidate;
      }

      if (!existing) {
        // No echo row yet (the common case: send wins the race). Same insert the
        // plain append performed here before the merge existed — default
        // 'pending' status, so an assistant message with links/media still flows
        // through enrichment.
        const now = Date.now();
        db.prepare(
          `insert into timeline_events (
            id, external_id, timeline_key, provider, role, sender_id,
            sender_display_name, body, timestamp, received_at, agent_session_id,
            agent_session_generation, event_json, enrichment_status, created_at, updated_at
          ) values (
            @id, @externalId, @timelineKey, @provider, @role, @senderId,
            @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
            @agentSessionGeneration, @eventJson, @enrichmentStatus, @createdAt, @updatedAt
          )`,
        ).run({ ...timelineEventParams(event, now), enrichmentStatus: "pending" });
        return "appended";
      }

      const updated: CanonicalChatEvent = {
        ...event,
        id: existing.id,
        timestamp: existing.timestamp,
        receivedAt: Math.min(existing.receivedAt, event.receivedAt),
        // The send-side event never carries attachment metadata (send_message
        // persists text/html only); the echo's attachments hold the mxc refs the
        // enrichment worker downloads from. Never clobber them.
        attachments: event.attachments?.length ? event.attachments : existing.attachments,
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
             agent_session_generation = @agentSessionGeneration,
             event_json = @eventJson,
             updated_at = @updatedAt
         where id = @id`,
      ).run(timelineEventParams(updated, Date.now()));
      return "merged";
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
            agent_session_generation, event_json, enrichment_status, created_at, updated_at
          ) values (
            @id, @externalId, @timelineKey, @provider, @role, @senderId,
            @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
            @agentSessionGeneration, @eventJson, @enrichmentStatus, @createdAt, @updatedAt
          )`,
        ).run({ ...timelineEventParams(event, now), enrichmentStatus: "skipped" });
        return "appended";
      }

      const updated: CanonicalChatEvent = {
        ...existing,
        externalId: event.externalId ?? existing.externalId,
        timestamp: event.timestamp,
        receivedAt: Math.min(existing.receivedAt, event.receivedAt),
        // The send-side row has no attachment metadata (send_message persists
        // text/html only); adopt the echo's attachments — their mxc refs are what
        // the enrichment worker downloads from. Previously the echo's attachments
        // were dropped here, so assistant-sent media only got enriched when the
        // echo won the race and landed its own (duplicate) row.
        attachments: existing.attachments?.length ? existing.attachments : event.attachments,
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
             agent_session_generation = @agentSessionGeneration,
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

  getByExternalId(
    provider: string,
    externalId: string,
    timelineKey: string,
  ): CanonicalChatEvent | undefined {
    return this.storage.getTimelineEventByExternalId(provider, externalId, timelineKey);
  }

  /**
   * Resolve the actual stored timeline_key of an edit target across the room and
   * its thread keys (issue #4). Used by the redecryption sweeper so a re-decrypted
   * edit reaches a thread-keyed target instead of parking under the room key where
   * replay never matches. Returns undefined when no target is stored.
   */
  resolveEditTargetTimelineKey(
    provider: string,
    externalId: string,
    roomTimelineKey: string,
  ): string | undefined {
    return this.storage.resolveEditTargetTimelineKey(provider, externalId, roomTimelineKey);
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
    return this.clampToFloor(
      timelineKey,
      this.storage.getTimelineEventsForContext(
        timelineKey,
        state?.compactStartEventId ?? state?.richStartEventId,
        1000,
      ),
    );
  }

  /** Events strictly after the given event (exclusive cursor); used when that event is covered by a summary. */
  queryAfterContext(timelineKey: string, afterEventId: string): CanonicalChatEvent[] {
    return this.clampToFloor(timelineKey, this.storage.getTimelineEventsAfter(timelineKey, afterEventId, 1000));
  }

  /**
   * Lower-bound clamp to the context floor (spec MESSAGE-BACKFETCH §4.4): drop any
   * event sorting strictly BELOW the floor by the canonical
   * `(timestamp, received_at, id)` order, so the first-class pipeline (context
   * rendering + summarization, the only callers of queryForContext/queryAfterContext)
   * never reaches into the search-only backfetched region. A no-op — and zero extra
   * work beyond one indexed lookup — for every timeline with no floor set (the
   * normal case; §4.5 guarantees backfetched events are the only ones below it).
   */
  private clampToFloor(timelineKey: string, events: CanonicalChatEvent[]): CanonicalChatEvent[] {
    const floor = this.storage.getContextFloorCursor(timelineKey);
    if (!floor) return events;
    return events.filter((e) => !cursorBelowFloor(e, floor));
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
   * gating. Returns `{ applied: true, event, status }`, or
   * `{ applied: false, pending: true }` when no target row exists — in which case
   * the resolved `replacement` is parked in `pending_edits` (keyed by
   * `(provider, targetExternalId, timelineKey)`, latest-wins by `editTimestamp`)
   * and replayed by the append path once the target lands (issue #12). The edit
   * is never stored as a standalone message. See {@link Storage.applyEditToTarget}.
   */
  applyEdit(
    provider: string,
    targetExternalId: string,
    timelineKey: string,
    replacement: EditReplacement,
    editTimestamp: number,
    updater: (target: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<
    | { applied: true; event: CanonicalChatEvent; status: string }
    | { applied: false; pending: true }
  > {
    return this.storage.applyEditToTarget(
      provider,
      targetExternalId,
      timelineKey,
      replacement,
      editTimestamp,
      updater,
      computeStatus,
    );
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

/**
 * True when `event` sorts strictly below `floor` in the canonical
 * `(timestamp, received_at, id)` order — i.e. it is a below-floor (search-only)
 * backfetched event that the first-class pipeline must exclude. The floor event
 * itself is first-class (`>= floor` is kept).
 */
function cursorBelowFloor(event: CanonicalChatEvent, floor: TimelineCursor): boolean {
  if (event.timestamp !== floor.timestamp) return event.timestamp < floor.timestamp;
  if (event.receivedAt !== floor.receivedAt) return event.receivedAt < floor.receivedAt;
  return event.id < floor.id;
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
    agentSessionGeneration: event.agentSessionGeneration ?? null,
    eventJson: JSON.stringify(event),
    // Bot/webhook flags for chain counting (spec MULTI-AGENT-SUPPORT §9).
    // NULL for non-Discord events and assistant (self) rows.
    senderIsBot: event.sender.isBot != null ? (event.sender.isBot ? 1 : 0) : null,
    senderIsWebhook: event.sender.isWebhook != null ? (event.sender.isWebhook ? 1 : 0) : null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
