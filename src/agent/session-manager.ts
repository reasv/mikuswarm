import { nanoid } from "nanoid";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { InboundChatEvent } from "../types.js";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";

export type AgentSessionStatus =
  | "created"
  | "running"
  | "completed"
  | "discarded"
  | "interrupted"
  | "suspended"
  | "resuming"
  | "failed-resumable";

/** Trigger body is truncated before persisting to keep the row small. */
const MAX_TRIGGER_BODY = 500;
/** Interjection body is truncated the same way as the trigger body. */
const MAX_INTERJECTION_BODY = 500;

/**
 * The inbound timeline message behind a user interjection (ARCHITECTURE.md §8/§11),
 * passed to {@link SessionManager.steer} so the inject is recorded as a searchable,
 * event-linked `session_interjections` row. `body` is the raw inbound text (the search
 * corpus); `kind` distinguishes a direct reply-steer, a co-target co-reply, and a
 * same-sender quick follow-up folded into the session (spec FOLLOWUP-FOLDING §5.1).
 */
export interface InterjectionSource {
  eventId?: string | null;
  externalId?: string | null;
  senderId?: string | null;
  senderDisplayName?: string | null;
  kind: "reply" | "co-reply" | "follow-up";
  body: string;
}

export interface AgentSessionRecord {
  id: string;
  timelineKey: string;
  sessionType: string;
  status: AgentSessionStatus;
  trigger: InboundChatEvent;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/**
 * Per-session run lifecycle state, owned by {@link SessionManager} and shared
 * with the {@link SessionRunner} via {@link SessionManager.runLifecycle}.
 *
 * `runInProgress` is the authoritative "logically running" signal: it is set
 * when the runner enters `run()` and cleared when the run settles. Unlike the
 * transient per-run `agent.signal` (defined only during an active `prompt()`),
 * it stays true across the inter-turn gap between forced-completion turns, so an
 * operator Stop landing in that gap is correctly treated as interruptible.
 *
 * `interrupted` is set by {@link SessionManager.interrupt} and read by the
 * runner's force-completion loop, which breaks on it even if an in-flight turn
 * resolved normally (`stopReason:"stop"`) a hair before the abort landed.
 */
interface RunState {
  runInProgress: boolean;
  interrupted: boolean;
}

/**
 * The slice of run lifecycle the {@link SessionRunner} consults/drives. Lets the
 * runner mark run-in-progress and observe interruption without holding a
 * reference to the whole manager (keeps the runner decoupled and unit-testable).
 */
export interface SessionRunLifecycle {
  markRunInProgress(): void;
  clearRunInProgress(): void;
  isInterrupted(): boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly agents = new Map<string, Agent>();
  private readonly byTimeline = new Map<string, Set<string>>();
  private readonly runStates = new Map<string, RunState>();
  /** Per-session "run settled" listeners, fired once on {@link evict}. */
  private readonly settleListeners = new Map<string, Set<() => void>>();

  /**
   * Storage and logger are optional so existing unit tests that construct
   * `new SessionManager()` keep working without a DB. When `storage` is absent,
   * all observability-row writes are skipped (no-op); in-memory state remains
   * the source of truth.
   */
  constructor(private readonly deps: { storage?: Storage; logger?: Logger } = {}) {}

  createPlaceholder(
    trigger: InboundChatEvent,
    sessionType: string = "default",
    modelId?: string | null,
  ): AgentSessionRecord {
    const record: AgentSessionRecord = {
      id: `s-${nanoid(10)}`,
      timelineKey: trigger.timelineKey,
      sessionType,
      status: "created",
      trigger,
      createdAt: Date.now(),
    };
    this.sessions.set(record.id, record);
    const ids = this.byTimeline.get(record.timelineKey) ?? new Set<string>();
    ids.add(record.id);
    this.byTimeline.set(record.timelineKey, ids);

    // Fire-and-forget durable row. FIFO write queue guarantees this insert
    // settles before any later status update for the same id.
    //
    // The trigger SENDER identity is persisted alongside the trigger body so a
    // manual resume can rebuild the SAME sender-bound tool set (user_profile_*,
    // recap's asker) from the durable row alone (spec
    // CONCURRENCY-AND-RATE-LIMITING §6.2). The resolution mirrors
    // buildSessionTools: the trigger's `triggeredBy` when present, else the
    // event sender.
    const triggerSender = trigger.trigger?.triggeredBy ?? trigger.event.sender;
    this.persist("session row insert", record.id, (storage) =>
      storage.insertAgentSession({
        id: record.id,
        timelineKey: record.timelineKey,
        sessionType: record.sessionType,
        status: "created",
        // Seed the model at creation (the workers do the same) so even a session
        // that dies before its first commit carries one; the per-request
        // write-back (updateAgentSessionUsage) keeps it authoritative thereafter.
        modelId: modelId ?? null,
        triggerEventId: trigger.event.id,
        triggerExternalId: trigger.event.externalId,
        triggerBody: trigger.event.body?.slice(0, MAX_TRIGGER_BODY),
        triggerSenderId: triggerSender.id,
        triggerSenderDisplayName: triggerSender.displayName,
        // Gap-backfill lower bound (spec RESUMABLE-SESSIONS §9.2): the trigger
        // group's latest member, which is always the trigger event itself (the
        // group only folds in EARLIER same-sender messages). On a reply-resume the
        // gap surfaces only what arrived after this. Worker/proactive sessions are
        // not reply-resumable, so the value is inert for them.
        chatUpperBoundTs: trigger.event.timestamp,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      }),
    );

    return record;
  }

  markRunning(sessionId: string): void {
    const startedAt = Date.now();
    this.update(sessionId, (session) => ({
      ...session,
      status: "running",
      startedAt: session.startedAt ?? startedAt,
    }));
    this.persist("session status running", sessionId, (storage) =>
      storage.updateAgentSessionStatus(sessionId, "running", { startedAt }),
    );
  }

  markCompleted(sessionId: string, opts: { noReply?: boolean } = {}): void {
    // Interruption is the authoritative terminal state: a run aborted via
    // `interrupt()` still settles normally (pi-agent-core resolves an aborted
    // run), so its run promise's `.then` lands here. Don't overwrite the
    // `interrupted` status — just evict and return.
    if (this.sessions.get(sessionId)?.status === "interrupted") {
      this.evict(sessionId);
      return;
    }
    const completedAt = Date.now();
    this.update(sessionId, (session) => ({
      ...session,
      status: "completed",
      completedAt,
    }));
    this.persist("session status completed", sessionId, (storage) =>
      storage.updateAgentSessionStatus(sessionId, "completed", {
        completedAt,
        noReply: opts.noReply,
      }),
    );
    this.evict(sessionId);
  }

  /**
   * Park a session whose auto-resume attempts are exhausted (spec §6.2): a
   * manual console action can redo the same resume on demand. Terminal for the
   * in-memory lifecycle (evicted like the other terminal states); the durable
   * row keeps the snapshot + transcript the manual resume needs.
   */
  markFailedResumable(sessionId: string, opts: { error?: string } = {}): void {
    if (this.sessions.get(sessionId)?.status === "interrupted") {
      this.evict(sessionId);
      return;
    }
    const completedAt = Date.now();
    this.update(sessionId, (session) => ({ ...session, status: "failed-resumable", completedAt }));
    this.persist("session status failed-resumable", sessionId, (storage) =>
      storage.updateAgentSessionStatus(sessionId, "failed-resumable", {
        completedAt,
        error: opts.error,
      }),
    );
    this.evict(sessionId);
  }

  /**
   * Re-register a session record reconstructed from its durable row (the manual
   * console resume of a parked `failed-resumable` session, possibly after a
   * restart — the original in-memory record was evicted). The caller drives the
   * normal lifecycle from here (`markRunning` → `attachAgent` → run).
   */
  adopt(record: AgentSessionRecord): void {
    this.sessions.set(record.id, record);
    const ids = this.byTimeline.get(record.timelineKey) ?? new Set<string>();
    ids.add(record.id);
    this.byTimeline.set(record.timelineKey, ids);
  }

  markDiscarded(sessionId: string, opts: { error?: string } = {}): void {
    // See `markCompleted`: an interrupted run that settles via the error path
    // must not clobber the `interrupted` status. Evict and return.
    if (this.sessions.get(sessionId)?.status === "interrupted") {
      this.evict(sessionId);
      return;
    }
    const completedAt = Date.now();
    this.update(sessionId, (session) => ({
      ...session,
      status: "discarded",
      completedAt,
    }));
    this.persist("session status discarded", sessionId, (storage) =>
      storage.updateAgentSessionStatus(sessionId, "discarded", {
        completedAt,
        error: opts.error,
      }),
    );
    this.evict(sessionId);
  }

  get(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Register the live `Agent` for a session so observers (the SSE stream) and
   * steering can reach it.
   *
   * Convention — callers MUST `markRunning(sessionId)` (or otherwise drive the
   * agent to a `running` state) BEFORE calling `attachAgent`. The observability
   * SSE liveness check (`isAgentLive`) and `steer` both gate on the agent being
   * in an active run; attaching an agent that has not yet been prompted would
   * make `getAgent(id)` return a not-yet-running agent. Today the chat path
   * (`markRunning` then `attachAgent`) and the summarization path (inserts at
   * `running`) both honor this. `SessionManager` does not structurally enforce
   * the ordering, so it is recorded here and defended against in `isAgentLive`.
   */
  attachAgent(sessionId: string, agent: Agent): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.agents.set(sessionId, agent);
  }

  getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  /**
   * Hand the runner the lifecycle slice for a session. The runner marks
   * run-in-progress on entry to `run()`, clears it when the run settles, and
   * polls `isInterrupted()` in its force-completion loop. Reading through this
   * (rather than a captured `AgentSessionRecord`, which `update()` replaces with
   * a fresh object) guarantees the runner sees live interrupt state.
   */
  runLifecycle(sessionId: string): SessionRunLifecycle {
    return {
      markRunInProgress: () => {
        const state = this.runStates.get(sessionId) ?? { runInProgress: false, interrupted: false };
        state.runInProgress = true;
        this.runStates.set(sessionId, state);
      },
      clearRunInProgress: () => {
        const state = this.runStates.get(sessionId);
        if (state) state.runInProgress = false;
      },
      isInterrupted: () => this.runStates.get(sessionId)?.interrupted === true,
    };
  }

  /**
   * True only when a session has an attached agent that is *actively running*.
   *
   * "Live" must mean more than map presence: pi-agent-core clears the agent's
   * active run (`agent.signal` → `undefined`) the moment its run settles, which
   * happens BEFORE `markCompleted`/`markDiscarded` evict the agent from the map.
   * So there is a window where `getAgent(id)` still returns an agent whose run
   * has already ended. The SSE stream uses this to refuse to treat such an agent
   * as live (belt-and-suspenders with its own terminal re-check), and it also
   * guards the markRunning-before-attach convention on `attachAgent`: an agent
   * attached before being prompted has no active run and is not yet live.
   */
  isAgentLive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const agent = this.agents.get(sessionId);
    if (!session || !agent || session.status !== "running") return false;
    return agent.signal !== undefined;
  }

  /**
   * Subscribe to a session's **run settlement** — fired exactly once when the
   * run finishes and the agent is evicted (`markCompleted`/`markFailedResumable`/
   * `markDiscarded` → {@link evict}). Returns an unsubscribe function.
   *
   * This is the signal the observability SSE stream closes on, deliberately
   * *not* the agent's per-prompt `agent_end`: a single `run()` can drive several
   * agent-loop invocations (the kickoff plus forced-completion prompts), each
   * emitting its own `agent_end`, so closing on `agent_end` would truncate the
   * live view after the first turn. The run is the unit that settles; the stream
   * spans it. If the run has already settled (the agent is gone), there is
   * nothing to fire — the caller's own liveness re-check ({@link isAgentLive})
   * handles that race and renders the persisted record instead.
   */
  onSettle(sessionId: string, listener: () => void): () => void {
    let set = this.settleListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.settleListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.settleListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.settleListeners.delete(sessionId);
    };
  }

  /**
   * Fire and clear a session's settle listeners. Snapshots the set and drops the
   * map entry before invoking, so a listener that unsubscribes (or the eviction
   * being observed) cannot mutate the set mid-iteration. Observe-only: a throwing
   * listener is swallowed so it can never break {@link evict}.
   */
  private fireSettle(sessionId: string): void {
    const set = this.settleListeners.get(sessionId);
    if (!set) return;
    this.settleListeners.delete(sessionId);
    for (const listener of [...set]) {
      try {
        listener();
      } catch (err) {
        this.deps.logger?.error("session manager: settle listener failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Inject a message into a running session. Returns false if the session isn't live
   * (unknown / not running) — the caller falls back (e.g. spawn a fresh session).
   *
   * `source` is the inbound timeline message behind a user **interjection** (reply-steer
   * / co-reply); when present AND the inject succeeds, a durable `session_interjections`
   * row is recorded so the session is reachable by the interjection's text and ids (the
   * "timeline message → session" debug path, §8/§11). Omitted for non-timeline injects
   * (cost-budget warning, delegate tool), which carry no event to link.
   */
  steer(sessionId: string, message: AgentMessage, source?: InterjectionSource): boolean {
    const session = this.sessions.get(sessionId);
    const agent = this.agents.get(sessionId);
    if (!session || !agent || session.status !== "running") return false;
    agent.steer(message);
    if (source) {
      this.persist("session interjection insert", sessionId, (storage) =>
        storage.insertSessionInterjection({
          sessionId,
          eventId: source.eventId ?? null,
          externalId: source.externalId ?? null,
          senderId: source.senderId ?? null,
          senderDisplayName: source.senderDisplayName ?? null,
          kind: source.kind,
          body: (source.body ?? "").slice(0, MAX_INTERJECTION_BODY),
          createdAt: Date.now(),
        }),
      );
    }
    return true;
  }

  /**
   * Interrupt a live run: tear down all pending work and mark the session
   * `interrupted` (spec §13 — operator Stop button). Returns `true` if a logically
   * running session was interrupted, `false` if the session has no in-progress run
   * (unknown / already terminal / never started).
   *
   * Liveness is gated on the explicit **run-in-progress** flag (set by the runner
   * for the whole duration of `run()`), NOT on the transient `agent.signal`.
   * `agent.signal` is defined only during an active `prompt()`; it is `undefined`
   * in the inter-turn gap between forced-completion turns, where the session is
   * still genuinely mid-`run()`. Gating on run-in-progress means a Stop landing in
   * that gap is honored instead of spuriously returning "not running".
   *
   * Status is set to `interrupted` BEFORE aborting so the run promise's natural
   * settlement (`markCompleted`/`markDiscarded`) defers to it. We deliberately do
   * NOT evict here: `agent.abort()` unwinds asynchronously and the SSE stream
   * still needs the live agent ref to forward the terminal `agent_end`. Eviction
   * happens once, from whichever terminal handler the settling run reaches.
   *
   * Teardown ordering: mark `interrupted` (sets the runner's loop-break signal) →
   * clear pending steering/follow-up queues → abort the in-flight run. The loop
   * break (the runner reads `isInterrupted()`) is the authoritative termination
   * signal; `abort()` is best-effort and only meaningful while a signal is
   * present (a missing signal in the inter-turn gap is fine — the loop break
   * catches it). Clearing the queues ensures no steered/follow-up message
   * survives the abort to re-prompt the agent.
   */
  interrupt(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const agent = this.agents.get(sessionId);
    const runState = this.runStates.get(sessionId);
    if (!session || !agent || session.status !== "running" || !runState?.runInProgress) {
      return false;
    }
    runState.interrupted = true;
    const completedAt = Date.now();
    this.update(sessionId, (s) => ({ ...s, status: "interrupted", completedAt }));
    this.persist("session status interrupted", sessionId, (storage) =>
      storage.updateAgentSessionStatus(sessionId, "interrupted", { completedAt }),
    );
    // Drop any queued steering/follow-up messages so nothing re-prompts the
    // agent after the abort. Guarded so we only touch the queue when needed.
    if (agent.hasQueuedMessages()) agent.clearAllQueues();
    // Only meaningful while a run is actively streaming; in the inter-turn gap
    // the signal is absent and the runner's loop break (above) does the work.
    if (agent.signal !== undefined) agent.abort();
    this.deps.logger?.info("session_interrupted", { sessionId });
    return true;
  }

  activeForTimeline(timelineKey: string): AgentSessionRecord[] {
    const ids = this.byTimeline.get(timelineKey) ?? new Set<string>();
    return [...ids]
      .map((id) => this.sessions.get(id))
      .filter((session): session is AgentSessionRecord =>
        Boolean(session && (session.status === "created" || session.status === "running")),
      );
  }

  /**
   * Run a fire-and-forget storage write through the single-writer queue,
   * error-logging any failure. No-op when storage was not provided. A failed
   * observability-row write must NEVER crash or block a live session.
   */
  private persist(what: string, sessionId: string, write: (storage: Storage) => Promise<void>): void {
    const { storage, logger } = this.deps;
    if (!storage) return;
    write(storage).catch((err) => {
      logger?.error(`session manager: ${what} write failed`, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private update(sessionId: string, updater: (session: AgentSessionRecord) => AgentSessionRecord): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.sessions.set(sessionId, updater(session));
  }

  private evict(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.agents.delete(sessionId);
    this.sessions.delete(sessionId);
    this.runStates.delete(sessionId);
    // Notify run-settlement observers (the SSE stream) AFTER the maps are torn
    // down: a listener that re-checks liveness must observe the settled state.
    this.fireSettle(sessionId);
    if (!session) return;
    const ids = this.byTimeline.get(session.timelineKey);
    ids?.delete(sessionId);
    if (ids?.size === 0) this.byTimeline.delete(session.timelineKey);
  }
}
