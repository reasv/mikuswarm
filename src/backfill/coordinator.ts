import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { TimelineStore } from "../timeline/index.js";
import { applyEditToCanonical, editStatus, needsEnrichment, type EditReplacement } from "../timeline/index.js";
import { parseTimelineKey, buildTimelineKey } from "../storage/timeline-key.js";
import type { CanonicalChatEvent, HistorySummary, InboundChatEvent, TimelineState } from "../types.js";
import { classifyForRoom } from "./classify.js";
import {
  paginateBackward,
  type BackfillReadClient,
  type BackwardPaginateStopReason,
  type MessageDisposition,
} from "./paginate.js";

/**
 * Startup gap backfetch coordinator (ARCHITECTURE.md §7c).
 *
 * Recovers room history missed while the bot was offline. Per room it runs an
 * in-memory state machine `frozen → filling → committing → done`:
 *
 * - **Freeze** (before `provider.start`): record each room's committed high-water
 *   (`floor`) and mark it frozen. While frozen, *nothing* for the room is
 *   committed — live intake is buffered (§5.2) and the backward descent
 *   accumulates into a buffer rather than inserting as it pages.
 * - **Fill**: paginate backward from the live head into the backfill buffer until
 *   the floor is reached (gap closed), history is exhausted, or an optional
 *   cap/window/timeout/UTD guard trips.
 * - **Commit** (oldest-first): persist the buffered gap as one contiguous block
 *   above the old high-water, apply buffered edits, and nudge the scan-driven
 *   downstreams (enrichment/captioning/chat-search/summarization). Backfetched
 *   messages carry NO trigger and never start a session (G3).
 * - **Unfreeze + replay**: drain the live buffer through the normal inbound path,
 *   so live `@`s that arrived during the freeze are replied to (G4).
 *
 * The core invariant (§4) — *the committed high-water never advances until a
 * room's gap is fully closed* — means a crash at any point re-derives the **same
 * single gap** (now extended by the new downtime) on the next startup, purely
 * from `committed-high-water` vs `server-head`. No durable coordinator state is
 * needed; everything here is in memory and the operation is restart-from-scratch
 * (§5 / §7).
 */

/** Floor = the room's committed high-water by the canonical `(timestamp, …, id)` ordering. */
interface Floor {
  timestamp: number;
  /**
   * Full canonical id of the high-water event — `matrix:<account>:<eventId>` for
   * a received message, but `assistant:<session>:<eventId>:<chunk>` when the
   * newest committed event is a bot-sent message (send_message's own append).
   */
  id: string;
  /** The floor event's Matrix `$…` event id, when it has one. */
  externalId?: string;
}

type BufferItem =
  | { kind: "event"; event: CanonicalChatEvent }
  | {
      kind: "edit";
      targetExternalId: string;
      replacement: EditReplacement;
      editTimestamp: number;
    };

type RoomPhase = "frozen" | "filling" | "committing" | "done" | "failed";

interface RoomState {
  accountId: string;
  roomId: string;
  /** Composite identity key `accountId roomId` (space-separated; §10 multi-account keying). */
  roomKey: string;
  /** The room's base (non-thread) timeline key — `room:` or `dm:`. */
  baseTimelineKey: string;
  isDm: boolean;
  selfUserId: string;
  /** All currently-known timeline keys for this room (room/DM + threads). */
  timelineKeys: string[];
  floor: Floor | undefined;
  phase: RoomPhase;
  backfillBuf: BufferItem[];
  liveBuf: InboundChatEvent[];
  /**
   * A permanent hole was left below the oldest committed gap message (capped).
   * `reason` (issue #6) is the descent's stop reason so an operator can tell an
   * operator cap (`count`/`window`/`timeout`) from a floor-undefined `utd_halt`;
   * post-#1 a read `error` never commits, so it is never a capped-hole reason.
   */
  cappedHole?: { fromTimestamp: number; toTimestamp: number; reason: BackwardPaginateStopReason };
  committed: number;
  startedAt: number;
}

export interface GapBackfetchConfig {
  enabled: boolean;
  maxMessages: number;
  windowMs: number;
  timeoutMs: number;
  pageSize: number;
  utdHaltThreshold: number;
  concurrency: number;
}

export interface GapBackfetchSnapshotRoom {
  accountId: string;
  roomId: string;
  baseTimelineKey: string;
  phase: RoomPhase;
  backfillBuffered: number;
  liveBuffered: number;
  committed: number;
  /**
   * The permanent hole left below the oldest committed gap message under an
   * operator cap/window/timeout (or a floor-undefined UTD halt). `reason` (issue
   * #6) is the stop reason that produced the hole, so the console can show *why*
   * it was capped. Optional/back-compatible: absent on every cleanly-filled room.
   */
  cappedHole?: { fromTimestamp: number; toTimestamp: number; reason: BackwardPaginateStopReason };
}

export interface GapBackfetchCoordinatorOptions {
  storage: Storage;
  timeline: TimelineStore;
  config: GapBackfetchConfig;
  /** Resolve the native read client for an account + room (provider boundary). */
  getClient: (accountId: string, roomId: string) => BackfillReadClient;
  /** Bot's own Matrix user id per account, for role assignment / self-detection. */
  selfUserIds: Map<string, string>;
  /** Nudge the enrichment pool for a single committed event. */
  notifyEnrichment: (eventId: string) => void;
  /** Nudge the caption pool (drains all pending captions). */
  notifyCaptions: () => void;
  /** Re-project a committed event into the chat-search index. */
  enqueueChatSearch: (eventId: string) => void;
  /** Re-evaluate a timeline's summarization threshold after a commit. */
  enqueueSummarization: (timelineKey: string) => void;
  /** Drain a buffered live event through the normal inbound path (fire-and-forget). */
  replayLiveInbound: (inbound: InboundChatEvent) => void;
  /**
   * True once the app has begun draining for shutdown. The fill loop stops
   * launching new rooms and an un-started room is skipped, so a backfetch can't
   * race `storage.waitForIdle()`/`close()` during teardown. A skipped room's gap
   * is simply re-derived on the next startup (the §4 invariant).
   */
  isDraining: () => boolean;
  logger: Logger;
}

interface ParsedKey {
  accountId: string;
  kind: "room" | "dm";
  roomId: string;
  threadRootId?: string;
}

/**
 * Parse a timeline key into the local coordinate system. Delegates to the shared
 * grammar parser (spec DISCORD-SUPPORT-DESIGN §4.2) so this and every other parse
 * site agree on the grammar. The local `ParsedKey` type keeps `roomId`/`threadRootId`
 * names that the rest of this file uses (= channelId/threadId from the shared type).
 */
function parseKey(timelineKey: string): ParsedKey | null {
  const p = parseTimelineKey(timelineKey);
  if (!p) return null;
  return { accountId: p.accountId, kind: p.kind, roomId: p.channelId, threadRootId: p.threadId };
}

function roomKeyOf(accountId: string, roomId: string): string {
  return `${accountId} ${roomId}`;
}

export class GapBackfetchCoordinator {
  /** Keyed by `accountId roomId` (space-separated); only rooms in a non-terminal phase are frozen. */
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly opts: GapBackfetchCoordinatorOptions) {}

  /** Configured to run. */
  get enabled(): boolean {
    return this.opts.config.enabled;
  }

  /**
   * Freeze every in-scope room (§5.1) — MUST run before `provider.start` so no
   * live event is missed and no commit can race ahead of the floor capture.
   * Enumerates all known rooms (§6.1), records each `floor`, and marks it frozen.
   * No-op when disabled.
   */
  prepare(): void {
    if (!this.opts.config.enabled) return;
    const keys = this.opts.storage.listKnownTimelineKeys();
    // Group known timeline keys by (account, room), tracking every key's kind. A
    // room's `m.direct` flag is mutable, so a single roomId can hold BOTH `room:`
    // and `dm:` keys; the base kind is resolved per group below (#7).
    const groups = new Map<
      string,
      { accountId: string; roomId: string; keysByKind: Map<"room" | "dm", string[]>; keys: string[] }
    >();
    for (const key of keys) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      const rk = roomKeyOf(parsed.accountId, parsed.roomId);
      let existing = groups.get(rk);
      if (!existing) {
        existing = { accountId: parsed.accountId, roomId: parsed.roomId, keysByKind: new Map(), keys: [] };
        groups.set(rk, existing);
      }
      existing.keys.push(key);
      const forKind = existing.keysByKind.get(parsed.kind);
      if (forKind) forKind.push(key);
      else existing.keysByKind.set(parsed.kind, [key]);
    }

    for (const [rk, { accountId, roomId, keysByKind, keys: roomKeys }] of groups) {
      const selfUserId = this.opts.selfUserIds.get(accountId);
      if (!selfUserId) {
        this.opts.logger.warn("gap_backfetch_skip_room", {
          accountId,
          roomId,
          reason: "unknown_self_user",
        });
        continue;
      }
      // Resolve the group's base kind (#7). Single-kind groups (the normal case)
      // take that one kind unchanged. A mixed `room:`/`dm:` group picks the side
      // whose timeline keys have the newest committed high-water — i.e. where the
      // room currently behaves, where new live events land — rather than the old
      // unconditional dm-preference (which mis-homed recovered events to the dm
      // base even after the room flipped back to a regular room). The descent floor
      // is still MAX across ALL keys (computed below), so this choice changes only
      // where recovered events are *based*, never how far the descent goes.
      const baseKind = this.selectBaseKind(accountId, roomId, keysByKind);
      const isDm = baseKind === "dm";
      // Use buildTimelineKey (shared grammar) rather than a template literal so
      // key construction goes through the same module as parsing.
      // GapBackfetchCoordinator is intentionally Matrix-specific; it is only
      // activated when matrixProvider is non-null (see app.ts wiring).
      const baseTimelineKey = buildTimelineKey({
        provider: "matrix",
        accountId,
        kind: isDm ? "dm" : "room",
        channelId: roomId,
      });
      // Floor = MAX across ALL the room's keys (room/DM + threads), independent of
      // the base-kind choice; this bounds the descent regardless (#7).
      const floor = this.opts.storage.getHighWaterMark(roomKeys);
      this.rooms.set(rk, {
        accountId,
        roomId,
        roomKey: rk,
        baseTimelineKey,
        isDm,
        selfUserId,
        timelineKeys: roomKeys,
        floor,
        phase: "frozen",
        backfillBuf: [],
        liveBuf: [],
        committed: 0,
        startedAt: 0,
      });
    }
    this.opts.logger.info("gap_backfetch_prepared", { rooms: this.rooms.size });
  }

  /**
   * Pick the group's base kind (#7). Single-kind groups return that kind directly
   * (the normal case — no log, no comparison). For a mixed `room:`/`dm:` group,
   * choose the kind whose subset of timeline keys has the newest committed
   * high-water by the canonical `(timestamp, id)` order — the side where current
   * live events land — and emit a one-line `gap_backfetch_mixed_room_kind` warning
   * for operator visibility. If exactly one kind has any committed events, that
   * kind wins; if neither does (only `timeline_compaction_state` rows), default to
   * `room`.
   */
  private selectBaseKind(
    accountId: string,
    roomId: string,
    keysByKind: Map<"room" | "dm", string[]>,
  ): "room" | "dm" {
    const roomKeys = keysByKind.get("room");
    const dmKeys = keysByKind.get("dm");
    if (!roomKeys) return "dm"; // dm-only (dmKeys is guaranteed present)
    if (!dmKeys) return "room"; // room-only (the common case)

    // Mixed: compare each side's high-water (MAX over that side's keys, threads
    // included) by canonical order and pick the newer.
    const roomHw = this.opts.storage.getHighWaterMark(roomKeys);
    const dmHw = this.opts.storage.getHighWaterMark(dmKeys);
    let chosen: "room" | "dm";
    if (roomHw && dmHw) {
      chosen = compareFloor(roomHw, dmHw) >= 0 ? "room" : "dm";
    } else if (roomHw) {
      chosen = "room";
    } else if (dmHw) {
      chosen = "dm";
    } else {
      chosen = "room";
    }
    this.opts.logger.warn("gap_backfetch_mixed_room_kind", {
      accountId,
      roomId,
      kinds: ["room", "dm"],
      chosen,
      roomHighWater: roomHw?.timestamp ?? null,
      dmHighWater: dmHw?.timestamp ?? null,
    });
    return chosen;
  }

  /** True while the room owning `timelineKey` has not yet finished its gap fill. */
  isFrozen(timelineKey: string): boolean {
    const parsed = parseKey(timelineKey);
    if (!parsed) return false;
    const room = this.rooms.get(roomKeyOf(parsed.accountId, parsed.roomId));
    return room != null && this.isActivePhase(room.phase);
  }

  /**
   * Buffer a live inbound event for a frozen room (§5.2). Called by `handleInbound`
   * immediately after a synchronous `isFrozen` check, so the room is guaranteed
   * frozen; a stray call for a non-frozen room is ignored rather than dropped onto
   * the floor.
   */
  bufferLive(inbound: InboundChatEvent): void {
    const parsed = parseKey(inbound.timelineKey);
    if (!parsed) return;
    const room = this.rooms.get(roomKeyOf(parsed.accountId, parsed.roomId));
    if (!room || !this.isActivePhase(room.phase)) return;
    room.liveBuf.push(inbound);
  }

  private isActivePhase(phase: RoomPhase): boolean {
    return phase === "frozen" || phase === "filling" || phase === "committing";
  }

  /**
   * Run the per-room fill→commit→unfreeze pipeline with bounded concurrency
   * (§6.1). MUST run AFTER the scan-driven pools have started so committed gap
   * rows are picked up. Resolves when every room has settled. No-op when disabled.
   */
  async run(): Promise<void> {
    if (!this.opts.config.enabled) return;
    const queue = [...this.rooms.values()].filter((r) => r.phase === "frozen");
    const concurrency = Math.max(1, this.opts.config.concurrency);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        if (this.opts.isDraining()) return; // shutdown began — stop launching rooms
        const room = queue[cursor++]!;
        await this.runRoom(room);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  }

  /** Per-room run: fill, commit, unfreeze. Errors leave the room frozen (recovered on restart). */
  private async runRoom(room: RoomState): Promise<void> {
    room.startedAt = Date.now();
    this.opts.logger.info("gap_backfetch_start", {
      accountId: room.accountId,
      roomId: room.roomId,
      floorTimestamp: room.floor?.timestamp ?? null,
    });
    try {
      room.phase = "filling";
      const result = await this.fill(room);
      this.opts.logger.info("gap_backfetch_filled", {
        roomId: room.roomId,
        fetched: result.fetched,
        buffered: room.backfillBuf.length,
        // Canonical single stop reason (issue #6) beside the raw flags it derives
        // from, so the fill log and the capped log agree on one discriminator.
        stopReason: result.stopReason,
        reachedFloor: result.reachedFloor,
        exhausted: result.exhausted,
        reachedCount: result.reachedCount,
        reachedWindow: result.reachedWindow,
        timedOut: result.timedOut,
        haltedOnUtd: result.haltedOnUtd,
        errored: result.errored,
      });
      // A read failure mid-descent must NOT commit the partial newest-suffix
      // buffer: doing so would advance the high-water and bury the un-fetched
      // older span (next startup's floor = the new high-water). Route to the
      // failed path exactly like the catch block — leave the room frozen, do NOT
      // commit, do NOT drain/replay the live buffer. The §4 invariant re-derives
      // the same single gap on the next startup; the partial backfill buffer is
      // simply discarded (restart-from-scratch). Only a genuine completion
      // (floor/exhausted) or an operator opt-in (cap/window/timeout) may commit.
      if (result.errored) {
        room.phase = "failed";
        this.opts.logger.error("gap_backfetch_failed", {
          accountId: room.accountId,
          roomId: room.roomId,
          reason: "read_error",
          error: result.error ?? null,
        });
        return;
      }
      room.phase = "committing";
      // A stop that is neither "gap fully closed" (floor) nor "no more history"
      // (exhausted) leaves a permanent hole below the oldest committed gap message
      // (§10). Carry the single canonical stop reason (issue #6) into commit so the
      // `gap_backfetch_capped` log + the `cappedHole` record name *which* opt-in
      // (count/window/timeout, or a floor-undefined utd_halt) produced the hole.
      await this.commit(room, result.stopReason);
      this.opts.logger.info("gap_backfetch_done", {
        roomId: room.roomId,
        committed: room.committed,
        liveReplayed: room.liveBuf.length,
        capped: room.cappedHole != null,
        durationMs: Date.now() - room.startedAt,
      });
    } catch (error) {
      room.phase = "failed";
      // The room stays frozen: do NOT drain its live buffer, which would advance
      // the high-water and bury the un-filled gap. The §4 invariant means the
      // next startup re-derives the same single gap and retries cleanly. (Only a
      // catastrophic single-writer failure reaches here; the page engine already
      // swallows transient read errors.)
      this.opts.logger.error("gap_backfetch_failed", {
        accountId: room.accountId,
        roomId: room.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Buffer the backward descent (§5.2). No DB writes happen here. */
  private fill(room: RoomState) {
    const cfg = this.opts.config;
    const windowFloor = cfg.windowMs > 0 ? Date.now() - cfg.windowMs : Number.NEGATIVE_INFINITY;
    const floor = room.floor;

    const onMessage = (summary: HistorySummary, timestamp: number): MessageDisposition => {
      // Derive provider from the room's base timeline key (shared grammar, spec §4.2).
      const provider = parseTimelineKey(room.baseTimelineKey)?.provider ?? "matrix";
      const classified = classifyForRoom(summary, {
        provider,
        accountId: room.accountId,
        selfUserId: room.selfUserId,
        baseTimelineKey: room.baseTimelineKey,
        isDm: room.isDm,
        timestamp,
        buildId: (externalId) => `matrix:${room.accountId}:${externalId}`,
      });
      if (!classified) return "skip";

      // Floor stop (primary): we've reached the committed high-water. The canonical
      // order is (timestamp, received_at, id), but a fetched summary carries no
      // received_at and a backfetched event is assigned received_at = now, which is
      // ≫ the floor event's historical received_at. So EVERY candidate at the floor's
      // exact timestamp that is not the floor event itself sorts canonically *above*
      // the floor and is a genuine gap event that must be recovered — regardless of
      // how its eventId sorts against floor.id. The only same-ms boundary is the
      // floor event itself, uniquely identified by its canonical id — OR by its
      // Matrix event id when the floor is a bot-sent message: send_message stores
      // those under `assistant:<session>:<eventId>:<chunk>` canonical ids, which the
      // re-derived `matrix:` candidate id can never equal, so the external-id
      // comparison is what recognizes an assistant-row floor. We therefore stop on
      // an exact canonical-id or external-id match, or any strictly-older timestamp;
      // the re-fetched floor event is buffered and harmlessly deduped at commit
      // (`appendIfMissing` drops the already-committed row — by canonical id, or by
      // (provider, external_id, timeline_key) for a self message stored under an
      // assistant id). (A plain `<=`/`<` id compare would mistake same-ms gap events
      // with a lower eventId for the floor and silently drop them — commit-time
      // dedup cannot recover an event that was never buffered.) If the floor event
      // is never re-fetched, the descent stops at the first strictly-older event
      // after buffering the same-ms layer.
      if (floor) {
        const candidateId = `matrix:${room.accountId}:${summary.externalId}`;
        if (
          timestamp < floor.timestamp ||
          candidateId === floor.id ||
          (floor.externalId != null && summary.externalId === floor.externalId)
        ) {
          return "floor";
        }
      }
      // Window stop (optional safety valve).
      if (timestamp < windowFloor) return "window";

      if (classified.kind === "edit") {
        room.backfillBuf.push({
          kind: "edit",
          targetExternalId: classified.targetExternalId,
          replacement: classified.replacement,
          editTimestamp: timestamp,
        });
        return "edit";
      }

      room.backfillBuf.push({ kind: "event", event: classified.event });
      return classified.event.undecryptable != null ? "stored-utd" : "stored";
    };

    return paginateBackward({
      client: this.opts.getClient(room.accountId, room.roomId),
      roomId: room.roomId,
      pageSize: cfg.pageSize,
      // 0 ⇒ unbounded (the default); the floor is the natural stop (§9).
      maxMessages: cfg.maxMessages,
      timeoutMs: cfg.timeoutMs,
      // Disable the UTD-halt guard for a floor-bounded descent. A gap bounded
      // below by the floor is entirely post-join, member-encrypted traffic, so a
      // UTD there is transient missing-keys (startup key-sync lag), NOT permanent
      // pre-join history. The floor already bounds the descent; UTD events buffer
      // as `skipped` and are healed in place later by the re-decryption sweeper —
      // identical to the live path. Halting here would bury the decryptable
      // remainder (worst case a head-of-gap UTD wall buries the whole gap). The
      // guard is retained ONLY for the floor-undefined (initial-backfill-style)
      // unbounded descent, where pre-join UTD history is a real risk (§6.1). 0
      // disables the guard inside paginateBackward.
      utdHaltThreshold: room.floor ? 0 : cfg.utdHaltThreshold,
      logger: this.opts.logger,
      readFailedEvent: "gap_backfetch_read_failed",
      logFields: { accountId: room.accountId, roomId: room.roomId },
      onMessage,
    });
  }

  /**
   * Commit the buffered gap (§5.3), oldest-first for crash-safety (§5.4), then
   * unfreeze and replay the live buffer.
   */
  private async commit(room: RoomState, stopReason: BackwardPaginateStopReason): Promise<void> {
    // Drain bail (#3): if shutdown has begun before this room issues its first
    // write, do NOT start committing. Leaving the room frozen (live buffer intact,
    // backfill buffer discarded with the coordinator) keeps the §4 invariant —
    // the same single gap re-derives on the next startup — and avoids racing a
    // write into a closing DB (`storage.waitForIdle()`/`close()` in `stop()`).
    // A room already mid-commit when `draining` flips still finishes its
    // oldest-first batch (crash-safe); this only prevents *starting* one. No-op
    // during normal operation (isDraining is false).
    if (this.opts.isDraining()) {
      this.opts.logger.info("gap_backfetch_commit_skipped_draining", {
        accountId: room.accountId,
        roomId: room.roomId,
        buffered: room.backfillBuf.length,
      });
      return;
    }
    // A stop that is neither "gap fully closed" (floor) nor "no more history"
    // (exhausted) leaves a permanent hole below the oldest committed gap message
    // (§10). `error` never reaches here (routed to the failed path in `runRoom`,
    // post-#1), so the incomplete reasons are the operator opt-ins
    // (count/window/timeout) or a floor-undefined utd_halt.
    const incomplete = stopReason !== "floor" && stopReason !== "exhausted";

    // 1. Dedup buffered events by canonical id, sort ascending (oldest-first).
    const byId = new Map<string, CanonicalChatEvent>();
    for (const item of room.backfillBuf) {
      if (item.kind === "event" && !byId.has(item.event.id)) byId.set(item.event.id, item.event);
    }
    const events = [...byId.values()].sort(compareAscending);

    // Capped-hole bookkeeping (§10): the hole spans from the floor up to the
    // oldest committed gap message. Only meaningful when the descent stopped
    // incomplete AND something was buffered. `reason` (issue #6) lets an operator
    // distinguish a cap from a window/timeout/UTD-halt hole in both the log and
    // the console panel.
    if (incomplete && room.floor && events.length > 0) {
      const oldest = events[0]!;
      if (oldest.timestamp > room.floor.timestamp) {
        room.cappedHole = {
          fromTimestamp: room.floor.timestamp,
          toTimestamp: oldest.timestamp,
          reason: stopReason,
        };
        this.opts.logger.warn("gap_backfetch_capped", {
          accountId: room.accountId,
          roomId: room.roomId,
          reason: stopReason,
          unfetchedFromTimestamp: room.floor.timestamp,
          unfetchedToTimestamp: oldest.timestamp,
        });
      }
    }

    // 2. Persist oldest-first. Status mirrors how each event's OWN timeline would
    //    have stored it live: active → 'pending'/'skipped' (enriched); inactive →
    //    'inactive' (deferred to a future activation flip); UTD → always 'skipped'.
    const stateCache = new Map<string, TimelineState>();
    const stateOf = (timelineKey: string): TimelineState => {
      let s = stateCache.get(timelineKey);
      if (s === undefined) {
        s = this.opts.storage.getTimelineState(timelineKey);
        stateCache.set(timelineKey, s);
      }
      return s;
    };
    const activeTimelines = new Set<string>();
    let committedAnyActive = false;

    for (const event of events) {
      const state = stateOf(event.timelineKey);
      const isUtd = event.undecryptable != null;
      const status = isUtd
        ? "skipped"
        : state === "active"
          ? needsEnrichment(event)
            ? "pending"
            : "skipped"
          : "inactive";
      const { duplicate } = await this.opts.timeline.appendIfMissing(event, status);
      if (duplicate) continue;
      room.committed++;
      if (state === "active") {
        activeTimelines.add(event.timelineKey);
        committedAnyActive = true;
        if (status === "pending") this.opts.notifyEnrichment(event.id);
        // Belt-and-suspenders chat-search projection (§5.3 step 3); idempotent.
        this.opts.enqueueChatSearch(event.id);
      }
    }

    // 3. Apply buffered edits AFTER all inserts (the target now exists for an
    //    in-batch edit), in chronological order. Resolve the target's actual
    //    stored timeline key across room+thread keys so a thread-target edit is
    //    not parked under the room key where replay never matches.
    const edits = room.backfillBuf
      .filter((i): i is Extract<BufferItem, { kind: "edit" }> => i.kind === "edit")
      .sort((a, b) => a.editTimestamp - b.editTimestamp);
    // Derive provider from the room's base timeline key (shared grammar, spec §4.2).
    const editProvider = parseTimelineKey(room.baseTimelineKey)?.provider ?? "matrix";
    for (const ed of edits) {
      const targetKey =
        this.opts.timeline.resolveEditTargetTimelineKey(editProvider, ed.targetExternalId, room.baseTimelineKey) ??
        room.baseTimelineKey;
      const res = await this.opts.timeline.applyEdit(
        editProvider,
        ed.targetExternalId,
        targetKey,
        ed.replacement,
        ed.editTimestamp,
        (target) => applyEditToCanonical(target, ed.replacement),
        editStatus,
      );
      if (res.applied) {
        const state = stateOf(res.event.timelineKey);
        if (state === "active") {
          activeTimelines.add(res.event.timelineKey);
          committedAnyActive = true;
          this.opts.enqueueChatSearch(res.event.id);
          if (res.status === "pending") this.opts.notifyEnrichment(res.event.id);
        }
      }
    }

    // 4. Nudge the remaining scan-driven downstreams for active timelines. The gap
    //    rows are contiguous above the old high-water, so summarization extends
    //    cleanly (§4).
    if (committedAnyActive) this.opts.notifyCaptions();
    for (const timelineKey of activeTimelines) this.opts.enqueueSummarization(timelineKey);

    // 5. Unfreeze + replay live buffer (§5.3 step 4/5). Snapshot + flip phase
    //    synchronously so no inbound interleaves between drain and unfreeze; the
    //    snapshot is already chronological (arrival order).
    room.backfillBuf = [];
    const live = room.liveBuf;
    room.liveBuf = [];
    room.phase = "done";
    for (const inbound of live) this.opts.replayLiveInbound(inbound);
  }

  /** Observability snapshot (§11): every room's phase and buffered/committed counts. */
  snapshot(): GapBackfetchSnapshotRoom[] {
    return [...this.rooms.values()].map((room) => ({
      accountId: room.accountId,
      roomId: room.roomId,
      baseTimelineKey: room.baseTimelineKey,
      phase: room.phase,
      backfillBuffered: room.backfillBuf.length,
      liveBuffered: room.liveBuf.length,
      committed: room.committed,
      ...(room.cappedHole ? { cappedHole: room.cappedHole } : {}),
    }));
  }
}

function compareAscending(a: CanonicalChatEvent, b: CanonicalChatEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compare two committed high-water marks by the canonical `(timestamp, id)` order
 * (the `received_at` tie-breaker is unavailable here — `getHighWaterMark` returns
 * only `{timestamp, id}`). Returns >0 when `a` is newer, <0 when `b` is newer,
 * 0 when equal. Used to pick a mixed room/dm group's base kind (#7).
 */
function compareFloor(a: { timestamp: number; id: string }, b: { timestamp: number; id: string }): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
