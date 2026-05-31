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
  | "suspended";

/** Trigger body is truncated before persisting to keep the row small. */
const MAX_TRIGGER_BODY = 500;

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

export class SessionManager {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly agents = new Map<string, Agent>();
  private readonly byTimeline = new Map<string, Set<string>>();

  /**
   * Storage and logger are optional so existing unit tests that construct
   * `new SessionManager()` keep working without a DB. When `storage` is absent,
   * all observability-row writes are skipped (no-op); in-memory state remains
   * the source of truth.
   */
  constructor(private readonly deps: { storage?: Storage; logger?: Logger } = {}) {}

  createPlaceholder(trigger: InboundChatEvent, sessionType: string = "default"): AgentSessionRecord {
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
    this.persist("session row insert", record.id, (storage) =>
      storage.insertAgentSession({
        id: record.id,
        timelineKey: record.timelineKey,
        sessionType: record.sessionType,
        status: "created",
        triggerEventId: trigger.event.id,
        triggerExternalId: trigger.event.externalId,
        triggerBody: trigger.event.body?.slice(0, MAX_TRIGGER_BODY),
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

  markDiscarded(sessionId: string, opts: { error?: string } = {}): void {
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

  attachAgent(sessionId: string, agent: Agent): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.agents.set(sessionId, agent);
  }

  getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  steer(sessionId: string, message: AgentMessage): boolean {
    const session = this.sessions.get(sessionId);
    const agent = this.agents.get(sessionId);
    if (!session || !agent || session.status !== "running") return false;
    agent.steer(message);
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
    if (!session) return;
    const ids = this.byTimeline.get(session.timelineKey);
    ids?.delete(sessionId);
    if (ids?.size === 0) this.byTimeline.delete(session.timelineKey);
  }
}
