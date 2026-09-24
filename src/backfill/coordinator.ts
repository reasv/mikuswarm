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
  /** Provider id (the timeline key's first segment, e.g. "matrix", "discord"). */
  provider: string;
  accountId: string;
  roomId: string;
  /**
   * Set when this unit is one thread of a `threadHistory: "separate"` provider
   * (the thread is its own history channel and is paged on its own). Absent for
   * a room/DM unit, which on an `"inline"` provider also covers every thread.
   */
  threadId?: string;
  /** Composite identity key (see `unitKeyOf`; §10 multi-account keying). */
  roomKey: string;
  /** The room's base (non-thread) timeline key — `room:` or `dm:`. */
  baseTimelineKey: string;
  isDm: boolean;
  /**
   * The bot's own user id on this provider account. Resolved at `run()` (not
   * `prepare()`): a provider may only learn its self-id inside `start()`, which
   * runs between the two, so a `prepare()`-time lookup would wrongly skip every
   * such account. Undefined until `runRoom` resolves it.
   */
  selfUserId?: string;
  /** All currently-known timeline keys for this unit (room/DM + threads, or the one thread key). */
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
  provider: string;
  accountId: string;
  roomId: string;
  /** Present when the unit is one separately-paged thread (see `RoomState.threadId`). */
  threadId?: string;
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

/** One descent unit, as handed to `getClient` (provider boundary). */
export interface GapBackfetchUnit {
  provider: string;
  accountId: string;
  /** Channel id (Matrix room id / Discord channel snowflake). */
  roomId: string;
  /** Set for a separately-paged thread unit (`threadHistory: "separate"`). */
  threadId?: string;
  /** The unit's own timeline key: the thread key for a thread unit, else the base room/DM key. */
  timelineKey: string;
}

/** How one provider's paged history is shaped, as reported by `providerHistory`. */
export interface GapBackfetchProviderHistory {
  /**
   * `"inline"`: a channel's history stream already contains its thread messages
   * (Matrix — thread relations live in the room timeline), so one descent per room
   * covers the room and every thread. `"separate"`: each thread is its own history
   * channel (Discord), so every thread timeline key is its own descent unit with
   * its own floor and read client.
   */
  threadHistory: "inline" | "separate";
}

export interface GapBackfetchCoordinatorOptions {
  storage: Storage;
  timeline: TimelineStore;
  config: GapBackfetchConfig;
  /**
   * Describe a provider's paged history, or return undefined when the provider is
   * not registered or has no paged history (its timelines are then out of scope:
   * never frozen, never fetched). Consulted once per provider at `prepare()`.
   */
  providerHistory: (provider: string) => GapBackfetchProviderHistory | undefined;
  /**
   * Resolve the read client for one descent unit, or undefined when the provider
   * cannot serve it (the unit is then released unfilled at `run()`). Called at
   * `run()`, after every provider has started.
   */
  getClient: (unit: GapBackfetchUnit) => BackfillReadClient | undefined;
  /**
   * The bot's own user id on a provider account, for role assignment /
   * self-detection. Called at `run()` — never at `prepare()` — because a provider
   * may only resolve its self-id inside `start()`, which runs between the two
   * (the boot-ordering constraint that once skipped every such account).
   */
  resolveSelfUserId: (provider: string, accountId: string) => string | undefined;
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
  provider: string;
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
  return { provider: p.provider, accountId: p.accountId, kind: p.kind, roomId: p.channelId, threadRootId: p.threadId };
}

/**
 * Composite identity of one descent unit: `provider accountId roomId` (space-
 * separated), plus ` thread <id>` for a separately-paged thread. Provider-qualified
 * so two providers whose operator-chosen account keys coincide never share a unit.
 */
function unitKeyOf(provider: string, accountId: string, roomId: string, threadId?: string): string {
  const base = `${provider} ${accountId} ${roomId}`;
  return threadId ? `${base} thread ${threadId}` : base;
}

export class GapBackfetchCoordinator {
  /** Keyed by `unitKeyOf(...)`; only units in a non-terminal phase are frozen. */
  private readonly rooms = new Map<string, RoomState>();
  /** Per-provider history shape captured at `prepare()`; absent ⇒ provider out of scope. */
  private readonly providerHistory = new Map<string, GapBackfetchProviderHistory>();

  constructor(private readonly opts: GapBackfetchCoordinatorOptions) {}

  /** Configured to run. */
  get enabled(): boolean {
    return this.opts.config.enabled;
  }

  /**
   * Resolve the history shape of `provider`, consulting the app once per provider
   * (memoized for the coordinator's lifetime — the provider set is fixed at boot).
   */
  private historyOf(provider: string): GapBackfetchProviderHistory | undefined {
    let shape = this.providerHistory.get(provider);
    if (!shape) {
      shape = this.opts.providerHistory(provider);
      if (shape) this.providerHistory.set(provider, shape);
    }
    return shape;
  }

  /** The unit key a timeline key belongs to, or undefined when its provider is out of scope. */
  private unitKeyFor(parsed: ParsedKey): string | undefined {
    const shape = this.historyOf(parsed.provider);
    if (!shape) return undefined;
    const threadId = shape.threadHistory === "separate" ? parsed.threadRootId : undefined;
    return unitKeyOf(parsed.provider, parsed.accountId, parsed.roomId, threadId);
  }

  /**
   * Freeze every in-scope room (§5.1) — MUST run before `provider.start` so no
   * live event is missed and no commit can race ahead of the floor capture.
   * Enumerates all known rooms (§6.1), records each `floor`, and marks it frozen.
   * Requires nothing from the providers themselves (self-ids and read clients are
   * resolved at `run()`, after they have started). No-op when disabled.
   */
  prepare(): void {
    if (!this.opts.config.enabled) return;
    const keys = this.opts.storage.listKnownTimelineKeys();
    // Group known timeline keys by descent unit — (provider, account, room), plus
    // the thread for a `threadHistory: "separate"` provider — tracking every key's
    // kind. A Matrix room's `m.direct` flag is mutable, so a single roomId can hold
    // BOTH `room:` and `dm:` keys; the base kind is resolved per group below (#7).
    // Keys of a provider with no paged history are left out of scope entirely
    // (never frozen), counted per provider for the prepared log.
    const groups = new Map<
      string,
      {
        provider: string;
        accountId: string;
        roomId: string;
        threadId?: string;
        keysByKind: Map<"room" | "dm", string[]>;
        keys: string[];
      }
    >();
    const outOfScope = new Map<string, number>();
    for (const key of keys) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      const rk = this.unitKeyFor(parsed);
      if (!rk) {
        outOfScope.set(parsed.provider, (outOfScope.get(parsed.provider) ?? 0) + 1);
        continue;
      }
      let existing = groups.get(rk);
      if (!existing) {
        const threadId =
          this.historyOf(parsed.provider)?.threadHistory === "separate" ? parsed.threadRootId : undefined;
        existing = {
          provider: parsed.provider,
          accountId: parsed.accountId,
          roomId: parsed.roomId,
          threadId,
          keysByKind: new Map(),
          keys: [],
        };
        groups.set(rk, existing);
      }
      existing.keys.push(key);
      const forKind = existing.keysByKind.get(parsed.kind);
      if (forKind) forKind.push(key);
      else existing.keysByKind.set(parsed.kind, [key]);
    }

    for (const [rk, { provider, accountId, roomId, threadId, keysByKind, keys: roomKeys }] of groups) {
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
      // key construction goes through the same module as parsing. The base key is
      // always the room/DM key — a separately-paged thread unit still routes its
      // events through `classifyForRoom`, which derives `${base}:thread:<root>`
      // from each summary's `threadRootExternalId`.
      const baseTimelineKey = buildTimelineKey({
        provider,
        accountId,
        kind: isDm ? "dm" : "room",
        channelId: roomId,
      });
      // Floor = MAX across ALL the unit's keys (room/DM + threads, or the single
      // thread key), independent of the base-kind choice; this bounds the descent
      // regardless (#7).
      const floor = this.opts.storage.getHighWaterMark(roomKeys);
      this.rooms.set(rk, {
        provider,
        accountId,
        roomId,
        threadId,
        roomKey: rk,
        baseTimelineKey,
        isDm,
        timelineKeys: roomKeys,
        floor,
        phase: "frozen",
        backfillBuf: [],
        liveBuf: [],
        committed: 0,
        startedAt: 0,
      });
    }
    this.opts.logger.info("gap_backfetch_prepared", {
      rooms: this.rooms.size,
      ...(outOfScope.size > 0 ? { outOfScope: Object.fromEntries(outOfScope) } : {}),
    });
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
    const room = this.unitOf(timelineKey);
    return room != null && this.isActivePhase(room.phase);
  }

  /** The unit owning `timelineKey`, if its provider is in scope and the unit was prepared. */
  private unitOf(timelineKey: string): RoomState | undefined {
    const parsed = parseKey(timelineKey);
    if (!parsed) return undefined;
    const rk = this.unitKeyFor(parsed);
    return rk ? this.rooms.get(rk) : undefined;
  }

  /**
   * Buffer a live inbound event for a frozen room (§5.2). Called by `handleInbound`
   * immediately after a synchronous `isFrozen` check, so the room is guaranteed
   * frozen; a stray call for a non-frozen room is ignored rather than dropped onto
   * the floor.
   */
  bufferLive(inbound: InboundChatEvent): void {
    const room = this.unitOf(inbound.timelineKey);
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

  /**
   * Release a unit whose gap cannot be filled at all (no self-id, no read client,
   * or history the provider reports as permanently unavailable): unfreeze it and
   * replay its live buffer, exactly as if it had never been in scope. Unlike a
   * transient read failure this does NOT leave the room frozen — there is no
   * fill to retry, and a frozen room would hold its live traffic (and its
   * sessions) hostage until the next restart. Logged as `gap_backfetch_skip_room`.
   */
  private release(room: RoomState, reason: string, extra: Record<string, unknown> = {}): void {
    this.opts.logger.warn("gap_backfetch_skip_room", {
      provider: room.provider,
      accountId: room.accountId,
      roomId: room.roomId,
      ...(room.threadId ? { threadId: room.threadId } : {}),
      reason,
      ...extra,
    });
    room.backfillBuf = [];
    const live = room.liveBuf;
    room.liveBuf = [];
    room.phase = "done";
    for (const inbound of live) this.opts.replayLiveInbound(inbound);
  }

  /** Per-room run: fill, commit, unfreeze. Errors leave the room frozen (recovered on restart). */
  private async runRoom(room: RoomState): Promise<void> {
    room.startedAt = Date.now();
    // Provider-side prerequisites, resolved now — after every provider's `start()`
    // — rather than at `prepare()` (see `RoomState.selfUserId`).
    const selfUserId = this.opts.resolveSelfUserId(room.provider, room.accountId);
    if (!selfUserId) {
      this.release(room, "unknown_self_user");
      return;
    }
    room.selfUserId = selfUserId;
    let client: BackfillReadClient | undefined;
    try {
      client = this.opts.getClient({
        provider: room.provider,
        accountId: room.accountId,
        roomId: room.roomId,
        threadId: room.threadId,
        timelineKey: room.threadId
          ? buildTimelineKey({
              provider: room.provider,
              accountId: room.accountId,
              kind: room.isDm ? "dm" : "room",
              channelId: room.roomId,
              threadId: room.threadId,
            })
          : room.baseTimelineKey,
      });
    } catch (error) {
      this.release(room, "client_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!client) {
      this.release(room, "client_unavailable");
      return;
    }
    this.opts.logger.info("gap_backfetch_start", {
      provider: room.provider,
      accountId: room.accountId,
      roomId: room.roomId,
      ...(room.threadId ? { threadId: room.threadId } : {}),
      floorTimestamp: room.floor?.timestamp ?? null,
    });
    try {
      room.phase = "filling";
      const result = await this.fill(room, client, selfUserId);
      // The provider reported this channel's history as permanently unavailable
      // (e.g. no permission to read it) — nothing to retry on a restart either, so
      // release the unit instead of freezing it (see `release`).
      if (result.historyUnavailable) {
        this.release(room, "history_unavailable", { error: result.error ?? null });
        return;
      }
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
  private fill(room: RoomState, client: BackfillReadClient, selfUserId: string) {
    const cfg = this.opts.config;
    const windowFloor = cfg.windowMs > 0 ? Date.now() - cfg.windowMs : Number.NEGATIVE_INFINITY;
    const floor = room.floor;
    // Canonical ids follow each provider's live-ingest scheme
    // (`<provider>:<account>:<externalId>`) so gap rows dedup against live rows.
    const buildId = (externalId: string) => `${room.provider}:${room.accountId}:${externalId}`;

    const onMessage = (summary: HistorySummary, timestamp: number): MessageDisposition => {
      const classified = classifyForRoom(summary, {
        provider: room.provider,
        accountId: room.accountId,
        selfUserId,
        baseTimelineKey: room.baseTimelineKey,
        isDm: room.isDm,
        timestamp,
        buildId,
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
        const candidateId = buildId(summary.externalId);
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
      client,
      roomId: room.threadId ?? room.roomId,
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
      logFields: { provider: room.provider, accountId: room.accountId, roomId: room.roomId, threadId: room.threadId },
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
    const editProvider = room.provider;
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
      provider: room.provider,
      accountId: room.accountId,
      roomId: room.roomId,
      ...(room.threadId ? { threadId: room.threadId } : {}),
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
